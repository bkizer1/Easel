/**
 * Easel — State X-Ray shared contract (issue #13).
 *
 * The inspection cockpit ("State X-Ray") turns Easel's DevTools inside out:
 * every observed fact about the running page (component state, a network
 * request, a state delta across time) is **source-anchored** and carries a
 * one-click bridge into the `EditRequest → backend → HMR → checkpoint`
 * pipeline.
 *
 * This module is the single source of truth shared by every tap:
 *   - the GUEST inspector (serializes live framework state into a portable,
 *     cycle-safe {@link SerializedValue} tree),
 *   - the MAIN process (network log entries, persisted per-checkpoint state
 *     snapshots),
 *   - the RENDERER cockpit (renders the trees and computes time-travel diffs).
 *
 * It contains ONLY types and **pure** helpers — no DOM, Node, or Electron
 * imports — so it compiles cleanly under every tsconfig and is unit-testable in
 * isolation (`xray.test.ts`).
 */

import type { SourceLocation } from './types';

/* -------------------------------------------------------------------------- */
/*  SerializedValue — a portable, depth-limited, cycle-safe value snapshot     */
/* -------------------------------------------------------------------------- */

/**
 * A JSON-safe, depth-limited, cycle-safe representation of an arbitrary runtime
 * value. The guest inspector cannot post live objects across the `ipc-message`
 * boundary (they would be structured-cloned, hang on cycles, or balloon on deep
 * graphs), so it lowers every value into this tagged union first. The renderer
 * renders it; {@link diffSerialized} diffs two of them for time-travel.
 */
export type SerializedValue =
  | { kind: 'string'; value: string; truncated?: boolean }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'undefined' }
  | { kind: 'bigint'; value: string }
  | { kind: 'symbol'; value: string }
  | { kind: 'function'; name: string }
  | { kind: 'date'; value: string }
  /** A DOM node — we never serialize its contents, just enough to identify it. */
  | { kind: 'dom'; tagName: string }
  | { kind: 'array'; items: SerializedValue[]; length: number; truncated: boolean }
  | {
      kind: 'object';
      /** Constructor name when it is a non-plain object (e.g. `Map`, `URL`). */
      ctor?: string;
      entries: Array<{ key: string; value: SerializedValue }>;
      truncated: boolean;
    }
  /** A value already visited on this path — guards against infinite recursion. */
  | { kind: 'circular' }
  /** The depth cap was hit; `preview` is a short human description. */
  | { kind: 'max-depth'; preview: string }
  /** Serialization threw (exotic getter, revoked proxy, …). */
  | { kind: 'unserializable'; preview: string };

/** Tunables for {@link serializeValue}. All have conservative defaults. */
export interface SerializeOptions {
  /** Maximum nesting depth before emitting a `max-depth` node. Default 4. */
  maxDepth?: number;
  /** Maximum array items / object keys captured per level. Default 50. */
  maxEntries?: number;
  /** Maximum captured string length before truncation. Default 200. */
  maxStringLen?: number;
}

const DEFAULT_SERIALIZE_OPTS: Required<SerializeOptions> = {
  maxDepth: 4,
  maxEntries: 50,
  maxStringLen: 200,
};

/** Duck-type a DOM node without referencing the DOM lib (shared compiles in node too). */
function looksLikeDomNode(v: object): v is { nodeType: number; tagName?: string; nodeName?: string } {
  const r = v as { nodeType?: unknown };
  return typeof r.nodeType === 'number';
}

/**
 * Lower an arbitrary value into a {@link SerializedValue}. Pure and total: it
 * never throws (exotic values become `unserializable`), never recurses past
 * `maxDepth`, and never revisits a value already on the current path (cycles
 * become `circular`). Safe to run inside the guest page on hot paths.
 */
export function serializeValue(
  input: unknown,
  options: SerializeOptions = {},
): SerializedValue {
  const opts = { ...DEFAULT_SERIALIZE_OPTS, ...options };
  return serialize(input, opts, 0, new WeakSet<object>());
}

function serialize(
  input: unknown,
  opts: Required<SerializeOptions>,
  depth: number,
  seen: WeakSet<object>,
): SerializedValue {
  try {
    if (input === null) return { kind: 'null' };
    const t = typeof input;

    switch (t) {
      case 'undefined':
        return { kind: 'undefined' };
      case 'boolean':
        return { kind: 'boolean', value: input as boolean };
      case 'number':
        return { kind: 'number', value: input as number };
      case 'bigint':
        return { kind: 'bigint', value: (input as bigint).toString() };
      case 'symbol':
        return { kind: 'symbol', value: (input as symbol).toString() };
      case 'function': {
        const fn = input as { name?: string };
        return { kind: 'function', name: typeof fn.name === 'string' && fn.name ? fn.name : '(anonymous)' };
      }
      case 'string': {
        const s = input as string;
        if (s.length > opts.maxStringLen) {
          return { kind: 'string', value: s.slice(0, opts.maxStringLen) + '…', truncated: true };
        }
        return { kind: 'string', value: s };
      }
    }

    // From here, `input` is a non-null object.
    const obj = input as object;

    if (obj instanceof Date) {
      return { kind: 'date', value: isNaN(obj.getTime()) ? 'Invalid Date' : obj.toISOString() };
    }

    if (looksLikeDomNode(obj)) {
      const tag = (obj.tagName ?? obj.nodeName ?? 'node');
      return { kind: 'dom', tagName: String(tag).toLowerCase() };
    }

    if (seen.has(obj)) return { kind: 'circular' };

    if (depth >= opts.maxDepth) {
      return { kind: 'max-depth', preview: previewObject(obj) };
    }

    seen.add(obj);
    try {
      if (Array.isArray(obj)) {
        const length = obj.length;
        const take = Math.min(length, opts.maxEntries);
        const items: SerializedValue[] = [];
        for (let i = 0; i < take; i++) {
          items.push(serialize(obj[i], opts, depth + 1, seen));
        }
        return { kind: 'array', items, length, truncated: length > take };
      }

      // Plain-ish object: enumerate own enumerable string keys.
      const ctorName = objectCtorName(obj);
      const keys = ownEnumerableKeys(obj);
      const take = Math.min(keys.length, opts.maxEntries);
      const entries: Array<{ key: string; value: SerializedValue }> = [];
      for (let i = 0; i < take; i++) {
        const key = keys[i];
        let val: unknown;
        try {
          val = (obj as Record<string, unknown>)[key];
        } catch {
          // A throwing getter — record the key but mark the value unserializable.
          entries.push({ key, value: { kind: 'unserializable', preview: '(getter threw)' } });
          continue;
        }
        entries.push({ key, value: serialize(val, opts, depth + 1, seen) });
      }
      return {
        kind: 'object',
        ...(ctorName ? { ctor: ctorName } : {}),
        entries,
        truncated: keys.length > take,
      };
    } finally {
      seen.delete(obj);
    }
  } catch (err) {
    return { kind: 'unserializable', preview: err instanceof Error ? err.message : 'unserializable' };
  }
}

function ownEnumerableKeys(obj: object): string[] {
  try {
    return Object.keys(obj);
  } catch {
    return [];
  }
}

function objectCtorName(obj: object): string | undefined {
  try {
    const proto = Object.getPrototypeOf(obj);
    if (proto === null) return undefined; // Object.create(null)
    const name = proto?.constructor?.name;
    return name && name !== 'Object' ? name : undefined;
  } catch {
    return undefined;
  }
}

function previewObject(obj: object): string {
  if (Array.isArray(obj)) return `Array(${obj.length})`;
  const name = objectCtorName(obj);
  return name ? `${name} {…}` : 'Object {…}';
}

/* -------------------------------------------------------------------------- */
/*  Rendering helper                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Render a {@link SerializedValue} as a compact single-line string for inline
 * display, diff text, and instruction building. Objects/arrays show a shallow
 * preview — the cockpit renders the full tree separately.
 */
export function formatSerializedValue(v: SerializedValue): string {
  switch (v.kind) {
    case 'string':
      return JSON.stringify(v.value);
    case 'number':
      return String(v.value);
    case 'boolean':
      return String(v.value);
    case 'null':
      return 'null';
    case 'undefined':
      return 'undefined';
    case 'bigint':
      return `${v.value}n`;
    case 'symbol':
      return v.value;
    case 'function':
      return `ƒ ${v.name}()`;
    case 'date':
      return v.value;
    case 'dom':
      return `<${v.tagName}>`;
    case 'array': {
      const inner = v.items.map(formatSerializedValue).join(', ');
      return `[${inner}${v.truncated ? ', …' : ''}]`;
    }
    case 'object': {
      const inner = v.entries
        .map((e) => `${e.key}: ${formatSerializedValue(e.value)}`)
        .join(', ');
      const body = `{${inner}${v.truncated ? ', …' : ''}}`;
      return v.ctor ? `${v.ctor} ${body}` : body;
    }
    case 'circular':
      return '[Circular]';
    case 'max-depth':
      return v.preview;
    case 'unserializable':
      return `[Unserializable: ${v.preview}]`;
  }
}

/* -------------------------------------------------------------------------- */
/*  Time-travel diff                                                          */
/* -------------------------------------------------------------------------- */

/** One difference between two {@link SerializedValue} trees, by JSON-ish path. */
export interface StateDiffEntry {
  /** Dotted/bracketed path from the root, e.g. `cart.items[0].qty`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  /** Compact rendering of the previous value (absent for `added`). */
  before?: string;
  /** Compact rendering of the next value (absent for `removed`). */
  after?: string;
}

/**
 * Deep-diff two serialized snapshots, producing a flat, ordered list of leaf
 * changes. Pure. Used by the History/cockpit time-travel view to show how app
 * state evolved between any two checkpoints.
 */
export function diffSerialized(
  before: SerializedValue,
  after: SerializedValue,
  path = '',
): StateDiffEntry[] {
  // Same kind of container → recurse structurally.
  if (before.kind === 'object' && after.kind === 'object') {
    return diffEntries(before.entries, after.entries, path);
  }
  if (before.kind === 'array' && after.kind === 'array') {
    return diffArray(before, after, path);
  }

  // Leaf (or kind mismatch): compare compact renderings.
  const b = formatSerializedValue(before);
  const a = formatSerializedValue(after);
  if (b === a) return [];
  return [{ path: path || '(root)', kind: 'changed', before: b, after: a }];
}

function diffEntries(
  beforeEntries: Array<{ key: string; value: SerializedValue }>,
  afterEntries: Array<{ key: string; value: SerializedValue }>,
  path: string,
): StateDiffEntry[] {
  const out: StateDiffEntry[] = [];
  const beforeMap = new Map(beforeEntries.map((e) => [e.key, e.value]));
  const afterMap = new Map(afterEntries.map((e) => [e.key, e.value]));

  // Stable order: existing keys first (in `before` order), then new keys.
  const orderedKeys: string[] = [];
  for (const e of beforeEntries) orderedKeys.push(e.key);
  for (const e of afterEntries) if (!beforeMap.has(e.key)) orderedKeys.push(e.key);

  for (const key of orderedKeys) {
    const childPath = path ? `${path}.${key}` : key;
    const hasBefore = beforeMap.has(key);
    const hasAfter = afterMap.has(key);
    if (hasBefore && !hasAfter) {
      out.push({ path: childPath, kind: 'removed', before: formatSerializedValue(beforeMap.get(key)!) });
    } else if (!hasBefore && hasAfter) {
      out.push({ path: childPath, kind: 'added', after: formatSerializedValue(afterMap.get(key)!) });
    } else {
      out.push(...diffSerialized(beforeMap.get(key)!, afterMap.get(key)!, childPath));
    }
  }
  return out;
}

function diffArray(
  before: { items: SerializedValue[]; length: number },
  after: { items: SerializedValue[]; length: number },
  path: string,
): StateDiffEntry[] {
  const out: StateDiffEntry[] = [];
  const max = Math.max(before.items.length, after.items.length);
  for (let i = 0; i < max; i++) {
    const childPath = `${path}[${i}]`;
    const b = before.items[i];
    const a = after.items[i];
    if (b !== undefined && a === undefined) {
      out.push({ path: childPath, kind: 'removed', before: formatSerializedValue(b) });
    } else if (b === undefined && a !== undefined) {
      out.push({ path: childPath, kind: 'added', after: formatSerializedValue(a) });
    } else if (b !== undefined && a !== undefined) {
      out.push(...diffSerialized(b, a, childPath));
    }
  }
  if (before.length !== after.length) {
    out.push({
      path: `${path}.length`,
      kind: 'changed',
      before: String(before.length),
      after: String(after.length),
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  State tap                                                                  */
/* -------------------------------------------------------------------------- */

/** Front-end framework detected on a picked element. */
export type DetectedFramework = 'react' | 'vue' | 'svelte' | 'unknown';

/** Which bucket a {@link StateEntry} belongs to in the cockpit's State tab. */
export type StateGroup = 'props' | 'state' | 'hooks' | 'context' | 'computed-style';

/**
 * One inspected value on a picked element — a prop, a hook/state slice, or a
 * highlighted computed-style declaration. `path` is the write target for the
 * `set-value` scrub command and for the "Change this" edit bridge.
 */
export interface StateEntry {
  group: StateGroup;
  /** Display label (prop name, `state[0]`, `color`, …). */
  label: string;
  value: SerializedValue;
  /** Machine path used to write the value back, e.g. `['props','count']`. */
  path: string[];
  /** Whether this value can be scrubbed live via the `set-value` command. */
  writable: boolean;
}

/**
 * How a {@link RenderCause}'s {@link RenderCause.changedKeys} was derived, so the
 * cockpit can label it honestly:
 *  - `'commit'`: diffed the component fiber's current values against React's
 *    previously-committed fiber (`fiber.alternate`) — a TRUE last-commit cause.
 *  - `'since-pick'`: no alternate was available, so we fell back to diffing
 *    against the value set captured the last time *you* inspected this element.
 */
export type RenderCauseSource = 'commit' | 'since-pick';

/**
 * Best-effort render-cause information for a picked element. {@link changedKeys}
 * are the prop/state labels whose value actually differs; {@link source} records
 * HOW that was determined so the UI never overclaims (see {@link RenderCauseSource}).
 */
export interface RenderCause {
  /** Keys (prop/state labels) whose serialized value changed. */
  changedKeys: string[];
  /** Provenance of {@link changedKeys}; absent on legacy snapshots (treat as `since-pick`). */
  source?: RenderCauseSource;
  /**
   * Honest, observed "why is this here / why is it shown" note — e.g. the gating
   * className(s) on the element or a detectable conditional/visibility gate.
   * Omitted when nothing meaningful was found (never speculative).
   */
  note?: string;
}

/* -------------------------------------------------------------------------- */
/*  Render-cause — alternate-based fiber diff (pure, framework-internal)        */
/* -------------------------------------------------------------------------- */

/**
 * Minimal structural view of a React fiber for render-cause diffing. The real
 * fiber has hundreds of fields; we only narrow `memoizedProps`, the hook chain
 * head (`memoizedState`), and `alternate` (React's previously-committed fiber).
 * Everything is optional — these are private internals that vary by React
 * version, so every access is guarded. Kept here (not in inspector.ts) so the
 * diff is a PURE function importable by both the guest tap and unit tests
 * (inspector.ts imports `electron` at module top and cannot be imported under
 * vitest).
 */
export interface RenderCauseFiber {
  memoizedProps?: unknown;
  memoizedState?: RenderCauseHook | unknown;
  alternate?: RenderCauseFiber | null;
}

/** One node of React's hook linked list, as far as render-cause cares. */
export interface RenderCauseHook {
  memoizedState?: unknown;
  next?: RenderCauseHook | null;
}

/** Collect the prop label→value map a component fiber rendered with. */
function propEntries(fiber: RenderCauseFiber | null | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const props = fiber?.memoizedProps;
  if (props && typeof props === 'object') {
    let keys: string[] = [];
    try {
      keys = Object.keys(props as Record<string, unknown>);
    } catch {
      keys = [];
    }
    for (const key of keys) {
      if (key === 'children') continue; // noisy React element tree, ignored everywhere
      try {
        out.set(key, (props as Record<string, unknown>)[key]);
      } catch {
        // throwing getter — treat as present-but-unreadable (still a key)
        out.set(key, undefined);
      }
    }
  }
  return out;
}

/**
 * Collect the `state[i]` label→value map from a component fiber's hook chain,
 * skipping function slots (effects/refs/callbacks) exactly like the cockpit's
 * `collectReactEntries` does — so labels line up with the rows the user sees.
 */
function hookStateEntries(fiber: RenderCauseFiber | null | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  let hook = fiber?.memoizedState as RenderCauseHook | undefined;
  let stateIndex = 0;
  let guard = 0;
  while (hook && typeof hook === 'object' && guard++ < 200) {
    const value = hook.memoizedState;
    if (typeof value !== 'function') {
      out.set(`state[${stateIndex}]`, value);
      stateIndex++;
    }
    hook = hook.next ?? undefined;
  }
  return out;
}

/**
 * Compute a TRUE last-commit render cause by diffing a component fiber's current
 * props + hook-state against its `alternate` (React's previously-committed
 * fiber). Returns the labels whose serialized value actually changed at the last
 * commit, or `null` when no alternate exists (first commit, or React did not
 * retain one) so the caller can fall back to a "since you last inspected" diff.
 *
 * Pure: takes a serializer so it shares the cockpit's exact value formatting and
 * has no DOM/Electron dependency (unit-testable against a real React fiber).
 */
export function diffFiberRenderCause(
  fiber: RenderCauseFiber | null | undefined,
  format: (v: unknown) => string,
): string[] | null {
  const alternate = fiber?.alternate;
  if (!alternate) return null;

  const changed: string[] = [];

  const curProps = propEntries(fiber);
  const prevProps = propEntries(alternate);
  for (const [key, val] of curProps) {
    if (!prevProps.has(key) || format(prevProps.get(key)) !== format(val)) {
      changed.push(key);
    }
  }

  const curHooks = hookStateEntries(fiber);
  const prevHooks = hookStateEntries(alternate);
  for (const [label, val] of curHooks) {
    if (!prevHooks.has(label) || format(prevHooks.get(label)) !== format(val)) {
      changed.push(label);
    }
  }

  return changed;
}

/** Observable, DOM-free inputs for {@link deriveRenderNote}. */
export interface RenderNoteInputs {
  /** Whether the element carries the `hidden` attribute. */
  hidden: boolean;
  /** Value of `aria-hidden` (or null when absent). */
  ariaHidden: string | null;
  /** The element's class list (order preserved). */
  classList: readonly string[];
}

/** Max gating classes named in a render note before truncating to "+N more". */
const RENDER_NOTE_MAX_CLASSES = 3;

/** Classnames that LOOK like visibility/conditional gates (a developer toggle). */
const RENDER_NOTE_GATE_HINT =
  /^(is-|has-|show|hide|hidden|visible|active|open|collapsed?|expanded?|selected|disabled|toggle)/i;

/**
 * Pure render-note derivation from observable element signals. Returns an
 * HONEST, non-speculative "why is this here / why is it shown" string, or
 * `undefined` when nothing meaningful is observable. Kept here (DOM-free, taking
 * already-read inputs) so the gate-vs-classed wording is unit-testable without
 * importing the Electron-coupled inspector. The DOM reading lives in
 * `inspector.ts::deriveRenderNote`, which delegates the decision to this.
 */
export function deriveRenderNote(inputs: RenderNoteInputs): string | undefined {
  // 1. An explicit visibility/conditional gate carried on the element.
  if (inputs.hidden) return 'gated by [hidden] attribute';
  if (inputs.ariaHidden === 'true') return 'gated by [aria-hidden]';

  // 2. Gating className(s). We report what is literally on the element — we do
  //    NOT claim a class "causes" the render, only that the element is classed
  //    by it (the observable fact). Prefer gate-looking classes for actionability.
  const classList = inputs.classList;
  if (classList.length > 0) {
    const gates = classList.filter((c) => RENDER_NOTE_GATE_HINT.test(c));
    const pool = gates.length > 0 ? gates : classList;
    const chosen = pool.slice(0, RENDER_NOTE_MAX_CLASSES);
    const more = pool.length - chosen.length;
    const list = chosen.map((c) => `.${c}`).join(', ') + (more > 0 ? `, +${more} more` : '');
    return gates.length > 0 ? `possibly gated by ${list}` : `classed ${list}`;
  }

  return undefined;
}

/**
 * The live runtime state of one picked element, posted by the guest as an
 * `element-state` {@link import('./ipc').InspectorMessage}. Every snapshot is
 * source-anchored via {@link dataEaselSource} so each row bridges into an edit.
 */
export interface ElementStateSnapshot {
  /** Correlates with the {@link import('./types').ElementTarget.id} just picked. */
  targetId: string;
  /** Robust CSS selector for the element (drives `set-value` / highlight). */
  selector: string;
  /** Lowercased tag name. */
  tagName: string;
  /** Source location when the inspector plugin stamped the element. */
  dataEaselSource?: SourceLocation;
  /** Component display name when the framework exposes one. */
  componentName?: string;
  framework: DetectedFramework;
  entries: StateEntry[];
  /** Highlighted computed-style declarations (color, spacing, typography). */
  computedStyle: Record<string, string>;
  renderCause?: RenderCause;
  /** Epoch ms the snapshot was taken. */
  capturedAt: number;
  /** Set when the guest could not read framework internals. */
  error?: string;
}

/* -------------------------------------------------------------------------- */
/*  Network tap                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One observed network request/response, captured in MAIN via a CDP debugger
 * attached to the guest `WebContents` and streamed to the renderer on the
 * `network.event` push channel. Source-anchored via {@link initiator} (parsed
 * from the request's initiator stack) so "this request is failing → add
 * loading/error states" becomes a one-click `EditRequest`.
 */
export interface NetworkEntry {
  /** CDP request id (stable across the request's lifecycle). */
  id: string;
  method: string;
  url: string;
  /** Resource type reported by CDP (Fetch, XHR, Script, …). */
  resourceType?: string;
  status?: number;
  statusText?: string;
  /** Epoch ms the request was sent. */
  startedAt: number;
  /** Wall-clock duration once the response/failure landed. */
  durationMs?: number;
  /** Whether the request failed (network error, blocked, CORS, …). */
  failed?: boolean;
  /** Failure description when {@link failed}. */
  errorText?: string;
  /** MIME type from the response, when known. */
  mimeType?: string;
  /** Project source location parsed from the initiator stack, when resolvable. */
  initiator?: SourceLocation;
  /** Raw initiator URL (script that issued the request), for display. */
  initiatorUrl?: string;

  /* ── Interception lifecycle (the "Burp" part — Workstream 2) ────────────────
   * All optional + backward-compatible: a passively-logged request has none of
   * these set. They are only populated when the Fetch interception mode is on.
   */
  /**
   * CDP `Fetch.requestPaused` id, present only while this request is HELD by the
   * interceptor awaiting a Continue/Fulfill/Block decision. Cleared (the field
   * removed) once an action resolves it. This is the handle the
   * continue/fulfill/fail IPC operations take.
   */
  interceptId?: string;
  /** True while the request is paused at the interceptor awaiting a decision. */
  paused?: boolean;
  /** Which interception stage paused it: `'request'` or `'response'`. */
  pausedStage?: 'request' | 'response';
  /** Set once the user fulfilled (mocked) the response for this request. */
  mocked?: boolean;
  /** Set once the user blocked (failed) this request at the interceptor. */
  blocked?: boolean;
  /**
   * Short human summary of an applied rewrite/override (e.g. `→ 503` for a mock,
   * `method PUT` for a request rewrite, or `BlockedByClient` for a block), shown
   * inline in the cockpit so the user can see what they did to the request.
   */
  interceptSummary?: string;
}

/* -------------------------------------------------------------------------- */
/*  Time-travel snapshots                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A serialized app-state snapshot persisted (in `userData`, keyed by checkpoint
 * id) when a checkpoint is created, so any two points on the timeline can be
 * deep-diffed in the History/cockpit view. Never written into the user's tree.
 */
export interface StateSnapshot {
  /** {@link import('./types').Checkpoint.id} this snapshot belongs to. */
  checkpointId: string;
  /** Epoch ms captured. */
  capturedAt: number;
  /** Optional human label (the checkpoint message) for the time-travel UI. */
  label?: string;
  /** The serialized state tree. */
  data: SerializedValue;
}
