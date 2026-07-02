/**
 * Easel — PreviewPane component.
 *
 * Hosts the <webview> that embeds a live dev server (any URL, browser-style)
 * and the AnnotationOverlay layer that sits on top of it.
 *
 * Responsibilities:
 *   - A browser address bar: type any URL (e.g. http://localhost:3000), plus
 *     back / forward / reload and an "open project folder" affordance.
 *   - Render <webview> with the current previewUrl, preload, and webpreferences.
 *   - Listen to 'ipc-message' from the guest (InspectorMessage) and relay to
 *     the Zustand store.
 *   - Send InspectorCommand messages into the guest via webview.send().
 *   - Sync interaction mode with the guest inspector on mode changes.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  FolderOpen,
  Globe,
  Lock,
  Loader2,
  Sparkles,
  Wand2,
} from 'lucide-react';
import type { BoundingBox, ElementTarget, Point } from '@shared/types';
import type { InspectorCommand, InspectorMessage } from '@shared/ipc';
import { DEFAULT_OFF_GRID_THRESHOLD } from '@shared/grid';
import { useEaselStore, normalizePreviewUrl } from '../store';
import { MATRIX_PRESETS, type MatrixFrameDef } from '../lib/responsiveMatrix';
import { easel } from '../lib/api';
import { AnnotationOverlay } from './AnnotationOverlay';
import { dropPointToQueryBox } from '../lib/dropImage';
import { DevServerOverlay } from './DevServerOverlay';
import { Tooltip } from './Tooltip';

/* -------------------------------------------------------------------------- */
/*  Webview element typing                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Electron's <webview> is a custom element not in the standard React typings.
 * We extend HTMLElement with the methods/properties we actually use.
 */
interface WebviewElement extends HTMLElement {
  src: string;
  preload: string;
  partition: string;
  webpreferences: string;
  allowpopups: string;
  reload(): void;
  reloadIgnoringCache(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  stop(): void;
  getURL(): string;
  isLoading(): boolean;
  send(channel: string, ...args: unknown[]): void;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
  getWebContentsId(): number;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/** Payload shape of the webview 'ipc-message' event. */
interface IpcMessageEvent extends Event {
  channel: string;
  args: unknown[];
}

/** Payload shape of the webview 'console-message' event. */
interface ConsoleMessageEvent extends Event {
  level: number;
  message: string;
  line: number;
  sourceId: string;
}

/** Payload shape of the webview 'did-fail-load' event. */
interface DidFailLoadEvent extends Event {
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
}

/* -------------------------------------------------------------------------- */
/*  Empty state                                                              */
/* -------------------------------------------------------------------------- */

function EmptyState({ onOpen, onNewSite }: { onOpen: () => void; onNewSite: () => void }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-gray-500 select-none px-6 text-center animate-fade-in">
      {/* Layered emblem: a soft jade halo behind the wand mark. */}
      <div className="relative grid place-items-center">
        <div className="absolute h-28 w-28 rounded-full bg-brand-500/15 blur-2xl" />
        <div className="relative grid place-items-center h-16 w-16 rounded-2xl border border-white/10 bg-ink-800/70 shadow-glass">
          <Wand2 className="h-7 w-7 text-brand-300" />
        </div>
      </div>
      <div className="max-w-sm">
        <p className="text-[15px] font-semibold text-gray-200">Start with a blank canvas</p>
        <p className="text-[12.5px] mt-1.5 leading-relaxed text-gray-500">
          Tell Easel about the site you have in mind — it&rsquo;ll scaffold a project and build a
          first draft for you. Already have something running? Open it instead.
        </p>
      </div>
      <div className="flex flex-col gap-2.5 w-full max-w-[260px]">
        <button
          onClick={onNewSite}
          className="flex items-center justify-center gap-2 px-4 py-2.5 text-[13px] font-semibold rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-white shadow-[0_0_22px_-6px_rgba(52,211,176,0.9),inset_0_1px_0_0_rgba(255,255,255,0.18)] hover:brightness-110 transition-all duration-150 ease-spring active:scale-[0.98]"
        >
          <Wand2 className="w-4 h-4" />
          Start a new site
        </button>
        <button
          onClick={onOpen}
          className="flex items-center justify-center gap-2 px-4 py-2.5 text-[13px] font-medium rounded-xl border border-white/10 bg-ink-800/60 text-gray-200 hover:bg-ink-800 hover:border-white/20 transition-all duration-150 ease-spring active:scale-[0.98]"
        >
          <FolderOpen className="w-4 h-4" />
          Open existing project
        </button>
      </div>
      <div className="flex items-center gap-1.5 text-[11px] text-gray-600">
        <Sparkles className="w-3 h-3 text-brand-500/70" />
        …or type a dev-server URL above, like{' '}
        <span className="font-mono text-gray-400">localhost:3000</span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Responsive matrix frame (issue #14)                                       */
/* -------------------------------------------------------------------------- */

interface MatrixFrameProps {
  /** Breakpoint definition (id/label/width). */
  def: MatrixFrameDef;
  /** Whether this is the active, interactive frame. */
  active: boolean;
  /** URL all frames load (synced navigation). */
  src: string;
  /** Absolute URL of the guest inspector preload. */
  preloadUrl: string;
  /** Bumped to force a synced reload across every frame. */
  reloadNonce: number;
  /** Report this frame's `<webview>` element up (null on unmount/remount). */
  onElement: (id: string, el: WebviewElement | null) => void;
  /** Report this frame's guest `webContentsId` once the page is ready. */
  onReady: (def: MatrixFrameDef, webContentsId: number) => void;
  /** Make this frame the active one. */
  onActivate: (id: string) => void;
  /** Overlay + drop affordance — supplied only for the active frame. */
  children?: React.ReactNode;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
}

/**
 * One breakpoint column of the Responsive Matrix: a width-constrained
 * `<webview>` plus a clickable header. The active frame carries the inspector
 * wiring (via {@link MatrixFrameProps.onElement} → PreviewPane) and the
 * annotation overlay; the others are live context mirrors that are still
 * captured on submit. The `<webview>` key is stable across active changes so
 * switching the active frame never reloads a guest.
 */
function MatrixFrame({
  def,
  active,
  src,
  preloadUrl,
  reloadNonce,
  onElement,
  onReady,
  onActivate,
  children,
  onDragOver,
  onDragLeave,
  onDrop,
}: MatrixFrameProps): React.ReactElement {
  const wvRef = useRef<WebviewElement | null>(null);

  const setRef = useCallback(
    (el: HTMLElement | null) => {
      const wv = (el as unknown as WebviewElement | null) ?? null;
      wvRef.current = wv;
      onElement(def.id, wv);
    },
    [def.id, onElement],
  );

  // Register the guest WebContents id once the page is ready (and after any
  // remount triggered by a navigation, hence `src` in the deps).
  useEffect(() => {
    const wv = wvRef.current;
    if (!wv) return;
    const report = (): void => {
      try {
        onReady(def, wv.getWebContentsId());
      } catch {
        /* webview not attached yet — a later dom-ready will cover it */
      }
    };
    wv.addEventListener('dom-ready', report);
    // The webview may already be loaded when this (re)binds — report now too.
    report();
    return () => wv.removeEventListener('dom-ready', report);
  }, [def, onReady, src]);

  // Synced reload when a revert / the toolbar bumps the nonce.
  useEffect(() => {
    if (reloadNonce > 0) wvRef.current?.reload();
  }, [reloadNonce]);

  return (
    <div className="relative flex h-full shrink-0 flex-col">
      <button
        type="button"
        onClick={() => onActivate(def.id)}
        className={`flex items-center justify-between gap-2 rounded-t-lg px-3 py-1.5 text-[11px] font-medium transition-colors ${
          active
            ? 'bg-brand-500/15 text-brand-200 ring-1 ring-inset ring-brand-400/40'
            : 'bg-ink-900/70 text-gray-400 hover:bg-ink-800/80 hover:text-gray-200'
        }`}
        style={{ width: `${def.width}px`, maxWidth: '100%' }}
      >
        <span className="flex items-center gap-1.5">
          {active && <span className="h-1.5 w-1.5 rounded-full bg-brand-400" />}
          {def.label}
        </span>
        <span className="font-mono text-[10px] text-gray-500">
          {active ? 'editing' : `${def.width}px`}
        </span>
      </button>
      <div
        className={`relative flex-1 overflow-hidden bg-gray-950 ${
          active ? 'ring-1 ring-inset ring-brand-400/40' : ''
        }`}
        style={{ width: `${def.width}px`, maxWidth: '100%' }}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <webview
          // Stable per (frame, url): switching the active frame must not remount
          // a guest, but navigating to a new url should.
          key={`${def.id}:${src}`}
          ref={setRef}
          src={src}
          preload={preloadUrl}
          partition="persist:easel-preview"
          webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
        />
        {children}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  PreviewPane                                                               */
/* -------------------------------------------------------------------------- */

export function PreviewPane(): React.ReactElement {
  const previewUrl = useEaselStore((s) => s.previewUrl);
  const setPreviewUrl = useEaselStore((s) => s.setPreviewUrl);
  const previewStatus = useEaselStore((s) => s.previewStatus);
  const devServer = useEaselStore((s) => s.devServer);
  const project = useEaselStore((s) => s.project);
  const startDevServer = useEaselStore((s) => s.startDevServer);
  const stopDevServer = useEaselStore((s) => s.stopDevServer);
  const previewReloadNonce = useEaselStore((s) => s.previewReloadNonce);
  const devToolsNonce = useEaselStore((s) => s.devToolsNonce);
  const viewportWidth = useEaselStore((s) => s.viewportWidth);
  const responsiveMatrix = useEaselStore((s) => s.responsiveMatrix);
  const matrixActiveFrameId = useEaselStore((s) => s.matrixActiveFrameId);
  const setMatrixActiveFrameId = useEaselStore((s) => s.setMatrixActiveFrameId);
  const setMatrixFrames = useEaselStore((s) => s.setMatrixFrames);
  const addPageLog = useEaselStore((s) => s.addPageLog);
  const addPageError = useEaselStore((s) => s.addPageError);
  const mode = useEaselStore((s) => s.mode);

  const openProject = useEaselStore((s) => s.openProject);
  const openNewSite = useEaselStore((s) => s.openNewSite);
  const addTarget = useEaselStore((s) => s.addTarget);
  const setHover = useEaselStore((s) => s.setHover);
  const addAnnotation = useEaselStore((s) => s.addAnnotation);
  const clearTargets = useEaselStore((s) => s.clearTargets);
  const clearAnnotations = useEaselStore((s) => s.clearAnnotations);
  const hoveredSelector = useEaselStore((s) => s.hoveredSelector);

  // Alignment grid (issue #5): display state is driven into the guest inspector.
  const gridVisible = useEaselStore((s) => s.gridVisible);
  const gridConfig = useEaselStore((s) => s.gridConfig);
  const offGridScanNonce = useEaselStore((s) => s.offGridScanNonce);
  const setOffGridResult = useEaselStore((s) => s.setOffGridResult);
  const setScanningOffGrid = useEaselStore((s) => s.setScanningOffGrid);

  // State X-Ray (issue #13): record live element state + drain guest commands.
  const setElementState = useEaselStore((s) => s.setElementState);
  // Issue #6: relay the accumulated style delta; Issue #9: drop-an-image.
  const setStyleTweak = useEaselStore((s) => s.setStyleTweak);
  const dropImageOnElement = useEaselStore((s) => s.dropImageOnElement);
  // Issue #17: resync puppeteer state into the guest after a reload/HMR cycle.
  const resyncPuppeteer = useEaselStore((s) => s.resyncPuppeteer);
  const pendingInspectorCommand = useEaselStore((s) => s.pendingInspectorCommand);
  const inspectorCommandNonce = useEaselStore((s) => s.inspectorCommandNonce);

  const webviewRef = useRef<WebviewElement | null>(null);
  // Mirror the webview element into state so the listener effect re-runs when it
  // actually mounts. The webview is conditionally rendered — it replaces the
  // dev-server overlay only once the server is reachable — and that mount does
  // not change `previewUrl`, so a plain ref would leave the inspector listeners
  // (and crucially `dom-ready` → `set-mode`) unattached, freezing the guest in
  // idle mode (no hover / no selection / no State X-Ray).
  const [webviewEl, setWebviewEl] = useState<WebviewElement | null>(null);
  const attachWebview = useCallback((el: HTMLElement | null) => {
    const wv = (el as unknown as WebviewElement | null) ?? null;
    webviewRef.current = wv;
    setWebviewEl(wv);
  }, []);

  /* ---- Responsive Matrix (issue #14): multi-frame registry ----
   * In matrix mode several <webview>s are live at once. We bind ALL the existing
   * single-webview inspector wiring to whichever frame is *active* (so exactly
   * one frame is interactive), and register every frame's guest `webContentsId`
   * so the store can capture each breakpoint on submit. Refs (not state) hold
   * the live elements/ids so re-registration never re-renders. */
  const frameEls = useRef<Map<string, WebviewElement | null>>(new Map());
  const frameRegs = useRef<Map<string, { id: string; label: string; width: number; webContentsId: number }>>(new Map());
  // Read latest active id / matrix flag inside stable callbacks without re-binding.
  const activeFrameIdRef = useRef(matrixActiveFrameId);
  activeFrameIdRef.current = matrixActiveFrameId;
  const responsiveMatrixRef = useRef(responsiveMatrix);
  responsiveMatrixRef.current = responsiveMatrix;

  const registerFrameEl = useCallback((id: string, el: WebviewElement | null) => {
    if (el) frameEls.current.set(id, el);
    else frameEls.current.delete(id);
    // Point the interactive webview at the active frame as it mounts.
    if (responsiveMatrixRef.current && id === activeFrameIdRef.current) {
      webviewRef.current = el;
      setWebviewEl(el);
    }
  }, []);

  const registerFrameReady = useCallback(
    (def: MatrixFrameDef, webContentsId: number) => {
      const prev = frameRegs.current.get(def.id);
      if (prev && prev.webContentsId === webContentsId) return; // no change
      frameRegs.current.set(def.id, { id: def.id, label: def.label, width: def.width, webContentsId });
      // Publish only the frames that are part of the current matrix layout.
      const live = MATRIX_PRESETS.map((p) => frameRegs.current.get(p.id)).filter(
        (f): f is { id: string; label: string; width: number; webContentsId: number } => f !== undefined,
      );
      setMatrixFrames(live);
    },
    [setMatrixFrames],
  );

  // Repoint the interactive webview whenever the active frame changes.
  useEffect(() => {
    if (!responsiveMatrix) return;
    const el = frameEls.current.get(matrixActiveFrameId) ?? null;
    webviewRef.current = el;
    setWebviewEl(el);
  }, [matrixActiveFrameId, responsiveMatrix]);

  // Tear down the registry when leaving matrix mode so stale guests aren't
  // captured and the single-preview webview owns `webviewEl` again.
  useEffect(() => {
    if (responsiveMatrix) return;
    frameEls.current.clear();
    frameRegs.current.clear();
    setMatrixFrames([]);
  }, [responsiveMatrix, setMatrixFrames]);

  // Address-bar text (synced to previewUrl, but editable while typing).
  const [urlInput, setUrlInput] = useState(previewUrl ?? '');
  // Hover box in viewport coordinates (from element-hover messages).
  const [hoverBox, setHoverBox] = useState<BoundingBox | null>(null);
  // Scroll offset from 'viewport-changed' messages.
  const [scroll, setScroll] = useState<Point>({ x: 0, y: 0 });
  // Whether the webview is ready (dom-ready fired).
  const [webviewReady, setWebviewReady] = useState(false);
  // Browser-chrome state: navigation progress, history affordances, favicon/title.
  const [loading, setLoading] = useState(false);
  const [navState, setNavState] = useState({ canGoBack: false, canGoForward: false });
  const [favicon, setFavicon] = useState<string | null>(null);
  const [pageTitle, setPageTitle] = useState<string | null>(null);
  // Whether the address bar is focused (drives the focus glow + title reveal).
  const [urlFocused, setUrlFocused] = useState(false);
  // Issue #9: drag-over affordance + in-flight image drops awaiting a target,
  // keyed by queryId so concurrent drops never clobber each other.
  const [dragActive, setDragActive] = useState(false);
  const pendingDrops = useRef<Map<string, { imageDataUrl: string }>>(new Map());
  const dropCounter = useRef(0);

  // Keep the address bar in sync when previewUrl changes externally
  // (e.g. opening a project pre-fills its dev-server URL).
  useEffect(() => {
    setUrlInput(previewUrl ?? '');
  }, [previewUrl]);

  // Reset readiness whenever we navigate to a new URL (new dom-ready follows).
  useEffect(() => {
    setWebviewReady(false);
    setDragActive(false); // clear any stale drag affordance from the old page
    setFavicon(null); // a new origin gets its own favicon/title
    setPageTitle(null);
  }, [previewUrl]);

  /* ---- Navigation ---- */
  const navigate = useCallback(
    (raw: string) => {
      const url = normalizePreviewUrl(raw);
      if (!url) return;
      if (url === previewUrl && webviewRef.current) {
        webviewRef.current.reload(); // same URL → reload
      } else {
        setPreviewUrl(url);
      }
    },
    [previewUrl, setPreviewUrl],
  );

  const reload = useCallback(() => {
    if (webviewRef.current) webviewRef.current.reload();
    else void easel.preview.reload({ hard: false });
  }, []);

  /* ---- Send a command to the guest inspector ---- */
  const sendCommand = useCallback((cmd: InspectorCommand) => {
    if (webviewRef.current) {
      webviewRef.current.send('inspector-command', cmd);
    }
  }, []);

  /* ---- Relay inspector messages from the guest ---- */
  const handleIpcMessage = useCallback(
    (event: IpcMessageEvent) => {
      if (event.channel !== 'inspector-message') return;
      const msg = event.args[0] as InspectorMessage;

      switch (msg.type) {
        case 'inspector-ready':
          // The guest inspector is now listening — a more reliable readiness
          // signal than the webview 'dom-ready' DOM event (which can fire before
          // our listener attaches). Mark ready and assert the current mode so
          // element-select works on the very first click.
          setWebviewReady(true);
          sendCommand({ type: 'set-mode', mode: useEaselStore.getState().mode });
          // Issue #17: re-push the active puppeteer enabled+mocks state into the
          // freshly (re)loaded guest so fetch/XHR interception stays sticky across
          // HMR reloads and full page navigations.
          void resyncPuppeteer();
          break;

        case 'element-hover':
          setHoverBox(msg.boundingBox);
          setHover(msg.selector);
          break;

        case 'element-picked': {
          const target: ElementTarget = msg.target;
          addTarget(target);
          setHoverBox(null);
          setHover(null);
          addAnnotation({
            id: target.id,
            mode: 'element',
            kind: 'rect',
            points: [
              { x: target.boundingBox.x, y: target.boundingBox.y },
              {
                x: target.boundingBox.x + target.boundingBox.width,
                y: target.boundingBox.y + target.boundingBox.height,
              },
            ],
            boundingBox: target.boundingBox,
            color: '#a684ff',
            targetElementId: target.id,
            scrollOrigin: scroll,
          });
          break;
        }

        case 'region-resolved': {
          // Issue #9: if a dropped image is awaiting this query, restyle the
          // top-ranked element to match it instead of selecting targets.
          const pending = pendingDrops.current.get(msg.queryId);
          if (pending) {
            pendingDrops.current.delete(msg.queryId);
            const top = msg.targets[0];
            if (top) void dropImageOnElement(top, pending.imageDataUrl);
            break;
          }
          for (const t of msg.targets) {
            addTarget(t);
          }
          break;
        }

        case 'style-delta':
          // Issue #6: accumulated inline-style delta for the tweaked element.
          setStyleTweak(
            msg.deltas.length > 0
              ? { selector: msg.selector, deltas: msg.deltas, dataEaselSource: msg.dataEaselSource }
              : null,
          );
          break;

        case 'off-grid-result':
          setOffGridResult(msg.offenders);
          break;

        case 'viewport-changed':
          setScroll({ x: msg.scrollX, y: msg.scrollY });
          break;

        case 'page-error':
          // Uncaught runtime error from the guest → record it as a fixable
          // page log so the Page Console can offer a one-click "Fix" button.
          addPageError({
            message: msg.message,
            stack: msg.stack,
            sources: msg.sources,
          });
          break;

        case 'element-state':
          // State X-Ray: live runtime state of the picked element. Feeds the
          // cockpit's State tab; each row bridges into a precise source edit.
          setElementState(msg.snapshot);
          break;
      }
    },
    [
      addTarget,
      setHover,
      addAnnotation,
      addPageError,
      scroll,
      setOffGridResult,
      setElementState,
      setStyleTweak,
      dropImageOnElement,
      resyncPuppeteer,
      sendCommand,
    ],
  );

  /* ---- Sync mode changes to the guest inspector ---- */
  useEffect(() => {
    if (!webviewReady) return;
    sendCommand({ type: 'set-mode', mode });
    if (mode !== 'element-select') {
      setHoverBox(null);
      setHover(null);
    }
    if (mode === 'idle') {
      // Toggling the active mode off is an explicit "done" — clear the whole
      // draft selection (targets + marks) so nothing lingers invisibly attached.
      clearTargets();
      clearAnnotations();
    }
  }, [mode, webviewReady, sendCommand, setHover, clearTargets, clearAnnotations]);

  /* ---- Attach/detach ipc-message listener (re-runs when webview mounts) ---- */
  useEffect(() => {
    const wv = webviewEl;
    if (!wv) return;

    // canGoBack/canGoForward proxy to the guest WebContents and can throw if the
    // webview is mid-teardown during a navigation/remount — read defensively.
    const readNav = (): { canGoBack: boolean; canGoForward: boolean } => {
      try {
        return { canGoBack: wv.canGoBack(), canGoForward: wv.canGoForward() };
      } catch {
        return { canGoBack: false, canGoForward: false };
      }
    };

    const listener = (e: Event) => handleIpcMessage(e as IpcMessageEvent);
    const domReady = () => {
      setWebviewReady(true);
      sendCommand({ type: 'set-mode', mode });
      setNavState(readNav());
    };

    // Browser-chrome events: drive the top loading bar, history affordances,
    // favicon, and page title for a real-browser feel.
    const onStartLoading = () => setLoading(true);
    const onStopLoading = () => {
      setLoading(false);
      setNavState(readNav());
      // Reliable readiness signal: by the time loading stops, the guest
      // inspector has initialised. `dom-ready` and `inspector-ready` are
      // one-shots that a listener re-attach (this effect re-runs on mode /
      // previewUrl changes) can land in the gap of and miss — which freezes the
      // guest (no hover/pick) and deadens the set-style forwarding. Assert
      // readiness here too, then sync the current mode.
      setWebviewReady(true);
      sendCommand({ type: 'set-mode', mode });
    };
    const onNavigate = () => setNavState(readNav());
    const onFavicon = (e: Event) => {
      const favs = (e as unknown as { favicons?: string[] }).favicons;
      setFavicon(favs && favs.length > 0 ? favs[0] : null);
    };
    const onTitle = (e: Event) => {
      const t = (e as unknown as { title?: string }).title;
      setPageTitle(t && t.trim() ? t : null);
    };

    // Capture the previewed page's own warnings/errors so a blank screen always
    // has an explanation (e.g. "ReferenceError: features is not defined").
    const onConsole = (e: Event) => {
      const msg = e as ConsoleMessageEvent;
      const level = typeof msg.level === 'number' ? msg.level : 0;
      if (level < 1) return; // skip ordinary logs/info
      addPageLog({
        level: level >= 2 ? 'error' : 'warn',
        message: String(msg.message ?? ''),
        source: msg.sourceId ? `${msg.sourceId.split('/').pop() ?? msg.sourceId}:${msg.line ?? 0}` : undefined,
      });
    };
    const onFailLoad = (e: Event) => {
      const f = e as DidFailLoadEvent;
      if (f.errorCode === -3) return; // ERR_ABORTED (benign navigation)
      addPageLog({
        level: 'error',
        message: `Failed to load: ${f.errorDescription || 'unknown error'}`,
        source: f.validatedURL,
      });
    };

    wv.addEventListener('ipc-message', listener);
    wv.addEventListener('dom-ready', domReady);
    wv.addEventListener('console-message', onConsole);
    wv.addEventListener('did-fail-load', onFailLoad);
    wv.addEventListener('did-start-loading', onStartLoading);
    wv.addEventListener('did-stop-loading', onStopLoading);
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    wv.addEventListener('page-favicon-updated', onFavicon);
    wv.addEventListener('page-title-updated', onTitle);

    // Recovery for the readiness race: if the webview already finished loading
    // before this (re)attach, the one-shot load events above were missed.
    // Detect the already-loaded page and assert readiness now so the guest is
    // never left frozen.
    try {
      const url = wv.getURL();
      if (!wv.isLoading() && url && !url.startsWith('about:')) {
        setWebviewReady(true);
        sendCommand({ type: 'set-mode', mode });
      }
    } catch {
      /* webview not queryable yet — the load events above will cover it */
    }

    return () => {
      wv.removeEventListener('ipc-message', listener);
      wv.removeEventListener('dom-ready', domReady);
      wv.removeEventListener('console-message', onConsole);
      wv.removeEventListener('did-fail-load', onFailLoad);
      wv.removeEventListener('did-start-loading', onStartLoading);
      wv.removeEventListener('did-stop-loading', onStopLoading);
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
      wv.removeEventListener('page-favicon-updated', onFavicon);
      wv.removeEventListener('page-title-updated', onTitle);
    };
  }, [handleIpcMessage, sendCommand, mode, previewUrl, addPageLog, webviewEl]);

  /* ---- Handle highlight command (driven by hoveredSelector) ---- */
  useEffect(() => {
    if (!webviewReady) return;
    sendCommand({ type: 'highlight', selector: hoveredSelector ?? null });
  }, [hoveredSelector, webviewReady, sendCommand]);

  /* ---- Issue #9: drag-and-drop an image onto an element ---- */
  const onPreviewDragOver = useCallback((e: React.DragEvent) => {
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }, []);

  const onPreviewDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragActive(false);
  }, []);

  const onPreviewDrop = useCallback(
    (e: React.DragEvent) => {
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.stopPropagation();
      setDragActive(false);

      const file = e.dataTransfer.files?.[0];
      if (!file || !file.type.startsWith('image/')) return;

      const wv = webviewRef.current;
      if (!wv) return;
      const rect = wv.getBoundingClientRect();
      const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };

      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = typeof reader.result === 'string' ? reader.result : null;
        if (!dataUrl) return;
        const queryId = `drop-${++dropCounter.current}`;
        pendingDrops.current.set(queryId, { imageDataUrl: dataUrl });
        sendCommand({ type: 'query-region', box: dropPointToQueryBox(point), queryId });
      };
      reader.readAsDataURL(file);
    },
    [sendCommand],
  );

  /* ---- Drive the alignment-grid overlay into the guest (issue #5) ---- */
  useEffect(() => {
    if (!webviewReady) return;
    sendCommand({ type: 'set-grid', grid: gridVisible ? gridConfig : null });
  }, [gridVisible, gridConfig, webviewReady, sendCommand]);

  /* ---- Run an off-grid scan when the toolbar bumps the nonce (issue #5) ---- */
  useEffect(() => {
    if (offGridScanNonce === 0) return;
    if (!webviewReady) {
      // Guest not ready yet — drop the scanning flag so the UI doesn't hang.
      setScanningOffGrid(false);
      return;
    }
    sendCommand({
      type: 'scan-off-grid',
      grid: gridConfig,
      threshold: DEFAULT_OFF_GRID_THRESHOLD,
      scanId: `scan-${offGridScanNonce}`,
    });
  }, [offGridScanNonce, webviewReady, gridConfig, sendCommand, setScanningOffGrid]);

  /* ---- Drain a queued InspectorCommand into the guest (State X-Ray) ---- */
  useEffect(() => {
    if (inspectorCommandNonce === 0 || !webviewReady) return;
    if (pendingInspectorCommand) sendCommand(pendingInspectorCommand);
  }, [inspectorCommandNonce, pendingInspectorCommand, webviewReady, sendCommand]);

  /* ---- Reload the webview when a revert (or the toolbar) bumps the nonce ---- */
  useEffect(() => {
    if (previewReloadNonce > 0) webviewRef.current?.reload();
  }, [previewReloadNonce]);

  /* ---- Toggle the webview devtools on nonce bump ---- */
  useEffect(() => {
    if (devToolsNonce === 0) return;
    const wv = webviewRef.current;
    if (!wv) return;
    if (wv.isDevToolsOpened()) wv.closeDevTools();
    else wv.openDevTools();
  }, [devToolsNonce]);

  /* ---- Reachability dot (only when the status matches what's loaded) ---- */
  const reachable =
    previewStatus && previewStatus.url === previewUrl ? previewStatus.reachable : null;

  /* ---- Address-bar security glyph + label ---- */
  const isHttps = (previewUrl ?? urlInput).startsWith('https://');
  const secureLabel = isHttps
    ? 'Secure connection (HTTPS)'
    : 'Local or insecure connection (HTTP)';

  /* ---- Decide whether to show the live webview or the dev-server overlay ----
   * Gate the webview on the dev server actually serving, so we never render a
   * blank/connection-refused page. When the open project's dev server isn't up
   * yet, the overlay (which Easel auto-starts) takes over until it responds.
   * URLs that aren't the project's dev server are shown optimistically. */
  const isProjectUrl =
    !!project?.devServerUrl && previewUrl === normalizePreviewUrl(project.devServerUrl);
  const dsState = devServer?.state ?? 'idle';
  const dsActive = dsState === 'starting' || dsState === 'running';
  const showDevServerOverlay =
    !!previewUrl && reachable !== true && (dsActive || reachable === false || isProjectUrl);

  /* ---- Render ---- */
  return (
    <div className="absolute inset-0 flex flex-col bg-gray-950 min-w-0">
      {/* Address bar */}
      <div className="relative flex items-center gap-1.5 px-2.5 py-2 hairline-b bg-ink-900/70 backdrop-blur-xl">
        <Tooltip label="Back" side="bottom">
          <button
            onClick={() => webviewRef.current?.goBack()}
            className="grid place-items-center w-8 h-8 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-100 transition-all duration-150 ease-spring active:scale-90 disabled:opacity-25 disabled:pointer-events-none"
            disabled={!previewUrl || !navState.canGoBack}
            aria-label="Back"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
        </Tooltip>
        <Tooltip label="Forward" side="bottom">
          <button
            onClick={() => webviewRef.current?.goForward()}
            className="grid place-items-center w-8 h-8 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-100 transition-all duration-150 ease-spring active:scale-90 disabled:opacity-25 disabled:pointer-events-none"
            disabled={!previewUrl || !navState.canGoForward}
            aria-label="Forward"
          >
            <ArrowRight className="w-4 h-4" />
          </button>
        </Tooltip>
        <Tooltip label={loading ? 'Stop' : 'Reload'} side="bottom">
          <button
            onClick={reload}
            className="grid place-items-center w-8 h-8 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-100 transition-all duration-150 ease-spring active:scale-90 disabled:opacity-25 disabled:pointer-events-none"
            disabled={!previewUrl}
            aria-label="Reload"
          >
            <RotateCw className={`w-4 h-4 ${loading ? 'animate-spin [animation-duration:1.4s]' : ''}`} />
          </button>
        </Tooltip>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate(urlInput);
          }}
          className="flex-1"
        >
          <div
            className={`relative flex items-center h-9 pl-2.5 pr-2.5 rounded-xl bg-ink-800/70 border transition-all duration-150 ease-spring ${
              urlFocused
                ? 'border-brand-500/50 bg-ink-800 shadow-[0_0_0_3px_rgba(45,212,191,0.10)]'
                : 'border-white/10 hover:border-white/[0.18]'
            }`}
          >
            {/* Leading slot: spinner while loading, then favicon or a security glyph. */}
            <Tooltip label={pageTitle ?? secureLabel} side="bottom">
              <span className="grid place-items-center w-5 h-5 shrink-0">
                {loading ? (
                  <Loader2 className="w-3.5 h-3.5 text-brand-400 animate-spin" />
                ) : favicon ? (
                  <img src={favicon} alt="" className="w-4 h-4 rounded-[3px]" />
                ) : isHttps ? (
                  <Lock className="w-3.5 h-3.5 text-brand-400" />
                ) : (
                  <Globe className="w-3.5 h-3.5 text-gray-500" />
                )}
              </span>
            </Tooltip>
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onFocus={(e) => {
                setUrlFocused(true);
                e.target.select();
              }}
              onBlur={() => setUrlFocused(false)}
              placeholder="http://localhost:3000"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full px-2.5 bg-transparent text-[12.5px] font-mono text-gray-200 placeholder-gray-600 focus:outline-none"
            />
            {reachable !== null && (
              <Tooltip label={reachable ? 'Reachable' : 'Not reachable'} side="bottom">
                <span
                  className={`shrink-0 w-2 h-2 rounded-full ${
                    reachable
                      ? 'bg-brand-400 shadow-[0_0_8px_rgba(45,212,191,0.8)]'
                      : 'bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.7)]'
                  }`}
                />
              </Tooltip>
            )}
          </div>
        </form>

        <Tooltip label="Open project folder — lets Claude edit source" side="bottom">
          <button
            onClick={() => void openProject()}
            className="grid place-items-center w-8 h-8 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-100 transition-all duration-150 ease-spring active:scale-90"
            aria-label="Open project folder"
          >
            <FolderOpen className="w-4 h-4" />
          </button>
        </Tooltip>

        {/* Navigation progress — indeterminate browser-style loading bar. */}
        {loading && (
          <div className="loadbar">
            <span />
          </div>
        )}
      </div>

      {/* Preview surface */}
      <div className="flex-1 relative overflow-hidden bg-gray-950">
        {!previewUrl ? (
          <EmptyState onOpen={() => void openProject()} onNewSite={() => openNewSite()} />
        ) : showDevServerOverlay ? (
          <DevServerOverlay
            url={previewUrl}
            state={dsState}
            reachable={reachable}
            command={devServer?.command ?? project?.devCommand}
            logTail={devServer?.logTail ?? []}
            canStart={isProjectUrl && !!project?.devCommand}
            onStart={() => void startDevServer()}
            onStop={() => void stopDevServer()}
          />
        ) : responsiveMatrix ? (
          // Responsive Matrix (issue #14): the dev-server URL rendered at every
          // breakpoint side by side. The active frame is interactive (inspector
          // + overlay); the rest are live context mirrors. All are captured on
          // submit so the agent fixes one breakpoint without regressing others.
          <div className="absolute inset-0 flex justify-start gap-4 overflow-x-auto overflow-y-hidden bg-black/30 px-4 pb-4 pt-2">
            {MATRIX_PRESETS.map((def) => {
              const active = def.id === matrixActiveFrameId;
              return (
                <MatrixFrame
                  key={def.id}
                  def={def}
                  active={active}
                  src={previewUrl}
                  preloadUrl={easel.webviewPreloadUrl}
                  reloadNonce={previewReloadNonce}
                  onElement={registerFrameEl}
                  onReady={registerFrameReady}
                  onActivate={setMatrixActiveFrameId}
                  onDragOver={active ? onPreviewDragOver : undefined}
                  onDragLeave={active ? onPreviewDragLeave : undefined}
                  onDrop={active ? onPreviewDrop : undefined}
                >
                  {active && (
                    <>
                      <AnnotationOverlay hoverBox={hoverBox} scroll={scroll} sendCommand={sendCommand} />
                      {dragActive && (
                        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-brand-500/10 ring-2 ring-inset ring-brand-400/70">
                          <span className="rounded-lg bg-ink-900/90 px-3 py-1.5 text-[12px] font-medium text-brand-200 shadow-lg">
                            Drop an image onto an element to restyle it
                          </span>
                        </div>
                      )}
                    </>
                  )}
                </MatrixFrame>
              );
            })}
          </div>
        ) : (
          // Center a (optionally width-constrained) column for responsive testing.
          // At full width this just fills the surface; the darker backdrop only
          // shows when a device preset narrows the column.
          <div className="absolute inset-0 flex justify-center overflow-hidden bg-black/30">
            <div
              className="relative h-full shrink-0 transition-[width] duration-200"
              style={{ width: viewportWidth ? `${viewportWidth}px` : '100%', maxWidth: '100%' }}
              onDragOver={onPreviewDragOver}
              onDragLeave={onPreviewDragLeave}
              onDrop={onPreviewDrop}
            >
              <webview
                // Keying by URL forces a fresh element on navigation so the
                // guest inspector re-initialises cleanly.
                key={previewUrl}
                ref={attachWebview}
                src={previewUrl}
                preload={easel.webviewPreloadUrl}
                partition="persist:easel-preview"
                webpreferences="contextIsolation=yes,nodeIntegration=no,sandbox=yes"
                // Electron <webview> ignores percentage height against a flex
                // parent and collapses to a small intrinsic size — fill the
                // (relative) column absolutely instead.
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
              />
              <AnnotationOverlay hoverBox={hoverBox} scroll={scroll} sendCommand={sendCommand} />
              {/* Issue #9: drop-an-image affordance */}
              {dragActive && (
                <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-brand-500/10 ring-2 ring-inset ring-brand-400/70">
                  <span className="rounded-lg bg-ink-900/90 px-3 py-1.5 text-[12px] font-medium text-brand-200 shadow-lg">
                    Drop an image onto an element to restyle it
                  </span>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
