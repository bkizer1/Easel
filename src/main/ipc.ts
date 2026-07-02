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
  XraySetNetworkInterceptRequest,
  XrayContinueRequestRequest,
  XrayFulfillRequestRequest,
  XrayFailRequestRequest,
  XraySaveSnapshotRequest,
  XrayGetSnapshotRequest,
  PuppeteerSetEnabledRequest,
  PuppeteerRemoveMockRequest,
  TokensMatchRequest,
  PublishOpenPrRequest,
  ProjectCreateNewRequest,
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
  setNetworkIntercept,
  continueRequest,
  fulfillRequest,
  failRequest,
  getNetworkLog,
  clearNetworkLog,
} from '@main/networkTap';
import {
  saveSnapshot,
  getSnapshot,
  listSnapshots,
} from '@main/stateSnapshots';
import {
  getState as getPuppeteerState,
  setEnabled as setPuppeteerEnabled,
  removeMock as removePuppeteerMock,
  clearAll as clearPuppeteerAll,
  resync as resyncPuppeteer,
} from '@main/puppeteer';
import { captureStateSnapshot } from '@main/stateCapture';

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

    log.info('Edit submitted', { requestId, instruction: req.request.instruction.slice(0, 80) });

    // Resolve the secrets the active backend may need.
    const secretIds = _secretIdsForBackend(settings.agentBackend);
    const secrets = resolveSecrets(secretIds);

    // Start the agent stream in the background; each event is pushed to the
    // renderer over the editEvent channel.
    void runEditStream({
      request: req.request,
      settings,
      secrets,
      projectRoot: project.root,
      // Time-travel (State X-Ray, issue #13): capture a bounded app-state
      // snapshot from the guest BEFORE the checkpoint commit, then persist it
      // keyed by the resulting checkpoint id — UNCONDITIONALLY, so every edit's
      // checkpoint gets a usable, diffable snapshot. The capture is best-effort
      // and timeout-bounded; it must never block or fail the checkpoint.
      createCheckpointFn: (msg, rid, provenance) =>
        _checkpointWithSnapshot(msg, rid, provenance),
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

  handle(IpcChannels.xraySetNetworkIntercept, (req: XraySetNetworkInterceptRequest) => {
    return ok(setNetworkIntercept(req.enabled));
  });

  handle(IpcChannels.xrayContinueRequest, (req: XrayContinueRequestRequest) => {
    if (!req.interceptId) return fail('interceptId is required', 'validation');
    return ok(continueRequest(req.interceptId, req.rewrite));
  });

  handle(IpcChannels.xrayFulfillRequest, (req: XrayFulfillRequestRequest) => {
    if (!req.interceptId) return fail('interceptId is required', 'validation');
    if (!req.mock || typeof req.mock.responseCode !== 'number') {
      return fail('a mock with a numeric responseCode is required', 'validation');
    }
    return ok(fulfillRequest(req.interceptId, req.mock));
  });

  handle(IpcChannels.xrayFailRequest, (req: XrayFailRequestRequest) => {
    if (!req.interceptId) return fail('interceptId is required', 'validation');
    return ok(failRequest(req.interceptId, req.reason));
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

  // ── puppeteer.* (Live State Puppeteer, issue #17) ────────────────────────────

  handle(IpcChannels.puppeteerGetState, () => {
    return ok({ state: getPuppeteerState() });
  });

  handle(IpcChannels.puppeteerSetEnabled, (req: PuppeteerSetEnabledRequest) => {
    // Enabling is policy-gated; needs the open project to read .easel/policy.json.
    const project = getCurrentProject();
    if (!project) return fail('No project open', 'no-project');
    const { state, detail } = setPuppeteerEnabled(req.enabled, project.root);
    return ok(detail ? { state, detail } : { state });
  });

  handle(IpcChannels.puppeteerRemoveMock, (req: PuppeteerRemoveMockRequest) => {
    if (!req.id) return fail('mock id is required', 'validation');
    removePuppeteerMock(req.id);
    return ok({ state: getPuppeteerState() });
  });

  handle(IpcChannels.puppeteerClearAll, () => {
    clearPuppeteerAll();
    return ok({ state: getPuppeteerState() });
  });

  handle(IpcChannels.puppeteerResync, () => {
    // Re-push enabled + mocks into a freshly (re)loaded guest. Re-checks policy
    // when a project is open so a mid-session policy change takes effect.
    resyncPuppeteer(getCurrentProject()?.root);
    return okVoid();
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

  log.info('IPC handlers registered');
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

import type { AppSettings, AgentBackendId, Checkpoint, CheckpointProvenance } from '@shared/types';
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
 * Time-travel (State X-Ray, issue #13): create a checkpoint AND persist a bounded
 * app-state snapshot keyed by the resulting checkpoint id.
 *
 * Order matters per spec: the snapshot is captured from the guest BEFORE the
 * checkpoint commit (so it reflects the pre-commit state), then — once we know
 * the new checkpoint id — persisted under that id. Capture is best-effort and
 * timeout-bounded inside {@link captureStateSnapshot}; persistence is best-effort
 * inside {@link saveSnapshot}. Neither can throw into or block the edit pipeline:
 * the checkpoint is returned regardless, so an edit never fails because the
 * snapshot side-channel hiccuped.
 */
async function _checkpointWithSnapshot(
  message: string,
  requestId: string,
  provenance?: CheckpointProvenance,
): Promise<Checkpoint> {
  // Capture BEFORE the commit. Never throws; degrades to an empty-but-valid tree.
  let data;
  try {
    data = await captureStateSnapshot();
  } catch (err) {
    log.warn('State snapshot capture failed; proceeding without it', { err: String(err) });
    data = undefined;
  }

  const checkpoint = await createCheckpoint(message, requestId, provenance);

  // Persist keyed by the resulting checkpoint id, UNCONDITIONALLY (an empty tree
  // is still a valid, diffable snapshot — every checkpoint gets one).
  try {
    saveSnapshot({
      checkpointId: checkpoint.id,
      capturedAt: Date.now(),
      label: checkpoint.message,
      data: data ?? { kind: 'object', entries: [], truncated: false },
    });
  } catch (err) {
    log.warn('Failed to persist state snapshot for checkpoint', {
      checkpointId: checkpoint.id,
      err: String(err),
    });
  }

  return checkpoint;
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
