/**
 * Easel — Webview Guest Inspector
 *
 * Injected into the dev-server page via the `<webview preload="...">` attribute.
 * Runs in the guest page's isolated context: full DOM access, Electron
 * `ipcRenderer.sendToHost` for outbound messages, and `ipcRenderer.on` for
 * inbound `InspectorCommand`s from the host renderer. Never reaches host
 * renderer JS or the main process directly.
 *
 * ── Channel contract ──────────────────────────────────────────────────────────
 *
 * OUTBOUND  (guest → host)   via `ipcRenderer.sendToHost(channel, payload)`
 *   channel: 'inspector-message'
 *   payload: InspectorMessage   (typed union from src/shared/ipc.ts)
 *
 * INBOUND   (host → guest)   via `<webview>.send(channel, payload)`
 *   channel: 'inspector-command'
 *   payload: InspectorCommand   (typed union from src/shared/ipc.ts)
 *
 * The PreviewPane renderer component must:
 *   - listen on `webviewEl.addEventListener('ipc-message', e => ...)` and
 *     dispatch on `e.channel === 'inspector-message'`
 *   - send commands with `webviewEl.send('inspector-command', cmd)`
 *
 * ── Design notes ─────────────────────────────────────────────────────────────
 *
 * - Everything is wrapped in a top-level try/catch so a bug here can never
 *   break the host page; errors are logged to the guest console only.
 * - No external dependencies — this file is compiled to a standalone CJS
 *   bundle by electron-vite and must be self-contained.
 * - All bounding-box coordinates are in viewport CSS px (from
 *   `getBoundingClientRect`), which matches the `BoundingBox` type contract.
 * - `viewport-changed` throttled to one event per 100 ms.
 */

import { ipcRenderer } from 'electron';
import type {
  BoundingBox,
  ConfidenceLevel,
  ElementTarget,
  OffGridElement,
  SourceLocation,
} from '@shared/types';
import type { InspectorCommand, InspectorMessage } from '@shared/ipc';
import { columnEdges, measureMisalignment, type GridConfig } from '@shared/grid';

/* -------------------------------------------------------------------------- */
/*  Channel names (single source — PreviewPane must match these)              */
/* -------------------------------------------------------------------------- */

/** Channel on which the guest sends `InspectorMessage` payloads to the host. */
const OUT_CHANNEL = 'inspector-message' as const;

/** Channel on which the host sends `InspectorCommand` payloads to the guest. */
const IN_CHANNEL = 'inspector-command' as const;

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

/** The current interaction mode set by the host via `set-mode`. */
type InspectorMode = 'idle' | 'element-select' | 'freeform';
let mode: InspectorMode = 'idle';

/** The overlay div used to highlight the currently hovered / commanded element. */
let highlightEl: HTMLDivElement | null = null;

/** The alignment-grid overlay container (issue #5), or null when hidden. */
let gridEl: HTMLDivElement | null = null;

/** The grid config the overlay is currently drawn with, so we can redraw on resize. */
let gridConfig: GridConfig | null = null;

/* -------------------------------------------------------------------------- */
/*  Helpers — messaging                                                        */
/* -------------------------------------------------------------------------- */

/** Send a typed `InspectorMessage` to the host renderer. */
function send(msg: InspectorMessage): void {
  try {
    ipcRenderer.sendToHost(OUT_CHANNEL, msg);
  } catch (err) {
    // If the webview is being destroyed, sendToHost may throw; swallow it.
    console.error('[Easel:inspector] sendToHost failed:', err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers — CSS selector computation                                         */
/* -------------------------------------------------------------------------- */

/**
 * Build a robust, unique CSS selector for `el`.
 *
 * Priority:
 *  1. Unique `#id` (document-unique)
 *  2. `[data-testid]`, `[data-cy]`, `[data-test]`, `[aria-label]` (stable semantics)
 *  3. Path of `tag:nth-of-type(n)` segments up to the nearest unique ancestor
 *     (resilient to sibling additions; prefers shallower selectors)
 */
function buildSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;

  while (current && current !== document.documentElement) {
    const tag = current.tagName.toLowerCase();

    // 1. Unique id
    if (current.id) {
      const escaped = CSS.escape(current.id);
      if (document.querySelectorAll(`#${escaped}`).length === 1) {
        parts.unshift(`#${escaped}`);
        return parts.join(' > ');
      }
    }

    // 2. Stable semantic attributes
    const testId = current.getAttribute('data-testid');
    if (testId) {
      parts.unshift(`${tag}[data-testid="${CSS.escape(testId)}"]`);
      return parts.join(' > ');
    }
    const dataCy = current.getAttribute('data-cy');
    if (dataCy) {
      parts.unshift(`${tag}[data-cy="${CSS.escape(dataCy)}"]`);
      return parts.join(' > ');
    }
    const dataTest = current.getAttribute('data-test');
    if (dataTest) {
      parts.unshift(`${tag}[data-test="${CSS.escape(dataTest)}"]`);
      return parts.join(' > ');
    }
    const ariaLabel = current.getAttribute('aria-label');
    if (ariaLabel) {
      parts.unshift(`${tag}[aria-label="${CSS.escape(ariaLabel)}"]`);
      return parts.join(' > ');
    }

    // 3. :nth-of-type among siblings with the same tag
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter(
          (s) => s.tagName === current!.tagName,
        )
      : [];
    const idx = siblings.indexOf(current as Element) + 1;
    parts.unshift(idx > 1 ? `${tag}:nth-of-type(${idx})` : tag);

    current = current.parentElement;
  }

  return parts.join(' > ') || el.tagName.toLowerCase();
}

/* -------------------------------------------------------------------------- */
/*  Helpers — source-attribute parsing                                         */
/* -------------------------------------------------------------------------- */

/**
 * Walk up the DOM tree from `el` to find the nearest element (including `el`
 * itself) that carries a `data-easel-source` attribute. Stops at `<html>`.
 */
function findSourceElement(el: Element): Element | null {
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    if (current.hasAttribute('data-easel-source')) return current;
    current = current.parentElement;
  }
  return null;
}

/**
 * Parse `"relativeFile:line:col"` (as stamped by `@easel/vite-plugin-inspector`)
 * into a `SourceLocation`. Returns `undefined` if the value is malformed.
 */
function parseSourceAttr(value: string): SourceLocation | undefined {
  // Format: "src/components/Button.tsx:34:5"
  // The file path may contain colons on Windows (e.g. "C:/foo:1:1"), so we
  // split from the right to find line+col.
  const lastColon = value.lastIndexOf(':');
  if (lastColon <= 0) return undefined;
  const withoutCol = value.slice(0, lastColon);
  const col = parseInt(value.slice(lastColon + 1), 10);

  const secondLastColon = withoutCol.lastIndexOf(':');
  if (secondLastColon <= 0) return undefined;
  const filePath = withoutCol.slice(0, secondLastColon);
  const line = parseInt(withoutCol.slice(secondLastColon + 1), 10);

  if (!filePath || isNaN(line) || isNaN(col) || line < 1 || col < 1) return undefined;
  return { filePath, line, column: col };
}

/* -------------------------------------------------------------------------- */
/*  Helpers — stack-frame parsing (uncaught page errors)                       */
/* -------------------------------------------------------------------------- */

/**
 * Convert a stack-frame URL into a project-relative file path, or `undefined`
 * when the frame is not a project source file.
 *
 * Dev-server stacks point at served module URLs, e.g.
 *   `http://localhost:3000/src/App.tsx`
 *   `http://localhost:5173/src/components/Hero.tsx?t=1700000000000` (Vite HMR)
 * We strip the origin (so the path is rooted at the served web root, which the
 * agent treats as project-relative) and any `?query`/`#hash` suffix. Frames in
 * `node_modules`, Vite's `/@`-prefixed internals, or non-http(s) schemes
 * (`<anonymous>`, `eval`, browser extensions) are rejected.
 */
function frameUrlToFilePath(rawUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return undefined; // not an absolute URL (e.g. "<anonymous>")
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;

  // Drop the leading slash so the path is project-relative (`src/App.tsx`).
  const path = url.pathname.replace(/^\/+/, '');
  if (!path) return undefined;

  // Vite internals (`/@vite/...`, `/@react-refresh`) and dependencies are not
  // editable project source — skip them so we target the user's own file.
  if (path.startsWith('@') || path.includes('node_modules')) return undefined;

  return path;
}

/**
 * Parse the `Error.stack` string into ordered {@link SourceLocation}s for the
 * project's own frames (top frame first). Handles both V8/Chromium formats:
 *   `    at fnName (http://host/src/App.tsx:12:5)`
 *   `    at http://host/src/App.tsx:12:5`
 * Non-project frames are dropped; the result is de-duplicated by file:line and
 * capped to keep the edit instruction focused on the most likely culprits.
 */
function parseStackFrames(stack: string | undefined): SourceLocation[] {
  if (!stack) return [];

  const FRAME_RE = /\(?((?:https?:)\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/;
  const out: SourceLocation[] = [];
  const seen = new Set<string>();
  const MAX_FRAMES = 5;

  for (const line of stack.split('\n')) {
    const m = FRAME_RE.exec(line.trim());
    if (!m) continue;

    const filePath = frameUrlToFilePath(m[1]);
    if (!filePath) continue;

    const lineNo = parseInt(m[2], 10);
    const column = parseInt(m[3], 10);
    if (isNaN(lineNo) || isNaN(column) || lineNo < 1 || column < 1) continue;

    const key = `${filePath}:${lineNo}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ filePath, line: lineNo, column });
    if (out.length >= MAX_FRAMES) break;
  }

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Helpers — ElementTarget construction                                       */
/* -------------------------------------------------------------------------- */

/** Whitelisted attribute names captured on every target. */
const ATTRIBUTE_ALLOWLIST: readonly string[] = [
  'id',
  'class',
  'src',
  'alt',
  'href',
  'data-testid',
  'role',
  'aria-label',
  'type',
  'name',
];

/** Maximum length for `textSnippet`. */
const TEXT_SNIPPET_MAX = 200;

/** Counter for stable intra-session target ids. */
let targetIdCounter = 0;

/**
 * Assemble a fully-resolved `ElementTarget` from a DOM element.
 * The `id` field uses a session counter so it is unique within one page load
 * (the host may further namespace it with the requestId).
 */
function buildElementTarget(el: Element): ElementTarget {
  const rect = el.getBoundingClientRect();
  const boundingBox: BoundingBox = {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };

  // Source attribute — prefer the exact element, then walk ancestors.
  const sourceEl = findSourceElement(el);
  const rawSource = sourceEl?.getAttribute('data-easel-source') ?? null;
  const dataEaselSource = rawSource ? parseSourceAttr(rawSource) : undefined;
  const pluginPresent = dataEaselSource !== undefined;

  // Confidence: high when plugin attribute is present and parsed, else medium
  // (the agent may further downgrade after disk verification).
  const confidence: ConfidenceLevel = pluginPresent ? 'high' : 'medium';

  // Whitelisted attributes
  const attributes: Record<string, string> = {};
  for (const name of ATTRIBUTE_ALLOWLIST) {
    const val = el.getAttribute(name);
    if (val !== null) attributes[name] = val;
  }

  // Trimmed text snippet
  const rawText = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
  const textSnippet = rawText.length > TEXT_SNIPPET_MAX
    ? rawText.slice(0, TEXT_SNIPPET_MAX) + '…'
    : rawText;

  return {
    id: `et-${++targetIdCounter}`,
    selector: buildSelector(el),
    tagName: el.tagName.toLowerCase(),
    dataEaselSource,
    boundingBox,
    textSnippet,
    attributes,
    pluginPresent,
    confidence,
  };
}

/* -------------------------------------------------------------------------- */
/*  Helpers — bounding box from selector                                       */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a CSS selector to its first matching element and return an
 * `ElementTarget`. Returns `null` if no element matches.
 */
function resolveSelector(selector: string): ElementTarget | null {
  try {
    const el = document.querySelector(selector);
    if (!el) return null;
    return buildElementTarget(el);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers — highlight overlay                                                */
/* -------------------------------------------------------------------------- */

/** Remove the current highlight overlay if it exists. */
function removeHighlight(): void {
  if (highlightEl) {
    highlightEl.remove();
    highlightEl = null;
  }
}

/**
 * Draw an absolutely-positioned highlight box over the given element.
 * Uses `getBoundingClientRect` + `scrollX/scrollY` so it stays aligned
 * when the page is scrolled (the overlay is placed in the document, not
 * the viewport).
 */
function drawHighlight(el: Element, color = '#3b82f6'): void {
  removeHighlight();
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;

  const div = document.createElement('div');
  div.setAttribute('data-easel-overlay', 'true');

  const top = rect.top + window.scrollY;
  const left = rect.left + window.scrollX;

  div.style.cssText = [
    'position:absolute',
    `top:${top}px`,
    `left:${left}px`,
    `width:${rect.width}px`,
    `height:${rect.height}px`,
    `outline:2px solid ${color}`,
    'outline-offset:-1px',
    'pointer-events:none',
    'z-index:2147483647',
    'box-sizing:border-box',
    'background:transparent',
  ].join(';');

  document.documentElement.appendChild(div);
  highlightEl = div;
}

/* -------------------------------------------------------------------------- */
/*  Helpers — alignment grid overlay (issue #5)                                */
/* -------------------------------------------------------------------------- */

/** Remove the alignment-grid overlay if present. */
function removeGrid(): void {
  if (gridEl) {
    gridEl.remove();
    gridEl = null;
  }
}

/**
 * Draw a column + baseline alignment grid over the full document, appended to
 * `document.documentElement` (same pattern as {@link drawHighlight}). Columns
 * are vertical bands at the computed {@link columnEdges}; the baseline rhythm is
 * a repeating horizontal hairline every `grid.baseline` px. Purely visual and
 * non-interactive — `pointer-events:none` so it never intercepts the page.
 */
function drawGrid(grid: GridConfig): void {
  removeGrid();
  gridConfig = grid;

  // Size to the scrollable document, not just the viewport, so the grid covers
  // the whole page as the user scrolls.
  const docWidth = Math.max(
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  );
  const docHeight = Math.max(
    document.documentElement.scrollHeight,
    document.documentElement.clientHeight,
  );
  const viewportWidth = document.documentElement.clientWidth;

  const container = document.createElement('div');
  container.setAttribute('data-easel-overlay', 'true');
  container.setAttribute('data-easel-grid', 'true');
  container.style.cssText = [
    'position:absolute',
    'top:0',
    'left:0',
    `width:${docWidth}px`,
    `height:${docHeight}px`,
    'pointer-events:none',
    'z-index:2147483646', // just below the element highlight
  ].join(';');

  // Column bands: shade each column lightly between its start/end edges.
  const edges = columnEdges(grid, viewportWidth);
  for (let i = 0; i + 1 < edges.length; i += 2) {
    const start = edges[i];
    const end = edges[i + 1];
    const band = document.createElement('div');
    band.style.cssText = [
      'position:absolute',
      'top:0',
      'bottom:0',
      `left:${start}px`,
      `width:${end - start}px`,
      'background:rgba(59,130,246,0.08)',
      'box-shadow:inset 1px 0 0 rgba(59,130,246,0.35),inset -1px 0 0 rgba(59,130,246,0.35)',
    ].join(';');
    container.appendChild(band);
  }

  // Baseline rhythm: a single repeating-linear-gradient hairline layer is far
  // cheaper than one element per row on a long page.
  if (grid.baseline > 0) {
    const baselines = document.createElement('div');
    baselines.style.cssText = [
      'position:absolute',
      'inset:0',
      `background-image:repeating-linear-gradient(to bottom, rgba(236,72,153,0.18) 0, rgba(236,72,153,0.18) 1px, transparent 1px, transparent ${grid.baseline}px)`,
    ].join(';');
    container.appendChild(baselines);
  }

  document.documentElement.appendChild(container);
  gridEl = container;
}

/* -------------------------------------------------------------------------- */
/*  Helpers — off-grid detector (issue #5)                                     */
/* -------------------------------------------------------------------------- */

/** Stable id counter for off-grid offenders within one scan. */
let offGridIdCounter = 0;

/** Whether an element is currently visible (has a non-trivial painted box). */
function isVisibleElement(el: Element): boolean {
  if (el === document.documentElement || el === document.body) return false;
  if (el.hasAttribute('data-easel-overlay')) return false;
  const rect = el.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1) return false;
  // Skip elements scrolled entirely out of (or above) the document viewport
  // area; measuring those adds noise without helping the user.
  if (rect.bottom < 0 || rect.right < 0) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  return true;
}

/**
 * Walk visible elements and flag those whose edges miss `grid` by more than
 * `threshold` px. Returns offenders worst-first, each tagged with its
 * `data-easel-source` (when the inspector plugin stamped it) so the host can
 * route a "snap to grid" edit to the right source. Capped so a giant DOM can't
 * flood the host.
 */
function scanOffGrid(grid: GridConfig, threshold: number): OffGridElement[] {
  const MAX_OFFENDERS = 100;
  const viewportWidth = document.documentElement.clientWidth;

  const offenders: OffGridElement[] = [];
  const all = document.querySelectorAll('body *');
  for (const el of Array.from(all)) {
    if (!isVisibleElement(el)) continue;

    const rect = el.getBoundingClientRect();
    const box: BoundingBox = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
    const m = measureMisalignment(box, grid, viewportWidth);
    if (m.worst <= threshold) continue;

    const sourceEl = findSourceElement(el);
    const rawSource = sourceEl?.getAttribute('data-easel-source') ?? null;
    const dataEaselSource = rawSource ? parseSourceAttr(rawSource) : undefined;

    offenders.push({
      id: `og-${++offGridIdCounter}`,
      selector: buildSelector(el),
      tagName: el.tagName.toLowerCase(),
      dataEaselSource,
      boundingBox: box,
      worstOffsetPx: Math.round(m.worst * 100) / 100,
    });
  }

  offenders.sort((a, b) => b.worstOffsetPx - a.worstOffsetPx);
  return offenders.slice(0, MAX_OFFENDERS);
}

/* -------------------------------------------------------------------------- */
/*  Mouse event handlers (element-select mode)                                */
/* -------------------------------------------------------------------------- */

/** Most recently hovered element, used by click handler to avoid re-computation. */
let lastHoveredEl: Element | null = null;

/** Throttle state for mousemove. */
let moveScheduled = false;

function onMouseMove(event: MouseEvent): void {
  if (mode !== 'element-select') return;
  if (moveScheduled) return;
  moveScheduled = true;

  // Defer to next animation frame so rapid moves don't flood the host.
  requestAnimationFrame(() => {
    moveScheduled = false;
    if (mode !== 'element-select') return;

    try {
      // Hit-test at the mouse position, skipping our own overlay element.
      const els = document.elementsFromPoint(event.clientX, event.clientY);
      const el = els.find(
        (e) => !e.hasAttribute('data-easel-overlay') && e !== document.documentElement,
      );
      if (!el) return;
      lastHoveredEl = el;

      const rect = el.getBoundingClientRect();
      const boundingBox: BoundingBox = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };

      drawHighlight(el);

      send({
        type: 'element-hover',
        boundingBox,
        tagName: el.tagName.toLowerCase(),
        selector: buildSelector(el),
      });
    } catch (err) {
      console.error('[Easel:inspector] mousemove error:', err);
    }
  });
}

function onClick(event: MouseEvent): void {
  if (mode !== 'element-select') return;

  try {
    event.preventDefault();
    event.stopPropagation();

    // Prefer the element we already identified on last mousemove for consistency.
    const els = document.elementsFromPoint(event.clientX, event.clientY);
    const el = els.find(
      (e) => !e.hasAttribute('data-easel-overlay') && e !== document.documentElement,
    ) ?? lastHoveredEl;

    if (!el) return;

    const target = buildElementTarget(el);
    send({ type: 'element-picked', target });
  } catch (err) {
    console.error('[Easel:inspector] click error:', err);
  }
}

/* -------------------------------------------------------------------------- */
/*  Uncaught page-error reporting                                              */
/* -------------------------------------------------------------------------- */

/**
 * Serialize an uncaught error into a `page-error` message and post it to the
 * host. Shared by the `error` and `unhandledrejection` listeners. `error` is
 * the thrown value (any type — promise rejections can reject with non-Errors),
 * `fallbackMessage` is used when no `.message` is available.
 */
function reportPageError(error: unknown, fallbackMessage: string): void {
  try {
    // `error` may be an Error, a string, or any rejected value; normalize both
    // the message and the (optional) stack defensively.
    const isErr = error instanceof Error;
    const message = isErr
      ? error.message || fallbackMessage
      : typeof error === 'string'
        ? error
        : fallbackMessage;
    const stack = isErr && typeof error.stack === 'string' ? error.stack : undefined;

    send({
      type: 'page-error',
      message,
      stack,
      // Stacks are sourcemapped to original files in dev, so the parsed
      // locations point at the user's actual source.
      sources: parseStackFrames(stack),
    });
  } catch (err) {
    console.error('[Easel:inspector] reportPageError failed:', err);
  }
}

/** `window.onerror` — synchronous uncaught exceptions. */
function onWindowError(event: ErrorEvent): void {
  // Prefer the rich Error object (carries a sourcemapped stack); fall back to
  // the plain message string ErrorEvent always provides.
  reportPageError(event.error ?? event.message, event.message || 'Uncaught error');
}

/** `window.onunhandledrejection` — promises that reject with no `.catch`. */
function onUnhandledRejection(event: PromiseRejectionEvent): void {
  reportPageError(event.reason, 'Unhandled promise rejection');
}

/* -------------------------------------------------------------------------- */
/*  Viewport change reporting                                                  */
/* -------------------------------------------------------------------------- */

let viewportThrottleTimer: ReturnType<typeof setTimeout> | null = null;
const VIEWPORT_THROTTLE_MS = 100;

function sendViewportChanged(): void {
  // Keep the alignment grid sized/positioned to the (possibly resized) document.
  if (gridConfig) drawGrid(gridConfig);

  send({
    type: 'viewport-changed',
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    width: window.innerWidth,
    height: window.innerHeight,
  });
}

function onViewportChanged(): void {
  if (viewportThrottleTimer !== null) return;
  viewportThrottleTimer = setTimeout(() => {
    viewportThrottleTimer = null;
    try {
      sendViewportChanged();
    } catch (err) {
      console.error('[Easel:inspector] viewport-changed error:', err);
    }
  }, VIEWPORT_THROTTLE_MS);
}

/* -------------------------------------------------------------------------- */
/*  Region query (freeform mode)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Grid-sample `document.elementsFromPoint` across `box` to find all DOM elements
 * that intersect the annotation region. Ranks candidates by hit-count (proxy for
 * overlap fraction), filters out the document root and our own overlay, and
 * returns fully resolved `ElementTarget[]`.
 *
 * Grid: 6×6 = 36 sample points (including edges) for good coverage without being
 * expensive on large pages.
 */
function queryRegion(box: BoundingBox): ElementTarget[] {
  const GRID = 6;
  const counts = new Map<Element, number>();

  for (let xi = 0; xi <= GRID; xi++) {
    for (let yi = 0; yi <= GRID; yi++) {
      const px = box.x + (box.width / GRID) * xi;
      const py = box.y + (box.height / GRID) * yi;
      try {
        const hits = document.elementsFromPoint(px, py);
        for (const hit of hits) {
          if (
            hit === document.documentElement ||
            hit === document.body ||
            hit.hasAttribute('data-easel-overlay')
          ) {
            continue;
          }
          counts.set(hit, (counts.get(hit) ?? 0) + 1);
        }
      } catch {
        // elementsFromPoint may throw on out-of-range coords; skip.
      }
    }
  }

  // Sort by hit-count descending (highest overlap first), then by DOM depth
  // ascending (prefer shallower / more specific elements over deep wrappers).
  const domDepth = (el: Element): number => {
    let depth = 0;
    let cur: Element | null = el;
    while (cur && cur !== document.documentElement) {
      depth++;
      cur = cur.parentElement;
    }
    return depth;
  };

  const sorted = Array.from(counts.entries()).sort(([aEl, aCount], [bEl, bCount]) => {
    if (bCount !== aCount) return bCount - aCount;
    // Shallower element (fewer ancestors) is preferred over deeply nested wrappers.
    return domDepth(aEl) - domDepth(bEl);
  });

  return sorted.map(([el]) => buildElementTarget(el));
}

/* -------------------------------------------------------------------------- */
/*  InspectorCommand handler                                                   */
/* -------------------------------------------------------------------------- */

ipcRenderer.on(
  IN_CHANNEL,
  (_event: Electron.IpcRendererEvent, cmd: InspectorCommand) => {
    try {
      switch (cmd.type) {
        case 'set-mode': {
          mode = cmd.mode;
          // Clear highlight when leaving element-select mode.
          if (mode !== 'element-select') removeHighlight();
          break;
        }

        case 'highlight': {
          if (cmd.selector === null) {
            removeHighlight();
          } else {
            try {
              const el = document.querySelector(cmd.selector);
              if (el) drawHighlight(el);
              else removeHighlight();
            } catch {
              removeHighlight();
            }
          }
          break;
        }

        case 'request-target': {
          const target = resolveSelector(cmd.selector);
          if (target) {
            send({ type: 'element-picked', target });
          }
          break;
        }

        case 'query-region': {
          const targets = queryRegion(cmd.box);
          send({ type: 'region-resolved', queryId: cmd.queryId, targets });
          break;
        }

        case 'set-grid': {
          if (cmd.grid === null) removeGrid();
          else drawGrid(cmd.grid);
          break;
        }

        case 'scan-off-grid': {
          const offenders = scanOffGrid(cmd.grid, cmd.threshold);
          send({ type: 'off-grid-result', scanId: cmd.scanId, offenders });
          break;
        }

        default: {
          // Exhaustiveness guard — new command types should be handled above.
          const _exhaustive: never = cmd;
          console.warn('[Easel:inspector] unknown command:', _exhaustive);
        }
      }
    } catch (err) {
      console.error('[Easel:inspector] command handler error:', err);
    }
  },
);

/* -------------------------------------------------------------------------- */
/*  DOM event listener registration                                            */
/* -------------------------------------------------------------------------- */

// Capture-phase listeners so we intercept before the page's own handlers.
document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
document.addEventListener('click', onClick, { capture: true });

window.addEventListener('scroll', onViewportChanged, { passive: true });
window.addEventListener('resize', onViewportChanged, { passive: true });

// Uncaught runtime errors and unhandled rejections → Page Console "Fix" button.
// We only observe (never preventDefault) so the page's own error handling and
// the host `console-message` capture are unaffected.
window.addEventListener('error', onWindowError);
window.addEventListener('unhandledrejection', onUnhandledRejection);

/* -------------------------------------------------------------------------- */
/*  DOMContentLoaded — initial ready signal                                    */
/* -------------------------------------------------------------------------- */

function onDOMReady(): void {
  try {
    // Detect whether the Vite inspector plugin stamped any elements.
    const hasSourceAttributes = document.querySelector('[data-easel-source]') !== null;
    send({ type: 'inspector-ready', hasSourceAttributes });

    // Emit an initial viewport snapshot so the overlay can position correctly
    // before any scroll/resize events.
    sendViewportChanged();
  } catch (err) {
    console.error('[Easel:inspector] DOMContentLoaded handler error:', err);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onDOMReady, { once: true });
} else {
  // Document already parsed (e.g. injected after load); fire immediately.
  onDOMReady();
}
