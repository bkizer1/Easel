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
import { useEaselStore, normalizePreviewUrl } from '../store';
import { easel } from '../lib/api';
import { AnnotationOverlay } from './AnnotationOverlay';

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
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

/** Payload shape of the webview 'ipc-message' event. */
interface IpcMessageEvent extends Event {
  channel: string;
  args: unknown[];
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
  const mode = useEaselStore((s) => s.mode);

  const openProject = useEaselStore((s) => s.openProject);
  const addTarget = useEaselStore((s) => s.addTarget);
  const setHover = useEaselStore((s) => s.setHover);
  const addAnnotation = useEaselStore((s) => s.addAnnotation);
  const clearTargets = useEaselStore((s) => s.clearTargets);
  const hoveredSelector = useEaselStore((s) => s.hoveredSelector);

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

        case 'viewport-changed':
          setScroll({ x: msg.scrollX, y: msg.scrollY });
          break;
      }
    },
    [addTarget, setHover, addAnnotation, scroll],
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const listener = (e: any) => handleIpcMessage(e as IpcMessageEvent);
    const domReady = () => {
      setWebviewReady(true);
      sendCommand({ type: 'set-mode', mode });
    };

    wv.addEventListener('ipc-message', listener);
    wv.addEventListener('dom-ready', domReady);
    return () => {
      wv.removeEventListener('ipc-message', listener);
      wv.removeEventListener('dom-ready', domReady);
    };
  }, [handleIpcMessage, sendCommand, mode, previewUrl]);

  /* ---- Handle highlight command (driven by hoveredSelector) ---- */
  useEffect(() => {
    if (!webviewReady) return;
    sendCommand({ type: 'highlight', selector: hoveredSelector ?? null });
  }, [hoveredSelector, webviewReady, sendCommand]);

  /* ---- Reachability dot (only when the status matches what's loaded) ---- */
  const reachable =
    previewStatus && previewStatus.url === previewUrl ? previewStatus.reachable : null;

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
        {previewUrl ? (
          <>
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
              // (relative) surface absolutely instead.
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', border: 'none' }}
            />
            <AnnotationOverlay hoverBox={hoverBox} scroll={scroll} sendCommand={sendCommand} />
          </>
        ) : (
          <EmptyState onOpen={() => void openProject()} />
        )}
      </div>
    </div>
  );
}
