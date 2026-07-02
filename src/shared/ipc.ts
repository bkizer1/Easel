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
  ChatMessage,
  Checkpoint,
  EditRequest,
  ElementTarget,
  ImageRequest,
  ImageResult,
  ImportedSession,
  OffGridElement,
  InstructionMacro,
  ProjectConfig,
  ScratchInfo,
  SourceLocation,
  StyleEdit,
  TokenMatch,
} from './types';
import type { GridConfig } from './grid';
import type { ElementStateSnapshot, NetworkEntry, StateSnapshot, SerializedValue } from './xray';
import type { NewSiteBrief } from './siteBrief';
import type { FetchMockSpec, JsonValue, PuppeteerState } from './puppeteer';

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
  /** Open a folder dialog to choose where a new site is created. */
  projectChooseLocation: 'project.chooseLocation',
  /** Scaffold a brand-new site project from a creative brief. */
  projectCreateNew: 'project.createNew',
  /** Streamed scaffolding progress (writing / installing / git / done / error). */
  projectScaffoldEvent: 'project.scaffoldEvent',
  /** Pre-warm Easel's shared build toolchain (fire-and-forget; overlaps the intake). */
  projectPrewarmToolchain: 'project.prewarmToolchain',

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
  /** Fetch a checkpoint's before/after preview screenshots (Issue #7). */
  checkpointGetShots: 'checkpoint.getShots',
  /** Start a scratch experiment (Issue #11). */
  checkpointScratchStart: 'checkpoint.scratchStart',
  /** Keep the active scratch (land it on the main line) (Issue #11). */
  checkpointScratchKeep: 'checkpoint.scratchKeep',
  /** Discard the active scratch (restore pre-scratch tree) (Issue #11). */
  checkpointScratchDiscard: 'checkpoint.scratchDiscard',

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

  // State X-Ray cockpit (issue #13) -----------------------------------------
  /** Read the buffered network log + current capture state. */
  xrayGetNetworkLog: 'xray.getNetworkLog',
  /** Clear the buffered network log. */
  xrayClearNetworkLog: 'xray.clearNetworkLog',
  /** Enable/disable the CDP network tap on the guest webview. */
  xraySetNetworkCapture: 'xray.setNetworkCapture',
  /** Enable/disable CDP Fetch request interception ("Burp" mode) on the tap. */
  xraySetNetworkIntercept: 'xray.setNetworkIntercept',
  /** Resume a paused (intercepted) request unchanged, or with rewrite overrides. */
  xrayContinueRequest: 'xray.continueRequest',
  /** Fulfill (mock) a paused request with a synthetic response. */
  xrayFulfillRequest: 'xray.fulfillRequest',
  /** Block (fail) a paused request at the interceptor. */
  xrayFailRequest: 'xray.failRequest',
  /** Persist a serialized state snapshot keyed by checkpoint id (userData). */
  xraySaveSnapshot: 'xray.saveSnapshot',
  /** Read a persisted state snapshot for a checkpoint id (or null). */
  xrayGetSnapshot: 'xray.getSnapshot',
  /** List checkpoint ids that have a persisted state snapshot. */
  xrayListSnapshots: 'xray.listSnapshots',
  /** Emitted by main as network requests are observed (CDP). */
  networkEvent: 'network.event',
  /**
   * Emitted by main when the tap's capture/intercept state changes WITHOUT a
   * renderer request — e.g. the guest reloaded/navigated and the debugger
   * detached, or the tap re-attached. Lets the renderer keep its `networkCapturing`
   * flag honest instead of falsely showing "Capturing" after a silent detach.
   */
  networkStatus: 'network.status',

  // Live State Puppeteer (issue #17) ----------------------------------------
  /** Read the authoritative puppeteer state (enabled + active mocks/overrides). */
  puppeteerGetState: 'puppeteer.getState',
  /** Opt in/out of puppeteer control (policy-gated). Installs/removes the guest hook. */
  puppeteerSetEnabled: 'puppeteer.setEnabled',
  /** Remove a single active fetch mock by id. */
  puppeteerRemoveMock: 'puppeteer.removeMock',
  /** Clear all active mocks + recorded state overrides (stays enabled). */
  puppeteerClearAll: 'puppeteer.clearAll',
  /** Re-push the active enabled+mocks state into a freshly (re)loaded guest. */
  puppeteerResync: 'puppeteer.resync',
  /** Emitted by main when puppeteer state changes (toggle, mock added/removed). */
  puppeteerChanged: 'puppeteer.changed',

  // Tokens (Issue #8) -------------------------------------------------------
  /** Match a picked element's computed values against the project's design tokens. */
  tokensMatch: 'tokens.match',

  // Publish (Issue #10) -----------------------------------------------------
  /** Squash accepted checkpoints onto a fresh branch off HEAD and open a PR. */
  publishOpenPr: 'publish.openPr',

  // Review mode — propose-don't-write (Issue #19) ---------------------------
  /** Apply the approved subset of a staged review session → live project + checkpoint. */
  reviewApply: 'review.apply',
  /** Discard a staged review session (tear down the shadow worktree, apply nothing). */
  reviewDiscard: 'review.discard',

  // Session replay (Issue #18) ----------------------------------------------
  /** Export the current session as a portable `.easel` bundle (save dialog). */
  sessionExport: 'session.export',
  /** Import a `.easel` bundle for scrubbing/replay (open dialog). */
  sessionImport: 'session.import',
  /** Deterministically re-apply one imported checkpoint's delta to current code. */
  sessionReplayStep: 'session.replayStep',
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
  /**
   * Issue #19: when true, the edit is STAGED in a shadow git worktree for
   * on-page approval instead of being written to the live project. The renderer
   * sets this from `settings.featureFlags.reviewMode` at submit time. The
   * streamed events are identical; the renderer routes them to the review panel
   * (rather than the live timeline) because it knows the request is staged.
   */
  reviewMode?: boolean;
}
export interface EditSubmitResponse {
  /** Echo of the request id now streaming via {@link IpcChannels.editEvent}. */
  requestId: string;
  /** Issue #19: echoes whether main staged this edit (shadow worktree created). */
  reviewMode?: boolean;
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
  /** Issue #11: the active scratch experiment, when one is running. */
  scratch?: ScratchInfo;
}

// Issue #7: checkpoint visual diff -------------------------------------------

export interface CheckpointGetShotsRequest {
  checkpointId: string;
}
export interface CheckpointGetShotsResponse {
  /** PNG data URL of the preview before the edit, if captured. */
  before?: string;
  /** PNG data URL of the preview after HMR settled, if captured. */
  after?: string;
}

// Issue #11: scratch experiments ---------------------------------------------

export interface CheckpointScratchStartRequest {
  /** Optional user-supplied experiment name. */
  name?: string;
}
export interface CheckpointScratchResponse {
  scratch: ScratchInfo;
}

// Issue #8: token matching ---------------------------------------------------

export interface TokensMatchRequest {
  /** Computed `{property: value}` pairs from the picked element. */
  values: Record<string, string>;
}
export interface TokensMatchResponse {
  /** One entry per input value; `token` is null when off-system. */
  matches: TokenMatch[];
}

// Issue #10: branch & open PR ------------------------------------------------

export interface PublishOpenPrRequest {
  /** Override the generated branch name. */
  branchName?: string;
  /** Override the generated PR title. */
  title?: string;
}
export interface PublishOpenPrResponse {
  /** The branch created off HEAD. */
  branch: string;
  /** The opened PR URL, when `gh` returned one. */
  prUrl?: string;
}

// review.* (Issue #19: propose-don't-write) ----------------------------------

export interface ReviewApplyRequest {
  /** The staged session's request id (echoes {@link EditRequest.id}). */
  requestId: string;
  /**
   * Project-relative paths the user approved. Only these are copied from the
   * shadow worktree into the live project; everything else is dropped. An empty
   * list applies nothing (equivalent to discard, but still tears the session down).
   */
  approvedPaths: string[];
}
export interface ReviewApplyResponse {
  /** The checkpoint created from the applied changes, or null if nothing applied. */
  checkpoint: Checkpoint | null;
  /** The project-relative files actually written to the live project. */
  appliedFiles: string[];
}

export interface ReviewDiscardRequest {
  /** The staged session's request id. */
  requestId: string;
}

// session.* (Issue #18: session replay) -------------------------------------

export interface SessionExportRequest {
  /**
   * The renderer's chat transcript snapshot. Chat lives in the renderer store,
   * so the renderer hands it to main to fold into the bundle manifest.
   */
  chat: ChatMessage[];
  /** Id of the checkpoint the working tree currently matches, if any. */
  currentCheckpointId?: string;
}
export interface SessionExportResponse {
  /** Absolute path the bundle was written to, or null if the dialog was cancelled. */
  savedPath: string | null;
}

export interface SessionImportResponse {
  /** The imported session (held live in main for replay), or null if cancelled. */
  session: ImportedSession | null;
}

export interface SessionReplayStepRequest {
  /** The imported checkpoint id whose recorded delta should be re-applied. */
  checkpointId: string;
}
export interface SessionReplayStepResponse {
  /** The new live checkpoint created by re-applying the step. */
  checkpoint: Checkpoint;
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
  /**
   * Optional id of the specific guest WebContents to capture (read in the
   * renderer via `<webview>.getWebContentsId()`). When omitted the main process
   * captures the first guest — the single-preview default. Required to
   * disambiguate frames in the Responsive Matrix (issue #14), where several
   * `<webview>`s are live at once and `guests[0]` is ambiguous.
   */
  webContentsId?: number;
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

// xray.* (State X-Ray cockpit) ----------------------------------------------

export interface XrayGetNetworkLogResponse {
  entries: NetworkEntry[];
  /** Whether the CDP network tap is currently attached + capturing. */
  capturing: boolean;
  /** Whether request interception ("Burp" mode) is currently on. */
  intercepting: boolean;
}

export interface XraySetNetworkCaptureRequest {
  enabled: boolean;
}
export interface XraySetNetworkCaptureResponse {
  /** Effective state after the request (false if attach failed). */
  capturing: boolean;
  /** Whether request interception (Fetch domain) is currently on. */
  intercepting?: boolean;
  /** Reason capture could not be enabled (e.g. no guest webview). */
  detail?: string;
}

// xray.* network interception ("Burp" mode) ---------------------------------

export interface XraySetNetworkInterceptRequest {
  enabled: boolean;
}
export interface XraySetNetworkInterceptResponse {
  /** Effective interception state (false if it could not be enabled). */
  intercepting: boolean;
  /** Whether capture is on (interception implies + requires capture). */
  capturing: boolean;
  /** Reason interception could not be toggled (e.g. no guest webview). */
  detail?: string;
}

/** Optional rewrite overrides applied when continuing a paused request. */
export interface NetworkRequestRewrite {
  url?: string;
  method?: string;
  /** Header overrides as a plain `{name: value}` map (merged into the request). */
  headers?: Record<string, string>;
  /** New request body (raw text; sent as-is). */
  postData?: string;
}

export interface XrayContinueRequestRequest {
  /** The {@link NetworkEntry.interceptId} of the paused request. */
  interceptId: string;
  /** Optional overrides; omit for a plain pass-through. */
  rewrite?: NetworkRequestRewrite;
}

/** A synthetic response used to fulfill (mock) a paused request. */
export interface NetworkResponseMock {
  /** HTTP status code, e.g. 200, 404, 503. */
  responseCode: number;
  /** Response header overrides as a plain `{name: value}` map. */
  headers?: Record<string, string>;
  /** Response body as plain text (encoded to base64 by main before sending). */
  body?: string;
}

export interface XrayFulfillRequestRequest {
  interceptId: string;
  mock: NetworkResponseMock;
}

export interface XrayFailRequestRequest {
  interceptId: string;
  /**
   * CDP `Network.ErrorReason`, e.g. `BlockedByClient`, `Failed`, `Aborted`.
   * Defaults to `BlockedByClient` when omitted.
   */
  reason?: string;
}

/** Generic result of a continue/fulfill/fail interception action. */
export interface XrayInterceptActionResponse {
  /** Whether the action was applied (false if the request was no longer paused). */
  applied: boolean;
  detail?: string;
}

export interface XraySaveSnapshotRequest {
  snapshot: StateSnapshot;
}

export interface XrayGetSnapshotRequest {
  checkpointId: string;
}
export interface XrayGetSnapshotResponse {
  snapshot: StateSnapshot | null;
}

export interface XrayListSnapshotsResponse {
  /** Checkpoint ids that have a persisted snapshot. */
  checkpointIds: string[];
}

/** Pushed on {@link IpcChannels.networkEvent} as requests are observed. */
export interface NetworkEventPayload {
  entry: NetworkEntry;
}

// puppeteer.* (Live State Puppeteer, issue #17) -----------------------------

export interface PuppeteerGetStateResponse {
  state: PuppeteerState;
}

export interface PuppeteerSetEnabledRequest {
  enabled: boolean;
}
export interface PuppeteerSetEnabledResponse {
  /** Effective state after the request (enabled stays false if policy blocked). */
  state: PuppeteerState;
  /** Reason the requested enable could not be honoured (e.g. policy, no preview). */
  detail?: string;
}

export interface PuppeteerRemoveMockRequest {
  id: string;
}

/** Pushed on {@link IpcChannels.puppeteerChanged} when puppeteer state changes. */
export interface PuppeteerChangedPayload {
  state: PuppeteerState;
}

/**
 * Pushed on {@link IpcChannels.networkStatus} when the tap's capture/intercept
 * state changes without a renderer request (e.g. a guest reload silently
 * detached the debugger, or the tap re-attached after navigation). Lets the
 * renderer reconcile its `networkCapturing` flag with reality.
 */
export interface NetworkStatusPayload {
  capturing: boolean;
  intercepting: boolean;
  /** Human note for the change (e.g. "Preview navigated — capture paused."). */
  detail?: string;
}

/* -------------------------------------------------------------------------- */
/*  Event payloads (push channels, main -> renderer)                          */
/* -------------------------------------------------------------------------- */

export interface ProjectChangedPayload {
  project: ProjectConfig | null;
}

/** Result of the choose-location folder dialog. */
export interface ProjectChooseLocationResponse {
  /** Absolute parent directory the user picked, or null if cancelled. */
  parentDir: string | null;
}

/** Request to scaffold a brand-new site project from a creative brief. */
export interface ProjectCreateNewRequest {
  brief: NewSiteBrief;
  /** Parent directory to create the project under. */
  parentDir: string;
  /** Desired project / folder name. */
  name: string;
}
export interface ProjectCreateNewResponse {
  project: ProjectConfig;
}

/** Streamed scaffolding progress, pushed on {@link IpcChannels.projectScaffoldEvent}. */
export interface ScaffoldEventPayload {
  phase: 'writing' | 'installing' | 'git' | 'done' | 'error';
  /** Recent `npm install` output line, when phase is 'installing'. */
  log?: string;
  /** Human message for the current phase (or the error text). */
  message?: string;
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
    /** Open a folder dialog to pick where a new site is created. */
    chooseLocation(): Promise<IpcResult<ProjectChooseLocationResponse>>;
    /** Scaffold + open a brand-new site from a creative brief. */
    createNew(req: ProjectCreateNewRequest): Promise<IpcResult<ProjectCreateNewResponse>>;
    /** Pre-warm Easel's shared toolchain so the one-time install overlaps the intake. */
    prewarmToolchain(): Promise<IpcResult<void>>;
    /** Subscribe to scaffolding progress. */
    onScaffold(handler: (payload: ScaffoldEventPayload) => void): Unsubscribe;
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
    /** Issue #7: fetch a checkpoint's before/after preview screenshots. */
    getShots(req: CheckpointGetShotsRequest): Promise<IpcResult<CheckpointGetShotsResponse>>;
    /** Issue #11: start a scratch experiment (routes new checkpoints to a scratch ref). */
    scratchStart(req: CheckpointScratchStartRequest): Promise<IpcResult<CheckpointScratchResponse>>;
    /** Issue #11: keep the active scratch (land its checkpoints on the main line). */
    scratchKeep(): Promise<IpcResult<CheckpointScratchResponse>>;
    /** Issue #11: discard the active scratch (restore the pre-scratch tree). */
    scratchDiscard(): Promise<IpcResult<CheckpointScratchResponse>>;
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

  /** State X-Ray cockpit (issue #13). */
  xray: {
    /** Read the buffered network log + capture state. */
    getNetworkLog(): Promise<IpcResult<XrayGetNetworkLogResponse>>;
    /** Clear the buffered network log. */
    clearNetworkLog(): Promise<IpcResult<void>>;
    /** Enable/disable the CDP network tap on the guest webview. */
    setNetworkCapture(
      req: XraySetNetworkCaptureRequest,
    ): Promise<IpcResult<XraySetNetworkCaptureResponse>>;
    /** Enable/disable CDP Fetch request interception ("Burp" mode). */
    setNetworkIntercept(
      req: XraySetNetworkInterceptRequest,
    ): Promise<IpcResult<XraySetNetworkInterceptResponse>>;
    /** Resume a paused request (optionally with rewrite overrides). */
    continueRequest(
      req: XrayContinueRequestRequest,
    ): Promise<IpcResult<XrayInterceptActionResponse>>;
    /** Fulfill (mock) a paused request with a synthetic response. */
    fulfillRequest(
      req: XrayFulfillRequestRequest,
    ): Promise<IpcResult<XrayInterceptActionResponse>>;
    /** Block (fail) a paused request at the interceptor. */
    failRequest(
      req: XrayFailRequestRequest,
    ): Promise<IpcResult<XrayInterceptActionResponse>>;
    /** Subscribe to out-of-band capture/intercept state changes (reload sync). */
    onNetworkStatus(handler: (payload: NetworkStatusPayload) => void): Unsubscribe;
    /** Persist a serialized state snapshot keyed by checkpoint id. */
    saveSnapshot(req: XraySaveSnapshotRequest): Promise<IpcResult<void>>;
    /** Read a persisted state snapshot for a checkpoint id. */
    getSnapshot(req: XrayGetSnapshotRequest): Promise<IpcResult<XrayGetSnapshotResponse>>;
    /** List checkpoint ids that have a persisted snapshot. */
    listSnapshots(): Promise<IpcResult<XrayListSnapshotsResponse>>;
    /** Subscribe to streamed network observations from the CDP tap. */
    onNetworkEvent(handler: (payload: NetworkEventPayload) => void): Unsubscribe;
  };

  /** Live State Puppeteer (issue #17). Main owns the authoritative state. */
  puppeteer: {
    /** Read the current puppeteer state (enabled + active mocks/overrides). */
    getState(): Promise<IpcResult<PuppeteerGetStateResponse>>;
    /** Opt in/out of puppeteer control. Policy-gated; installs/removes the guest hook. */
    setEnabled(req: PuppeteerSetEnabledRequest): Promise<IpcResult<PuppeteerSetEnabledResponse>>;
    /** Remove a single active fetch mock by id. */
    removeMock(req: PuppeteerRemoveMockRequest): Promise<IpcResult<PuppeteerGetStateResponse>>;
    /** Clear all active mocks + recorded state overrides. */
    clearAll(): Promise<IpcResult<PuppeteerGetStateResponse>>;
    /** Re-push the active enabled+mocks state into a freshly (re)loaded guest. */
    resync(): Promise<IpcResult<void>>;
    /** Subscribe to authoritative puppeteer state changes. */
    onChanged(handler: (payload: PuppeteerChangedPayload) => void): Unsubscribe;
  };

  // ── Issue #8: Live token inspector ──────────────────────────────────────────
  tokens: {
    /** Match computed values against the open project's design tokens. */
    match(req: TokensMatchRequest): Promise<IpcResult<TokensMatchResponse>>;
  };

  // ── Issue #10: Branch & open PR ─────────────────────────────────────────────
  publish: {
    /** Squash accepted checkpoints onto a fresh branch off HEAD and open a PR. */
    openPr(req: PublishOpenPrRequest): Promise<IpcResult<PublishOpenPrResponse>>;
  };

  // ── Issue #19: Review mode (propose-don't-write) ────────────────────────────
  review: {
    /** Apply the approved subset of a staged session to the live project + checkpoint. */
    apply(req: ReviewApplyRequest): Promise<IpcResult<ReviewApplyResponse>>;
    /** Discard a staged session without applying (tear down the shadow worktree). */
    discard(req: ReviewDiscardRequest): Promise<IpcResult<void>>;
  };

  // ── Issue #18: Session replay (.easel bundles) ──────────────────────────────
  session: {
    /** Save the current session as a `.easel` bundle (shows a save dialog). */
    export(req: SessionExportRequest): Promise<IpcResult<SessionExportResponse>>;
    /** Open and import a `.easel` bundle for scrubbing/replay (open dialog). */
    import(): Promise<IpcResult<SessionImportResponse>>;
    /**
     * Deterministically re-apply one imported checkpoint's recorded delta to the
     * current working tree, creating a new live checkpoint. Fails with
     * `code: 'conflict'` when the patch does not apply cleanly.
     */
    replayStep(req: SessionReplayStepRequest): Promise<IpcResult<SessionReplayStepResponse>>;
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
  [IpcChannels.projectChooseLocation]: { request: void; response: IpcResult<ProjectChooseLocationResponse> };
  [IpcChannels.projectCreateNew]: { request: ProjectCreateNewRequest; response: IpcResult<ProjectCreateNewResponse> };
  [IpcChannels.projectPrewarmToolchain]: { request: void; response: IpcResult<void> };

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
  [IpcChannels.checkpointGetShots]: { request: CheckpointGetShotsRequest; response: IpcResult<CheckpointGetShotsResponse> };
  [IpcChannels.checkpointScratchStart]: { request: CheckpointScratchStartRequest; response: IpcResult<CheckpointScratchResponse> };
  [IpcChannels.checkpointScratchKeep]: { request: void; response: IpcResult<CheckpointScratchResponse> };
  [IpcChannels.checkpointScratchDiscard]: { request: void; response: IpcResult<CheckpointScratchResponse> };

  [IpcChannels.previewReload]: { request: PreviewReloadRequest | void; response: IpcResult<void> };
  [IpcChannels.previewCapture]: { request: PreviewCaptureRequest | void; response: IpcResult<PreviewCaptureResponse> };
  [IpcChannels.previewRequestImage]: { request: PreviewRequestImageRequest; response: IpcResult<PreviewRequestImageResponse> };
  [IpcChannels.previewOpenExternal]: { request: PreviewOpenExternalRequest; response: IpcResult<void> };

  [IpcChannels.devServerStart]: { request: void; response: IpcResult<void> };
  [IpcChannels.devServerStop]: { request: void; response: IpcResult<void> };
  [IpcChannels.devServerGet]: { request: void; response: IpcResult<DevServerStatePayload> };

  [IpcChannels.xrayGetNetworkLog]: { request: void; response: IpcResult<XrayGetNetworkLogResponse> };
  [IpcChannels.xrayClearNetworkLog]: { request: void; response: IpcResult<void> };
  [IpcChannels.xraySetNetworkCapture]: {
    request: XraySetNetworkCaptureRequest;
    response: IpcResult<XraySetNetworkCaptureResponse>;
  };
  [IpcChannels.xraySetNetworkIntercept]: {
    request: XraySetNetworkInterceptRequest;
    response: IpcResult<XraySetNetworkInterceptResponse>;
  };
  [IpcChannels.xrayContinueRequest]: {
    request: XrayContinueRequestRequest;
    response: IpcResult<XrayInterceptActionResponse>;
  };
  [IpcChannels.xrayFulfillRequest]: {
    request: XrayFulfillRequestRequest;
    response: IpcResult<XrayInterceptActionResponse>;
  };
  [IpcChannels.xrayFailRequest]: {
    request: XrayFailRequestRequest;
    response: IpcResult<XrayInterceptActionResponse>;
  };
  [IpcChannels.xraySaveSnapshot]: { request: XraySaveSnapshotRequest; response: IpcResult<void> };
  [IpcChannels.xrayGetSnapshot]: {
    request: XrayGetSnapshotRequest;
    response: IpcResult<XrayGetSnapshotResponse>;
  };
  [IpcChannels.xrayListSnapshots]: { request: void; response: IpcResult<XrayListSnapshotsResponse> };

  [IpcChannels.puppeteerGetState]: { request: void; response: IpcResult<PuppeteerGetStateResponse> };
  [IpcChannels.puppeteerSetEnabled]: {
    request: PuppeteerSetEnabledRequest;
    response: IpcResult<PuppeteerSetEnabledResponse>;
  };
  [IpcChannels.puppeteerRemoveMock]: {
    request: PuppeteerRemoveMockRequest;
    response: IpcResult<PuppeteerGetStateResponse>;
  };
  [IpcChannels.puppeteerClearAll]: { request: void; response: IpcResult<PuppeteerGetStateResponse> };
  [IpcChannels.puppeteerResync]: { request: void; response: IpcResult<void> };

  [IpcChannels.tokensMatch]: { request: TokensMatchRequest; response: IpcResult<TokensMatchResponse> };

  [IpcChannels.publishOpenPr]: { request: PublishOpenPrRequest; response: IpcResult<PublishOpenPrResponse> };

  [IpcChannels.reviewApply]: { request: ReviewApplyRequest; response: IpcResult<ReviewApplyResponse> };
  [IpcChannels.reviewDiscard]: { request: ReviewDiscardRequest; response: IpcResult<void> };

  [IpcChannels.sessionExport]: { request: SessionExportRequest; response: IpcResult<SessionExportResponse> };
  [IpcChannels.sessionImport]: { request: void; response: IpcResult<SessionImportResponse> };
  [IpcChannels.sessionReplayStep]: {
    request: SessionReplayStepRequest;
    response: IpcResult<SessionReplayStepResponse>;
  };
}

/**
 * Maps each push channel (main -> renderer) to its payload type. The preload
 * bridge uses this to type `ipcRenderer.on` listeners that back the `on*`
 * subscription methods in {@link EaselApi}.
 */
export interface IpcEventMap {
  [IpcChannels.projectChanged]: ProjectChangedPayload;
  [IpcChannels.projectScaffoldEvent]: ScaffoldEventPayload;
  [IpcChannels.editEvent]: EditEventPayload;
  [IpcChannels.settingsChanged]: SettingsChangedPayload;
  [IpcChannels.checkpointChanged]: CheckpointChangedPayload;
  [IpcChannels.previewStatus]: PreviewStatusPayload;
  [IpcChannels.devServerEvent]: DevServerStatePayload;
  [IpcChannels.networkEvent]: NetworkEventPayload;
  [IpcChannels.puppeteerChanged]: PuppeteerChangedPayload;
  [IpcChannels.networkStatus]: NetworkStatusPayload;
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
      /**
       * Reply to `scan-off-grid`: elements whose edges miss the active grid by
       * more than the requested threshold, worst offender first. Display data is
       * computed entirely guest-side (no agent round-trip).
       */
      type: 'off-grid-result';
      /** Echoes the {@link InspectorCommand} `scan-off-grid` `scanId`. */
      scanId: string;
      offenders: OffGridElement[];
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
    }
  | {
      /**
       * The live runtime state of a picked element (State X-Ray, issue #13):
       * framework props/hooks/state + highlighted computed styles, each row
       * source-anchored. Emitted automatically when an element is picked and on
       * demand for a `request-element-state` command. Distinct from
       * `element-picked` (which carries only the static {@link ElementTarget}).
       */
      type: 'element-state';
      snapshot: ElementStateSnapshot;
    }
  | {
      /**
       * Time-travel (State X-Ray): the guest's reply to a `snapshot-state`
       * command. Carries a bounded {@link SerializedValue} tree of detectable app
       * state — captured UNCONDITIONALLY (no element need be picked) so every
       * checkpoint created during normal editing gets a usable snapshot. The
       * MAIN process drives this before {@link createCheckpoint} and persists the
       * reply keyed by the new checkpoint id. `requestId` correlates the reply to
       * the originating command. Distinct from `element-state`, which is the live
       * state of one specifically-picked element.
       */
      type: 'state-snapshot';
      /** Echoes the {@link InspectorCommand} `snapshot-state` `requestId`. */
      requestId: string;
      /** The bounded, cycle-safe serialized state tree (never live objects). */
      data: SerializedValue;
    }
  // ── Issue #6: Live DOM/CSS tweak ────────────────────────────────────────────
  | {
      /** Accumulated inline-style delta for the tweaked element. */
      type: 'style-delta';
      /** Selector of the element the delta applies to. */
      selector: string;
      /** All `{property, oldValue, newValue}` changes so far (empty after discard). */
      deltas: StyleEdit[];
      /** The element's source location, when `data-easel-source` is present. */
      dataEaselSource?: SourceLocation;
    };

/** Commands the host renderer sends down into the guest inspector. */
export type InspectorCommand =
  | { type: 'set-mode'; mode: 'idle' | 'element-select' | 'freeform' }
  | { type: 'highlight'; selector: string | null }
  | {
      /**
       * Review mode (Issue #19): highlight the live on-page element(s) a staged
       * change affects, resolved by REVERSE `data-easel-source` lookup. The guest
       * scans stamped elements (`[data-easel-source]`), matches each
       * {@link SourceLocation} by `filePath` and nearest `line`, and outlines the
       * best match(es) — reusing the same overlay as `highlight`. Pass `sources:
       * null` (or an empty array) to clear. Distinct from `highlight`, which keys
       * off a CSS selector; this lets a streamed diff light up its target with no
       * selector, since the diff only knows file:line.
       */
      type: 'highlight-source';
      sources: SourceLocation[] | null;
    }
  | { type: 'request-target'; selector: string }
  | {
      /** Freeform mode: resolve which element(s) a drawn region overlaps. */
      type: 'query-region';
      /** The annotation bounding box (preview-viewport coords). */
      box: BoundingBox;
      /** Correlates the eventual `region-resolved` reply. */
      queryId: string;
    }
  | {
      /**
       * Toggle the alignment-grid overlay drawn guest-side. Pass a
       * {@link GridConfig} to show/update it, or `null` to remove it. Pure
       * display — no agent round-trip (issue #5 guardrail).
       */
      type: 'set-grid';
      grid: GridConfig | null;
    }
  | {
      /**
       * Run the off-grid scan: walk visible elements, flag any whose edges miss
       * `grid` by more than `threshold` px, and reply with an `off-grid-result`.
       */
      type: 'scan-off-grid';
      grid: GridConfig;
      /** Maximum tolerated edge-to-grid distance, in px. */
      threshold: number;
      /** Correlates the eventual `off-grid-result` reply. */
      scanId: string;
    }
  | {
      /**
       * State X-Ray: (re)read the live state of the element matching `selector`
       * and reply with an `element-state` message. The guest compares the new
       * value set against {@link previousKeys} to compute render-cause.
       */
      type: 'request-element-state';
      selector: string;
      /** Entry labels from the host's last snapshot, for render-cause diffing. */
      previousKeys?: string[];
    }
  | {
      /**
       * Time-travel (State X-Ray): capture a bounded snapshot of detectable app
       * state UNCONDITIONALLY (no element need be picked) and reply with a
       * `state-snapshot` message echoing `requestId`. Driven by MAIN before a
       * checkpoint is created; the reply is persisted keyed by the new checkpoint
       * id so any two checkpoints can be deep-diffed in the History/cockpit view.
       */
      type: 'snapshot-state';
      /** Correlates the eventual `state-snapshot` reply. */
      requestId: string;
    }
  | {
      /**
       * State X-Ray "scrub": write a value live into the element's framework
       * state at `path` for instant exploration (ephemeral until baked into a
       * source edit). Best-effort; no-op if the path is not writable.
       */
      type: 'set-value';
      selector: string;
      /** Machine path from a {@link import('./xray').StateEntry}, e.g. `['props','count']`. */
      path: string[];
      value: string | number | boolean | null;
    }
  // ── Issue #6: Live DOM/CSS tweak ────────────────────────────────────────────
  | {
      /** Apply an ephemeral inline-style tweak to the element for instant feedback. */
      type: 'set-style';
      selector: string;
      /** CSS property in kebab-case. */
      property: string;
      /** New value to apply inline. */
      value: string;
    }
  | {
      /** Drop all inline tweaks on the element, restoring its source styling. */
      type: 'discard-style';
      selector: string;
    }
  // ── Issue #17: Live State Puppeteer (main → guest; policy + opt-in gated) ────
  | {
      /**
       * Install (or uninstall) the guest fetch/XHR interception monkeypatch. On
       * `enabled: false` the guest restores the native `fetch`/`XMLHttpRequest`
       * and drops all active mocks. Sent by main when the user toggles puppeteer
       * and re-sent on guest reload to keep interception sticky.
       */
      type: 'puppeteer-enable';
      enabled: boolean;
    }
  | {
      /**
       * Replace the guest's full active mock set (first match wins). Main owns the
       * authoritative list and pushes the whole list on every change + on resync,
       * so the guest never drifts. No-op unless puppeteer is enabled.
       */
      type: 'puppeteer-set-mocks';
      mocks: FetchMockSpec[];
    }
  | {
      /**
       * Write a structured JSON value into the framework state of the element
       * matching `selector` at `path` (reuses the State X-Ray fiber tap). One-shot
       * and ephemeral — a reload restores the app's real state. No-op unless
       * puppeteer is enabled.
       */
      type: 'puppeteer-set-state';
      selector: string;
      /** Machine path from a {@link import('./xray').StateEntry}, e.g. `['state','items']`. */
      path: string[];
      value: JsonValue;
    };
