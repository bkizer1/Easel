/**
 * Easel Renderer — root application component.
 *
 * Responsibilities:
 *   - Bootstrap the Zustand store (init subscriptions, load initial state).
 *   - Apply the user's theme preference to the document root.
 *   - Compose the top-level layout:
 *       Toolbar (top bar)
 *       PreviewPane (center, fills remaining height)
 *       ChatPanel (right sidebar, docked)
 *       SettingsDialog (modal overlay)
 *       DiffViewer (panel, shown when liveDiffs are present)
 *   - Expose a global error toast for lastError.
 *
 * Component is kept lean — all business logic lives in the store or in the
 * individual component files. This file is the integration point only.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import { useEaselStore } from './store';
import { Tooltip } from './components/Tooltip';
import { Toolbar } from './components/Toolbar';
import { PreviewPane } from './components/PreviewPane';
import { ChatPanel } from './components/ChatPanel';
import { DiffViewer } from './components/DiffViewer';
import { ReviewPanel } from './components/ReviewPanel';
import { SettingsDialog } from './components/SettingsDialog';
import { ScrubberDialog } from './components/ScrubberDialog';
import { NewSiteWizard } from './components/NewSiteWizard';
import { PolicyPrompt } from './components/PolicyPrompt';
import { StateXRayPanel } from './components/StateXRayPanel';
import { PuppeteerPanel } from './components/PuppeteerPanel';
import { TweakPanel } from './components/TweakPanel';
import { TokenPanel } from './components/TokenPanel';

/* -------------------------------------------------------------------------- */
/*  Theme management                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Apply the user's theme preference to `document.documentElement` so that
 * Tailwind's `dark:` variants activate. Respects system preference when
 * settings.theme === 'system'.
 */
function useTheme(theme: 'system' | 'light' | 'dark' | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    // Dark-first: the Easel shell is always the ink theme. Only an explicit
    // 'light' preference opts out (the embedded preview keeps its own theme).
    if (theme === 'light') {
      root.classList.remove('dark');
    } else {
      root.classList.add('dark');
    }
  }, [theme]);
}

/* -------------------------------------------------------------------------- */
/*  Error toast                                                                */
/* -------------------------------------------------------------------------- */

interface ErrorToastProps {
  message: string;
  onDismiss: () => void;
}

function ErrorToast({ message, onDismiss }: ErrorToastProps): JSX.Element {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className={[
        'fixed bottom-5 left-1/2 -translate-x-1/2 z-50 animate-slide-up',
        'flex items-center gap-3',
        'px-4 py-3 rounded-xl',
        'bg-rose-950/80 backdrop-blur-xl border border-rose-500/30 text-rose-100 text-sm',
        'shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_18px_50px_-16px_rgba(0,0,0,0.7)] max-w-md w-[calc(100%-2rem)]',
      ].join(' ')}
    >
      <span className="flex-1 break-words">{message}</span>
      <Tooltip label="Dismiss" side="top">
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss error"
          className="shrink-0 grid place-items-center w-6 h-6 rounded-lg text-rose-300/70 hover:text-rose-100 hover:bg-rose-500/20 transition-all duration-150 ease-spring active:scale-90"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Auth banner                                                                */
/* -------------------------------------------------------------------------- */

function AuthBanner(): JSX.Element {
  const setSettingsOpen = useEaselStore((s) => s.setSettingsOpen);
  const dismiss = useEaselStore((s) => s.dismissAuthNotice);
  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 bg-amber-500/[0.08] hairline-b text-amber-200/90 text-[13px]">
      <span className="grid place-items-center w-6 h-6 rounded-lg bg-amber-500/15 text-amber-300 flex-shrink-0">
        <KeyRound className="w-3.5 h-3.5" />
      </span>
      <span className="flex-1 leading-snug">
        Claude isn&rsquo;t authenticated. In a terminal run{' '}
        <span className="font-mono text-amber-100">claude</span> →{' '}
        <span className="font-mono text-amber-100">/login</span> (uses your subscription, no extra spend), or add a
        setup token / API key.
      </span>
      <button
        onClick={() => {
          dismiss();
          setSettingsOpen(true);
        }}
        className="flex-shrink-0 px-3 py-1.5 rounded-lg bg-amber-400 text-ink-950 text-xs font-semibold hover:brightness-110 transition"
      >
        Open Settings
      </button>
      <Tooltip label="Dismiss" side="bottom">
        <button
          onClick={dismiss}
          aria-label="Dismiss"
          className="flex-shrink-0 grid place-items-center w-6 h-6 rounded-lg text-amber-300/70 hover:text-amber-100 hover:bg-amber-500/15 transition-all duration-150 ease-spring active:scale-90"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  State X-Ray dock (resizable / collapsible bottom panel, issue #13 / WS3)   */
/* -------------------------------------------------------------------------- */

/** localStorage keys for the dock's persisted height + collapse state. */
const XRAY_DOCK_HEIGHT_KEY = 'easel.xray.dock.height';
const XRAY_DOCK_COLLAPSED_KEY = 'easel.xray.dock.collapsed';

/** Sensible bounds for the dock height (px). Collapsed shows only the header. */
const XRAY_DOCK_MIN_HEIGHT = 140;
const XRAY_DOCK_MAX_HEIGHT = 720;
const XRAY_DOCK_DEFAULT_HEIGHT = 288; // matches the previous hard-coded h-72
/** Height of the header-only strip when collapsed (≈ the header row). */
const XRAY_DOCK_COLLAPSED_HEIGHT = 41;

function clampDockHeight(h: number): number {
  return Math.min(XRAY_DOCK_MAX_HEIGHT, Math.max(XRAY_DOCK_MIN_HEIGHT, h));
}

function readPersistedHeight(): number {
  try {
    const raw = window.localStorage.getItem(XRAY_DOCK_HEIGHT_KEY);
    const n = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isFinite(n) ? clampDockHeight(n) : XRAY_DOCK_DEFAULT_HEIGHT;
  } catch {
    return XRAY_DOCK_DEFAULT_HEIGHT;
  }
}

function readPersistedCollapsed(): boolean {
  try {
    return window.localStorage.getItem(XRAY_DOCK_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * Genuinely dockable container for {@link StateXRayPanel}: a drag handle on the
 * top edge resizes the height (bounded to [{@link XRAY_DOCK_MIN_HEIGHT},
 * {@link XRAY_DOCK_MAX_HEIGHT}]), a collapse/expand affordance shrinks it to a
 * header-only strip, and both height + collapse persist across reopen via
 * localStorage. Replaces the previous fixed `h-72` strip.
 */
function XRayDock(): JSX.Element {
  const [height, setHeight] = useState<number>(readPersistedHeight);
  const [collapsed, setCollapsed] = useState<boolean>(readPersistedCollapsed);
  const [dragging, setDragging] = useState(false);

  // Persist height (debounced via effect on settled value) + collapse state.
  useEffect(() => {
    try {
      window.localStorage.setItem(XRAY_DOCK_HEIGHT_KEY, String(height));
    } catch {
      /* storage may be unavailable; non-fatal */
    }
  }, [height]);

  useEffect(() => {
    try {
      window.localStorage.setItem(XRAY_DOCK_COLLAPSED_KEY, collapsed ? '1' : '0');
    } catch {
      /* non-fatal */
    }
  }, [collapsed]);

  // Pointer-driven resize from the top-edge handle. Dragging up grows the dock
  // (height increases as the pointer moves toward the top of the window). Uses
  // pointer CAPTURE (not window listeners) so the drag keeps tracking even when
  // the pointer crosses the Electron <webview> beneath — which otherwise
  // swallows host-window pointer events and freezes the drag — and so React
  // tears the handlers down automatically if the dock unmounts mid-drag.
  const dragState = useRef<{ startY: number; startH: number } | null>(null);

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (collapsed) return; // can't resize a collapsed dock
      e.preventDefault();
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture unsupported/failed — the drag still works window-locally */
      }
      dragState.current = { startY: e.clientY, startH: height };
      setDragging(true);
    },
    [collapsed, height],
  );

  const onHandlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const st = dragState.current;
    if (!st) return;
    // Pointer moving up (smaller clientY) → taller dock.
    setHeight(clampDockHeight(st.startH + (st.startY - e.clientY)));
  }, []);

  const onHandlePointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current) return;
    dragState.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  }, []);

  const effectiveHeight = collapsed ? XRAY_DOCK_COLLAPSED_HEIGHT : height;

  return (
    <div
      className="shrink-0 hairline-t bg-ink-900/60 relative"
      style={{ height: effectiveHeight }}
    >
      {/* Top-edge resize handle (hidden when collapsed). */}
      {!collapsed && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize State X-Ray panel"
          onPointerDown={onHandlePointerDown}
          onPointerMove={onHandlePointerMove}
          onPointerUp={onHandlePointerUp}
          onPointerCancel={onHandlePointerUp}
          className={[
            'absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize',
            'after:absolute after:left-1/2 after:top-1/2 after:h-0.5 after:w-8 after:-translate-x-1/2 after:-translate-y-1/2 after:rounded-full',
            dragging ? 'after:bg-brand-400/70' : 'after:bg-white/10 hover:after:bg-white/25',
            'transition-colors',
          ].join(' ')}
        />
      )}
      <StateXRayPanel collapsed={collapsed} onToggleCollapse={() => setCollapsed((c) => !c)} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Root App component                                                         */
/* -------------------------------------------------------------------------- */

export default function App(): JSX.Element {
  // Store selectors — select only what this component needs.
  const init = useEaselStore((s) => s.init);
  const settings = useEaselStore((s) => s.settings);
  const lastError = useEaselStore((s) => s.lastError);
  const clearError = useEaselStore((s) => s.clearError);
  const liveDiffs = useEaselStore((s) => s.liveDiffs);
  const reviewSession = useEaselStore((s) => s.reviewSession);
  const currentCheckpointId = useEaselStore((s) => s.currentCheckpointId);
  const settingsOpen = useEaselStore((s) => s.settingsOpen);
  const needsAuth = useEaselStore((s) => s.needsAuth);
  const xrayOpen = useEaselStore((s) => s.xrayOpen);
  const puppeteerOpen = useEaselStore((s) => s.puppeteerOpen);
  const newSiteOpen = useEaselStore((s) => s.newSiteOpen);
  const scrubberOpen = useEaselStore((s) => s.scrubberOpen);

  // Apply theme whenever settings change.
  useTheme(settings?.theme);

  // Keep a ref to the cleanup function returned by init() so we can call it
  // from the unmount effect without including `init` in the dep array.
  const cleanupRef = useRef<(() => void) | null>(null);

  // Stable dismiss handler so the ErrorToast reference is stable.
  const handleDismissError = useCallback(() => {
    clearError();
  }, [clearError]);

  const clearDiffs = useCallback(() => {
    useEaselStore.setState({ liveDiffs: [] });
  }, []);

  useEffect(() => {
    // Bootstrap: subscribe to IPC push channels and load initial state.
    cleanupRef.current = init();
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
    // init is a stable reference from the store; this effect runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Global undo/redo shortcuts (⌘Z / ⌘⇧Z), skipping text fields so normal text
  // editing keeps working. Reads state imperatively to avoid re-subscribing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const store = useEaselStore.getState();
      if (store.streaming || !store.project) return;
      e.preventDefault();
      if (e.shiftKey) void store.redo();
      else void store.undo();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    /*
     * Root container: full viewport, flex column, no scroll (scroll happens
     * inside individual panes). Dark-first: the dark class is toggled on
     * <html> by useTheme; bg/text are set in globals.css @layer base.
     */
    <div className="relative flex flex-col w-screen h-screen overflow-hidden shell-atmosphere text-gray-100">
      {/* Atmospheric film grain (decorative, non-interactive) */}
      <div className="shell-grain" aria-hidden />

      <div className="relative z-10 flex flex-col flex-1 min-h-0">
        <div className="shrink-0">
          <Toolbar />
        </div>

        {needsAuth && <AuthBanner />}

        {/* Main area: preview + chat side-by-side */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 relative overflow-hidden">
            <PreviewPane />
            {/* Issue #6: live CSS tweak panel (renders only when an element is picked) */}
            <TweakPanel />
            {/* Issue #8: design-token inspector (renders after token matches resolve) */}
            <TokenPanel />
          </div>

          <div className="shrink-0 flex flex-col hairline-l w-80 lg:w-[360px]">
            <ChatPanel />
          </div>
        </div>

        {/* State X-Ray cockpit: genuinely dockable bottom panel (issue #13 / WS3).
            Resize via the top-edge handle, collapse/expand, height persisted. */}
        {xrayOpen && <XRayDock />}

        {/* Live State Puppeteer panel: dockable bottom panel (issue #17) */}
        {puppeteerOpen && (
          <div className="shrink-0 hairline-t h-72 bg-ink-900/60">
            <PuppeteerPanel />
          </div>
        )}

        {/* Issue #19: ReviewPanel supersedes the normal DiffViewer slide-up
            while a review session is active (propose-don't-write). */}
        {reviewSession ? (
          <div className="shrink-0 hairline-t max-h-80 overflow-y-auto bg-ink-900/60 p-3">
            <ReviewPanel />
          </div>
        ) : (
          /* DiffViewer: slide-up panel when there are live diffs */
          liveDiffs.length > 0 && (
            <div className="shrink-0 hairline-t max-h-64 overflow-y-auto bg-ink-900/60">
              <DiffViewer diffs={liveDiffs} checkpointId={currentCheckpointId} onDismiss={clearDiffs} />
            </div>
          )
        )}
      </div>

      {/* Settings dialog: modal overlay */}
      {settingsOpen && <SettingsDialog />}

      {/* Session scrubber dialog: modal overlay (Issue #18) */}
      {scrubberOpen && <ScrubberDialog />}

      {/* New-site intake wizard: shown when starting a site from scratch */}
      {newSiteOpen && <NewSiteWizard />}

      {/* Guardrail allow-once prompt (when a requireConfirm write is paused) */}
      <PolicyPrompt />

      {/* Error toast */}
      {lastError && <ErrorToast message={lastError} onDismiss={handleDismissError} />}
    </div>
  );
}
