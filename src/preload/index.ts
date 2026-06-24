/**
 * Easel — Host Preload Script
 *
 * Runs in the preload context (contextIsolation ON, nodeIntegration OFF).
 * Its sole responsibility: expose a typed `window.easel : EaselApi` via
 * `contextBridge`. The renderer has NO access to `ipcRenderer`, `require`,
 * or any Node primitive — it programs only against this bridge.
 *
 * Each invoke method wraps `ipcRenderer.invoke(channel, payload?)` typed via
 * `IpcInvokeMap`. Each `on*` method wraps `ipcRenderer.on(channel, listener)`
 * and returns an `Unsubscribe` that removes that exact listener.
 *
 * `webviewPreloadUrl` is a computed constant: the `file://` URL of the compiled
 * guest inspector at `out/preload/webview/inspector.js`. The host preload is
 * emitted to `out/preload/index.js` by electron-vite, so __dirname is
 * `out/preload` at runtime — the guest lives one sub-directory below.
 */

import { contextBridge, ipcRenderer } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import type {
  EaselApi,
  IpcEventMap,
  Unsubscribe,
} from '@shared/ipc';
import { IpcChannels } from '@shared/ipc';

/* -------------------------------------------------------------------------- */
/*  webviewPreloadUrl                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the guest inspector path relative to this preload's __dirname.
 *
 * Build layout (electron-vite):
 *   out/preload/index.js           ← this file at runtime (__dirname)
 *   out/preload/webview/inspector.js ← the guest preload
 *
 * We therefore join __dirname with 'webview/inspector.js'.
 */
const webviewPreloadUrl: string = pathToFileURL(
  path.join(__dirname, 'webview', 'inspector.cjs'),
).href;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Subscribe to a push channel (main → renderer). Registers the handler on
 * `ipcRenderer.on` and returns an `Unsubscribe` that tears down only this
 * handler (other subscribers on the same channel are unaffected).
 *
 * The generic `P` is the payload type from `IpcEventMap` for channel `C`.
 */
function subscribe<C extends keyof IpcEventMap>(
  channel: C,
  handler: (payload: IpcEventMap[C]) => void,
): Unsubscribe {
  // Electron's ipcRenderer listener receives (event, ...args); we destructure
  // the first arg as the typed payload and ignore the IpcRendererEvent.
  const listener = (_event: Electron.IpcRendererEvent, payload: IpcEventMap[C]): void => {
    handler(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

/* -------------------------------------------------------------------------- */
/*  EaselApi implementation                                                    */
/* -------------------------------------------------------------------------- */

const api: EaselApi = {
  // ── readonly constant ──────────────────────────────────────────────────────
  webviewPreloadUrl,

  // ── project.* ─────────────────────────────────────────────────────────────
  project: {
    open() {
      return ipcRenderer.invoke(IpcChannels.projectOpen);
    },
    getCurrent() {
      return ipcRenderer.invoke(IpcChannels.projectGetCurrent);
    },
    close() {
      return ipcRenderer.invoke(IpcChannels.projectClose);
    },
    onChanged(handler) {
      return subscribe(IpcChannels.projectChanged, handler);
    },
  },

  // ── edit.* ────────────────────────────────────────────────────────────────
  edit: {
    submit(req) {
      return ipcRenderer.invoke(IpcChannels.editSubmit, req);
    },
    cancel(req) {
      return ipcRenderer.invoke(IpcChannels.editCancel, req);
    },
    onEvent(handler) {
      return subscribe(IpcChannels.editEvent, handler);
    },
  },

  // ── settings.* ────────────────────────────────────────────────────────────
  settings: {
    get() {
      return ipcRenderer.invoke(IpcChannels.settingsGet);
    },
    update(req) {
      return ipcRenderer.invoke(IpcChannels.settingsUpdate, req);
    },
    setSecret(req) {
      return ipcRenderer.invoke(IpcChannels.settingsSetSecret, req);
    },
    clearSecret(req) {
      return ipcRenderer.invoke(IpcChannels.settingsClearSecret, req);
    },
    validateBackend() {
      return ipcRenderer.invoke(IpcChannels.settingsValidateBackend);
    },
    onChanged(handler) {
      return subscribe(IpcChannels.settingsChanged, handler);
    },
  },

  // ── checkpoint.* ──────────────────────────────────────────────────────────
  checkpoint: {
    list() {
      return ipcRenderer.invoke(IpcChannels.checkpointList);
    },
    restore(req) {
      return ipcRenderer.invoke(IpcChannels.checkpointRestore, req);
    },
    undo() {
      return ipcRenderer.invoke(IpcChannels.checkpointUndo);
    },
    redo() {
      return ipcRenderer.invoke(IpcChannels.checkpointRedo);
    },
    onChanged(handler) {
      return subscribe(IpcChannels.checkpointChanged, handler);
    },
  },

  // ── preview.* ─────────────────────────────────────────────────────────────
  preview: {
    reload(req) {
      return ipcRenderer.invoke(IpcChannels.previewReload, req);
    },
    capture(req) {
      return ipcRenderer.invoke(IpcChannels.previewCapture, req);
    },
    requestImage(req) {
      return ipcRenderer.invoke(IpcChannels.previewRequestImage, req);
    },
    openExternal(req) {
      return ipcRenderer.invoke(IpcChannels.previewOpenExternal, req);
    },
    onStatus(handler) {
      return subscribe(IpcChannels.previewStatus, handler);
    },
  },

  // ── devServer.* ───────────────────────────────────────────────────────────
  devServer: {
    start() {
      return ipcRenderer.invoke(IpcChannels.devServerStart);
    },
    stop() {
      return ipcRenderer.invoke(IpcChannels.devServerStop);
    },
    get() {
      return ipcRenderer.invoke(IpcChannels.devServerGet);
    },
    onEvent(handler) {
      return subscribe(IpcChannels.devServerEvent, handler);
    },
  },
};

/* -------------------------------------------------------------------------- */
/*  Expose to renderer world                                                   */
/* -------------------------------------------------------------------------- */

contextBridge.exposeInMainWorld('easel', api);
