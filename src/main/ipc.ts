/**
 * Easel — main-process IPC handler registration.
 *
 * Registers exactly one `ipcMain.handle` per invoke channel declared in
 * `src/shared/ipc.ts`.  Every handler validates the inbound payload, calls the
 * appropriate service, and returns an `IpcResult<T>` — failures are returned as
 * values (never thrown across the boundary).
 *
 * Push channels (main → renderer) are emitted by the service modules directly
 * via `webContents.send`; they are not registered here.
 *
 * Call `registerIpcHandlers()` once, after `app.whenReady()`.
 */

import { ipcMain, shell } from 'electron';
import type {
  EditSubmitRequest,
  EditCancelRequest,
  EditPolicyRespondRequest,
  SettingsUpdateRequest,
  SettingsSetSecretRequest,
  SettingsClearSecretRequest,
  SettingsSetMacrosRequest,
  CheckpointRestoreRequest,
  CheckpointGetShotsRequest,
  CheckpointScratchStartRequest,
  PreviewReloadRequest,
  PreviewCaptureRequest,
  PreviewRequestImageRequest,
  PreviewOpenExternalRequest,
  XraySetNetworkCaptureRequest,
  XraySaveSnapshotRequest,
  XrayGetSnapshotRequest,
  TokensMatchRequest,
  PublishOpenPrRequest,
  ProjectCreateNewRequest,
  ReviewApplyRequest,
  ReviewDiscardRequest,
} from '@shared/ipc';
import { IpcChannels } from '@shared/ipc';
import { ok, okVoid, fail } from '@shared/result';
import {
  getSettings,
  updateSettings,
  setSecret,
  clearSecret,
  resolveSecrets,
} from '@main/settings';
import {
  openProjectFolder,
  getCurrentProject,
  closeProject,
} from '@main/project';
import { chooseNewSiteLocation, createNewSite } from '@main/scaffold';
import { prewarmToolchain } from '@main/toolchain';
import {
  startDevServer,
  stopDevServer,
  getDevServerState,
  maybeAutoStartDevServer,
} from '@main/devServer';
import {
  initCheckpoints,
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  undoCheckpoint,
  redoCheckpoint,
  startScratch,
  keepScratch,
  discardScratch,
} from '@main/checkpoints';
import { getMainWindow, capturePreview } from '@main/window';
import { createLogger } from '@main/logger';
import { runEditStream, type VerifyFn } from '@main/editRunner';
import { buildJudgePrompt, runVisionJudge } from '@main/agents/visionJudge';
import { createAnthropicClient } from '@main/agents/anthropicClient';
import {
  setNetworkCapture,
  getNetworkLog,
  clearNetworkLog,
} from '@main/networkTap';
import {
  saveSnapshot,
  getSnapshot,
  listSnapshots,
} from '@main/stateSnapshots';

const log = createLogger('ipc');

/* -------------------------------------------------------------------------- */
/*  Typed ipcMain.handle wrapper                                               */
/* -------------------------------------------------------------------------- */

/**
 * Tiny helper that catches any synchronous or async error from a handler and
 * converts it to a `fail(...)` result so the renderer always receives a typed
 * response.  Removes try/catch boilerplate from every handler below.
 */
function handle<Req, Res>(
  channel: string,
  fn: (req: Req) => Promise<Res> | Res,
): void {
  ipcMain.handle(channel, async (_event, req: Req) => {
    try {
      return await fn(req);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error(`Handler error on ${channel}`, { err: msg });
      return fail(msg);
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  Registration                                                               */
/* -------------------------------------------------------------------------- */

export function registerIpcHandlers(): void {
  log.info('Registering IPC handlers');

  // ── project.* ─────────────────────────────────────────────────────────────

  handle(IpcChannels.projectOpen, async () => {
    const project = await openProjectFolder();
    if (project) {
      // Initialise the checkpoint manager for the newly opened project.
      await initCheckpoints(project.root).catch((err) =>
        log.warn('Checkpoint init failed', { err: String(err) }),
      );
      // A freshly opened project supersedes any prior managed dev server.
      stopDevServer();
      // Auto-start its dev server when one isn't already reachable (fire-and-forget;
      // the renderer reflects progress via devServer.event + the reachability poll).
      void maybeAutoStartDevServer(project);
    }
    return ok({ project });
  });

  handle(IpcChannels.projectGetCurrent, () => {
    return ok({ project: getCurrentProject() });
  });

  handle(IpcChannels.projectClose, () => {
    stopDevServer();
    closeProject();
    return okVoid();
  });

  handle(IpcChannels.projectChooseLocation, async () => {
    const parentDir = await chooseNewSiteLocation();
    return ok({ parentDir });
  });

  handle(IpcChannels.projectPrewarmToolchain, () => {
    // Fire-and-forget: warm the shared toolchain while the user fills out the brief.
    prewarmToolchain();
    return okVoid();
  });

  handle(IpcChannels.projectCreateNew, async (req: ProjectCreateNewRequest) => {
    if (!req.parentDir || !req.name?.trim()) return fail('A name and location are required', 'validation');
    // Scaffold the new project (writes files, installs deps, git-inits, loads it).
    const project = await createNewSite(req);
    // Same post-open wiring as projectOpen: checkpoints + auto-start its dev server.
    await initCheckpoints(project.root).catch((err) =>
      log.warn('Checkpoint init failed', { err: String(err) }),
    );
    stopDevServer();
    void maybeAutoStartDevServer(project);
    return ok({ project });
  });

  // ── edit.* ────────────────────────────────────────────────────────────────

  handle(IpcChannels.editSubmit, async (req: EditSubmitRequest) => {
    const project = getCurrentProject();
    if (!project) return fail('No project open', 'no-project');

    const settings = getSettings();
    const requestId = req.request.id;

    log.info('Edit submitted', {
      requestId,
      instruction: req.request.instruction.slice(0, 80),
      reviewMode: req.reviewMode === true,
    });

    // Resolve the secrets the active backend may need.
    const secretIds = _secretIdsForBackend(settings.agentBackend);
    const secrets = resolveSecrets(secretIds);

    // ── Review mode (Issue #19): stage the edit in a shadow worktree ─────────
    // Instead of writing to the live project, point the agent at a shadow
    // worktree and commit its edits to a staging ref. The live tree (and preview)
    // is never touched until the user approves via review.apply. Self-heal verify
    // is DISABLED here: there is no live HMR to capture before/after frames, so we
    // pass verify: undefined + maxRetries: 0.
    if (req.reviewMode) {
      const { createReviewSession, discardReviewSession } = await import('@main/reviewSession');
      let worktreePath: string;
      let stagedCheckpointFn: Parameters<typeof runEditStream>[0]['createCheckpointFn'];
      try {
        const session = await createReviewSession(project.root, requestId);
        worktreePath = session.worktreePath;
        stagedCheckpointFn = session.stagedCheckpointFn;
      } catch (err) {
        log.error('Failed to create review session', { requestId, err: String(err) });
        return fail(`Could not start review session: ${String(err)}`, 'review-init-failed');
      }

      // CRITICAL: the Claude Agent SDK roots cwd / additionalDirectories on
      // request.projectRoot (not ctx.projectRoot), so the request itself must
      // point at the worktree for the default backend to stage rather than write
      // the live tree. The hand-built backends use ctx.fs (rooted at the projectRoot
      // we pass below), so they are correct either way.
      const stagedRequest = { ...req.request, projectRoot: worktreePath };

      void runEditStream({
        request: stagedRequest,
        settings,
        secrets,
        projectRoot: worktreePath,
        createCheckpointFn: stagedCheckpointFn,
        // No live HMR in review mode → no before/after frames to judge against.
        verify: undefined,
        maxRetries: 0,
      }).catch(async (err) => {
        // A synchronous throw from runEditStream is unexpected (it catches its own
        // errors), but if session wiring half-fails, don't leak the worktree.
        log.error('Review edit stream threw', { requestId, err: String(err) });
        await discardReviewSession(project.root, requestId).catch(() => undefined);
      });

      return ok({ requestId, reviewMode: true });
    }

    // ── Normal mode: write directly to the live project ──────────────────────
    // Start the agent stream in the background; each event is pushed to the
    // renderer over the editEvent channel.
    void runEditStream({
      request: req.request,
      settings,
      secrets,
      projectRoot: project.root,
      createCheckpointFn: (msg, rid, provenance) => createCheckpoint(msg, rid, provenance),
      verify: _makeVerifyFn(settings),
      maxRetries: settings.maxRetries,
    });

    return ok({ requestId });
  });

  handle(IpcChannels.editCancel, async (req: EditCancelRequest) => {
    log.info('Edit cancel requested', { requestId: req.requestId });
    // The cancel signal is handled inside runEditStream via AbortController.
    // We delegate to the runner's cancel registry.
    const { cancelEdit } = await import('@main/editRunner');
    cancelEdit(req.requestId);
    return okVoid();
  });

  handle(IpcChannels.editPolicyRespond, async (req: EditPolicyRespondRequest) => {
    if (!req.requestId || !req.path) return fail('requestId and path are required', 'validation');
    log.info('Policy confirm response', {
      requestId: req.requestId,
      path: req.path,
      decision: req.decision,
    });
    const { respondPolicyConfirm } = await import('@main/editRunner');
    respondPolicyConfirm(req.requestId, req.path, req.decision === 'allow-once');
    return okVoid();
  });

  // ── settings.* ────────────────────────────────────────────────────────────

  handle(IpcChannels.settingsGet, () => {
    return ok({ settings: getSettings() });
  });

  handle(IpcChannels.settingsUpdate, (req: SettingsUpdateRequest) => {
    const settings = updateSettings(req.patch);
    _broadcastSettingsChanged(settings);
    return ok({ settings });
  });

  handle(IpcChannels.settingsSetSecret, (req: SettingsSetSecretRequest) => {
    if (!req.id || !req.value) return fail('id and value are required', 'validation');
    setSecret(req.id, req.value);
    const settings = getSettings();
    _broadcastSettingsChanged(settings);
    return ok({ settings });
  });

  handle(IpcChannels.settingsClearSecret, (req: SettingsClearSecretRequest) => {
    if (!req.id) return fail('id is required', 'validation');
    clearSecret(req.id);
    const settings = getSettings();
    _broadcastSettingsChanged(settings);
    return ok({ settings });
  });

  handle(IpcChannels.settingsValidateBackend, async () => {
    const { validateActiveBackend } = await import('@main/editRunner');
    const result = await validateActiveBackend();
    return ok(result);
  });

  handle(IpcChannels.settingsGetMacros, () => {
    return ok({ macros: getSettings().macros });
  });

  handle(IpcChannels.settingsSetMacros, (req: SettingsSetMacrosRequest) => {
    if (!Array.isArray(req.macros)) return fail('macros must be an array', 'validation');
    // Reuse the existing settings persistence as-is (no separate macro store).
    const settings = updateSettings({ macros: req.macros });
    _broadcastSettingsChanged(settings);
    return ok({ settings });
  });

  // ── checkpoint.* ──────────────────────────────────────────────────────────

  handle(IpcChannels.checkpointList, () => {
    const { checkpoints, currentId } = listCheckpoints();
    return ok({ checkpoints, currentId });
  });

  handle(IpcChannels.checkpointRestore, async (req: CheckpointRestoreRequest) => {
    if (!req.checkpointId) return fail('checkpointId is required', 'validation');
    const changedFiles = await restoreCheckpoint(req.checkpointId);
    return ok({ changedFiles });
  });

  handle(IpcChannels.checkpointUndo, async () => {
    const checkpoint = await undoCheckpoint();
    return ok({ checkpoint });
  });

  handle(IpcChannels.checkpointRedo, async () => {
    const checkpoint = await redoCheckpoint();
    return ok({ checkpoint });
  });

  handle(IpcChannels.checkpointGetShots, async (req: CheckpointGetShotsRequest) => {
    if (!req.checkpointId) return fail('checkpointId is required', 'validation');
    const { readShots } = await import('@main/checkpointShots');
    const shots = await readShots(req.checkpointId);
    return ok(shots);
  });

  // ── Issue #11: scratch experiments ──────────────────────────────────────────

  handle(IpcChannels.checkpointScratchStart, async (req: CheckpointScratchStartRequest) => {
    if (!getCurrentProject()) return fail('No project open', 'no-project');
    const scratch = await startScratch(req?.name);
    return ok({ scratch });
  });

  handle(IpcChannels.checkpointScratchKeep, async () => {
    const scratch = await keepScratch();
    return ok({ scratch });
  });

  handle(IpcChannels.checkpointScratchDiscard, async () => {
    const scratch = await discardScratch();
    return ok({ scratch });
  });

  // ── preview.* ─────────────────────────────────────────────────────────────

  handle(IpcChannels.previewReload, (req: PreviewReloadRequest | void) => {
    const win = getMainWindow();
    if (!win) return fail('No window open', 'no-window');

    const hard = (req as PreviewReloadRequest | undefined)?.hard ?? false;
    // The renderer controls the <webview>; we pass the reload signal back down.
    // Since we can also directly call reload on the webview webContents, we
    // send a dedicated message.  But the preload exposes this as
    // window.easel.preview.reload — the renderer will call webview.reload() itself.
    // Here we just reload the entire renderer if a hard reload was requested.
    if (hard) {
      win.webContents.reloadIgnoringCache();
    }
    return okVoid();
  });

  handle(IpcChannels.previewCapture, async (req: PreviewCaptureRequest | void) => {
    const box = (req as PreviewCaptureRequest | undefined)?.box;
    const screenshotDataUrl = await capturePreview(box);
    return ok({ screenshotDataUrl });
  });

  handle(IpcChannels.previewRequestImage, async (req: PreviewRequestImageRequest) => {
    // The image provider is resolved at runtime by the editRunner / a singleton.
    // For now, use the stub provider which is always registered.
    const { getActiveImageProvider } = await import('@main/imageProvider');
    const provider = getActiveImageProvider();
    const result = await provider.request(req.request);
    return ok({ result });
  });

  handle(IpcChannels.previewOpenExternal, async (req: PreviewOpenExternalRequest) => {
    if (!/^https?:\/\//i.test(req.url)) return fail('Only http(s) URLs can be opened externally', 'validation');
    await shell.openExternal(req.url);
    return okVoid();
  });

  // ── devServer.* ───────────────────────────────────────────────────────────

  handle(IpcChannels.devServerStart, () => {
    const project = getCurrentProject();
    if (!project) return fail('No project open', 'no-project');
    if (!project.devCommand) return fail('No dev command detected for this project', 'no-command');
    startDevServer({ command: project.devCommand, cwd: project.root, url: project.devServerUrl });
    return okVoid();
  });

  handle(IpcChannels.devServerStop, () => {
    stopDevServer();
    return okVoid();
  });

  handle(IpcChannels.devServerGet, () => {
    return ok(getDevServerState());
  });

  // ── xray.* (State X-Ray cockpit) ────────────────────────────────────────────

  handle(IpcChannels.xrayGetNetworkLog, () => {
    return ok(getNetworkLog());
  });

  handle(IpcChannels.xrayClearNetworkLog, () => {
    clearNetworkLog();
    return okVoid();
  });

  handle(IpcChannels.xraySetNetworkCapture, (req: XraySetNetworkCaptureRequest) => {
    return ok(setNetworkCapture(req.enabled));
  });

  handle(IpcChannels.xraySaveSnapshot, (req: XraySaveSnapshotRequest) => {
    if (!req.snapshot || !req.snapshot.checkpointId) {
      return fail('snapshot with a checkpointId is required', 'validation');
    }
    saveSnapshot(req.snapshot);
    return okVoid();
  });

  handle(IpcChannels.xrayGetSnapshot, (req: XrayGetSnapshotRequest) => {
    if (!req.checkpointId) return fail('checkpointId is required', 'validation');
    return ok({ snapshot: getSnapshot(req.checkpointId) });
  });

  handle(IpcChannels.xrayListSnapshots, () => {
    return ok({ checkpointIds: listSnapshots() });
  });

  // ── tokens.* (Issue #8) ──────────────────────────────────────────────────────

  handle(IpcChannels.tokensMatch, async (req: TokensMatchRequest) => {
    const project = getCurrentProject();
    if (!project) return fail('No project open', 'no-project');
    const { resolveTokens } = await import('@main/tokens');
    const matches = await resolveTokens(project.root, req.values ?? {});
    return ok({ matches });
  });

  // ── publish.* (Issue #10) ────────────────────────────────────────────────────

  handle(IpcChannels.publishOpenPr, async (req: PublishOpenPrRequest) => {
    const project = getCurrentProject();
    if (!project) return fail('No project open', 'no-project');

    // The session's accepted edits are the checkpoints that carry a requestId
    // (the initial "Original" snapshot does not).
    const { checkpoints } = listCheckpoints();
    const edits = checkpoints.filter((c) => c.requestId);
    if (edits.length === 0) return fail('No accepted edits to publish yet', 'no-checkpoints');

    // Accumulate instructions + changed files + provenance. Arrays (targets/
    // sources) are unioned; scalar fields take the most recent non-empty value.
    const { getCheckpointProvenance } = await import('@main/checkpoints');
    const instructions: string[] = [];
    const files = new Set<string>();
    const allTargets = new Set<string>();
    const allSources = new Set<string>();
    const scalar: Pick<CheckpointProvenance, 'model' | 'backend' | 'confidence'> = {};
    for (const c of edits) {
      for (const f of c.changedFiles) files.add(f);
      const prov = await getCheckpointProvenance(c.commitSha);
      if (prov.instruction) instructions.push(prov.instruction);
      for (const t of prov.targets ?? []) allTargets.add(t);
      for (const s of prov.sources ?? []) allSources.add(s);
      if (prov.model) scalar.model = prov.model;
      if (prov.backend) scalar.backend = prov.backend;
      if (prov.confidence) scalar.confidence = prov.confidence;
    }
    const mergedProvenance: CheckpointProvenance = {
      ...scalar,
      instruction: instructions.length > 0 ? instructions.join(' | ') : undefined,
      targets: allTargets.size > 0 ? [...allTargets] : undefined,
      sources: allSources.size > 0 ? [...allSources] : undefined,
    };

    const { openPr, buildPrContent } = await import('@main/publish');
    const content = buildPrContent({ instructions, changedFiles: [...files] });
    const result = await openPr({
      root: project.root,
      checkpoints: edits,
      title: req.title?.trim() || content.title,
      body: content.body,
      branchName: req.branchName?.trim() || undefined,
      provenance: mergedProvenance,
    });

    if (!result.ok) return fail(result.message, result.code);
    return ok({ branch: result.branch, prUrl: result.prUrl });
  });

  // ── review.* (Issue #19: propose-don't-write) ─────────────────────────────────

  handle(IpcChannels.reviewApply, async (req: ReviewApplyRequest) => {
    if (!req.requestId) return fail('requestId is required', 'validation');
    const project = getCurrentProject();
    if (!project) return fail('No project open', 'no-project');

    const { applyReviewSession } = await import('@main/reviewSession');
    try {
      const result = await applyReviewSession(
        project.root,
        req.requestId,
        Array.isArray(req.approvedPaths) ? req.approvedPaths : [],
      );
      return ok(result);
    } catch (err) {
      // Unknown session (or apply failure) → typed failure, never thrown across IPC.
      return fail(String(err instanceof Error ? err.message : err), 'review-apply-failed');
    }
  });

  handle(IpcChannels.reviewDiscard, async (req: ReviewDiscardRequest) => {
    if (!req.requestId) return fail('requestId is required', 'validation');
    const project = getCurrentProject();
    // Discard must tear down the worktree even if the project was closed; fall
    // back to the checkpoint root when no project is open so the worktree still
    // gets cleaned up.
    const { discardReviewSession } = await import('@main/reviewSession');
    const { getCheckpointRoot } = await import('@main/checkpoints');
    const root = project?.root ?? getCheckpointRoot();
    if (!root) return fail('No project open', 'no-project');
    await discardReviewSession(root, req.requestId);
    return okVoid();
  });

  log.info('IPC handlers registered');
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

import type { AppSettings, AgentBackendId, CheckpointProvenance } from '@shared/types';
import type { SettingsChangedPayload } from '@shared/ipc';

/** Return the secret ids the given backend may need decrypted at call time. */
function _secretIdsForBackend(backendId: AgentBackendId): string[] {
  switch (backendId) {
    case 'claude-agent-sdk':
      return ['anthropic', 'gateway-token', 'claude-oauth-token'];
    case 'anthropic-api':
      return ['anthropic'];
    case 'local-openai':
      return ['local'];
    default:
      return [];
  }
}

/**
 * Build the self-heal vision judge (issue #16) for an edit, or `undefined` when
 * it cannot run. The judge calls the Anthropic Messages API directly (vision),
 * so it needs an `anthropic` API key regardless of the active edit backend;
 * absent the flag or a key it is skipped and the verify step no-ops (fail-open).
 */
function _makeVerifyFn(settings: AppSettings): VerifyFn | undefined {
  if (!settings.featureFlags.selfHealVerify) return undefined;
  const apiKey = resolveSecrets(['anthropic'])['anthropic'];
  if (!apiKey) return undefined;
  const baseURL = settings.backends['anthropic-api']?.baseUrl;

  return async ({ instruction, before, after, signal }) => {
    try {
      const client = await createAnthropicClient(apiKey, baseURL);
      const prompt = buildJudgePrompt(instruction, before, after);
      return await runVisionJudge(client, prompt, { model: settings.model, signal });
    } catch {
      return null;
    }
  };
}

function _broadcastSettingsChanged(settings: AppSettings): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const payload: SettingsChangedPayload = { settings };
  win.webContents.send(IpcChannels.settingsChanged, payload);
}
