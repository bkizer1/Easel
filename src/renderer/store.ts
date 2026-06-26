/**
 * Easel Renderer — Zustand application store.
 *
 * Single source of UI truth for the renderer. All cross-component state lives
 * here; all actions delegate side-effects to `window.easel` (the typed IPC
 * bridge installed by the host preload via contextBridge).
 *
 * State shape and action signatures conform to the RENDERER SEAMS spec so that
 * the components agent can integrate without modification. TypeScript strict +
 * noUnusedLocals/Params enforced; no placeholder throws.
 *
 * Process isolation contract: this module NEVER imports Node/Electron APIs.
 * All privileged operations go through `easel.*`.
 */

import { create } from 'zustand';
import { easel } from './lib/api';
import { bboxUnion } from './lib/geometry';
import { captureRegion } from './lib/screenshot';
import type {
  AgentEvent,
  Annotation,
  AppSettings,
  Checkpoint,
  ChatMessage,
  EditRequest,
  ElementTarget,
  FileDiff,
  OffGridElement,
  InstructionMacro,
  ProjectConfig,
  ScratchInfo,
  SourceLocation,
  StyleEdit,
  TokenMatch,
} from '@shared/types';
import type { DevServerStatePayload, InspectorCommand, PreviewStatusPayload } from '@shared/ipc';
import { buildStyleEditInstruction } from './lib/styleEdit';
import { buildTokenizeInstruction } from './lib/tokenize';
import { buildDropImageEditRequest } from './lib/dropImage';
import { DEFAULT_GRID, type GridConfig } from '@shared/grid';
import { resolveMacroInstruction } from '@shared/macros';
import {
  diffSerialized,
  formatSerializedValue,
  type ElementStateSnapshot,
  type NetworkEntry,
  type SerializedValue,
  type StateDiffEntry,
  type StateEntry,
} from '@shared/xray';

/* -------------------------------------------------------------------------- */
/*  ID generation                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Generate a UUID-like id using the Web Crypto API (available in Electron's
 * renderer Chromium context). Falls back to a timestamp+random string for
 * environments that do not expose `crypto.randomUUID` (older Electron shims).
 */
function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: base-36 timestamp + random suffix.
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/**
 * Normalize a user-typed preview URL: trim whitespace and default to the
 * `http://` scheme when none is given (so `localhost:3000` → `http://localhost:3000`).
 * Returns '' for blank input.
 */
export function normalizePreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/**
 * Tracks the lifecycle of a one-click "Fix this" attempt on a page error:
 *  - `fixing`        : an edit is in flight against the error's source.
 *  - `resolved`      : the edit finished and no equivalent error re-fired.
 *  - `still-erroring`: an equivalent error re-fired after the edit completed.
 */
export type PageErrorFixState = 'fixing' | 'resolved' | 'still-erroring';

/**
 * Structured payload for an UNCAUGHT page error (from the guest inspector's
 * `page-error` message). Present only on `level: 'error'` logs that originated
 * as runtime exceptions / unhandled rejections — these get a "Fix" button.
 * Plain `console.error(...)` logs (from the host `console-message` path) carry
 * no `error` field and so render without the affordance.
 */
export interface PageErrorInfo {
  /** Sourcemapped stack trace, when the runtime provided one. */
  stack?: string;
  /** Project-relative source locations parsed from the top stack frames. */
  sources: SourceLocation[];
  /** Lifecycle of the most recent "Fix" attempt; undefined until clicked. */
  fixState?: PageErrorFixState;
  /** EditRequest.id of the in-flight fix, used to correlate resolution. */
  fixRequestId?: string;
}

/** A warning/error captured from the previewed page's own console. */
export interface PageLog {
  id: string;
  level: 'warn' | 'error';
  message: string;
  source?: string;
  ts: number;
  /**
   * Structured data for an uncaught runtime error. When present, ConsolePanel
   * renders a "Fix" button that dispatches an AI edit at {@link PageErrorInfo.sources}.
   */
  error?: PageErrorInfo;
}

/**
 * Window (ms) after a fix's terminal `done` during which a re-fired equivalent
 * error marks the fix `still-erroring`. Generous enough to cover an HMR reload.
 */
const FIX_RESOLUTION_WINDOW_MS = 5000;

/**
 * A pending guardrail approval: the agent tried to write a `requireConfirm`
 * path and the edit is paused until the user clicks allow-once / deny. Surfaced
 * by a `policy-confirm` warning event; resolved via `respondPolicyConfirm`.
 */
export interface PendingPolicyConfirm {
  requestId: string;
  /** Project-relative path awaiting approval. */
  path: string;
  /** Human-readable reason from the policy (which rule matched). */
  reason: string;
}

/** Responsive viewport presets for the preview surface. */
export interface ViewportPreset {
  label: string;
  width: number | null; // null = fill available space
}

export const VIEWPORT_PRESETS: ViewportPreset[] = [
  { label: 'Fill', width: null },
  { label: 'Desktop', width: 1280 },
  { label: 'Tablet', width: 834 },
  { label: 'Mobile', width: 390 },
];

/* -------------------------------------------------------------------------- */
/*  State shape                                                               */
/* -------------------------------------------------------------------------- */

export interface EaselState {
  /** Currently open project configuration, or null. */
  project: ProjectConfig | null;
  /** Current application settings (secrets as ApiKeyRef refs only, never plaintext). */
  settings: AppSettings | null;
  /** Latest dev-server reachability status pushed by main. */
  previewStatus: PreviewStatusPayload | null;
  /** Latest dev-server lifecycle state (auto-start); null until the first event. */
  devServer: DevServerStatePayload | null;
  /** URL currently loaded in the preview <webview> (browser-style address bar). */
  previewUrl: string | null;
  /** Bumped to force the preview <webview> to reload (e.g. after a revert). */
  previewReloadNonce: number;
  /** Bumped to toggle the preview <webview> devtools. */
  devToolsNonce: number;
  /** Constrained preview width (px) for responsive testing; null = fill. */
  viewportWidth: number | null;
  /** Warnings/errors captured from the previewed page's console. */
  pageLogs: PageLog[];
  /** Whether the checkpoint History panel is open. */
  historyOpen: boolean;
  /** Current annotation interaction mode for the overlay. */
  mode: 'idle' | 'element-select' | 'freeform';
  /** Freeform annotations accumulated in the current draft batch. */
  annotations: Annotation[];
  /** Element targets selected in the current draft batch. */
  targets: ElementTarget[];
  /** CSS selector of the currently hovered element; null when not hovering. */
  hoveredSelector: string | null;
  /** Ordered chat transcript rendered in ChatPanel. */
  chat: ChatMessage[];
  /** EditRequest.id of the in-flight edit, or null when idle. */
  activeRequestId: string | null;
  /** True while an edit is streaming; gates submit and drives spinner. */
  streaming: boolean;
  /** Live FileDiffs accumulated during the current (or most recent) edit. */
  liveDiffs: FileDiff[];
  /** Ordered checkpoint timeline for the open project, newest first. */
  checkpoints: Checkpoint[];
  /** Id of the checkpoint the working tree currently matches. */
  currentCheckpointId?: string;
  /** Whether the Settings dialog is open. */
  settingsOpen: boolean;
  /** Most recent error message surfaced to the UI; null when no error. */
  lastError: string | null;
  /** True when the agent failed to authenticate — drives the auth banner. */
  needsAuth: boolean;
  /** Guardrail writes awaiting the user's allow-once / deny decision. */
  pendingPolicyConfirms: PendingPolicyConfirm[];

  /* ---- Alignment grid (issue #5) ---------------------------------------- */
  /** Active alignment-grid configuration (column + baseline). */
  gridConfig: GridConfig;
  /** Whether the alignment-grid overlay is shown on the preview. */
  gridVisible: boolean;
  /** True while an off-grid scan is in flight. */
  scanningOffGrid: boolean;
  /** Elements the last scan flagged as misaligned, worst offender first. */
  offGridElements: OffGridElement[];
  /** Bumped to ask PreviewPane to run an off-grid scan in the guest. */
  offGridScanNonce: number;

  /* ---- State X-Ray cockpit (issue #13) ---------------------------------- */
  /** Whether the State X-Ray cockpit panel is open. */
  xrayOpen: boolean;
  /** Active cockpit tab. */
  xrayTab: 'state' | 'network' | 'time-travel';
  /** Live state of the most recently picked element (State tap), or null. */
  currentElementState: ElementStateSnapshot | null;
  /** Observed network requests (newest last), streamed from the CDP tap. */
  networkEntries: NetworkEntry[];
  /** Whether the CDP network tap is attached + capturing. */
  networkCapturing: boolean;
  /** A one-shot InspectorCommand for the guest, drained by PreviewPane. */
  pendingInspectorCommand: InspectorCommand | null;
  /** Bumped whenever {@link pendingInspectorCommand} is set, to trigger send. */
  inspectorCommandNonce: number;

  // ── Issue #6: Live DOM/CSS tweak ──────────────────────────────────────────
  /** The accumulated ephemeral style delta for the element being tweaked. */
  styleTweak: { selector: string; deltas: StyleEdit[]; dataEaselSource?: SourceLocation } | null;

  // ── Issue #8: Live token inspector ────────────────────────────────────────
  /** Token matches for the picked element's computed values, or null. */
  tokenMatches: TokenMatch[] | null;
  /** True while token matches are being resolved by main. */
  tokenLoading: boolean;

  // ── Issue #11: Scratch branches ───────────────────────────────────────────
  /** The active scratch experiment, or null when on the main checkpoint line. */
  scratch: ScratchInfo | null;

  // ── Issue #10: Branch & open PR ───────────────────────────────────────────
  /** True while a branch+PR is being created. */
  publishing: boolean;
  /** URL of the most recently opened PR, or null. */
  lastPrUrl: string | null;
}

/* -------------------------------------------------------------------------- */
/*  Actions shape                                                             */
/* -------------------------------------------------------------------------- */

export interface EaselActions {
  /**
   * Bootstrap: subscribe to all push channels and load initial state (current
   * project, settings, checkpoints). Call once from App.tsx's useEffect.
   * Returns a cleanup function that unsubscribes all listeners.
   */
  init(): () => void;

  /** Show OS open-folder dialog and open the selected project. */
  openProject(): Promise<void>;
  /** Close the current project and reset all project-scoped state. */
  closeProject(): Promise<void>;

  /** Set the annotation interaction mode for the overlay. */
  setMode(mode: 'idle' | 'element-select' | 'freeform'): void;

  /** Point the embedded preview at a URL (browser-style address bar). */
  setPreviewUrl(url: string): void;

  /** Start the current project's dev server (runs its detected command). */
  startDevServer(): Promise<void>;
  /** Stop the dev server Easel started. */
  stopDevServer(): Promise<void>;

  /** Force the preview <webview> to reload (used after reverts). */
  reloadPreview(): void;
  /** Toggle the preview <webview> devtools. */
  toggleDevTools(): void;
  /** Constrain the preview width for responsive testing (null = fill). */
  setViewportWidth(width: number | null): void;
  /** Append a captured page console warning/error. */
  addPageLog(log: Omit<PageLog, 'id' | 'ts'>): void;
  /**
   * Record an uncaught page error (from the guest's `page-error` message) as a
   * fixable error-level {@link PageLog}. If an equivalent error is currently
   * being fixed, this is treated as a re-fire and marks that fix
   * `still-erroring` instead of stacking a duplicate entry.
   */
  addPageError(info: { message: string; source?: string } & PageErrorInfo): void;
  /**
   * Dispatch a one-click "Fix this" AI edit for a captured page error: assemble
   * an instruction from the error message + stack, target the error's source
   * files, and submit via {@link submitEdit}. Marks the log `fixing`; resolution
   * is tracked in {@link applyAgentEvent} / {@link addPageError}.
   */
  fixPageError(logId: string): Promise<void>;
  /** Clear captured page logs. */
  clearPageLogs(): void;
  /** Open or close the checkpoint History panel. */
  setHistoryOpen(open: boolean): void;

  /** Append an annotation to the current draft. */
  addAnnotation(a: Annotation): void;
  /** Remove a single annotation by id. */
  removeAnnotation(id: string): void;
  /** Patch an existing annotation in place (move / resize). */
  updateAnnotation(id: string, patch: Partial<Annotation>): void;
  /** Clear all annotations in the current draft. */
  clearAnnotations(): void;

  /** Append an element target to the current draft (de-duplicates by selector). */
  addTarget(t: ElementTarget): void;
  /** Clear all element targets in the current draft. */
  clearTargets(): void;
  /** Update the hovered CSS selector (null clears the highlight). */
  setHover(selector: string | null): void;

  /**
   * Assemble an EditRequest from the current annotations + targets + a
   * screenshot of their union bounding box, push a user ChatMessage, submit
   * the request, and clear the annotation/target draft.
   */
  submitEdit(instruction: string): Promise<void>;

  /** Cancel the currently in-flight edit (no-op if idle). */
  cancelEdit(): Promise<void>;

  /**
   * Answer a guardrail `requireConfirm` prompt for a paused write. `allow`
   * lets the write through (once); otherwise it is denied. Clears the pending
   * entry either way.
   */
  respondPolicyConfirm(requestId: string, path: string, allow: boolean): Promise<void>;

  /**
   * Reducer for incoming AgentEvents (called from the edit.onEvent subscription).
   * Updates the chat transcript, liveDiffs, checkpoints, streaming flag, and
   * lastError according to the event type discriminant.
   */
  applyAgentEvent(e: AgentEvent): void;

  /** Load (or reload) settings from main. */
  loadSettings(): Promise<void>;
  /**
   * Persist a partial settings patch. Secrets are handled separately via
   * setSecret / clearSecret — never via this method.
   */
  updateSettings(patch: Partial<Omit<AppSettings, 'apiKeyRef' | 'imageApiKeyRef'>>): Promise<void>;
  /** Store a secret (e.g. API key) via safeStorage; returns updated settings. */
  setSecret(id: string, value: string): Promise<void>;
  /** Clear a stored secret by logical id. */
  clearSecret(id: string): Promise<void>;
  /**
   * Probe whether the selected backend is usable with current settings.
   * Sets lastError on failure.
   */
  validateBackend(): Promise<{ ok: boolean; problem?: string }>;

  /* ---- Instruction macros -------------------------------------------------- */

  /**
   * Save a new macro from a name + instruction template (and optional hotkey).
   * The macro is appended to the persisted list and the store's settings are
   * refreshed. Returns the created macro's id, or null if persistence failed.
   */
  saveMacro(input: { name: string; instructionTemplate: string; hotkey?: string }): Promise<string | null>;
  /** Patch an existing macro by id (name / template / hotkey) and persist. */
  updateMacro(id: string, patch: Partial<Omit<InstructionMacro, 'id'>>): Promise<void>;
  /** Remove a macro by id and persist the new list. */
  deleteMacro(id: string): Promise<void>;
  /**
   * Invoke a macro by id: interpolate its template against the first selected
   * element target ({@link interpolateMacro}) and submit via the existing
   * {@link submitEdit}. No-op (sets lastError) if the macro id is unknown.
   */
  runMacro(id: string): Promise<void>;

  /** Refresh the checkpoint list from main. */
  listCheckpoints(): Promise<void>;
  /** Restore the working tree to a specific checkpoint id. */
  restoreCheckpoint(id: string): Promise<void>;
  /** Undo the most recent applied edit. */
  undo(): Promise<void>;
  /** Redo a previously undone edit. */
  redo(): Promise<void>;

  /** Open or close the Settings dialog. */
  setSettingsOpen(open: boolean): void;
  /** Clear lastError (e.g. when the user dismisses a toast). */
  clearError(): void;
  /** Dismiss the "not authenticated" banner. */
  dismissAuthNotice(): void;

  /* ---- Alignment grid (issue #5) ---------------------------------------- */
  /**
   * Show/hide the alignment-grid overlay. Pure display: PreviewPane forwards the
   * change to the guest inspector via `set-grid` (no agent round-trip). Hiding
   * the grid also clears any off-grid scan results.
   */
  setGridVisible(visible: boolean): void;
  /** Store the off-grid scan result relayed from the guest inspector. */
  setOffGridResult(offenders: OffGridElement[]): void;
  /** Mark an off-grid scan as in flight (cleared when results arrive). */
  setScanningOffGrid(scanning: boolean): void;
  /**
   * Kick off an off-grid scan: ensures the grid is shown, marks scanning, and
   * bumps a nonce that PreviewPane observes to send `scan-off-grid` to the guest.
   */
  scanOffGrid(): void;
  /**
   * Build a single {@link EditRequest} asking the agent to align the given
   * off-grid elements to the active grid, and submit it through the existing
   * edit pipeline (one edit → one checkpoint). Reuses {@link submitEdit}.
   */
  snapToGrid(ids: string[]): Promise<void>;

  /* ---- State X-Ray cockpit (issue #13) ---------------------------------- */
  /** Open/close the cockpit panel. */
  setXrayOpen(open: boolean): void;
  /** Switch the active cockpit tab (refreshes the network log when relevant). */
  setXrayTab(tab: 'state' | 'network' | 'time-travel'): void;
  /** Queue a one-shot InspectorCommand for the guest (drained by PreviewPane). */
  sendInspectorCommand(cmd: InspectorCommand): void;
  /** Record the live element-state snapshot relayed from the guest. */
  setElementState(snapshot: ElementStateSnapshot): void;
  /** Re-request the current element's live state (also computes render-cause). */
  refreshElementState(): void;
  /** Scrub a value live in the guest (ephemeral until baked into a source edit). */
  scrubValue(path: string[], value: string | number | boolean | null): void;
  /**
   * "Change this": bridge an inspected state value into a source edit. Builds an
   * instruction + source-anchored target from the current element snapshot and
   * submits through the existing pipeline. Reuses {@link submitEdit}.
   */
  bridgeElementStateToEdit(entry: StateEntry): Promise<void>;
  /**
   * Bridge a network request into a source edit ("add loading/error states"),
   * carrying the request's URL/status + initiator source location.
   */
  bridgeNetworkToEdit(entryId: string): Promise<void>;
  /** Enable/disable the CDP network tap on the guest webview. */
  setNetworkCapture(enabled: boolean): Promise<void>;
  /** Refresh the buffered network log + capture state from main. */
  loadNetworkLog(): Promise<void>;
  /** Clear the buffered network log. */
  clearNetworkLog(): Promise<void>;
  /**
   * Deep-diff two checkpoints' persisted state snapshots for the time-travel
   * view. Returns null when either checkpoint lacks a snapshot.
   */
  compareSnapshots(
    fromCheckpointId: string,
    toCheckpointId: string,
  ): Promise<StateDiffEntry[] | null>;

  // ── Shared: submit a pre-baked EditRequest (used by #6/#8/#9) ──────────────
  /**
   * Submit a fully-assembled {@link EditRequest} directly (bypassing the
   * annotation/screenshot draft path of {@link submitEdit}). Pushes a user
   * ChatMessage, flips the streaming flag, and routes failures like submitEdit.
   */
  submitDirectEdit(request: EditRequest): Promise<void>;

  // ── Issue #6: Live DOM/CSS tweak ──────────────────────────────────────────
  /** Store the latest style delta the guest reported for the tweaked element. */
  setStyleTweak(tweak: EaselState['styleTweak']): void;
  /** Apply one live inline-style tweak to `selector` (instant, ephemeral). */
  tweakStyle(selector: string, property: string, value: string): void;
  /** "Apply to source": ship the accumulated delta as an EditRequest. */
  applyStyleToSource(): Promise<void>;
  /** Discard the accumulated tweaks, restoring the element's source styling. */
  discardStyleTweak(): void;

  // ── Issue #7: Checkpoint visual diff ──────────────────────────────────────
  /** Fetch a checkpoint's before/after preview screenshots (visual diff). */
  getCheckpointShots(checkpointId: string): Promise<{ before?: string; after?: string }>;

  // ── Issue #8: Live token inspector ────────────────────────────────────────
  /** Resolve token matches for a set of computed `{property: value}` pairs. */
  fetchTokenMatches(values: Record<string, string>): Promise<void>;
  /** Clear the current token matches (e.g. when the panel closes). */
  clearTokenMatches(): void;
  /** "Use token": build an EditRequest swapping the hardcoded value for a token. */
  tokenizeValue(match: TokenMatch): Promise<void>;

  // ── Issue #9: Drop-an-image design-to-code ────────────────────────────────
  /** Restyle one existing element to match a dropped image. */
  dropImageOnElement(target: ElementTarget, imageDataUrl: string): Promise<void>;

  // ── Issue #11: Scratch branches ───────────────────────────────────────────
  /** Start a scratch experiment (routes new checkpoints to a throwaway ref). */
  startScratch(name?: string): Promise<void>;
  /** Keep the active scratch: land its checkpoints on the main line. */
  keepScratch(): Promise<void>;
  /** Discard the active scratch: restore the pre-scratch tree and reload. */
  discardScratch(): Promise<void>;

  // ── Issue #10: Branch & open PR ───────────────────────────────────────────
  /** Squash this session's accepted checkpoints onto a fresh branch and open a PR. */
  openPr(): Promise<string | null>;
}

/* -------------------------------------------------------------------------- */
/*  Combined store type                                                       */
/* -------------------------------------------------------------------------- */

export type EaselStore = EaselState & EaselActions;

/* -------------------------------------------------------------------------- */
/*  Store implementation                                                      */
/* -------------------------------------------------------------------------- */

export const useEaselStore = create<EaselStore>((set, get) => ({
  /* ---- Initial state ------------------------------------------------------- */
  project: null,
  settings: null,
  previewStatus: null,
  devServer: null,
  previewUrl: null,
  previewReloadNonce: 0,
  devToolsNonce: 0,
  viewportWidth: null,
  pageLogs: [],
  historyOpen: false,
  mode: 'idle',
  annotations: [],
  targets: [],
  hoveredSelector: null,
  chat: [],
  activeRequestId: null,
  streaming: false,
  liveDiffs: [],
  checkpoints: [],
  currentCheckpointId: undefined,
  settingsOpen: false,
  lastError: null,
  needsAuth: false,
  pendingPolicyConfirms: [],
  gridConfig: DEFAULT_GRID,
  gridVisible: false,
  scanningOffGrid: false,
  offGridElements: [],
  offGridScanNonce: 0,
  xrayOpen: false,
  xrayTab: 'state',
  currentElementState: null,
  networkEntries: [],
  networkCapturing: false,
  pendingInspectorCommand: null,
  inspectorCommandNonce: 0,
  styleTweak: null,
  tokenMatches: null,
  tokenLoading: false,
  scratch: null,
  publishing: false,
  lastPrUrl: null,

  /* ---- Init / subscriptions ------------------------------------------------ */

  init() {
    // Subscribe to all main-process push channels.
    const unsubProject = easel.project.onChanged(({ project }) => {
      set({ project });
    });

    const unsubSettings = easel.settings.onChanged(({ settings }) => {
      set({ settings });
    });

    const unsubCheckpoint = easel.checkpoint.onChanged(({ checkpoints, currentId, scratch }) => {
      set({ checkpoints, currentCheckpointId: currentId, scratch: scratch ?? null });
    });

    const unsubPreview = easel.preview.onStatus((payload) => {
      set({ previewStatus: payload });
    });

    const unsubDevServer = easel.devServer.onEvent((payload) => {
      set({ devServer: payload });
    });

    const unsubEdit = easel.edit.onEvent(({ event }) => {
      get().applyAgentEvent(event);
    });

    // State X-Ray: stream observed network requests from the CDP tap. Keep the
    // most recent 200 to bound memory; entries with the same id are coalesced
    // (request started → response received updates the same row).
    const unsubNetwork = easel.xray.onNetworkEvent(({ entry }) => {
      set((s) => {
        const idx = s.networkEntries.findIndex((e) => e.id === entry.id);
        if (idx >= 0) {
          const next = [...s.networkEntries];
          next[idx] = { ...next[idx], ...entry };
          return { networkEntries: next };
        }
        const next = [...s.networkEntries, entry];
        return { networkEntries: next.length > 200 ? next.slice(next.length - 200) : next };
      });
    });

    // Load initial data from main (fire-and-forget; errors set lastError).
    void (async () => {
      // Load settings first so the rest of the UI can render properly.
      await get().loadSettings();

      const projResult = await easel.project.getCurrent();
      if (projResult.ok) {
        const proj = projResult.value.project;
        set({
          project: proj,
          previewUrl: proj?.devServerUrl ? normalizePreviewUrl(proj.devServerUrl) : null,
        });
      } else {
        set({ lastError: projResult.error });
      }

      const dsResult = await easel.devServer.get();
      if (dsResult.ok) set({ devServer: dsResult.value });

      await get().listCheckpoints();
    })();

    // Cleanup: unsubscribe all push listeners on unmount.
    return () => {
      unsubProject();
      unsubSettings();
      unsubCheckpoint();
      unsubPreview();
      unsubDevServer();
      unsubEdit();
      unsubNetwork();
    };
  },

  /* ---- Project ------------------------------------------------------------- */

  async openProject() {
    const result = await easel.project.open();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    if (result.value.project) {
      const proj = result.value.project;
      set({
        project: proj,
        previewUrl: proj.devServerUrl ? normalizePreviewUrl(proj.devServerUrl) : get().previewUrl,
        lastError: null,
      });
      // Refresh checkpoints for the new project.
      await get().listCheckpoints();
    }
  },

  async closeProject() {
    const result = await easel.project.close();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({
      project: null,
      previewUrl: null,
      devServer: null,
      annotations: [],
      targets: [],
      hoveredSelector: null,
      chat: [],
      activeRequestId: null,
      streaming: false,
      liveDiffs: [],
      checkpoints: [],
      currentCheckpointId: undefined,
      mode: 'idle',
      lastError: null,
      pendingPolicyConfirms: [],
      gridVisible: false,
      offGridElements: [],
      scanningOffGrid: false,
      xrayOpen: false,
      currentElementState: null,
      networkEntries: [],
      // Issues #6-#11: clear feature state so it never leaks into the next project.
      styleTweak: null,
      tokenMatches: null,
      tokenLoading: false,
      scratch: null,
      publishing: false,
      lastPrUrl: null,
    });
  },

  /* ---- Interaction mode ---------------------------------------------------- */

  setMode(mode) {
    set({ mode });
  },

  setPreviewUrl(url) {
    const next = normalizePreviewUrl(url) || null;
    set((s) => ({
      previewUrl: next,
      // Page logs belong to the previously-loaded URL; reset on navigation.
      pageLogs: next === s.previewUrl ? s.pageLogs : [],
    }));
  },

  async startDevServer() {
    const result = await easel.devServer.start();
    if (!result.ok) set({ lastError: result.error });
  },

  async stopDevServer() {
    const result = await easel.devServer.stop();
    if (!result.ok) set({ lastError: result.error });
  },

  reloadPreview() {
    set((s) => ({ previewReloadNonce: s.previewReloadNonce + 1 }));
  },

  toggleDevTools() {
    set((s) => ({ devToolsNonce: s.devToolsNonce + 1 }));
  },

  setViewportWidth(width) {
    set({ viewportWidth: width });
  },

  addPageLog(log) {
    set((s) => {
      const entry: PageLog = { ...log, id: genId(), ts: Date.now() };
      const next = [...s.pageLogs, entry];
      // Cap to the most recent 50 to bound memory.
      return { pageLogs: next.length > 50 ? next.slice(next.length - 50) : next };
    });
  },

  addPageError(info) {
    set((s) => {
      // Resolution detection: if this error matches one we're actively fixing,
      // it's a re-fire — mark that attempt `still-erroring` rather than adding a
      // duplicate row. Equivalence is by message text (post-HMR line numbers may
      // shift, so the message is the stable key).
      const fixingIdx = s.pageLogs.findIndex(
        (l) => l.error?.fixState === 'fixing' && l.message === info.message,
      );
      if (fixingIdx >= 0) {
        const pageLogs = s.pageLogs.map((l, i) =>
          i === fixingIdx
            ? { ...l, error: { ...l.error!, fixState: 'still-erroring' as const } }
            : l,
        );
        return { pageLogs };
      }

      const entry: PageLog = {
        id: genId(),
        ts: Date.now(),
        level: 'error',
        message: info.message,
        source: info.source,
        error: { stack: info.stack, sources: info.sources },
      };
      const next = [...s.pageLogs, entry];
      return { pageLogs: next.length > 50 ? next.slice(next.length - 50) : next };
    });
  },

  async fixPageError(logId) {
    const log = get().pageLogs.find((l) => l.id === logId);
    if (!log || !log.error) return;

    // Don't dispatch a second fix while one is already in flight for this error.
    if (log.error.fixState === 'fixing' || get().streaming) return;

    const { stack, sources } = log.error;

    // Build a precise instruction: the error, its sourcemapped stack, and (when
    // resolved) the exact source locations so the agent goes straight to the
    // throwing line instead of guessing.
    const locationList =
      sources.length > 0
        ? '\n\nLikely source (top stack frames):\n' +
          sources.map((s) => `  • ${s.filePath}:${s.line}:${s.column}`).join('\n')
        : '';
    const stackBlock = stack ? `\n\nStack trace:\n${stack}` : '';
    const instruction =
      `The previewed page throws an uncaught runtime error:\n\n${log.message}` +
      `${stackBlock}${locationList}\n\nFind the root cause and fix it.`;

    // Convert parsed stack frames into ElementTargets so submitEdit's existing
    // pipeline carries them through as EditRequest.targets. These are source-only
    // targets (no DOM node), so DOM-specific fields are empty/sentinel.
    const targets: ElementTarget[] = sources.map((src, i) => ({
      id: `page-error-${logId}-${i}`,
      selector: '',
      tagName: '',
      dataEaselSource: src,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      textSnippet: '',
      attributes: {},
      pluginPresent: true,
      confidence: 'high',
    }));

    // Capture the requestId submitEdit will mint so we can correlate the fix.
    // submitEdit generates its own id internally; we mirror its generation by
    // reading activeRequestId right after it sets streaming state.
    set((s) => ({
      pageLogs: s.pageLogs.map((l) =>
        l.id === logId ? { ...l, error: { ...l.error!, fixState: 'fixing' as const } } : l,
      ),
    }));

    // Stage the source targets, then submit. submitEdit clears targets afterward.
    set({ targets });
    await get().submitEdit(instruction);

    // Record the active request id onto the log so applyAgentEvent can detect
    // the terminal `done` and arm the resolution timer.
    const requestId = get().activeRequestId;
    if (requestId) {
      set((s) => ({
        pageLogs: s.pageLogs.map((l) =>
          l.id === logId && l.error
            ? { ...l, error: { ...l.error, fixRequestId: requestId } }
            : l,
        ),
      }));
    }
  },

  clearPageLogs() {
    set({ pageLogs: [] });
  },

  setHistoryOpen(open) {
    set({ historyOpen: open });
  },

  /* ---- Annotations --------------------------------------------------------- */

  addAnnotation(a) {
    // Dedup by id so re-picking the same element (which reuses the target id)
    // can't stack duplicate annotations → React key collisions / inflated counts.
    set((s) => (s.annotations.some((x) => x.id === a.id) ? {} : { annotations: [...s.annotations, a] }));
  },

  removeAnnotation(id) {
    set((s) => ({ annotations: s.annotations.filter((a) => a.id !== id) }));
  },

  updateAnnotation(id, patch) {
    set((s) => ({
      annotations: s.annotations.map((a) => (a.id === id ? { ...a, ...patch } : a)),
    }));
  },

  clearAnnotations() {
    set({ annotations: [] });
  },

  /* ---- Targets ------------------------------------------------------------- */

  addTarget(t) {
    set((s) => {
      // De-duplicate by selector so rapid clicks don't stack identical targets.
      if (s.targets.some((x) => x.selector === t.selector)) return {};
      return { targets: [...s.targets, t] };
    });
  },

  clearTargets() {
    set({ targets: [] });
  },

  setHover(selector) {
    set({ hoveredSelector: selector });
  },

  /* ---- Submit edit --------------------------------------------------------- */

  async submitEdit(instruction) {
    const { project, annotations, targets, previewUrl } = get();

    if (!project) {
      set({ lastError: 'No project is open.' });
      return;
    }

    if (!instruction.trim()) {
      set({ lastError: 'Instruction cannot be empty.' });
      return;
    }

    // Capture a screenshot of the union bbox of all annotation bounding boxes,
    // falling back to the full viewport when there are no annotations.
    // main process reads webview pixels via webContents.capturePage.
    const annotationBoxes = annotations.map((a) => a.boundingBox);
    const unionBox = annotationBoxes.length > 0 ? bboxUnion(annotationBoxes) : undefined;
    let screenshotDataUrl: string | undefined;
    try {
      screenshotDataUrl = (await captureRegion(unionBox)) ?? undefined;
    } catch {
      // Screenshot is best-effort; the agent can operate without it.
      screenshotDataUrl = undefined;
    }

    const requestId = genId();
    const now = Date.now();

    // Snapshot annotations before clearing so the user message carries them.
    const snapshotAnnotations = annotations.length > 0 ? [...annotations] : undefined;

    // Push the user message to the chat transcript.
    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: instruction,
      createdAt: now,
      requestId,
      annotations: snapshotAnnotations,
    };

    set((s) => ({
      chat: [...s.chat, userMsg],
      activeRequestId: requestId,
      streaming: true,
      liveDiffs: [],
      lastError: null,
    }));

    // Intentionally keep the draft selection (annotations + targets) on screen
    // after submitting. Persisting it is a better UX: the user can fire several
    // instructions at the same region, and removes the selection themselves via
    // the per-mark "×" bubble (or the composer's "Clear selection" chip) when
    // they're ready to move on. The request above already carries its own copy.

    const result = await easel.edit.submit({
      request: {
        id: requestId,
        instruction,
        annotations,
        targets,
        screenshotDataUrl,
        projectRoot: project.root,
        devServerUrl: previewUrl ?? project.devServerUrl,
      },
    });

    if (!result.ok) {
      // IPC-level failure (before streaming even starts).
      const errMsg: ChatMessage = {
        id: genId(),
        role: 'system',
        content: `Submit failed: ${result.error}`,
        createdAt: Date.now(),
        requestId,
      };
      set((s) => ({
        chat: [...s.chat, errMsg],
        lastError: result.error,
        streaming: false,
        activeRequestId: null,
      }));
    }
    // On IPC success, streaming events drive the rest via applyAgentEvent.
  },

  /* ---- Cancel edit --------------------------------------------------------- */

  async cancelEdit() {
    const { activeRequestId } = get();
    if (!activeRequestId) return;

    const result = await easel.edit.cancel({ requestId: activeRequestId });
    if (!result.ok) {
      set({ lastError: result.error });
    }
    // streaming=false will be set when the terminal 'error' (code: 'cancelled')
    // event arrives through applyAgentEvent, keeping state transitions atomic.
  },

  /* ---- Guardrail confirm --------------------------------------------------- */

  async respondPolicyConfirm(requestId, path, allow) {
    // Optimistically clear the prompt; main resolves the paused write.
    set((s) => ({
      pendingPolicyConfirms: s.pendingPolicyConfirms.filter(
        (p) => !(p.requestId === requestId && p.path === path),
      ),
    }));
    const result = await easel.edit.policyRespond({
      requestId,
      path,
      decision: allow ? 'allow-once' : 'deny',
    });
    if (!result.ok) set({ lastError: result.error });
  },

  /* ---- AgentEvent reducer -------------------------------------------------- */

  applyAgentEvent(e) {
    const { activeRequestId } = get();

    switch (e.type) {
      case 'thinking': {
        // Guard against stale events from a previous request.
        if (e.requestId !== activeRequestId) return;

        // Stream incremental thinking text onto the last assistant message, or
        // create a new assistant message if the last entry is not one.
        set((s) => {
          const last = s.chat[s.chat.length - 1];
          if (last?.role === 'assistant' && last.requestId === e.requestId) {
            const updated: ChatMessage = { ...last, content: last.content + e.text };
            return { chat: [...s.chat.slice(0, -1), updated] };
          }
          const newMsg: ChatMessage = {
            id: genId(),
            role: 'assistant',
            content: e.text,
            createdAt: Date.now(),
            requestId: e.requestId,
          };
          return { chat: [...s.chat, newMsg] };
        });
        break;
      }

      case 'message': {
        if (e.requestId !== activeRequestId) return;

        // Stream user-facing assistant narration onto the last assistant turn.
        set((s) => {
          const last = s.chat[s.chat.length - 1];
          if (last?.role === 'assistant' && last.requestId === e.requestId) {
            const updated: ChatMessage = { ...last, content: last.content + e.text };
            return { chat: [...s.chat.slice(0, -1), updated] };
          }
          const newMsg: ChatMessage = {
            id: genId(),
            role: 'assistant',
            content: e.text,
            createdAt: Date.now(),
            requestId: e.requestId,
          };
          return { chat: [...s.chat, newMsg] };
        });
        break;
      }

      case 'confidence': {
        if (e.requestId !== activeRequestId) return;

        // Surface a confidence note as a system message in the transcript.
        // ChatPanel renders these with color-coded badges (green/amber/red).
        set((s) => {
          const note: ChatMessage = {
            id: genId(),
            role: 'system',
            content: `[confidence:${e.level}] ${e.message}`,
            createdAt: Date.now(),
            requestId: e.requestId,
          };
          return { chat: [...s.chat, note] };
        });
        break;
      }

      case 'warning': {
        if (e.requestId !== activeRequestId) return;

        // Guardrail: a requireConfirm path is paused awaiting the user's
        // allow-once / deny decision. Queue it for the PolicyPrompt UI.
        if (e.code === 'policy-confirm' && e.path) {
          set((s) => {
            if (
              s.pendingPolicyConfirms.some(
                (p) => p.requestId === e.requestId && p.path === e.path,
              )
            ) {
              return {}; // already queued (defensive against duplicate events)
            }
            const pending: PendingPolicyConfirm = {
              requestId: e.requestId,
              path: e.path as string,
              reason: e.message,
            };
            return { pendingPolicyConfirms: [...s.pendingPolicyConfirms, pending] };
          });
          break;
        }

        // Guardrail: a write was blocked outright (deny rule, blast-radius cap,
        // or the user denied a confirm). Clear any matching pending prompt and
        // note it in the transcript.
        if (e.code === 'policy-blocked') {
          set((s) => {
            const blockedMsg: ChatMessage = {
              id: genId(),
              role: 'system',
              content: `Blocked by policy: ${e.message}`,
              createdAt: Date.now(),
              requestId: e.requestId,
            };
            return {
              chat: [...s.chat, blockedMsg],
              pendingPolicyConfirms: s.pendingPolicyConfirms.filter(
                (p) => !(p.requestId === e.requestId && p.path === e.path),
              ),
            };
          });
          break;
        }

        set((s) => {
          const warnMsg: ChatMessage = {
            id: genId(),
            role: 'system',
            content: `Warning: ${e.message}`,
            createdAt: Date.now(),
            requestId: e.requestId,
          };
          return { chat: [...s.chat, warnMsg] };
        });
        break;
      }

      case 'file-edit': {
        if (e.requestId !== activeRequestId) return;

        // Accumulate / update live diffs. Replace an existing entry for the
        // same file so we always show the latest diff for that file.
        set((s) => {
          const idx = s.liveDiffs.findIndex((d) => d.filePath === e.diff.filePath);
          if (idx >= 0) {
            const updated = [...s.liveDiffs];
            updated[idx] = e.diff;
            return { liveDiffs: updated };
          }
          return { liveDiffs: [...s.liveDiffs, e.diff] };
        });
        break;
      }

      case 'diff': {
        if (e.requestId !== activeRequestId) return;

        // Full snapshot of all accumulated diffs for this request.
        set({ liveDiffs: e.diffs });
        break;
      }

      case 'checkpoint': {
        if (e.requestId !== activeRequestId) return;

        // Prepend the new checkpoint and advance the cursor.
        set((s) => ({
          checkpoints: [e.checkpoint, ...s.checkpoints],
          currentCheckpointId: e.checkpoint.id,
        }));

        // Attach the checkpointId to the most recent assistant message so
        // per-message undo is possible from the ChatPanel.
        set((s) => {
          const lastAssistant = [...s.chat]
            .reverse()
            .find((m) => m.role === 'assistant' && m.requestId === e.requestId);
          if (!lastAssistant) return {};
          return {
            chat: s.chat.map((m) =>
              m.id === lastAssistant.id ? { ...m, checkpointId: e.checkpoint.id } : m,
            ),
          };
        });

        // Time-travel (State X-Ray): persist the live inspected state alongside
        // the checkpoint so any two points can be deep-diffed later. Best-effort:
        // only when an element is currently inspected. The snapshot lives in
        // userData (main), never in the user's tree.
        {
          const cur = get().currentElementState;
          if (cur) {
            // Build a SerializedValue tree directly from the inspected entries so
            // the persisted snapshot diffs cleanly against another checkpoint's.
            const data: SerializedValue = {
              kind: 'object',
              entries: cur.entries.map((entry) => ({ key: entry.label, value: entry.value })),
              truncated: false,
            };
            void easel.xray.saveSnapshot({
              snapshot: {
                checkpointId: e.checkpoint.id,
                capturedAt: Date.now(),
                label: e.checkpoint.message,
                data,
              },
            });
          }
        }
        break;
      }

      case 'done': {
        if (e.requestId !== activeRequestId) return;

        // Terminal success: finalize the last assistant turn with the summary
        // and complete diff set, then clear streaming state.
        set((s) => {
          const last = s.chat[s.chat.length - 1];
          if (last?.role === 'assistant' && last.requestId === e.requestId) {
            const updated: ChatMessage = {
              ...last,
              // Prefer the streaming content if it's been built up; fall
              // through to the summary if the backend sent it only at done.
              content: last.content || e.summary,
              diffs: e.diffs.length > 0 ? e.diffs : undefined,
            };
            return {
              chat: [...s.chat.slice(0, -1), updated],
              liveDiffs: e.diffs,
              streaming: false,
              activeRequestId: null,
              pendingPolicyConfirms: s.pendingPolicyConfirms.filter(
                (p) => p.requestId !== e.requestId,
              ),
            };
          }
          // No assistant message yet (backend emitted nothing before done).
          const doneMsg: ChatMessage = {
            id: genId(),
            role: 'assistant',
            content: e.summary,
            createdAt: Date.now(),
            requestId: e.requestId,
            diffs: e.diffs.length > 0 ? e.diffs : undefined,
          };
          return {
            chat: [...s.chat, doneMsg],
            liveDiffs: e.diffs,
            streaming: false,
            activeRequestId: null,
            pendingPolicyConfirms: s.pendingPolicyConfirms.filter(
              (p) => p.requestId !== e.requestId,
            ),
          };
        });

        // Resolution check for a "Fix this" edit: if this `done` belongs to a
        // page-error fix that is still in `fixing` state, give the page a few
        // seconds to re-render via HMR. If no equivalent error re-fires in that
        // window (which would flip it to `still-erroring` via addPageError),
        // mark the fix `resolved`.
        {
          const fixedLog = get().pageLogs.find(
            (l) => l.error?.fixRequestId === e.requestId && l.error.fixState === 'fixing',
          );
          if (fixedLog) {
            const logId = fixedLog.id;
            setTimeout(() => {
              set((s) => ({
                pageLogs: s.pageLogs.map((l) =>
                  l.id === logId && l.error?.fixState === 'fixing'
                    ? { ...l, error: { ...l.error, fixState: 'resolved' as const } }
                    : l,
                ),
              }));
            }, FIX_RESOLUTION_WINDOW_MS);
          }
        }
        break;
      }

      case 'error': {
        if (e.requestId !== activeRequestId) return;

        const isCancelled = e.code === 'cancelled';
        const isAuth =
          !isCancelled &&
          (e.code === 'auth' ||
            /401|authentication|invalid authentication|unauthor|\/login/i.test(e.message));

        set((s) => {
          const errMsg: ChatMessage = {
            id: genId(),
            role: 'system',
            content: isCancelled
              ? 'Edit cancelled.'
              : isAuth
                ? 'Not authenticated — use the banner above to connect Claude.'
                : `Error: ${e.message}`,
            createdAt: Date.now(),
            requestId: e.requestId,
          };
          return {
            chat: [...s.chat, errMsg],
            streaming: false,
            activeRequestId: null,
            // Auth failures surface via the banner, not the error toast.
            lastError: isCancelled || isAuth ? null : e.message,
            needsAuth: isAuth ? true : s.needsAuth,
            pendingPolicyConfirms: s.pendingPolicyConfirms.filter(
              (p) => p.requestId !== e.requestId,
            ),
          };
        });

        // If the failed edit was a "Fix this" attempt, clear its `fixing` state
        // so the Page Console offers the button again (the error is unchanged).
        set((s) => ({
          pageLogs: s.pageLogs.map((l) =>
            l.error?.fixRequestId === e.requestId && l.error.fixState === 'fixing'
              ? { ...l, error: { ...l.error, fixState: undefined, fixRequestId: undefined } }
              : l,
          ),
        }));

        // For 'needs-file': surface candidate paths inline so the user can
        // pick one and the ChatPanel can offer a re-submit affordance.
        if (e.code === 'needs-file' && e.candidates && e.candidates.length > 0) {
          const candidateMsg: ChatMessage = {
            id: genId(),
            role: 'system',
            content: `Candidate files:\n${e.candidates.map((c) => `  • ${c}`).join('\n')}`,
            createdAt: Date.now(),
            requestId: e.requestId,
          };
          set((s) => ({ chat: [...s.chat, candidateMsg] }));
        }
        break;
      }

      case 'tool-call': {
        // Tool-call events are transient; they don't update chat or diffs.
        // A future version could show inline tool progress in the chat.
        break;
      }
    }
  },

  /* ---- Settings ------------------------------------------------------------ */

  async loadSettings() {
    const result = await easel.settings.get();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ settings: result.value.settings });
  },

  async updateSettings(patch) {
    const result = await easel.settings.update({ patch });
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ settings: result.value.settings });
  },

  async setSecret(id, value) {
    const result = await easel.settings.setSecret({ id, value });
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ settings: result.value.settings });
  },

  async clearSecret(id) {
    const result = await easel.settings.clearSecret({ id });
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ settings: result.value.settings });
  },

  async validateBackend() {
    const result = await easel.settings.validateBackend();
    if (!result.ok) {
      // IPC failure (transport error, not a validation failure).
      set({ lastError: result.error });
      return { ok: false, problem: result.error };
    }
    // Validation failure: surface problem in lastError.
    if (!result.value.ok && result.value.problem) {
      set({ lastError: result.value.problem });
    } else {
      set({ lastError: null });
    }
    return result.value;
  },

  /* ---- Instruction macros -------------------------------------------------- */

  async saveMacro(input) {
    const name = input.name.trim();
    const instructionTemplate = input.instructionTemplate.trim();
    if (!name || !instructionTemplate) {
      set({ lastError: 'Macro name and instruction are required.' });
      return null;
    }
    const macro: InstructionMacro = {
      id: genId(),
      name,
      instructionTemplate,
      ...(input.hotkey?.trim() ? { hotkey: input.hotkey.trim() } : {}),
    };
    const current = get().settings?.macros ?? [];
    const next = [...current, macro];
    const result = await easel.settings.setMacros({ macros: next });
    if (!result.ok) {
      set({ lastError: result.error });
      return null;
    }
    set({ settings: result.value.settings });
    return macro.id;
  },

  async updateMacro(id, patch) {
    const current = get().settings?.macros ?? [];
    const next = current.map((m) => (m.id === id ? { ...m, ...patch } : m));
    const result = await easel.settings.setMacros({ macros: next });
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ settings: result.value.settings });
  },

  async deleteMacro(id) {
    const current = get().settings?.macros ?? [];
    const next = current.filter((m) => m.id !== id);
    const result = await easel.settings.setMacros({ macros: next });
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ settings: result.value.settings });
  },

  async runMacro(id) {
    const { settings, targets } = get();
    const macro = settings?.macros.find((m) => m.id === id);
    if (!macro) {
      set({ lastError: 'Macro not found.' });
      return;
    }
    // Interpolate against the first selected target (if any) and reuse the
    // existing edit pipeline unchanged.
    const instruction = resolveMacroInstruction(macro, targets[0]);
    await get().submitEdit(instruction);
  },

  /* ---- Checkpoints --------------------------------------------------------- */

  async listCheckpoints() {
    const result = await easel.checkpoint.list();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({
      checkpoints: result.value.checkpoints,
      currentCheckpointId: result.value.currentId,
    });
  },

  async restoreCheckpoint(id) {
    const result = await easel.checkpoint.restore({ checkpointId: id });
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    // main pushes checkpoint.changed to sync the list. Reload the preview so the
    // reverted source is rendered, and close the history panel.
    set({ lastError: null, historyOpen: false });
    get().reloadPreview();
  },

  async undo() {
    const result = await easel.checkpoint.undo();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    // The cursor update arrives via checkpoint.changed push; reload the preview.
    set({ lastError: null });
    get().reloadPreview();
  },

  async redo() {
    const result = await easel.checkpoint.redo();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ lastError: null });
    get().reloadPreview();
  },

  /* ---- UI helpers ---------------------------------------------------------- */

  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  clearError() {
    set({ lastError: null });
  },

  dismissAuthNotice() {
    set({ needsAuth: false });
  },

  /* ---- Alignment grid (issue #5) ------------------------------------------ */

  setGridVisible(visible) {
    // Hiding the grid clears stale scan results (they belong to a shown grid).
    set(visible ? { gridVisible: true } : { gridVisible: false, offGridElements: [], scanningOffGrid: false });
  },

  setOffGridResult(offenders) {
    set({ offGridElements: offenders, scanningOffGrid: false });
  },

  setScanningOffGrid(scanning) {
    set({ scanningOffGrid: scanning });
  },

  scanOffGrid() {
    // Showing the grid first keeps the overlay and the scan in sync visually.
    set((s) => ({
      gridVisible: true,
      scanningOffGrid: true,
      offGridScanNonce: s.offGridScanNonce + 1,
    }));
  },

  async snapToGrid(ids) {
    const { offGridElements, gridConfig } = get();
    const selected = offGridElements.filter((o) => ids.includes(o.id));
    if (selected.length === 0) {
      set({ lastError: 'No off-grid elements selected to snap.' });
      return;
    }

    // Reuse the existing batch-edit path: turn each off-grid offender into an
    // ElementTarget (so the agent gets selector + data-easel-source for source
    // resolution), seed the draft, and submit ONE EditRequest → one checkpoint.
    const targets: ElementTarget[] = selected.map((o) => ({
      id: o.id,
      selector: o.selector,
      tagName: o.tagName,
      dataEaselSource: o.dataEaselSource,
      boundingBox: o.boundingBox,
      textSnippet: '',
      attributes: {},
      pluginPresent: o.dataEaselSource !== undefined,
      confidence: o.dataEaselSource !== undefined ? 'high' : 'medium',
    }));
    set({ targets });

    const { columns, gutter, margin, baseline } = gridConfig;
    const instruction =
      `Align the ${selected.length === 1 ? 'selected element' : `${selected.length} selected elements`} ` +
      `to the layout grid (${columns} columns, ${gutter}px gutter, ${margin}px outer margin) ` +
      `and snap vertical spacing to an ${baseline}px baseline. Adjust spacing/sizing in the source ` +
      `(padding, margin, width) so each element's edges land on the nearest grid line; ` +
      `do not change copy or visual styling beyond alignment.`;

    await get().submitEdit(instruction);

    // The scan reflects the pre-snap layout; clear it so the user re-scans after
    // the edit re-renders.
    set({ offGridElements: [] });
  },

  /* ---- State X-Ray cockpit (issue #13) ------------------------------------ */

  setXrayOpen(open) {
    set({ xrayOpen: open });
    // Opening the Network tab implicitly refreshes the log.
    if (open && get().xrayTab === 'network') void get().loadNetworkLog();
    // The cockpit is useless until an element is picked, and picking requires
    // element-select mode in the guest. Auto-arm Select mode when X-Ray opens
    // from idle so clicking an element "just works" (don't override freeform
    // markup, and don't arm when there's no project/preview to inspect).
    if (open && get().mode === 'idle' && get().project && get().previewUrl) {
      get().setMode('element-select');
    }
  },

  setXrayTab(tab) {
    set({ xrayTab: tab });
    if (tab === 'network') void get().loadNetworkLog();
  },

  sendInspectorCommand(cmd) {
    set((s) => ({
      pendingInspectorCommand: cmd,
      inspectorCommandNonce: s.inspectorCommandNonce + 1,
    }));
  },

  setElementState(snapshot) {
    set({ currentElementState: snapshot });
  },

  refreshElementState() {
    const cur = get().currentElementState;
    if (!cur) return;
    get().sendInspectorCommand({
      type: 'request-element-state',
      selector: cur.selector,
      previousKeys: cur.entries.map((e) => e.label),
    });
  },

  scrubValue(path, value) {
    const cur = get().currentElementState;
    if (!cur) return;
    get().sendInspectorCommand({ type: 'set-value', selector: cur.selector, path, value });
  },

  async bridgeElementStateToEdit(entry) {
    const cur = get().currentElementState;
    if (!cur) {
      set({ lastError: 'No inspected element to change.' });
      return;
    }
    if (get().streaming) return;

    const label =
      cur.componentName ?? (cur.dataEaselSource ? cur.dataEaselSource.filePath : cur.selector);
    const where = cur.dataEaselSource
      ? `${cur.dataEaselSource.filePath}:${cur.dataEaselSource.line}:${cur.dataEaselSource.column}`
      : `the element matching \`${cur.selector}\``;
    const valueText = formatSerializedValue(entry.value);
    const pathText = entry.path.join('.');
    const instruction =
      `In ${where}, change the ${cur.framework} ${entry.group} \`${pathText}\` ` +
      `(currently ${valueText}) on the \`${label}\` component. ` +
      `Edit the SOURCE so the new value is the durable default/binding — ` +
      `do not just patch the rendered DOM.`;

    // Build a source-anchored target so the agent goes straight to the file.
    const target: ElementTarget = {
      id: `xray-state-${cur.targetId}-${pathText || 'value'}`,
      selector: cur.selector,
      tagName: cur.tagName,
      dataEaselSource: cur.dataEaselSource,
      boundingBox: { x: 0, y: 0, width: 0, height: 0 },
      textSnippet: '',
      attributes: {},
      pluginPresent: cur.dataEaselSource !== undefined,
      confidence: cur.dataEaselSource !== undefined ? 'high' : 'medium',
    };
    set({ targets: [target] });
    await get().submitEdit(instruction);
  },

  async bridgeNetworkToEdit(entryId) {
    const entry = get().networkEntries.find((e) => e.id === entryId);
    if (!entry) {
      set({ lastError: 'Network request not found.' });
      return;
    }
    if (get().streaming) return;

    const isFailing = entry.failed || (entry.status !== undefined && entry.status >= 400);
    const statusText = isFailing
      ? `failing (${entry.failed ? (entry.errorText ?? 'network error') : `HTTP ${entry.status} ${entry.statusText ?? ''}`.trim()})`
      : `returning HTTP ${entry.status ?? '???'}`;
    const where = entry.initiator
      ? ` The request is issued near ${entry.initiator.filePath}:${entry.initiator.line}:${entry.initiator.column}.`
      : '';
    const instruction =
      `The \`${entry.method} ${entry.url}\` request is ${statusText}.${where} ` +
      `Add proper loading and error states around this request in the source ` +
      `(handle the failure path, show a spinner/skeleton while pending, and surface ` +
      `an error message instead of leaving the UI blank or broken).`;

    const targets: ElementTarget[] = entry.initiator
      ? [
          {
            id: `xray-net-${entry.id}`,
            selector: '',
            tagName: '',
            dataEaselSource: entry.initiator,
            boundingBox: { x: 0, y: 0, width: 0, height: 0 },
            textSnippet: '',
            attributes: {},
            pluginPresent: true,
            confidence: 'high',
          },
        ]
      : [];
    set({ targets });
    await get().submitEdit(instruction);
  },

  async setNetworkCapture(enabled) {
    const result = await easel.xray.setNetworkCapture({ enabled });
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ networkCapturing: result.value.capturing });
    if (result.value.detail && enabled && !result.value.capturing) {
      set({ lastError: result.value.detail });
    }
  },

  async loadNetworkLog() {
    const result = await easel.xray.getNetworkLog();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ networkEntries: result.value.entries, networkCapturing: result.value.capturing });
  },

  async clearNetworkLog() {
    const result = await easel.xray.clearNetworkLog();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ networkEntries: [] });
  },

  async compareSnapshots(fromCheckpointId, toCheckpointId) {
    const [from, to] = await Promise.all([
      easel.xray.getSnapshot({ checkpointId: fromCheckpointId }),
      easel.xray.getSnapshot({ checkpointId: toCheckpointId }),
    ]);
    if (!from.ok) {
      set({ lastError: from.error });
      return null;
    }
    if (!to.ok) {
      set({ lastError: to.error });
      return null;
    }
    if (!from.value.snapshot || !to.value.snapshot) return null;
    return diffSerialized(from.value.snapshot.data, to.value.snapshot.data);
  },

  /* ---- Shared: submit a pre-baked EditRequest ------------------------------ */

  async submitDirectEdit(request) {
    const { project } = get();
    if (!project) {
      set({ lastError: 'No project is open.' });
      return;
    }
    if (!request.instruction.trim()) {
      set({ lastError: 'Instruction cannot be empty.' });
      return;
    }

    const userMsg: ChatMessage = {
      id: genId(),
      role: 'user',
      content: request.instruction,
      createdAt: Date.now(),
      requestId: request.id,
    };

    set((s) => ({
      chat: [...s.chat, userMsg],
      activeRequestId: request.id,
      streaming: true,
      liveDiffs: [],
      lastError: null,
    }));

    const result = await easel.edit.submit({ request });
    if (!result.ok) {
      const errMsg: ChatMessage = {
        id: genId(),
        role: 'system',
        content: `Submit failed: ${result.error}`,
        createdAt: Date.now(),
        requestId: request.id,
      };
      set((s) => ({
        chat: [...s.chat, errMsg],
        lastError: result.error,
        streaming: false,
        activeRequestId: null,
      }));
    }
  },

  /* ---- Issue #6: Live DOM/CSS tweak --------------------------------------- */

  setStyleTweak(tweak) {
    set({ styleTweak: tweak });
  },

  tweakStyle(selector, property, value) {
    get().sendInspectorCommand({ type: 'set-style', selector, property, value });
  },

  async applyStyleToSource() {
    const { project, previewUrl, styleTweak, targets } = get();
    if (!project) {
      set({ lastError: 'No project is open.' });
      return;
    }
    if (!styleTweak || styleTweak.deltas.length === 0) {
      set({ lastError: 'No style changes to apply.' });
      return;
    }

    const matched = targets.find((t) => t.selector === styleTweak.selector);
    const target: ElementTarget =
      matched ?? {
        id: genId(),
        selector: styleTweak.selector,
        tagName: '',
        dataEaselSource: styleTweak.dataEaselSource,
        boundingBox: { x: 0, y: 0, width: 0, height: 0 },
        textSnippet: '',
        attributes: {},
        pluginPresent: Boolean(styleTweak.dataEaselSource),
        confidence: styleTweak.dataEaselSource ? 'high' : 'low',
      };

    const request: EditRequest = {
      id: genId(),
      instruction: buildStyleEditInstruction(styleTweak.deltas),
      annotations: [],
      targets: [target],
      projectRoot: project.root,
      devServerUrl: previewUrl ?? project.devServerUrl,
    };

    set({ styleTweak: null });
    await get().submitDirectEdit(request);
  },

  discardStyleTweak() {
    const { styleTweak } = get();
    if (styleTweak) {
      get().sendInspectorCommand({ type: 'discard-style', selector: styleTweak.selector });
    }
    set({ styleTweak: null });
  },

  /* ---- Issue #7: Checkpoint visual diff ----------------------------------- */

  async getCheckpointShots(checkpointId) {
    const result = await easel.checkpoint.getShots({ checkpointId });
    if (!result.ok) {
      set({ lastError: result.error });
      return {};
    }
    return result.value;
  },

  /* ---- Issue #8: Live token inspector ------------------------------------- */

  async fetchTokenMatches(values) {
    if (Object.keys(values).length === 0) {
      set({ tokenMatches: [], tokenLoading: false });
      return;
    }
    set({ tokenLoading: true });
    const result = await easel.tokens.match({ values });
    if (!result.ok) {
      set({ lastError: result.error, tokenLoading: false, tokenMatches: null });
      return;
    }
    set({ tokenMatches: result.value.matches, tokenLoading: false });
  },

  clearTokenMatches() {
    set({ tokenMatches: null, tokenLoading: false });
  },

  async tokenizeValue(match) {
    const { project, previewUrl, targets } = get();
    if (!project) {
      set({ lastError: 'No project is open.' });
      return;
    }
    if (!match.token) {
      set({ lastError: 'This value has no matching design token.' });
      return;
    }

    const target =
      targets.find((t) => t.computedStyles?.[match.property] === match.value) ??
      targets[targets.length - 1];
    if (!target) {
      set({ lastError: 'No element is selected.' });
      return;
    }

    const request: EditRequest = {
      id: genId(),
      instruction: buildTokenizeInstruction(match),
      annotations: [],
      targets: [target],
      projectRoot: project.root,
      devServerUrl: previewUrl ?? project.devServerUrl,
    };

    await get().submitDirectEdit(request);
  },

  /* ---- Issue #9: Drop-an-image design-to-code ----------------------------- */

  async dropImageOnElement(target, imageDataUrl) {
    const { project, previewUrl } = get();
    if (!project) {
      set({ lastError: 'No project is open.' });
      return;
    }
    const request = buildDropImageEditRequest({
      id: genId(),
      target,
      imageDataUrl,
      projectRoot: project.root,
      devServerUrl: previewUrl ?? project.devServerUrl,
    });
    await get().submitDirectEdit(request);
  },

  /* ---- Issue #11: Scratch branches ---------------------------------------- */

  async startScratch(name) {
    const result = await easel.checkpoint.scratchStart({ name });
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ scratch: result.value.scratch, lastError: null });
  },

  async keepScratch() {
    const result = await easel.checkpoint.scratchKeep();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ scratch: result.value.scratch, lastError: null });
  },

  async discardScratch() {
    const result = await easel.checkpoint.scratchDiscard();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ scratch: result.value.scratch, lastError: null });
    get().reloadPreview();
  },

  /* ---- Issue #10: Branch & open PR ---------------------------------------- */

  async openPr() {
    if (get().publishing) return null;
    set({ publishing: true, lastError: null });
    const result = await easel.publish.openPr({});
    set({ publishing: false });
    if (!result.ok) {
      set({ lastError: result.error });
      return null;
    }
    const url = result.value.prUrl ?? null;
    set({ lastPrUrl: url });
    return url;
  },
}));
