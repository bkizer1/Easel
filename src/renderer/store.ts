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
  ProjectConfig,
} from '@shared/types';
import type { PreviewStatusPayload } from '@shared/ipc';

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
  /** URL currently loaded in the preview <webview> (browser-style address bar). */
  previewUrl: string | null;
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
  previewUrl: null,
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

      await get().listCheckpoints();
    })();

    // Cleanup: unsubscribe all push listeners on unmount.
    return () => {
      unsubProject();
      unsubSettings();
      unsubCheckpoint();
      unsubPreview();
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
    });
  },

  /* ---- Interaction mode ---------------------------------------------------- */

  setMode(mode) {
    set({ mode });
  },

  setPreviewUrl(url) {
    set({ previewUrl: normalizePreviewUrl(url) || null });
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
    // main will push checkpoint.changed to sync the list; no manual refresh needed.
    set({ lastError: null });
  },

  async undo() {
    const result = await easel.checkpoint.undo();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    // The cursor update arrives via checkpoint.changed push; no manual set needed.
    set({ lastError: null });
  },

  async redo() {
    const result = await easel.checkpoint.redo();
    if (!result.ok) {
      set({ lastError: result.error });
      return;
    }
    set({ lastError: null });
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
}));
