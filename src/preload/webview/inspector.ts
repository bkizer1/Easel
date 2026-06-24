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
import type { BoundingBox, ConfidenceLevel, ElementTarget, SourceLocation } from '@shared/types';
import type { InspectorCommand, InspectorMessage } from '@shared/ipc';

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
/*  Viewport change reporting                                                  */
/* -------------------------------------------------------------------------- */

let viewportThrottleTimer: ReturnType<typeof setTimeout> | null = null;
const VIEWPORT_THROTTLE_MS = 100;

function sendViewportChanged(): void {
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
