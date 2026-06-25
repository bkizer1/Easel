/**
 * Easel — CDP network tap (State X-Ray, issue #13).
 *
 * Attaches an Electron `webContents.debugger` (Chrome DevTools Protocol) to the
 * embedded `<webview>` guest so the MAIN process can observe every network
 * request the previewed page makes — without the renderer (which has no Node
 * access) being able to read the guest's traffic directly.
 *
 * The debugger is attached LAZILY (only when {@link setNetworkCapture}(true) is
 * called) so it never races the user opening DevTools on the preview (only one
 * client may own the protocol at a time). Observed requests are buffered (capped)
 * and streamed to the renderer on the {@link IpcChannels.networkEvent} push
 * channel, each one source-anchored via {@link parseInitiator}.
 */

import { webContents as WebContentsRegistry } from 'electron';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipc';
import type { NetworkEventPayload } from '@shared/ipc';
import type { NetworkEntry } from '@shared/xray';
import type { SourceLocation } from '@shared/types';
import { getMainWindow } from '@main/window';
import { createLogger } from '@main/logger';

const log = createLogger('networktap');

/* -------------------------------------------------------------------------- */
/*  CDP message shapes (only the fields we read)                               */
/* -------------------------------------------------------------------------- */

interface CdpCallFrame {
  url?: string;
  lineNumber?: number;
  columnNumber?: number;
  functionName?: string;
}

interface CdpInitiator {
  type?: string;
  url?: string;
  stack?: { callFrames?: CdpCallFrame[] };
}

interface CdpRequestWillBeSent {
  requestId: string;
  request: { method: string; url: string };
  type?: string;
  initiator?: CdpInitiator;
}

interface CdpResponseReceived {
  requestId: string;
  type?: string;
  response: { status?: number; statusText?: string; mimeType?: string };
}

interface CdpLoadingFinished {
  requestId: string;
}

interface CdpLoadingFailed {
  requestId: string;
  errorText?: string;
}

/* -------------------------------------------------------------------------- */
/*  Module state                                                               */
/* -------------------------------------------------------------------------- */

const MAX_ENTRIES = 300;

/** WebContents we currently have the debugger attached to (ours). */
let attached: WebContents | null = null;
/** Whether the network domain is enabled and we are capturing. */
let capturing = false;
/** The single message handler we registered, so we can detach it cleanly. */
let messageHandler: ((event: Electron.Event, method: string, params: object) => void) | null = null;
/** Buffer of observed entries, keyed by CDP request id for in-place updates. */
const entries = new Map<string, NetworkEntry>();

/* -------------------------------------------------------------------------- */
/*  Initiator parsing (pure, exported, unit-tested)                            */
/* -------------------------------------------------------------------------- */

/** A frame's url is noise if it's empty, from node_modules, or the Easel inspector. */
function isNoiseUrl(url: string | undefined): boolean {
  if (!url) return true;
  if (url.includes('/node_modules/')) return true;
  if (url.includes('easel') && (url.includes('inspector') || url.includes('preload'))) return true;
  return false;
}

/**
 * Convert a dev-server script url to a project-relative path:
 * strip the origin, drop the query/hash, and remove a leading slash.
 * `http://localhost:3000/src/components/Cart.tsx?t=123` → `src/components/Cart.tsx`.
 */
function urlToProjectPath(url: string): string {
  let path = url;
  // Strip protocol + host (origin). Fall back to manual parsing if URL throws.
  try {
    const u = new URL(url);
    path = u.pathname;
  } catch {
    // Best-effort: cut off scheme://host if present.
    const m = /^[a-z]+:\/\/[^/]+(\/.*)$/i.exec(url);
    path = m ? m[1] : url;
    // Drop query / hash.
    path = path.split('?')[0].split('#')[0];
  }
  // Remove a single leading slash.
  return path.replace(/^\//, '');
}

/**
 * Pull the top meaningful call frame from a CDP request initiator and convert it
 * into a project-relative {@link SourceLocation}. CDP line/column numbers are
 * 0-based; SourceLocation is 1-based, so we add 1. Robust: never throws, returns
 * `{}` on garbage input.
 *
 * @param projectRoot - reserved for future origin-aware mapping; unused today.
 */
export function parseInitiator(
  initiator:
    | {
        type?: string;
        url?: string;
        stack?: {
          callFrames?: Array<{
            url?: string;
            lineNumber?: number;
            columnNumber?: number;
            functionName?: string;
          }>;
        };
      }
    | undefined,
  projectRoot?: string,
): { initiatorUrl?: string; source?: SourceLocation } {
  void projectRoot;
  try {
    if (!initiator || typeof initiator !== 'object') return {};

    const frames = initiator.stack?.callFrames;
    const frame = Array.isArray(frames)
      ? frames.find((f) => f && !isNoiseUrl(f.url))
      : undefined;

    // Initiator url for display: the chosen frame's url, else the top-level url.
    const rawUrl = frame?.url ?? (isNoiseUrl(initiator.url) ? undefined : initiator.url);
    const initiatorUrl = rawUrl || undefined;

    let source: SourceLocation | undefined;
    if (frame && frame.url) {
      const filePath = urlToProjectPath(frame.url);
      if (filePath) {
        const line = (typeof frame.lineNumber === 'number' ? frame.lineNumber : 0) + 1;
        const column = (typeof frame.columnNumber === 'number' ? frame.columnNumber : 0) + 1;
        source = { filePath, line, column };
      }
    }

    return { ...(initiatorUrl ? { initiatorUrl } : {}), ...(source ? { source } : {}) };
  } catch {
    return {};
  }
}

/* -------------------------------------------------------------------------- */
/*  Emit                                                                       */
/* -------------------------------------------------------------------------- */

function emit(entry: NetworkEntry): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const payload: NetworkEventPayload = { entry };
  win.webContents.send(IpcChannels.networkEvent, payload);
}

/** Cap the buffer to the most recent MAX_ENTRIES by insertion order. */
function trimBuffer(): void {
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) break;
    entries.delete(oldest);
  }
}

/* -------------------------------------------------------------------------- */
/*  CDP message handling                                                       */
/* -------------------------------------------------------------------------- */

function handleCdpMessage(_event: Electron.Event, method: string, params: object): void {
  try {
    switch (method) {
      case 'Network.requestWillBeSent': {
        const p = params as CdpRequestWillBeSent;
        const { initiatorUrl, source } = parseInitiator(p.initiator);
        const entry: NetworkEntry = {
          id: p.requestId,
          method: p.request.method,
          url: p.request.url,
          startedAt: Date.now(),
          ...(p.type ? { resourceType: p.type } : {}),
          ...(initiatorUrl ? { initiatorUrl } : {}),
          ...(source ? { initiator: source } : {}),
        };
        entries.set(p.requestId, entry);
        trimBuffer();
        emit(entry);
        break;
      }
      case 'Network.responseReceived': {
        const p = params as CdpResponseReceived;
        const entry = entries.get(p.requestId);
        if (!entry) break;
        if (typeof p.response.status === 'number') entry.status = p.response.status;
        if (typeof p.response.statusText === 'string') entry.statusText = p.response.statusText;
        if (typeof p.response.mimeType === 'string') entry.mimeType = p.response.mimeType;
        if (p.type) entry.resourceType = p.type;
        emit(entry);
        break;
      }
      case 'Network.loadingFinished': {
        const p = params as CdpLoadingFinished;
        const entry = entries.get(p.requestId);
        if (!entry) break;
        entry.durationMs = Date.now() - entry.startedAt;
        emit(entry);
        break;
      }
      case 'Network.loadingFailed': {
        const p = params as CdpLoadingFailed;
        const entry = entries.get(p.requestId);
        if (!entry) break;
        entry.failed = true;
        if (p.errorText) entry.errorText = p.errorText;
        entry.durationMs = Date.now() - entry.startedAt;
        emit(entry);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    log.warn('CDP message handling failed', { method, err: String(err) });
  }
}

/* -------------------------------------------------------------------------- */
/*  Guest WebContents lookup (window.ts technique)                             */
/* -------------------------------------------------------------------------- */

function findGuestWebContents(): WebContents | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  // Same technique as capturePreview: the first non-main, non-devtools WebContents.
  const all = WebContentsRegistry.getAllWebContents();
  const guests = all.filter(
    (wc) => wc.id !== win.webContents.id && !wc.isDevToolsOpened(),
  );
  return guests.length > 0 ? guests[0] : null;
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Enable/disable the CDP network tap on the guest webview. Attaches the debugger
 * lazily on enable and detaches on disable. Returns the effective state plus a
 * human `detail` when capture could not be enabled.
 */
export function setNetworkCapture(enabled: boolean): { capturing: boolean; detail?: string } {
  if (enabled) {
    if (capturing && attached && !attached.isDestroyed()) {
      return { capturing: true };
    }

    const wc = findGuestWebContents();
    if (!wc) {
      return { capturing: false, detail: 'No preview is loaded.' };
    }

    // Attach the debugger (no-op if we already own it on this wc).
    try {
      if (!wc.debugger.isAttached()) {
        wc.debugger.attach('1.3');
      }
    } catch (err) {
      // Something else (e.g. DevTools) owns the protocol.
      log.warn('Debugger attach failed', { err: String(err) });
      return { capturing: false, detail: 'Detach DevTools from the preview to capture network.' };
    }

    // Register the message handler exactly once for this attachment.
    if (!messageHandler) {
      messageHandler = handleCdpMessage;
      wc.debugger.on('message', messageHandler);
    }

    try {
      wc.debugger.sendCommand('Network.enable');
    } catch (err) {
      log.warn('Network.enable failed', { err: String(err) });
      detach();
      return { capturing: false, detail: 'Could not enable network capture on the preview.' };
    }

    attached = wc;
    capturing = true;
    log.info('Network capture enabled');
    return { capturing: true };
  }

  // Disable.
  detach();
  return { capturing: false };
}

/** Read the buffered network log (capped) + current capture state. */
export function getNetworkLog(): { entries: NetworkEntry[]; capturing: boolean } {
  const all = Array.from(entries.values());
  const capped = all.length > MAX_ENTRIES ? all.slice(all.length - MAX_ENTRIES) : all;
  return { entries: capped, capturing };
}

/** Clear the buffered network log. */
export function clearNetworkLog(): void {
  entries.clear();
}

/** Detach the debugger safely. Idempotent. Call on app quit. */
export function disposeNetworkTap(): void {
  detach();
}

/* -------------------------------------------------------------------------- */
/*  Internal teardown                                                          */
/* -------------------------------------------------------------------------- */

function detach(): void {
  const wc = attached;
  capturing = false;
  if (wc && !wc.isDestroyed()) {
    try {
      if (wc.debugger.isAttached()) {
        try {
          wc.debugger.sendCommand('Network.disable');
        } catch {
          // Ignore — we are tearing down anyway.
        }
        wc.debugger.detach();
      }
    } catch (err) {
      log.warn('Debugger detach failed', { err: String(err) });
    }
    if (messageHandler) {
      try {
        wc.debugger.removeListener('message', messageHandler);
      } catch {
        // Ignore.
      }
    }
  }
  messageHandler = null;
  attached = null;
}
