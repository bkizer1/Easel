/**
 * Easel — BrowserWindow creation and window helpers.
 *
 * Responsibilities:
 *  - Create the single main window with the correct webPreferences (contextIsolation,
 *    no nodeIntegration, sandbox:false so the HOST preload can expose `webviewPreloadUrl`,
 *    webviewTag:true).
 *  - Apply a strict but webview-friendly Content-Security-Policy via
 *    `session.defaultSession.webRequest`.
 *  - Load the renderer (dev: ELECTRON_RENDERER_URL env var; prod: file:// index.html).
 *  - Export helpers the IPC layer needs:
 *      getMainWindow()          — the current BrowserWindow or null
 *      capturePreview(box?)     — PNG data-URL from the webview via capturePage
 */

import { BrowserWindow, session } from 'electron';
import path from 'node:path';
import { createLogger } from '@main/logger';
import type { BoundingBox } from '@shared/types';

const log = createLogger('window');

/** Singleton reference to the main window. Null before creation or after close. */
let mainWindow: BrowserWindow | null = null;

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Returns the current main window, or null if it has not been created yet. */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/**
 * Pure selection of which guest WebContents id to capture.
 *
 * Extracted from {@link capturePreview} so it can be unit-tested without
 * Electron.  The caller is responsible for resolving the returned id back to an
 * actual WebContents object (only ever from the already-filtered guest list).
 *
 * Rules:
 *  - If `webContentsId` is provided AND present in `guestIds`, return it — this
 *    is the Responsive Matrix case where the renderer names a specific webview.
 *  - Else, if there are any guests, return the first one (today's behavior).
 *  - Else return `null`, meaning "no guest — fall back to the main window".
 *
 * Note we only ever select among ids the caller already filtered to real,
 * non-main, non-devtools guests; an arbitrary `webContentsId` that is not in
 * the list is intentionally ignored rather than trusted blindly.
 *
 * @param guestIds      - Ids of the filtered guest WebContents.
 * @param webContentsId - The renderer-requested target id, if any.
 * @returns The chosen guest id, or `null` to fall back to the main window.
 */
export function pickCaptureTargetId(
  guestIds: number[],
  webContentsId: number | undefined,
): number | null {
  if (webContentsId !== undefined && guestIds.includes(webContentsId)) {
    return webContentsId;
  }
  return guestIds.length > 0 ? guestIds[0] : null;
}

/**
 * Capture the contents of an embedded `<webview>` as a PNG data URL.
 *
 * The renderer cannot call `webContents.capturePage()` directly because it
 * has no Node access. The main process locates the webview's `WebContents`
 * among the non-main, non-devtools guests attached to the same session.
 *
 * The Responsive Matrix renders multiple `<webview>`s at once, so we can no
 * longer assume the first guest is the right one — the renderer passes a
 * specific `webContentsId` (from `<webview>.getWebContentsId()`) to name the
 * exact guest to capture.  When it is omitted (or does not match a known
 * guest) we fall back to the first guest, then to the full main window.
 *
 * @param box - Optional region in preview-viewport CSS pixels.  When omitted
 *              the full webview content is captured.
 * @param webContentsId - Optional id of the specific guest `<webview>` to
 *              capture (Responsive Matrix).  Ignored if it does not match a
 *              known guest.
 */
export async function capturePreview(box?: BoundingBox, webContentsId?: number): Promise<string> {
  const win = mainWindow;
  if (!win) throw new Error('No main window open');

  // Locate the webview guest WebContents.  The renderer loads the dev-server URL
  // inside a <webview>; its WebContents is registered as an "in-page" webContents
  // child.  We filter to non-main, non-devtools WebContents attached to the same
  // session, then let the pure selector pick which one to capture.
  const { webContents: WebContents } = await import('electron');
  const guests = WebContents.getAllWebContents().filter(
    (wc) => wc.id !== win.webContents.id && !wc.isDevToolsOpened(),
  );

  const targetId = pickCaptureTargetId(
    guests.map((wc) => wc.id),
    webContentsId,
  );
  const target =
    targetId !== null ? (guests.find((wc) => wc.id === targetId) ?? win.webContents) : win.webContents;

  const rect = box
    ? { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) }
    : undefined;

  const nativeImage = await target.capturePage(rect);
  const png = nativeImage.toPNG();
  return `data:image/png;base64,${png.toString('base64')}`;
}

/* -------------------------------------------------------------------------- */
/*  CSP header                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Inject a Content-Security-Policy header on every response served to the
 * renderer.  The policy is intentionally permissive for the embedded
 * `<webview>` (which loads arbitrary dev-server origins via the webview tag,
 * not the renderer frame), while locking down the renderer frame itself.
 *
 * Key decisions:
 *  - `default-src 'self'`               — only allow same-origin by default.
 *  - `script-src 'self' 'unsafe-inline' 'unsafe-eval'` — Vite dev HMR needs
 *    eval; unsafe-inline covers inline event handlers in the preload bridge.
 *    In production builds this could be tightened with a nonce.
 *  - `style-src 'self' 'unsafe-inline'` — Tailwind injects inline styles.
 *  - `img-src 'self' data: blob:`       — data URLs for screenshots/previews.
 *  - `connect-src 'self' ws: wss: http: https:` — allow HMR websocket +
 *    any HTTP(S) fetch the renderer makes (e.g. checking dev server status).
 *  - The embedded <webview> content is governed by its own CSP from the
 *    dev-server, not by this policy (webview frames are separate origins).
 */
function installCsp(isDev: boolean): void {
  // Vite HMR + React Fast Refresh need 'unsafe-eval' (and the HMR websocket) in
  // dev; the packaged renderer is a static bundle that never evals, so we drop it.
  const scriptSrc = isDev
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'";
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            scriptSrc,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: blob:",
            "font-src 'self' data:",
            "connect-src 'self' ws: wss: http: https:",
            "media-src 'self' blob:",
            "worker-src blob:",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
          ].join('; '),
        ],
      },
    });
  });
}

/* -------------------------------------------------------------------------- */
/*  Window factory                                                             */
/* -------------------------------------------------------------------------- */

/** Absolute path to the compiled HOST preload script. */
function preloadPath(): string {
  // Emitted as .cjs so Electron can require() it under "type": "module".
  // __dirname in the compiled main bundle is out/main/.
  return path.join(__dirname, '../preload/index.cjs');
}

/** Absolute path to the compiled GUEST inspector preload script. */
function inspectorPreloadPath(): string {
  return path.join(__dirname, '../preload/webview/inspector.cjs');
}

/**
 * Create (or re-use) the main BrowserWindow.  Safe to call multiple times;
 * if the window already exists and is not destroyed, it is focused instead.
 */
export function createMainWindow(): BrowserWindow {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.focus();
    return mainWindow;
  }

  installCsp(Boolean(process.env['ELECTRON_RENDERER_URL']));

  const preload = preloadPath();
  const inspectorPreload = inspectorPreloadPath();

  log.info('Creating BrowserWindow', { preload, inspectorPreload });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false, // shown after ready-to-show to prevent flash
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    // Vertically centre the macOS window controls within the 48px title bar.
    trafficLightPosition: { x: 16, y: 17 },
    backgroundColor: '#06080c',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      // sandbox:false is REQUIRED so the host preload can use `__dirname` to
      // build the absolute `webviewPreloadUrl` and expose it to the renderer via
      // contextBridge.  The renderer itself remains fully sandboxed (no Node).
      sandbox: false,
      webviewTag: true,
      // Disable navigation outside the renderer bundle.
      navigateOnDragDrop: false,
      // Pass the inspector preload path as an additional context so the
      // host preload can expose it as `window.easel.webviewPreloadUrl`.
      additionalArguments: [`--webview-preload=${inspectorPreload}`],
    },
  });

  // Dev diagnostics: surface renderer console + load/preload failures in the
  // main log (and open devtools) so blank-screen errors are visible.
  if (process.env['ELECTRON_RENDERER_URL']) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      log.info('renderer console', { level, message, source: `${sourceId}:${line}` });
    });
    win.webContents.on('preload-error', (_e, preloadPath, error) => {
      log.error('preload error', { preloadPath, error: String(error) });
    });
    win.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log.error('renderer did-fail-load', { code, desc, url });
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      log.error('render-process-gone', { reason: details.reason });
    });
  }

  // Prevent flash on first paint.
  win.once('ready-to-show', () => {
    win.show();
    log.info('Window ready to show');
  });

  // Load renderer.
  const rendererUrl = process.env['ELECTRON_RENDERER_URL'];
  if (rendererUrl) {
    log.info('Loading renderer from dev URL', { url: rendererUrl });
    win.loadURL(rendererUrl);
  } else {
    const indexHtml = path.join(__dirname, '../renderer/index.html');
    log.info('Loading renderer from file', { path: indexHtml });
    win.loadFile(indexHtml);
  }

  // Cleanup.
  win.on('closed', () => {
    mainWindow = null;
    log.info('Window closed');
  });

  // Prevent the window from navigating away from the renderer (security).
  win.webContents.on('will-navigate', (evt, url) => {
    const allowed = rendererUrl
      ? url.startsWith(rendererUrl)
      : url.startsWith('file://');
    if (!allowed) {
      log.warn('Blocked renderer navigation', { url });
      evt.preventDefault();
    }
  });

  // Authoritatively enforce <webview> sandboxing from the trusted main process,
  // regardless of the renderer-side `webpreferences` attribute (defense in depth).
  win.webContents.on('will-attach-webview', (_evt, webPreferences) => {
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
  });

  mainWindow = win;
  return win;
}
