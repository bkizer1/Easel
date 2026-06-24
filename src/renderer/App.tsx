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

import { useEffect, useRef, useCallback } from 'react';
import { KeyRound } from 'lucide-react';
import { useEaselStore } from './store';
import { Toolbar } from './components/Toolbar';
import { PreviewPane } from './components/PreviewPane';
import { ChatPanel } from './components/ChatPanel';
import { DiffViewer } from './components/DiffViewer';
import { SettingsDialog } from './components/SettingsDialog';

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
        'fixed bottom-5 left-1/2 -translate-x-1/2 z-50',
        'flex items-center gap-3',
        'px-4 py-3 rounded-xl',
        'bg-rose-950/80 backdrop-blur-xl border border-rose-500/30 text-rose-100 text-sm',
        'shadow-[0_8px_40px_-8px_rgba(0,0,0,0.6)] max-w-md w-[calc(100%-2rem)]',
      ].join(' ')}
    >
      <span className="flex-1 break-words">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="shrink-0 grid place-items-center w-6 h-6 rounded-lg text-rose-300/70 hover:text-rose-100 hover:bg-rose-500/20 transition-colors"
      >
        &#x2715;
      </button>
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
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="flex-shrink-0 grid place-items-center w-6 h-6 rounded-lg text-amber-300/70 hover:text-amber-100 hover:bg-amber-500/15 transition-colors"
      >
        &#x2715;
      </button>
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
  const currentCheckpointId = useEaselStore((s) => s.currentCheckpointId);
  const settingsOpen = useEaselStore((s) => s.settingsOpen);
  const needsAuth = useEaselStore((s) => s.needsAuth);

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
          </div>

          <div className="shrink-0 flex flex-col hairline-l w-80 lg:w-[360px]">
            <ChatPanel />
          </div>
        </div>

        {/* DiffViewer: slide-up panel when there are live diffs */}
        {liveDiffs.length > 0 && (
          <div className="shrink-0 hairline-t max-h-64 overflow-y-auto bg-ink-900/60">
            <DiffViewer diffs={liveDiffs} checkpointId={currentCheckpointId} onDismiss={clearDiffs} />
          </div>
        )}
      </div>

      {/* Settings dialog: modal overlay */}
      {settingsOpen && <SettingsDialog />}

      {/* Error toast */}
      {lastError && <ErrorToast message={lastError} onDismiss={handleDismissError} />}
    </div>
  );
}
