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
 *
 * Workstream 2 ("the Burp part") adds OPT-IN request **interception**: when
 * {@link setNetworkIntercept}(true) is called we also `Fetch.enable` and pause
 * matching requests, surfacing them to the renderer so the user can
 * **continue** (optionally rewriting url/method/headers/body), **fulfill**
 * (mock a synthetic response), or **block** them. Interception is layered on
 * top of the passive log and never alters the passive path when off. To avoid
 * wedging the page, every paused request is tracked by its CDP id and is
 * auto-continued on teardown/disable, and `Fetch.enable` is torn down cleanly on
 * detach.
 */

import { webContents as WebContentsRegistry } from 'electron';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipc';
import type {
  NetworkEventPayload,
  NetworkStatusPayload,
  NetworkRequestRewrite,
  NetworkResponseMock,
} from '@shared/ipc';
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

/** A `Fetch.requestPaused` event (only the fields we read). */
interface CdpRequestPaused {
  /** Fetch-domain interception id (the handle for continue/fulfill/fail). */
  requestId: string;
  /** The Network-domain id (correlates to a `requestWillBeSent` entry). */
  networkId?: string;
  request: { method: string; url: string };
  resourceType?: string;
  /** Present when paused at the Response stage. */
  responseStatusCode?: number;
}

/* -------------------------------------------------------------------------- */
/*  Module state                                                               */
/* -------------------------------------------------------------------------- */

const MAX_ENTRIES = 300;

/** WebContents we currently have the debugger attached to (ours). */
let attached: WebContents | null = null;
/** Whether the network domain is enabled and we are capturing. */
let capturing = false;
/** Whether Fetch interception is enabled (opt-in "Burp" mode). */
let intercepting = false;
/** The single message handler we registered, so we can detach it cleanly. */
let messageHandler: ((event: Electron.Event, method: string, params: object) => void) | null = null;
/** Navigation listener bound to the live guest, so we can re-attach on reload. */
let navHandler: (() => void) | null = null;
/** Buffer of observed entries, keyed by CDP request id for in-place updates. */
const entries = new Map<string, NetworkEntry>();

/* -------------------------------------------------------------------------- */
/*  Paused-request bookkeeping (pure, exported, unit-tested)                   */
/* -------------------------------------------------------------------------- */

/** One request held by the Fetch interceptor, awaiting a user decision. */
export interface PausedRequest {
  /** Fetch-domain id passed back to `Fetch.continueRequest` / `fulfillRequest`. */
  interceptId: string;
  /** Network-domain id correlating to the buffered {@link NetworkEntry}, if known. */
  networkId?: string;
  method: string;
  url: string;
  /** `'request'` (before send) or `'response'` (after headers received). */
  stage: 'request' | 'response';
}

/**
 * The map of currently-paused requests, keyed by Fetch interceptId. Exposed for
 * tests only; production code goes through the helpers below so transitions stay
 * consistent.
 */
export const pausedRequests = new Map<string, PausedRequest>();

/** Record a newly-paused request. Pure bookkeeping; idempotent on interceptId. */
export function addPausedRequest(req: PausedRequest): void {
  pausedRequests.set(req.interceptId, req);
}

/**
 * Resolve (remove) a paused request once an action is taken on it. Returns the
 * record that was removed (so the caller can update the matching entry), or null
 * if the id was unknown/already resolved — the guard against double-acting that
 * would otherwise throw a CDP "Invalid InterceptionId" error.
 */
export function resolvePausedRequest(interceptId: string): PausedRequest | null {
  const req = pausedRequests.get(interceptId);
  if (!req) return null;
  pausedRequests.delete(interceptId);
  return req;
}

/** Drop all paused-request bookkeeping (on disable/detach). */
export function clearPausedRequests(): void {
  pausedRequests.clear();
}

/* -------------------------------------------------------------------------- */
/*  Fulfill / continue payload construction (pure, exported, unit-tested)      */
/* -------------------------------------------------------------------------- */

/** A `name`/`value` header pair as CDP's Fetch domain expects them. */
export interface CdpHeaderEntry {
  name: string;
  value: string;
}

/** Lower a plain `{name: value}` header map to CDP's `[{name, value}]` array. */
export function toHeaderEntries(headers: Record<string, string> | undefined): CdpHeaderEntry[] {
  if (!headers) return [];
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}

/** Base64-encode a UTF-8 string for `Fetch.fulfillRequest`'s `body` field. */
export function encodeBody(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  // Buffer is always available in main; tests run under node too.
  return Buffer.from(body, 'utf8').toString('base64');
}

/** The exact params object passed to `Fetch.fulfillRequest`. */
export interface FetchFulfillParams {
  requestId: string;
  responseCode: number;
  responseHeaders: CdpHeaderEntry[];
  body?: string;
}

/**
 * Build the `Fetch.fulfillRequest` params for a mock response. Pure: maps the
 * portable {@link NetworkResponseMock} (plain status/headers/text body) into the
 * CDP shape (header array + base64 body). Exported for direct unit testing.
 */
export function buildFulfillParams(interceptId: string, mock: NetworkResponseMock): FetchFulfillParams {
  const body = encodeBody(mock.body);
  return {
    requestId: interceptId,
    responseCode: mock.responseCode,
    responseHeaders: toHeaderEntries(mock.headers),
    ...(body !== undefined ? { body } : {}),
  };
}

/** The exact params object passed to `Fetch.continueRequest`. */
export interface FetchContinueParams {
  requestId: string;
  url?: string;
  method?: string;
  postData?: string;
  headers?: CdpHeaderEntry[];
}

/**
 * Build the `Fetch.continueRequest` params from optional rewrite overrides. With
 * no rewrite, returns just the id (a plain pass-through). Pure; exported for
 * tests. `postData` is base64-encoded per the CDP contract.
 */
export function buildContinueParams(
  interceptId: string,
  rewrite?: NetworkRequestRewrite,
): FetchContinueParams {
  const params: FetchContinueParams = { requestId: interceptId };
  if (!rewrite) return params;
  if (rewrite.url !== undefined) params.url = rewrite.url;
  if (rewrite.method !== undefined) params.method = rewrite.method;
  if (rewrite.postData !== undefined) params.postData = encodeBody(rewrite.postData);
  if (rewrite.headers !== undefined) params.headers = toHeaderEntries(rewrite.headers);
  return params;
}

/**
 * Compose a short human summary of a rewrite for the cockpit's inline label.
 * Returns undefined when the rewrite is empty (a plain continue).
 */
export function summarizeRewrite(rewrite?: NetworkRequestRewrite): string | undefined {
  if (!rewrite) return undefined;
  const parts: string[] = [];
  if (rewrite.method !== undefined) parts.push(`method ${rewrite.method}`);
  if (rewrite.url !== undefined) parts.push('url');
  if (rewrite.headers !== undefined) parts.push('headers');
  if (rewrite.postData !== undefined) parts.push('body');
  return parts.length ? `rewrote ${parts.join(', ')}` : undefined;
}

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

/**
 * Push the tap's capture/intercept state to the renderer out-of-band so its
 * `networkCapturing` flag stays honest after a silent detach (reload/navigation)
 * or a re-attach. Safe to call any time — no-op if the window is gone.
 */
function emitStatus(detail?: string): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const payload: NetworkStatusPayload = {
    capturing,
    intercepting,
    ...(detail ? { detail } : {}),
  };
  win.webContents.send(IpcChannels.networkStatus, payload);
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
      case 'Fetch.requestPaused': {
        handleRequestPaused(params as CdpRequestPaused);
        break;
      }
      default:
        break;
    }
  } catch (err) {
    log.warn('CDP message handling failed', { method, err: String(err) });
  }
}

/**
 * Handle a `Fetch.requestPaused` event: record the paused request, mark the
 * matching buffered entry as paused, and surface it to the renderer. If
 * interception was disabled out from under us (race), auto-continue immediately
 * so the page never wedges.
 */
function handleRequestPaused(p: CdpRequestPaused): void {
  if (!intercepting) {
    // Interception was turned off between Fetch.enable and this event; let it
    // through unchanged so nothing hangs.
    safeContinue(p.requestId);
    return;
  }

  const stage: 'request' | 'response' =
    typeof p.responseStatusCode === 'number' ? 'response' : 'request';

  addPausedRequest({
    interceptId: p.requestId,
    ...(p.networkId ? { networkId: p.networkId } : {}),
    method: p.request.method,
    url: p.request.url,
    stage,
  });

  // Annotate the matching buffered entry (by networkId) so the cockpit can mark
  // the row "paused" with controls. If we have no entry yet (paused before
  // requestWillBeSent), synthesize a minimal one keyed by the network id.
  const key = p.networkId ?? p.requestId;
  let entry = entries.get(key);
  if (!entry) {
    entry = { id: key, method: p.request.method, url: p.request.url, startedAt: Date.now() };
    entries.set(key, entry);
    trimBuffer();
  }
  entry.interceptId = p.requestId;
  entry.paused = true;
  entry.pausedStage = stage;
  emit(entry);
}

/* -------------------------------------------------------------------------- */
/*  Interception actions (continue / fulfill / fail)                           */
/* -------------------------------------------------------------------------- */

/**
 * Send a best-effort `Fetch.continueRequest` that never throws AND never leaks an
 * unhandled rejection. `debugger.sendCommand` returns a promise that REJECTS on a
 * dead/stale interceptId (e.g. a request whose id was cleared by a navigation
 * race), so a bare sync try/catch would miss it — we attach `.catch` too.
 */
function safeContinue(interceptId: string, params?: FetchContinueParams): void {
  const wc = attached;
  if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) return;
  try {
    void wc.debugger
      .sendCommand('Fetch.continueRequest', params ?? { requestId: interceptId })
      .catch((err) => log.warn('Fetch.continueRequest failed', { err: String(err) }));
  } catch (err) {
    log.warn('Fetch.continueRequest failed', { err: String(err) });
  }
}

/** Clear the paused flags on the entry matching a resolved interceptId. */
function clearEntryPaused(req: PausedRequest, patch: Partial<NetworkEntry>): void {
  const key = req.networkId ?? req.interceptId;
  const entry = entries.get(key);
  if (!entry) return;
  entry.paused = false;
  delete entry.pausedStage;
  delete entry.interceptId;
  Object.assign(entry, patch);
  emit(entry);
}

/**
 * Resume a paused request unchanged, or with rewrite overrides. Returns whether
 * the action was applied (false if the id was no longer paused).
 */
export function continueRequest(
  interceptId: string,
  rewrite?: NetworkRequestRewrite,
): { applied: boolean; detail?: string } {
  const req = resolvePausedRequest(interceptId);
  if (!req) return { applied: false, detail: 'Request is no longer paused.' };
  const params = buildContinueParams(interceptId, rewrite);
  safeContinue(interceptId, params);
  const summary = summarizeRewrite(rewrite);
  clearEntryPaused(req, summary ? { interceptSummary: summary } : {});
  return { applied: true };
}

/**
 * Fulfill (mock) a paused request with a synthetic response. Returns whether the
 * action was applied.
 */
export function fulfillRequest(
  interceptId: string,
  mock: NetworkResponseMock,
): { applied: boolean; detail?: string } {
  const req = resolvePausedRequest(interceptId);
  if (!req) return { applied: false, detail: 'Request is no longer paused.' };
  const wc = attached;
  if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
    try {
      void wc.debugger
        .sendCommand('Fetch.fulfillRequest', buildFulfillParams(interceptId, mock))
        .catch((err) => log.warn('Fetch.fulfillRequest failed', { err: String(err) }));
    } catch (err) {
      log.warn('Fetch.fulfillRequest failed', { err: String(err) });
    }
  }
  clearEntryPaused(req, {
    mocked: true,
    status: mock.responseCode,
    interceptSummary: `mocked → ${mock.responseCode}`,
  });
  return { applied: true };
}

/**
 * Block (fail) a paused request at the interceptor. Returns whether the action
 * was applied.
 */
export function failRequest(
  interceptId: string,
  reason: string = 'BlockedByClient',
): { applied: boolean; detail?: string } {
  const req = resolvePausedRequest(interceptId);
  if (!req) return { applied: false, detail: 'Request is no longer paused.' };
  const wc = attached;
  if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
    try {
      void wc.debugger
        .sendCommand('Fetch.failRequest', { requestId: interceptId, errorReason: reason })
        .catch((err) => log.warn('Fetch.failRequest failed', { err: String(err) }));
    } catch (err) {
      log.warn('Fetch.failRequest failed', { err: String(err) });
    }
  }
  clearEntryPaused(req, { blocked: true, failed: true, interceptSummary: `blocked (${reason})` });
  return { applied: true };
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
/*  Fetch enable/disable (the "Burp" mode)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Enable the Fetch domain on the live guest with patterns covering all requests
 * at the Request stage. Best-effort; logs and bails on failure (capture stays
 * up). Auto-continues nothing here — pausing happens via `requestPaused`.
 */
function enableFetch(wc: WebContents): boolean {
  try {
    wc.debugger.sendCommand('Fetch.enable', {
      // Intercept all requests at the Request stage. (Response-stage interception
      // is also surfaced if Chrome reports it, but we don't request it broadly to
      // keep the page responsive.)
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    return true;
  } catch (err) {
    log.warn('Fetch.enable failed', { err: String(err) });
    return false;
  }
}

/**
 * Disable the Fetch domain and release every still-paused request so the page
 * cannot wedge. Best-effort and total — never throws.
 */
function disableFetch(): void {
  const wc = attached;
  // Release everything we're holding BEFORE disabling, so no request is left
  // hanging. (After Fetch.disable, continue would error anyway.)
  for (const id of Array.from(pausedRequests.keys())) {
    safeContinue(id);
  }
  clearPausedRequests();
  if (wc && !wc.isDestroyed() && wc.debugger.isAttached()) {
    try {
      wc.debugger.sendCommand('Fetch.disable');
    } catch (err) {
      log.warn('Fetch.disable failed', { err: String(err) });
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Re-attach on guest navigation/reload                                        */
/* -------------------------------------------------------------------------- */

/**
 * Bind a navigation listener to the live guest so a reload/navigation triggers a
 * clean re-attach (the old WebContents' debugger detaches; capture would
 * silently die otherwise). Replaces any prior binding. The listener fires on the
 * SAME wc — after navigation it re-runs the capture path, which detaches the
 * stale attachment and re-enables Network (+ Fetch if interception was on),
 * keeping the renderer's flag honest via {@link emitStatus}.
 */
function bindNavListener(wc: WebContents): void {
  unbindNavListener();
  navHandler = () => {
    // The guest navigated. The debugger may still be attached to the same wc
    // (in-page nav) or have detached (full reload → the `detach` handler already
    // reset state). Re-run the capture path to restore Network.enable on the
    // live wc, then re-enable interception if it was on. Always resync the flag.
    try {
      reattachAfterNavigation();
    } catch (err) {
      log.warn('Re-attach after navigation failed', { err: String(err) });
    }
  };
  wc.on('did-navigate', navHandler);
  wc.on('did-frame-navigate', navHandler);
}

function unbindNavListener(): void {
  const wc = attached;
  if (wc && !wc.isDestroyed() && navHandler) {
    try {
      wc.removeListener('did-navigate', navHandler);
      wc.removeListener('did-frame-navigate', navHandler);
    } catch {
      // Ignore — the wc may already be gone.
    }
  }
  navHandler = null;
}

/**
 * After the guest navigates: re-establish Network.enable (+ Fetch if it was on)
 * on the live guest WebContents and push the true capture state to the renderer.
 * On a full reload the old debugger has detached and module state was reset by
 * the `detach` handler; we re-attach fresh. On an in-page navigation the
 * attachment survives and this is a near no-op beyond the status resync.
 */
function reattachAfterNavigation(): void {
  // If capture was never on, nothing to do.
  if (!capturing && !attached) return;

  const wantIntercept = intercepting;
  const wc = findGuestWebContents();

  if (!wc || wc.isDestroyed()) {
    // The preview went away. Reflect honest state.
    if (attached) detach();
    capturing = false;
    intercepting = false;
    emitStatus('Preview navigated away — capture paused.');
    return;
  }

  // Same live attachment survived (top-level in-page nav, OR — because
  // did-frame-navigate also fires for SUBFRAMES — a mere iframe navigation that
  // did NOT detach the debugger). In the subframe case the top document's held
  // requests are still live, so we must RELEASE them before dropping bookkeeping
  // — otherwise a cleared-but-still-paused request wedges the page (a later
  // Continue/Fulfill/Block finds no paused entry and never resolves it). Mirror
  // disableFetch's release-before-clear; safeContinue is best-effort so it is
  // harmless for the true full-nav case where some ids are already dead.
  if (attached === wc && wc.debugger.isAttached()) {
    for (const id of Array.from(pausedRequests.keys())) safeContinue(id);
    clearPausedRequests();
    emitStatus();
    return;
  }

  // Full reload: the prior debugger detached. Re-run the capture path on the
  // fresh wc, restoring interception if it was on.
  capturing = false;
  intercepting = false;
  const res = enableCaptureOn(wc, wantIntercept);
  emitStatus(
    res.capturing
      ? 'Preview reloaded — capture re-attached.'
      : (res.detail ?? 'Preview reloaded — capture could not re-attach.'),
  );
}

/* -------------------------------------------------------------------------- */
/*  Attach core (shared by enable + re-attach)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Attach the debugger to `wc`, enable Network, register the message handler and
 * nav listener, and (when `withIntercept`) enable Fetch. Sets module state on
 * success. Returns the effective state. Does NOT push status — callers decide.
 */
function enableCaptureOn(
  wc: WebContents,
  withIntercept: boolean,
): { capturing: boolean; intercepting: boolean; detail?: string } {
  // We were attached to a different or now-destroyed guest — tear it down first.
  if (attached && attached !== wc) detach();

  // Attach the debugger (no-op if we already own it on this wc).
  try {
    if (!wc.debugger.isAttached()) {
      wc.debugger.attach('1.3');
    }
  } catch (err) {
    log.warn('Debugger attach failed', { err: String(err) });
    return {
      capturing: false,
      intercepting: false,
      detail: 'Detach DevTools from the preview to capture network.',
    };
  }

  // (Re)register the message handler for THIS attachment.
  if (messageHandler) {
    try {
      wc.debugger.removeListener('message', messageHandler);
    } catch {
      // Ignore — the prior wc may already be gone.
    }
  }
  messageHandler = handleCdpMessage;
  wc.debugger.on('message', messageHandler);

  // If the protocol detaches under us (navigation, or another client attaching),
  // reset module state so a later enable re-attaches cleanly, and tell the
  // renderer capture has stopped so it doesn't falsely show "Capturing".
  wc.debugger.once('detach', () => {
    if (attached === wc) {
      capturing = false;
      intercepting = false;
      attached = null;
      messageHandler = null;
      clearPausedRequests();
      emitStatus('Preview reloaded — capture paused.');
    }
  });

  try {
    wc.debugger.sendCommand('Network.enable');
  } catch (err) {
    log.warn('Network.enable failed', { err: String(err) });
    detach();
    return {
      capturing: false,
      intercepting: false,
      detail: 'Could not enable network capture on the preview.',
    };
  }

  attached = wc;
  capturing = true;
  bindNavListener(wc);

  // Optionally layer Fetch interception on top.
  let interceptOk = false;
  if (withIntercept) {
    interceptOk = enableFetch(wc);
    intercepting = interceptOk;
  } else {
    intercepting = false;
  }

  log.info('Network capture enabled', { intercepting });
  return {
    capturing: true,
    intercepting,
    ...(withIntercept && !interceptOk ? { detail: 'Could not enable request interception.' } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Enable/disable the CDP network tap on the guest webview. Attaches the debugger
 * lazily on enable and detaches on disable. Returns the effective state plus a
 * human `detail` when capture could not be enabled. Disabling capture also tears
 * down any active interception.
 */
export function setNetworkCapture(enabled: boolean): {
  capturing: boolean;
  intercepting?: boolean;
  detail?: string;
} {
  if (!enabled) {
    detach();
    return { capturing: false, intercepting: false };
  }

  const wc = findGuestWebContents();
  if (!wc) {
    // No guest to attach to — drop any stale attachment so state stays honest.
    if (attached) detach();
    return { capturing: false, intercepting: false, detail: 'No preview is loaded.' };
  }

  // Already capturing on this exact, live guest — nothing to do.
  if (capturing && attached === wc && !wc.isDestroyed()) {
    return { capturing: true, intercepting };
  }

  const res = enableCaptureOn(wc, intercepting);
  return { capturing: res.capturing, intercepting: res.intercepting, detail: res.detail };
}

/**
 * Enable/disable OPT-IN request interception ("Burp" mode). Requires capture; if
 * capture is off when enabling, it is brought up first. Disabling interception
 * releases all paused requests and disables the Fetch domain but LEAVES passive
 * capture running.
 */
export function setNetworkIntercept(enabled: boolean): {
  intercepting: boolean;
  capturing: boolean;
  detail?: string;
} {
  if (!enabled) {
    if (intercepting) disableFetch();
    intercepting = false;
    emitStatus();
    return { intercepting: false, capturing };
  }

  // Enabling: ensure capture is up first.
  const wc = findGuestWebContents();
  if (!wc) {
    return { intercepting: false, capturing, detail: 'No preview is loaded.' };
  }

  if (!capturing || attached !== wc) {
    const res = enableCaptureOn(wc, true);
    emitStatus();
    return { intercepting: res.intercepting, capturing: res.capturing, detail: res.detail };
  }

  // Capture already up on this guest — just enable Fetch.
  if (!attached) {
    return { intercepting: false, capturing, detail: 'No active capture.' };
  }
  const ok = enableFetch(attached);
  intercepting = ok;
  emitStatus();
  return {
    intercepting: ok,
    capturing,
    ...(ok ? {} : { detail: 'Could not enable request interception.' }),
  };
}

/** Read the buffered network log (capped) + current capture state. */
export function getNetworkLog(): {
  entries: NetworkEntry[];
  capturing: boolean;
  intercepting: boolean;
} {
  const all = Array.from(entries.values());
  const capped = all.length > MAX_ENTRIES ? all.slice(all.length - MAX_ENTRIES) : all;
  return { entries: capped, capturing, intercepting };
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
  // Release any still-paused requests + disable Fetch BEFORE detaching so the
  // page can never be left wedged on a held request.
  if (intercepting || pausedRequests.size > 0) {
    disableFetch();
  }
  capturing = false;
  intercepting = false;
  unbindNavListener();
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
  clearPausedRequests();
  messageHandler = null;
  attached = null;
  // Push honest state so the renderer clears both Capturing AND Intercepting even
  // when the teardown was out-of-band (navigation, capture toggled off, quit).
  emitStatus();
}
