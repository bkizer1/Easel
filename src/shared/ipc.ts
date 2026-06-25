/**
 * Easel — typed IPC contract (single source of truth for main <-> renderer).
 *
 * - {@link IpcChannels} is a `const` map of channel-name string literals,
 *   grouped by domain. The main process registers handlers for these; the
 *   preload bridge invokes/subscribes to them.
 * - For each channel, a request/response (or event payload) type is declared.
 * - {@link EaselApi} is the typed surface the preload script exposes on
 *   `window.easel`. The renderer programs against this interface only — it
 *   never touches `ipcRenderer` directly (contextIsolation is ON).
 *
 * Pure types/const literals — no runtime logic, no Electron imports.
 */

import type {
  AgentEvent,
  AppSettings,
  BoundingBox,
  Checkpoint,
  EditRequest,
  ElementTarget,
  ImageRequest,
  ImageResult,
  InstructionMacro,
  ProjectConfig,
  SourceLocation,
} from './types';

/* -------------------------------------------------------------------------- */
/*  Channel names                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Canonical channel-name literals. Grouped by domain (`project.*`, `edit.*`,
 * `settings.*`, `checkpoint.*`, `preview.*`). `as const` preserves the exact
 * string-literal types so handler/invoker maps below stay type-safe.
 */
export const IpcChannels = {
  // Project lifecycle -------------------------------------------------------
  /** Show an open-folder dialog and open the chosen project. */
  projectOpen: 'project.open',
  /** Return the currently open project's config (or null). */
  projectGetCurrent: 'project.getCurrent',
  /** Close the current project. */
  projectClose: 'project.close',
  /** Emitted by main when the open project changes. */
  projectChanged: 'project.changed',

  // Edit pipeline -----------------------------------------------------------
  /** Submit an EditRequest; main runs the agent and streams events back. */
  editSubmit: 'edit.submit',
  /** Cancel an in-flight edit by request id. */
  editCancel: 'edit.cancel',
  /** Answer a guardrail `requireConfirm` prompt (allow-once / deny) for a path. */
  editPolicyRespond: 'edit.policyRespond',
  /** Streamed AgentEvents for in-flight edits (main -> renderer). */
  editEvent: 'edit.event',

  // Settings & secrets ------------------------------------------------------
  /** Read current settings (secrets returned as refs, never plaintext). */
  settingsGet: 'settings.get',
  /** Persist updated settings. */
  settingsUpdate: 'settings.update',
  /** Store a secret (e.g. API key) via safeStorage; returns its ref. */
  settingsSetSecret: 'settings.setSecret',
  /** Clear a stored secret by logical id. */
  settingsClearSecret: 'settings.clearSecret',
  /** Validate that the selected backend is usable with current settings. */
  settingsValidateBackend: 'settings.validateBackend',
  /** Read the saved instruction macros (convenience over the full settings get). */
  settingsGetMacros: 'settings.getMacros',
  /** Persist the full ordered list of instruction macros. */
  settingsSetMacros: 'settings.setMacros',
  /** Emitted by main when settings change (e.g. from another window). */
  settingsChanged: 'settings.changed',

  // Checkpoints (undo/redo) -------------------------------------------------
  /** List all checkpoints for the current project, newest first. */
  checkpointList: 'checkpoint.list',
  /** Restore the project to a specific checkpoint. */
  checkpointRestore: 'checkpoint.restore',
  /** Undo the most recent applied edit. */
  checkpointUndo: 'checkpoint.undo',
  /** Redo a previously undone edit. */
  checkpointRedo: 'checkpoint.redo',
  /** Emitted by main when the checkpoint list/position changes. */
  checkpointChanged: 'checkpoint.changed',

  // Preview / images --------------------------------------------------------
  /** Reload the embedded preview (e.g. after a manual file change). */
  previewReload: 'preview.reload',
  /** Capture preview page pixels in main via `webContents.capturePage` (optional bbox). */
  previewCapture: 'preview.capture',
  /** Fulfill an image request through the active ImageProvider. */
  previewRequestImage: 'preview.requestImage',
  /** Emitted by main to report dev-server reachability status. */
  previewStatus: 'preview.status',
  /** Open the current preview URL in the user's external browser. */
  previewOpenExternal: 'preview.openExternal',

  // Dev server (auto-start) -------------------------------------------------
  /** Start the current project's dev server (runs its detected devCommand). */
  devServerStart: 'devServer.start',
  /** Stop the dev server Easel started. */
  devServerStop: 'devServer.stop',
  /** Get the current dev-server state + recent log tail. */
  devServerGet: 'devServer.get',
  /** Emitted by main on dev-server state / log changes. */
  devServerEvent: 'devServer.event',
} as const;

/** Union of every channel-name literal. */
export type IpcChannelName = (typeof IpcChannels)[keyof typeof IpcChannels];

/* -------------------------------------------------------------------------- */
/*  Request / response payloads (invoke channels)                             */
/* -------------------------------------------------------------------------- */

/** Generic wrapper so handlers can return failure without throwing across IPC. */
export type IpcResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string };

// project.* -----------------------------------------------------------------

export interface ProjectOpenResponse {
  /** The opened project, or null if the dialog was cancelled. */
  project: ProjectConfig | null;
}

export interface ProjectGetCurrentResponse {
  project: ProjectConfig | null;
}

// edit.* --------------------------------------------------------------------

export interface EditSubmitRequest {
  request: EditRequest;
}
export interface EditSubmitResponse {
  /** Echo of the request id now streaming via {@link IpcChannels.editEvent}. */
  requestId: string;
}

export interface EditCancelRequest {
  requestId: string;
}

/**
 * The renderer's answer to a guardrail `policy-confirm` prompt for one path.
 * `allow-once` lets this single write through for the rest of the edit; `deny`
 * blocks it (the agent's tool call fails, leaving the file unchanged).
 */
export interface EditPolicyRespondRequest {
  requestId: string;
  /** Project-relative path from the `policy-confirm` warning. */
  path: string;
  decision: 'allow-once' | 'deny';
}

/** Payload pushed on {@link IpcChannels.editEvent}. */
export interface EditEventPayload {
  event: AgentEvent;
}

// settings.* ----------------------------------------------------------------

export interface SettingsGetResponse {
  settings: AppSettings;
}

export interface SettingsUpdateRequest {
  /** Partial patch merged over current settings (secrets excluded). */
  patch: Partial<Omit<AppSettings, 'apiKeyRef' | 'imageApiKeyRef'>>;
}
export interface SettingsUpdateResponse {
  settings: AppSettings;
}

export interface SettingsSetSecretRequest {
  /** Logical secret id, e.g. `anthropic` or `image-provider`. */
  id: string;
  /** Plaintext value; encrypted with safeStorage by main, never echoed back. */
  value: string;
}
export interface SettingsSetSecretResponse {
  settings: AppSettings;
}

export interface SettingsClearSecretRequest {
  id: string;
}
export interface SettingsClearSecretResponse {
  settings: AppSettings;
}

export interface SettingsValidateBackendResponse {
  ok: boolean;
  problem?: string;
}

export interface SettingsGetMacrosResponse {
  macros: InstructionMacro[];
}

export interface SettingsSetMacrosRequest {
  /** The full, ordered macro list to persist (replaces the stored list). */
  macros: InstructionMacro[];
}
export interface SettingsSetMacrosResponse {
  /** Updated settings (so the renderer can refresh its single source of truth). */
  settings: AppSettings;
}

// checkpoint.* --------------------------------------------------------------

export interface CheckpointListResponse {
  checkpoints: Checkpoint[];
  /** Id of the checkpoint the working tree currently matches. */
  currentId?: string;
}

export interface CheckpointRestoreRequest {
  checkpointId: string;
}
export interface CheckpointRestoreResponse {
  /** Files changed by the restore, for UI feedback. */
  changedFiles: string[];
}

export interface CheckpointUndoResponse {
  /** The checkpoint now active after undo, or null if nothing to undo. */
  checkpoint: Checkpoint | null;
}
export interface CheckpointRedoResponse {
  /** The checkpoint now active after redo, or null if nothing to redo. */
  checkpoint: Checkpoint | null;
}

/** Payload pushed on {@link IpcChannels.checkpointChanged}. */
export interface CheckpointChangedPayload {
  checkpoints: Checkpoint[];
  currentId?: string;
}

// preview.* -----------------------------------------------------------------

export interface PreviewReloadRequest {
  /** Hard reload (ignore cache) vs. soft reload. */
  hard?: boolean;
}

export interface PreviewCaptureRequest {
  /**
   * Optional region to capture, in preview-viewport CSS pixels. The full
   * viewport is captured when omitted. Page pixels are read in the MAIN process
   * via `webContents.capturePage` (the renderer cannot read the `<webview>`
   * guest's pixels), so this is the authoritative source for
   * {@link EditRequest.screenshotDataUrl}.
   */
  box?: BoundingBox;
}

export interface PreviewCaptureResponse {
  /** Data URL of the captured region (PNG). */
  screenshotDataUrl: string;
}

export interface PreviewRequestImageRequest {
  request: ImageRequest;
}
export interface PreviewRequestImageResponse {
  result: ImageResult;
}

export interface PreviewOpenExternalRequest {
  /** http(s) URL to open in the user's default browser. */
  url: string;
}

/** Dev-server reachability, pushed on {@link IpcChannels.previewStatus}. */
export interface PreviewStatusPayload {
  url: string;
  reachable: boolean;
  /** Human-readable detail (e.g. `ECONNREFUSED`). */
  detail?: string;
}

/** Lifecycle state of the dev server Easel manages. */
export type DevServerState = 'idle' | 'starting' | 'running' | 'stopped' | 'error';

/** Dev-server status + recent output, pushed on {@link IpcChannels.devServerEvent}. */
export interface DevServerStatePayload {
  state: DevServerState;
  /** The command being run (e.g. `npm run dev`), when one is active. */
  command?: string;
  /** Working directory the command runs in. */
  cwd?: string;
  /** The dev-server URL Easel is waiting on. */
  url?: string;
  /** Most recent output lines (ANSI-stripped, capped). */
  logTail: string[];
}

/* -------------------------------------------------------------------------- */
/*  Event payloads (push channels, main -> renderer)                          */
/* -------------------------------------------------------------------------- */

export interface ProjectChangedPayload {
  project: ProjectConfig | null;
}

export interface SettingsChangedPayload {
  settings: AppSettings;
}

/* -------------------------------------------------------------------------- */
/*  window.easel — the preload-exposed renderer API                           */
/* -------------------------------------------------------------------------- */

/** Unsubscribe function returned by every event-subscription method. */
export type Unsubscribe = () => void;

/**
 * The typed API surface the preload bridge installs at `window.easel`. Methods
 * map to invoke channels; `on*` methods map to push channels and return an
 * {@link Unsubscribe}. The renderer depends ONLY on this interface.
 */
export interface EaselApi {
  /**
   * Absolute `file://` URL of the compiled guest inspector
   * (`out/preload/webview/inspector.js`), exposed by the host preload as a
   * constant (NOT an IPC channel). The renderer sets it as the `<webview>`
   * `preload` attribute so the guest script loads inside the embedded page.
   */
  readonly webviewPreloadUrl: string;

  project: {
    open(): Promise<IpcResult<ProjectOpenResponse>>;
    getCurrent(): Promise<IpcResult<ProjectGetCurrentResponse>>;
    close(): Promise<IpcResult<void>>;
    onChanged(handler: (payload: ProjectChangedPayload) => void): Unsubscribe;
  };

  edit: {
    submit(req: EditSubmitRequest): Promise<IpcResult<EditSubmitResponse>>;
    cancel(req: EditCancelRequest): Promise<IpcResult<void>>;
    /** Answer a guardrail `policy-confirm` prompt (allow-once / deny) for a path. */
    policyRespond(req: EditPolicyRespondRequest): Promise<IpcResult<void>>;
    /** Subscribe to streamed AgentEvents for all in-flight edits. */
    onEvent(handler: (payload: EditEventPayload) => void): Unsubscribe;
  };

  settings: {
    get(): Promise<IpcResult<SettingsGetResponse>>;
    update(req: SettingsUpdateRequest): Promise<IpcResult<SettingsUpdateResponse>>;
    setSecret(req: SettingsSetSecretRequest): Promise<IpcResult<SettingsSetSecretResponse>>;
    clearSecret(req: SettingsClearSecretRequest): Promise<IpcResult<SettingsClearSecretResponse>>;
    validateBackend(): Promise<IpcResult<SettingsValidateBackendResponse>>;
    /** Read the saved instruction macros. */
    getMacros(): Promise<IpcResult<SettingsGetMacrosResponse>>;
    /** Persist the full ordered list of instruction macros. */
    setMacros(req: SettingsSetMacrosRequest): Promise<IpcResult<SettingsSetMacrosResponse>>;
    onChanged(handler: (payload: SettingsChangedPayload) => void): Unsubscribe;
  };

  checkpoint: {
    list(): Promise<IpcResult<CheckpointListResponse>>;
    restore(req: CheckpointRestoreRequest): Promise<IpcResult<CheckpointRestoreResponse>>;
    undo(): Promise<IpcResult<CheckpointUndoResponse>>;
    redo(): Promise<IpcResult<CheckpointRedoResponse>>;
    onChanged(handler: (payload: CheckpointChangedPayload) => void): Unsubscribe;
  };

  preview: {
    reload(req?: PreviewReloadRequest): Promise<IpcResult<void>>;
    capture(req?: PreviewCaptureRequest): Promise<IpcResult<PreviewCaptureResponse>>;
    requestImage(req: PreviewRequestImageRequest): Promise<IpcResult<PreviewRequestImageResponse>>;
    openExternal(req: PreviewOpenExternalRequest): Promise<IpcResult<void>>;
    onStatus(handler: (payload: PreviewStatusPayload) => void): Unsubscribe;
  };

  devServer: {
    /** Start the current project's dev server (idempotent if already running). */
    start(): Promise<IpcResult<void>>;
    /** Stop the dev server Easel started. */
    stop(): Promise<IpcResult<void>>;
    /** Read the current dev-server state + recent log tail. */
    get(): Promise<IpcResult<DevServerStatePayload>>;
    /** Subscribe to dev-server state / log updates. */
    onEvent(handler: (payload: DevServerStatePayload) => void): Unsubscribe;
  };
}

/* -------------------------------------------------------------------------- */
/*  Handler/invoker maps (used by main registration + preload bridge)         */
/* -------------------------------------------------------------------------- */

/**
 * Maps each invoke channel to its `{ request; response }` shape. The main
 * process uses this to type `ipcMain.handle` registrations and the preload
 * bridge uses it to type `ipcRenderer.invoke` calls. `void` request means the
 * call takes no payload.
 */
export interface IpcInvokeMap {
  [IpcChannels.projectOpen]: { request: void; response: IpcResult<ProjectOpenResponse> };
  [IpcChannels.projectGetCurrent]: { request: void; response: IpcResult<ProjectGetCurrentResponse> };
  [IpcChannels.projectClose]: { request: void; response: IpcResult<void> };

  [IpcChannels.editSubmit]: { request: EditSubmitRequest; response: IpcResult<EditSubmitResponse> };
  [IpcChannels.editCancel]: { request: EditCancelRequest; response: IpcResult<void> };
  [IpcChannels.editPolicyRespond]: { request: EditPolicyRespondRequest; response: IpcResult<void> };

  [IpcChannels.settingsGet]: { request: void; response: IpcResult<SettingsGetResponse> };
  [IpcChannels.settingsUpdate]: { request: SettingsUpdateRequest; response: IpcResult<SettingsUpdateResponse> };
  [IpcChannels.settingsSetSecret]: { request: SettingsSetSecretRequest; response: IpcResult<SettingsSetSecretResponse> };
  [IpcChannels.settingsClearSecret]: { request: SettingsClearSecretRequest; response: IpcResult<SettingsClearSecretResponse> };
  [IpcChannels.settingsValidateBackend]: { request: void; response: IpcResult<SettingsValidateBackendResponse> };
  [IpcChannels.settingsGetMacros]: { request: void; response: IpcResult<SettingsGetMacrosResponse> };
  [IpcChannels.settingsSetMacros]: { request: SettingsSetMacrosRequest; response: IpcResult<SettingsSetMacrosResponse> };

  [IpcChannels.checkpointList]: { request: void; response: IpcResult<CheckpointListResponse> };
  [IpcChannels.checkpointRestore]: { request: CheckpointRestoreRequest; response: IpcResult<CheckpointRestoreResponse> };
  [IpcChannels.checkpointUndo]: { request: void; response: IpcResult<CheckpointUndoResponse> };
  [IpcChannels.checkpointRedo]: { request: void; response: IpcResult<CheckpointRedoResponse> };

  [IpcChannels.previewReload]: { request: PreviewReloadRequest | void; response: IpcResult<void> };
  [IpcChannels.previewCapture]: { request: PreviewCaptureRequest | void; response: IpcResult<PreviewCaptureResponse> };
  [IpcChannels.previewRequestImage]: { request: PreviewRequestImageRequest; response: IpcResult<PreviewRequestImageResponse> };
  [IpcChannels.previewOpenExternal]: { request: PreviewOpenExternalRequest; response: IpcResult<void> };

  [IpcChannels.devServerStart]: { request: void; response: IpcResult<void> };
  [IpcChannels.devServerStop]: { request: void; response: IpcResult<void> };
  [IpcChannels.devServerGet]: { request: void; response: IpcResult<DevServerStatePayload> };
}

/**
 * Maps each push channel (main -> renderer) to its payload type. The preload
 * bridge uses this to type `ipcRenderer.on` listeners that back the `on*`
 * subscription methods in {@link EaselApi}.
 */
export interface IpcEventMap {
  [IpcChannels.projectChanged]: ProjectChangedPayload;
  [IpcChannels.editEvent]: EditEventPayload;
  [IpcChannels.settingsChanged]: SettingsChangedPayload;
  [IpcChannels.checkpointChanged]: CheckpointChangedPayload;
  [IpcChannels.previewStatus]: PreviewStatusPayload;
  [IpcChannels.devServerEvent]: DevServerStatePayload;
}

/* -------------------------------------------------------------------------- */
/*  Webview-preload <-> renderer bridge (postMessage, not Electron IPC)        */
/* -------------------------------------------------------------------------- */

/**
 * Messages the guest inspector (`src/preload/webview/inspector.ts`) posts to
 * the host renderer via the `<webview>` `ipc-message` / `postMessage` channel.
 * Distinct from main<->renderer IPC: this is host-renderer <-> guest-page.
 */
export type InspectorMessage =
  | {
      type: 'inspector-ready';
      /** Whether `data-easel-source` attributes were found on the page. */
      hasSourceAttributes: boolean;
    }
  | {
      type: 'element-hover';
      /** Bounding box of the hovered element (preview-viewport coords). */
      boundingBox: BoundingBox;
      tagName: string;
      /** Robust selector for the hovered element, so the host can drive `highlight`. */
      selector: string;
    }
  | {
      type: 'element-picked';
      /** Fully resolved target for the clicked element. */
      target: ElementTarget;
    }
  | {
      /** Reply to `query-region`: elements overlapping the box, best match first. */
      type: 'region-resolved';
      /** Echoes the {@link InspectorCommand} `query-region` `queryId`. */
      queryId: string;
      targets: ElementTarget[];
    }
  | {
      type: 'viewport-changed';
      /** New scroll offset / size so the overlay can stay aligned. */
      scrollX: number;
      scrollY: number;
      width: number;
      height: number;
    }
  | {
      /**
       * An UNCAUGHT runtime error (or unhandled promise rejection) thrown by the
       * previewed page. Surfaced in the Page Console with a one-click "Fix"
       * affordance that dispatches an AI edit at {@link sources}. Emitted by the
       * guest's `window` `error` / `unhandledrejection` listeners — distinct from
       * the host `console-message` path, which only carries an unstructured string.
       */
      type: 'page-error';
      /** The error's `message` (e.g. `features is not defined`). */
      message: string;
      /**
       * The sourcemapped stack trace as a single string, when the runtime
       * provided one (dev builds symbolicate to original source). Used verbatim
       * in the edit instruction so the agent can locate the throwing call.
       */
      stack?: string;
      /**
       * Project-relative source locations parsed from the top stack frames,
       * best-guess first. Drives the edit's {@link EditRequest.targets}. Empty
       * when no frame could be mapped to a project file (e.g. minified prod
       * bundle); the agent then falls back to grepping {@link message}.
       */
      sources: SourceLocation[];
    };

/** Commands the host renderer sends down into the guest inspector. */
export type InspectorCommand =
  | { type: 'set-mode'; mode: 'idle' | 'element-select' | 'freeform' }
  | { type: 'highlight'; selector: string | null }
  | { type: 'request-target'; selector: string }
  | {
      /** Freeform mode: resolve which element(s) a drawn region overlaps. */
      type: 'query-region';
      /** The annotation bounding box (preview-viewport coords). */
      box: BoundingBox;
      /** Correlates the eventual `region-resolved` reply. */
      queryId: string;
    };
