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
  ElementTarget,
  FileDiff,
  OffGridElement,
  ProjectConfig,
} from '@shared/types';
import type { DevServerStatePayload, PreviewStatusPayload } from '@shared/ipc';
import { DEFAULT_GRID, type GridConfig } from '@shared/grid';

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

/** A warning/error captured from the previewed page's own console. */
export interface PageLog {
  id: string;
  level: 'warn' | 'error';
  message: string;
  source?: string;
  ts: number;
}

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

  /* ---- Init / subscriptions ------------------------------------------------ */

  init() {
    // Subscribe to all main-process push channels.
    const unsubProject = easel.project.onChanged(({ project }) => {
      set({ project });
    });

    const unsubSettings = easel.settings.onChanged(({ settings }) => {
      set({ settings });
    });

    const unsubCheckpoint = easel.checkpoint.onChanged(({ checkpoints, currentId }) => {
      set({ checkpoints, currentCheckpointId: currentId });
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

  clearPageLogs() {
    set({ pageLogs: [] });
  },

  setHistoryOpen(open) {
    set({ historyOpen: open });
  },

  /* ---- Annotations --------------------------------------------------------- */

  addAnnotation(a) {
    set((s) => ({ annotations: [...s.annotations, a] }));
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

    // Clear the draft batch so the overlay is clean while the edit runs.
    set({ annotations: [], targets: [] });

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
}));
