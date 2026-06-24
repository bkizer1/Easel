# Element-to-Source Mapping — Deep Technical Design

**Subsystem:** `@easel/vite-plugin-inspector` + webview preload inspector + agent-side fallback resolution

---

## 1. The Problem

When a developer clicks a rendered DOM element in the Easel preview pane and says "make this button blue," the agent must know exactly which source file to open, on which line, in which column. Getting this right is the hardest reliability problem in the entire system.

### Why naive approaches fail

**Inspecting `bundle.js` is useless.** Modern bundlers (Vite/Rollup, Webpack, esbuild) tree-shake, inline, rename, and concatenate modules. The rendered DOM element `<button class="btn-primary">` exists nowhere as a string in the output. Even with source maps, the map gives you a character offset in a transformed module — not a human-readable component line.

**CSS-in-JS class names are ephemeral.** Tailwind's JIT compiler, CSS Modules, and runtime-CSS-in-JS libraries (Emotion, styled-components) generate class names that encode a hash, not a location. `class="bg-blue-500 jss4a2f"` gives you zero information about which JSX file rendered this node.

**Runtime-generated DOM cannot be traced post-hoc.** Frameworks like React insert comment nodes, fragment markers, and wrapper divs. A list rendered by `Array.map()` produces ten `<li>` elements; without instrumentation you cannot tell which JSX expression produced which one, let alone the line number.

**`document.currentScript` is not available at render time.** This is synchronous script metadata; there is no equivalent that tags rendered markup.

**Partial hydration and SSR make it worse.** Next.js and Astro pages may render markup on the server and hydrate on the client, blending server-side paths with client-side component boundaries. The DOM you see may not be the DOM the framework rendered on this machine.

---

## 2. Primary Approach: The Vite Plugin Inspector

### Overview

`packages/vite-plugin-inspector` is a Vite plugin that runs exclusively in development mode. It intercepts the JSX/TSX transform pipeline and annotates every JSX element's opening tag with a `data-easel-source` attribute whose value is `"relativeFile:line:col"`.

After transformation, a rendered button that originated in `src/components/Button.tsx` line 34, column 5 will appear in the DOM as:

```html
<button data-easel-source="src/components/Button.tsx:34:5" class="btn-primary">
```

This attribute survives into the final rendered DOM regardless of what React, Vue, or any other framework does with it, because HTML data attributes are opaque to frameworks.

### Plugin registration

The developer adds the plugin to their project's `vite.config.ts`:

```ts
import { easelInspector } from '@easel/vite-plugin-inspector';

export default defineConfig({
  plugins: [
    react(),
    easelInspector(),  // must come after the framework plugin
  ],
});
```

Easel's UI will detect whether the plugin is active by checking for the presence of `data-easel-source` on the first inspected element. If absent, it falls back to the agent-side resolution path described in Section 4.

### Dev-only guard

The plugin checks `config.command === 'serve'` inside its `configResolved` hook and exits early (returning the source unchanged) when building for production. This ensures zero overhead and zero attribute leakage in production bundles.

```ts
export function easelInspector(): Plugin {
  let isDev = false;
  return {
    name: 'easel-inspector',
    configResolved(config) {
      isDev = config.command === 'serve';
    },
    transform(code, id) {
      if (!isDev) return null;
      if (!/\.[jt]sx?$/.test(id)) return null;
      return transformSource(code, id, config.root);
    },
  };
}
```

### AST transform: React / JSX-TSX

The transform uses Babel (via `@babel/core` + `@babel/parser` + `@babel/traverse` + `@babel/generator`) to walk the JSX AST. The choice of Babel over SWC is intentional: SWC's Rust-side plugin API is not yet stable in the Node ecosystem for Vite; esbuild does not expose a JSX visitor. Babel is slower but fully capable for dev-only use.

The visitor targets `JSXOpeningElement` nodes. For each node it:

1. Reads the node's `loc.start` (line and column, already 1-based from `@babel/parser` with `startLine: 1`).
2. Computes a relative path from `config.root` to the absolute `id` of the module.
3. Constructs the attribute string `relativeFile:line:col`.
4. Injects a `JSXAttribute` node for `data-easel-source` **only if one does not already exist** (idempotency guard for fast-refresh re-transforms).

```ts
import * as t from '@babel/types';
import traverse from '@babel/traverse';
import { parse } from '@babel/parser';
import generate from '@babel/generator';
import path from 'node:path';

export function transformSource(
  code: string,
  absoluteId: string,
  projectRoot: string,
): { code: string; map: any } | null {
  const relativeId = path.relative(projectRoot, absoluteId);
  let ast: t.File;
  try {
    ast = parse(code, {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
      sourceFilename: absoluteId,
    });
  } catch {
    return null; // parse failure; let the framework plugin handle errors
  }

  traverse(ast, {
    JSXOpeningElement(nodePath) {
      const { node } = nodePath;
      const loc = node.loc?.start;
      if (!loc) return;

      // Idempotency: skip if already stamped
      const alreadyStamped = node.attributes.some(
        (attr) =>
          t.isJSXAttribute(attr) &&
          t.isJSXIdentifier(attr.name, { name: 'data-easel-source' }),
      );
      if (alreadyStamped) return;

      const value = `${relativeId}:${loc.line}:${loc.column + 1}`;
      const attr = t.jsxAttribute(
        t.jsxIdentifier('data-easel-source'),
        t.stringLiteral(value),
      );
      node.attributes.unshift(attr); // prepend so it is first in the DOM
    },
  });

  return generate(ast, { sourceMaps: true, sourceFileName: absoluteId }, code);
}
```

**Self-closing elements** (e.g., `<img />`, `<input />`) have their `JSXOpeningElement` visited identically; the attribute is legal on self-closing tags and HTML ignores unknown data attributes on void elements.

**Fragment shorthand** (`<>...</>`) does not render a DOM element, so no attribute is injected — fragments have no `JSXOpeningElement` with a real tag name.

**Spread props** (`<Button {...props} />`) are harmless: the injected attribute is a static literal and cannot be overwritten by spreads since we unshift it before any spread.

### Source path resolution

The `id` passed by Vite to `transform` is always the absolute on-disk path of the module (e.g., `/Users/bkizer1/myapp/src/components/Button.tsx`). We derive the relative path with `path.relative(config.root, id)`, giving `src/components/Button.tsx`. This is the same path convention used by Vite's own error overlays. The agent receives this relative path and resolves it against the project root (which Easel knows from the project configuration in `src/main/project.ts`).

### Framework coverage

| Framework | Strategy | Status |
|---|---|---|
| React (JSX/TSX) | Babel JSXOpeningElement visitor | Primary, MVP |
| React (`.js` with `React.createElement`) | Not instrumented; uncommon in modern projects | Out of scope v1 |
| Vue 3 (`.vue` SFC) | Vite's SFC compiler exposes a `compilerOptions.nodeTransforms` hook; inject a `NodeTransform` that appends the attribute to every `ElementNode` | Post-MVP |
| Svelte | Svelte's preprocessor API (`markup` hook) can add attributes during parse; or use `svelte-inspector` as prior art | Post-MVP |
| Plain HTML (`.html` files) | An HTML plugin transform can use a regex + `htmlparser2` to stamp attributes | Post-MVP, low priority |
| Astro | Astro's integrations API exposes an `addRenderer` hook; attribute injection during JSX compilation is feasible | Post-MVP |

### Prior art and differentiation

**react-dev-inspector** (GitHub: `zthxxx/react-dev-inspector`) injects `data-inspector-line`, `data-inspector-column`, and `data-inspector-relative-path` as three separate attributes. It is React-specific, opens files in the developer's IDE, and is not designed for agent consumption.

**vite-plugin-inspect** inspects the Vite plugin pipeline itself, not the rendered DOM.

**locator.js** (GitHub: `infi-pc/locatejs`) uses a similar stamping approach but relies on a browser devtools extension to surface the data.

**How Easel differs:**
- Single consolidated `data-easel-source` attribute with a `file:line:col` format that is compact and parseable by agents.
- Host-controlled: the webview preload script reads the attribute and posts it back to Electron via `ipcRenderer`; the developer does not interact with browser devtools.
- Generic: the attribute name and format are stable across framework plugins so the webview inspector, the agent, and the UI all share one contract defined in `src/shared/types.ts`.
- Agent-facing: the goal is accurate file editing, not IDE navigation. Confidence scoring (Section 6) compensates for cases where the attribute is stale due to hot-reload race conditions.

---

## 3. Webview Preload Inspector

The file `src/preload/webview/inspector.ts` is the guest-side script injected into the `<webview>` element via the `preload` attribute on the `<webview>` tag. It has access to the guest page's DOM but cannot access the host renderer's JavaScript context.

### Hit-testing under the cursor

When the user hovers or clicks inside the preview pane, mouse events are translated from the Electron renderer's coordinate space (which includes the sidebar, toolbar, etc.) into the webview's coordinate space. The webview preload attaches a `mousemove` listener at `capture: true` on `document` and a `click` listener for confirmed selection.

On mousemove, it calls:

```ts
document.elementFromPoint(event.clientX, event.clientY)
```

`elementFromPoint` returns the topmost painted element at that coordinate, respecting z-index and stacking contexts. This is more reliable than `event.target` for overlapping elements.

### Walking up to the nearest stamped ancestor

The immediately hit element may not have `data-easel-source` — for example, a span of text inside a button. The inspector walks up the DOM tree to find the nearest ancestor with the attribute:

```ts
function findSourceElement(el: Element | null): Element | null {
  let current: Element | null = el;
  while (current && current !== document.documentElement) {
    if (current.hasAttribute('data-easel-source')) return current;
    current = current.parentElement;
  }
  return null;
}
```

The walk stops at `<html>` to avoid surfacing the root. If no ancestor is found, the inspector falls back to computing a robust CSS selector (see below).

### Computing a robust CSS selector (fallback)

When `data-easel-source` is absent, the inspector computes a CSS selector that uniquely identifies the element in the current DOM. The algorithm prioritizes stability over brevity:

1. If the element has a non-empty `id` that is unique in the document, use `#id`.
2. If the element has a `data-testid`, `data-cy`, `data-test`, or `aria-label`, use `[data-testid="value"]` etc. These are developer-assigned and semantically stable.
3. Otherwise, build a path from the element up to the nearest ancestor with a stable ID or the body, using `:nth-of-type` rather than `:nth-child` to be more resilient to sibling additions:

```ts
function buildSelector(el: Element): string {
  const parts: string[] = [];
  let current: Element | null = el;
  while (current && current.tagName !== 'BODY') {
    const tag = current.tagName.toLowerCase();
    const id = current.id;
    if (id && document.querySelectorAll(`#${CSS.escape(id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(id)}`);
      break;
    }
    const testId = current.getAttribute('data-testid');
    if (testId) {
      parts.unshift(`${tag}[data-testid="${CSS.escape(testId)}"]`);
      break;
    }
    // nth-of-type among siblings of same tag
    const siblings = Array.from(current.parentElement?.children ?? []).filter(
      (s) => s.tagName === current!.tagName,
    );
    const index = siblings.indexOf(current) + 1;
    parts.unshift(index > 1 ? `${tag}:nth-of-type(${index})` : tag);
    current = current.parentElement;
  }
  return parts.join(' > ');
}
```

### Capturing element metadata

The inspector assembles an `ElementTarget` object (typed in `src/shared/types.ts`) containing everything the agent and annotation overlay need:

```ts
interface ElementTarget {
  id: string;                        // stable id within an EditRequest
  selector: string;                  // robust CSS selector (e.g. #id or tag:nth-of-type(n))
  tagName: string;                   // "button"
  dataEaselSource?: SourceLocation;  // { filePath, line, column } if plugin present
  boundingBox: BoundingBox;          // { x, y, width, height } in preview-viewport CSS pixels
  textSnippet: string;               // trimmed visible text, truncated to reasonable length
  attributes: Record<string, string>; // whitelisted: id, class, src, alt, href, data-testid, etc.
  pluginPresent: boolean;            // true if data-easel-source attribute was found
  confidence: ConfidenceLevel;       // 'high' | 'medium' | 'low' | 'none'
}
```

The `boundingBox` is derived from `element.getBoundingClientRect()` in preview-viewport coordinates. For the annotation overlay to position its highlight correctly, the host renderer also needs the scroll offset, which is posted separately via `viewport-changed` as `{ scrollX: window.scrollX, scrollY: window.scrollY }`.

### Posting back to the host renderer

The inspector uses the `ipcRenderer` available in the webview preload context to send messages back to the host renderer (not to main). The guest and host communicate via a distinct channel from main↔renderer Electron IPC:

```ts
import { ipcRenderer } from 'electron';

document.addEventListener('click', (event) => {
  if (!isInspectorActive) return; // toggled by an InspectorCommand from host
  event.preventDefault();
  event.stopPropagation();

  const hit = document.elementFromPoint(event.clientX, event.clientY);
  const sourceEl = findSourceElement(hit);
  const target = buildElementTarget(sourceEl ?? hit);

  ipcRenderer.sendToHost('inspector-message', {
    type: 'element-picked',
    target,
  } as InspectorMessage);
}, { capture: true });
```

`sendToHost` posts an `InspectorMessage` to the host renderer's `<webview>` element, which listens via the `ipc-message` event. The host sends `InspectorCommand`s back via `<webview>.send(...)`. This guest↔host channel is typed in `src/shared/ipc.ts` as `InspectorMessage` and `InspectorCommand` unions, distinct from main↔renderer IPC.

---

## 4. Fallback: Agent-Side Source Resolution

When the plugin is not installed, `pluginPresent` is `false` in the `ElementTarget`. The agent receives the CSS selector, tag name, text content, and relevant attributes and must locate the source markup without any file:line hint.

### Search strategy

The agent (in `src/main/agents/tools.ts`) executes a `grep_source` tool call that ripgreps the project source directory:

```
rg --type jsx --type tsx --type html \
   -n \
   --glob '!node_modules' \
   --glob '!dist' \
   '<button' \
   /path/to/project
```

It then ranks results by scoring each candidate line against the known attributes:

| Signal | Score contribution |
|---|---|
| Tag name matches | +30 |
| `class` attribute value overlap (Jaccard on tokens) | +0 to +25 |
| `id` attribute exact match | +40 |
| `data-testid` exact match | +40 |
| Text content appears in adjacent lines | +20 |
| `aria-label` matches | +20 |
| `type` attribute matches (for `<input>`) | +10 |
| `href`/`src` matches | +15 |
| File name contains component name inferred from selector | +10 |
| Multiple candidates in same file (increases ambiguity) | -10 per extra |

A result with a score above 60 is treated as a confident match. A result between 30 and 60 is flagged as `confidence: 'low'` and the agent includes a warning in its progress event. Below 30, the agent asks the user to install the plugin or manually identify the file.

### Heuristics for common patterns

**Class-based CSS selector fallback.** If the computed selector is `button.btn-primary`, the agent searches for `btn-primary` across all source files, then narrows by tag name. Tailwind class names are often predictive; unique Tailwind combos like `bg-indigo-600 hover:bg-indigo-700 rounded-lg px-4 py-2` are highly discriminative.

**Text content matching.** If the element's `textContent` is "Submit Order", the agent searches for that exact string in JSX files. This works for static strings and is highly reliable since text content rarely changes without the developer knowing.

**Component name inference from selector.** If the CSS path includes `[data-testid="submit-order-btn"]`, the agent knows to look for `submit-order-btn` which often directly names the component file.

**Inline-style uniqueness.** If the element has a unique inline style (`style="border-radius: 12px; background: #ff6b35"`), that exact string is extremely discriminative in a codebase search.

### Failure handling

If no match clears the confidence threshold, the agent:
1. Emits a `progress` event with `type: 'warning'` describing what it searched and why it failed.
2. Asks the user to confirm the file path by name ("I believe this is defined in `src/components/Hero.tsx` around line 45 — is that right?").
3. Presents a `diff` preview before writing, requiring explicit user confirmation.
4. Logs the failed resolution to `~/.easel/resolution-failures.log` to help improve heuristics over time.

---

## 5. Freeform-Mode Mapping

In Freeform mode, the user draws a region (rectangle, ellipse, arrow, or freehand stroke) on the annotation overlay. The overlay is an SVG/Canvas layer rendered on top of the `<webview>`. We must map the drawn region to the underlying DOM element(s).

### Coordinate translation

The overlay and the `<webview>` share the same coordinate origin in the Electron renderer window. The overlay is `position: absolute` with `top: 0; left: 0` and `pointer-events: none` (so mouse events fall through to the webview during inspect mode, or are captured by the canvas in draw mode). The webview occupies the same bounding rect.

The drawn annotation stores its geometry as a `BoundingBox` (x, y, width, height in preview-viewport CSS pixels). To find intersecting DOM elements, the host sends this region to the webview inspector via an `InspectorCommand`:

```ts
// In renderer (host side)
webviewElement.send('inspector-command', {
  type: 'query-region',
  box: annotationBoundingBox,  // { x, y, width, height }
  queryId: 'region-123',       // correlates the eventual reply
} as InspectorCommand);
```

The webview adjusts for scroll offset and uses `document.elementsFromPoint` at several sample points within the rect to collect candidates, then posts back a `region-resolved` message with the ranked `ElementTarget[]`.

### Element intersection detection

The webview preload samples a grid of points across the annotation bounding box (e.g., a 5x5 grid giving 25 sample points) and calls `document.elementsFromPoint(x, y)` at each. It deduplicates and ranks elements by:

1. **Overlap fraction**: what fraction of the element's bounding box is covered by the annotation rect.
2. **Containment**: elements fully contained within the drawn region score higher than elements that merely intersect.
3. **Depth**: shallower elements (fewer ancestor levels) are preferred over deeply nested wrappers.

```ts
function findElementsInRegion(
  rect: { x: number; y: number; width: number; height: number },
): ElementTarget[] {
  const candidates = new Map<Element, number>(); // element -> overlap count
  const step = { x: rect.width / 5, y: rect.height / 5 };

  for (let xi = 0; xi <= 5; xi++) {
    for (let yi = 0; yi <= 5; yi++) {
      const px = rect.x + xi * step.x;
      const py = rect.y + yi * step.y;
      const els = document.elementsFromPoint(px, py);
      for (const el of els) {
        candidates.set(el, (candidates.get(el) ?? 0) + 1);
      }
    }
  }

  // Filter to elements that appear in source or are meaningful
  const results = Array.from(candidates.entries())
    .filter(([el]) => el !== document.body && el !== document.documentElement)
    .sort(([, a], [, b]) => b - a)
    .map(([el]) => buildElementTarget(el));

  return results;
}
```

The host renderer receives a list of `ElementTarget[]` sorted by relevance. The agent's instruction is then applied with the full list as context, and the agent decides which elements are semantically relevant to the instruction.

### Semantic filtering by instruction

For a freehand circle drawn over a photo, the overlapping elements might include `<img>`, `<figure>`, `<section>`, `<div>`, and `<body>`. The agent prompt includes all of them but explicitly asks the model to pick the most specific relevant element for the instruction ("replace this photo with a golden doodle" -> select the `<img>`).

---

## 6. Edge Cases and Confidence Scoring

### Stale source map (hot-reload race)

When the user makes an edit and the dev server reloads, there is a brief window where the DOM still reflects the old render but the source file has changed. If the agent reads `data-easel-source="src/Button.tsx:34:5"` but the line has since shifted to line 36, the edit lands two lines off.

Mitigation:
- After each agent edit, Easel's IPC layer sends a `webview:reload-complete` event. The UI suppresses new click-to-edit actions until the webview fires `dom-ready`.
- The agent uses a line-neighborhood search: it reads `file:line:col`, extracts the source line, then searches ±5 lines for the matching tag name. If the tag has moved, it adjusts.
- Source maps generated by the Babel transform are attached to the `transform` return value, so Vite's HMR system can invalidate the stamped attribute on re-render.

### Generated lists (map/v-for/each)

When a component renders `items.map(item => <Card key={item.id} ... />)`, every `<Card>` instance has the same `data-easel-source` because they all originate from the same JSX expression. The source file and line point to the `map` expression, which is correct for edits that affect all cards uniformly.

For edits that target a specific card ("change the title of the second card"), the agent also receives the element's `textContent` and key-discriminating attributes (like `data-id` or `data-key`). It edits the data source (the array in state or a JSON file) rather than the JSX template.

### CSS Modules and `className` collisions

CSS Modules generate stable local class names but hash them in the bundle (e.g., `Button_primary__3xF2a`). The `data-easel-source` attribute is independent of class names, so this is not a problem for plugin-instrumented projects. For the fallback path, the agent is told to ignore hashed class segments and search by tag + structure only.

### Server-side rendered HTML

For Next.js pages, the initial HTML is server-rendered. On hydration, React attaches event handlers but does not re-render the DOM. The `data-easel-source` attribute injected by the Vite plugin during compilation is present on the server-rendered HTML because Next.js runs the same JSX transform on the server. The attribute therefore survives SSR.

However, for Astro islands, the non-interactive HTML shells are rendered without the React transform. Easel v1 documents this limitation; Astro support is a post-MVP item.

### Shadow DOM

`document.elementsFromPoint` does not pierce shadow roots by default. Web components with shadow DOM (e.g., Shoelace, Lit-based components) will not expose their internal elements to the inspector. The inspector detects shadow hosts and reports them as such; the agent receives the host element's source location and warns the user that internal shadow DOM elements are not directly addressable.

### iframes nested inside the webview

The `<webview>` is itself an isolated browsing context. Nested `<iframe>` elements within the user's page are not accessible from the webview preload. This is a known limitation; Easel v1 surfaces a message: "This element is inside an iframe and cannot be inspected directly."

### Confidence score summary

| Scenario | Confidence level | Agent behavior |
|---|---|---|
| `data-easel-source` found, file and line verified against current source | High (>80) | Edit directly, checkpoint |
| `data-easel-source` found, line shifted ≤5 lines (HMR race detected) | Medium (50–80) | Adjust line, warn user, diff preview |
| No plugin; grep finds unique match (score >60) | Medium (50–70) | Edit with diff preview |
| No plugin; grep finds multiple candidates | Low (20–50) | Ask user to confirm file |
| No plugin; no match | Very low (<20) | Block edit, prompt user to install plugin or specify file |
| Freeform region with single stamped element | High | Use stamped source |
| Freeform region with multiple elements, instruction is specific | Medium | Model selects best match |
| Shadow DOM host | Low | Warn, surface host source only |

The confidence value is included in the `AgentEvent` union. When the agent is locating source during an edit, it emits `AgentEvent` variants of type `'confidence'` (with a resolved `level` and `message`) and `'warning'` (for non-fatal issues). For critical failures (no match), the agent emits an `'error'` event with code `'needs-file'` and a list of candidate files the user can disambiguate. The UI renders confidence indicators (green checkmark vs. amber warning vs. red blocked state) based on these events.

---

## 7. Implementation Checklist

These are the discrete units of work, in dependency order:

1. **`src/shared/types.ts`**: Define `ElementTarget`, `AnnotationRegion`, `SourceLocation`, `ConfidenceLevel`.
2. **`packages/vite-plugin-inspector/src/index.ts`**: Plugin scaffold, `configResolved` dev guard, `transform` hook.
3. **`packages/vite-plugin-inspector/src/transform.ts`**: Babel AST visitor, `data-easel-source` injection, source map passthrough.
4. **`packages/vite-plugin-inspector/src/vue-transform.ts`**: (post-MVP) Vue `compilerOptions.nodeTransforms` hook.
5. **`src/preload/webview/inspector.ts`**: `elementFromPoint`, ancestor walk, `buildSelector`, `buildElementTarget`, `ipcRenderer.sendToHost`.
6. **`src/main/ipc.ts`**: Register `inspector:element-selected` and `inspector:query-rect` channels.
7. **`src/main/agents/tools.ts`**: `grep_source` tool, scoring algorithm, confidence emission.
8. **`src/renderer/lib/selector.ts`**: Utility functions for selector generation (shared with preload via bundler alias or copy).
9. **`src/renderer/lib/geometry.ts`**: `Rect` intersection, grid sampling for freeform mode.
10. **`src/renderer/components/AnnotationOverlay.tsx`**: Freeform region -> `inspector:query-rect` IPC call on stroke completion.
