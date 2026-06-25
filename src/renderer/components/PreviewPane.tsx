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
import { ArrowLeft, ArrowRight, RotateCw, FolderOpen, Globe } from 'lucide-react';
import type { BoundingBox, ElementTarget, Point } from '@shared/types';
import type { InspectorCommand, InspectorMessage } from '@shared/ipc';
import { DEFAULT_OFF_GRID_THRESHOLD } from '@shared/grid';
import { useEaselStore, normalizePreviewUrl } from '../store';
import { easel } from '../lib/api';
import { AnnotationOverlay } from './AnnotationOverlay';
import { DevServerOverlay } from './DevServerOverlay';

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
  stop(): void;
  getURL(): string;
  send(channel: string, ...args: unknown[]): void;
  openDevTools(): void;
  closeDevTools(): void;
  isDevToolsOpened(): boolean;
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

function EmptyState({ onOpen }: { onOpen: () => void }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 text-gray-500 select-none px-6 text-center">
      <Globe className="w-12 h-12 text-gray-700" />
      <div>
        <p className="text-sm font-medium text-gray-400">Nothing loaded yet</p>
        <p className="text-xs mt-1 max-w-xs">
          Type your dev server URL in the address bar above (e.g.{' '}
          <span className="font-mono text-gray-400">http://localhost:3000</span>) and press Enter —
          or open a project folder to also let Claude edit its source.
        </p>
      </div>
      <button
        onClick={onOpen}
        className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg bg-brand-700 hover:bg-brand-600 text-white transition-colors"
      >
        <FolderOpen className="w-4 h-4" />
        Open project folder
      </button>
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
  const addPageLog = useEaselStore((s) => s.addPageLog);
  const addPageError = useEaselStore((s) => s.addPageError);
  const mode = useEaselStore((s) => s.mode);

  const openProject = useEaselStore((s) => s.openProject);
  const addTarget = useEaselStore((s) => s.addTarget);
  const setHover = useEaselStore((s) => s.setHover);
  const addAnnotation = useEaselStore((s) => s.addAnnotation);
  const clearTargets = useEaselStore((s) => s.clearTargets);
  const hoveredSelector = useEaselStore((s) => s.hoveredSelector);

  // Alignment grid (issue #5): display state is driven into the guest inspector.
  const gridVisible = useEaselStore((s) => s.gridVisible);
  const gridConfig = useEaselStore((s) => s.gridConfig);
  const offGridScanNonce = useEaselStore((s) => s.offGridScanNonce);
  const setOffGridResult = useEaselStore((s) => s.setOffGridResult);
  const setScanningOffGrid = useEaselStore((s) => s.setScanningOffGrid);

  const webviewRef = useRef<WebviewElement | null>(null);

  // Address-bar text (synced to previewUrl, but editable while typing).
  const [urlInput, setUrlInput] = useState(previewUrl ?? '');
  // Hover box in viewport coordinates (from element-hover messages).
  const [hoverBox, setHoverBox] = useState<BoundingBox | null>(null);
  // Scroll offset from 'viewport-changed' messages.
  const [scroll, setScroll] = useState<Point>({ x: 0, y: 0 });
  // Whether the webview is ready (dom-ready fired).
  const [webviewReady, setWebviewReady] = useState(false);

  // Keep the address bar in sync when previewUrl changes externally
  // (e.g. opening a project pre-fills its dev-server URL).
  useEffect(() => {
    setUrlInput(previewUrl ?? '');
  }, [previewUrl]);

  // Reset readiness whenever we navigate to a new URL (new dom-ready follows).
  useEffect(() => {
    setWebviewReady(false);
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
      webviewRef.current.send('easel:inspector-command', cmd);
    }
  }, []);

  /* ---- Relay inspector messages from the guest ---- */
  const handleIpcMessage = useCallback(
    (event: IpcMessageEvent) => {
      if (event.channel !== 'easel:inspector-message') return;
      const msg = event.args[0] as InspectorMessage;

      switch (msg.type) {
        case 'inspector-ready':
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
          for (const t of msg.targets) {
            addTarget(t);
          }
          break;
        }

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
      }
    },
    [addTarget, setHover, addAnnotation, addPageError, scroll, setOffGridResult],
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
      clearTargets();
    }
  }, [mode, webviewReady, sendCommand, setHover, clearTargets]);

  /* ---- Attach/detach ipc-message listener (re-runs when webview mounts) ---- */
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    const listener = (e: Event) => handleIpcMessage(e as IpcMessageEvent);
    const domReady = () => {
      setWebviewReady(true);
      sendCommand({ type: 'set-mode', mode });
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
    return () => {
      wv.removeEventListener('ipc-message', listener);
      wv.removeEventListener('dom-ready', domReady);
      wv.removeEventListener('console-message', onConsole);
      wv.removeEventListener('did-fail-load', onFailLoad);
    };
  }, [handleIpcMessage, sendCommand, mode, previewUrl, addPageLog]);

  /* ---- Handle highlight command (driven by hoveredSelector) ---- */
  useEffect(() => {
    if (!webviewReady) return;
    sendCommand({ type: 'highlight', selector: hoveredSelector ?? null });
  }, [hoveredSelector, webviewReady, sendCommand]);

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
      <div className="flex items-center gap-1 px-2.5 py-2 hairline-b bg-ink-900/70 backdrop-blur-xl">
        <button
          onClick={() => webviewRef.current?.goBack()}
          title="Back"
          className="grid place-items-center w-8 h-8 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-100 transition-colors disabled:opacity-25"
          disabled={!previewUrl}
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <button
          onClick={() => webviewRef.current?.goForward()}
          title="Forward"
          className="grid place-items-center w-8 h-8 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-100 transition-colors disabled:opacity-25"
          disabled={!previewUrl}
        >
          <ArrowRight className="w-4 h-4" />
        </button>
        <button
          onClick={reload}
          title="Reload"
          className="grid place-items-center w-8 h-8 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-100 transition-colors disabled:opacity-25"
          disabled={!previewUrl}
        >
          <RotateCw className="w-4 h-4" />
        </button>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate(urlInput);
          }}
          className="flex-1"
        >
          <div className="relative flex items-center">
            <Globe className="absolute left-2.5 w-3.5 h-3.5 text-gray-500 pointer-events-none" />
            {reachable !== null && (
              <span
                title={reachable ? 'Reachable' : 'Not reachable'}
                className={`absolute right-2.5 w-2 h-2 rounded-full ${
                  reachable ? 'bg-brand-400 shadow-[0_0_8px_rgba(45,212,191,0.8)]' : 'bg-rose-500'
                }`}
              />
            )}
            <input
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="http://localhost:3000"
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              className="w-full pl-8 pr-7 py-2 text-xs font-mono rounded-lg bg-ink-800/80 text-gray-200 placeholder-gray-600 border border-white/10 focus:border-brand-500/50 focus:bg-ink-800 focus:outline-none focus:shadow-[0_0_0_3px_rgba(45,212,191,0.10)] transition-all"
            />
          </div>
        </form>

        <button
          onClick={() => void openProject()}
          title="Open project folder (lets Claude edit source)"
          className="grid place-items-center w-8 h-8 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-100 transition-colors"
        >
          <FolderOpen className="w-4 h-4" />
        </button>
      </div>

      {/* Preview surface */}
      <div className="flex-1 relative overflow-hidden bg-gray-950">
        {!previewUrl ? (
          <EmptyState onOpen={() => void openProject()} />
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
        ) : (
          // Center a (optionally width-constrained) column for responsive testing.
          // At full width this just fills the surface; the darker backdrop only
          // shows when a device preset narrows the column.
          <div className="absolute inset-0 flex justify-center overflow-hidden bg-black/30">
            <div
              className="relative h-full shrink-0 transition-[width] duration-200"
              style={{ width: viewportWidth ? `${viewportWidth}px` : '100%', maxWidth: '100%' }}
            >
              <webview
                // Keying by URL forces a fresh element on navigation so the
                // guest inspector re-initialises cleanly.
                key={previewUrl}
                ref={(el) => {
                  webviewRef.current = el as unknown as WebviewElement | null;
                }}
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
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
