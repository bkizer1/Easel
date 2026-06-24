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

import { ipcMain } from 'electron';
import type {
  EditSubmitRequest,
  EditCancelRequest,
  SettingsUpdateRequest,
  SettingsSetSecretRequest,
  SettingsClearSecretRequest,
  CheckpointRestoreRequest,
  PreviewReloadRequest,
  PreviewCaptureRequest,
  PreviewRequestImageRequest,
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
import {
  initCheckpoints,
  createCheckpoint,
  listCheckpoints,
  restoreCheckpoint,
  undoCheckpoint,
  redoCheckpoint,
} from '@main/checkpoints';
import { getMainWindow, capturePreview } from '@main/window';
import { createLogger } from '@main/logger';
import { runEditStream } from '@main/editRunner';

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
    }
    return ok({ project });
  });

  handle(IpcChannels.projectGetCurrent, () => {
    return ok({ project: getCurrentProject() });
  });

  handle(IpcChannels.projectClose, () => {
    closeProject();
    return okVoid();
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
      createCheckpointFn: (msg, rid) => createCheckpoint(msg, rid),
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

  log.info('IPC handlers registered');
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

import type { AppSettings, AgentBackendId } from '@shared/types';
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

function _broadcastSettingsChanged(settings: AppSettings): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const payload: SettingsChangedPayload = { settings };
  win.webContents.send(IpcChannels.settingsChanged, payload);
}
