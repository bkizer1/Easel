/**
 * Easel — pure framework-state collectors for the State X-Ray state tap (#13).
 *
 * `inspector.ts` imports `electron` at module top, so it can't be loaded under
 * vitest. These collectors are factored out here — pure functions over plain
 * framework-internal SHAPES (no DOM, no electron) — so the guest inspector can
 * delegate to them AND they can be unit-tested directly against synthesized
 * internals (the same approach as `reactRenderCause.ts`/`reactFiberTap.test.ts`).
 *
 * Each collector is total: it pushes whatever it can read and never throws.
 */
import { serializeValue, type SerializedValue, type StateEntry } from '@shared/xray';

/** Default cap on entries a single collector contributes (mirrors inspector). */
const DEFAULT_MAX = 50;

/* -------------------------------------------------------------------------- */
/*  Svelte — read $$.ctx (correlated to prop names via $$.props)               */
/* -------------------------------------------------------------------------- */

/** The relevant slice of a Svelte component instance's internal `$$` record. */
export interface SvelteInternal {
  /** The reactive context array — all compiled locals, by index. */
  ctx?: unknown[];
  /** Map of prop name → its index into `ctx`, used to label named entries. */
  props?: Record<string, number>;
}

/** A Svelte component instance exposing its internal `$$`. */
export interface SvelteInstance {
  $$?: SvelteInternal;
}

/**
 * Lower a Svelte component instance's `$$.ctx` into `StateEntry[]`. Entries that
 * correspond to a declared prop are labelled by name (via `$$.props`); the rest
 * are labelled `ctx[i]`. Function slots (compiled handlers/derived helpers) are
 * skipped as noise. Read-only: Svelte's reactive writes are closure-bound and
 * not safely settable from outside, so these rows are not scrubbable.
 */
export function collectSvelteEntries(
  instance: SvelteInstance | null | undefined,
  entries: StateEntry[],
  max: number = DEFAULT_MAX,
): void {
  const ctx = instance?.$$?.ctx;
  if (!Array.isArray(ctx)) return;

  const indexToName = new Map<number, string>();
  const props = instance?.$$?.props;
  if (props && typeof props === 'object') {
    for (const [name, idx] of Object.entries(props)) {
      if (typeof idx === 'number') indexToName.set(idx, name);
    }
  }

  for (let i = 0; i < ctx.length; i++) {
    if (entries.length >= max) return;
    const value = ctx[i];
    if (typeof value === 'function') continue; // compiled handlers/derived — noise
    entries.push({
      group: 'state',
      label: indexToName.get(i) ?? `ctx[${i}]`,
      value: serializeValue(value),
      path: ['ctx', String(i)],
      writable: false,
    });
  }
}

/* -------------------------------------------------------------------------- */
/*  React — subscribed context slices (the 'context' group)                    */
/* -------------------------------------------------------------------------- */

/** One node of a React fiber's context-dependency linked list. */
export interface ReactContextDep {
  context?: { _currentValue?: unknown; displayName?: string };
  /** The value actually consumed at this fiber (React 18). */
  memoizedValue?: unknown;
  next?: ReactContextDep | null;
}

/**
 * The slice of a React fiber that carries its subscribed context dependencies.
 * `firstContext` is typed `unknown` so the guest inspector's own `ReactFiber`
 * (whose internals are all loosely typed) is assignable without a cast; it is
 * narrowed to {@link ReactContextDep} internally.
 */
export interface ReactFiberDeps {
  dependencies?: { firstContext?: unknown } | null;
}

/**
 * Walk a fiber's context-dependency chain and lower each subscribed React
 * Context value into a `'context'`-group `StateEntry`. Read-only (context is set
 * by a Provider, not from a consumer). Labelled by the context's `displayName`
 * when set, else `Context[i]`.
 */
export function collectReactContextEntries(
  fiber: ReactFiberDeps | null | undefined,
  entries: StateEntry[],
  max: number = DEFAULT_MAX,
): void {
  let dep = fiber?.dependencies?.firstContext as ReactContextDep | null | undefined;
  let guard = 0;
  let i = 0;
  while (dep && guard++ < 50) {
    if (entries.length >= max) return;
    const ctx = dep.context;
    const value = dep.memoizedValue !== undefined ? dep.memoizedValue : ctx?._currentValue;
    const label = (ctx?.displayName && String(ctx.displayName)) || `Context[${i}]`;
    entries.push({
      group: 'context',
      label,
      value: serializeValue(value),
      path: ['context', String(i)],
      writable: false,
    });
    dep = dep.next ?? undefined;
    i++;
  }
}

/* -------------------------------------------------------------------------- */
/*  Vue — ref-aware read + write-back                                          */
/* -------------------------------------------------------------------------- */

/** A Vue ref carries the `__v_isRef` brand and a `.value`. */
export interface VueRef {
  __v_isRef?: boolean;
  value: unknown;
}

/** True when `v` is a Vue ref (so reads/writes must go through `.value`). */
export function isVueRef(v: unknown): v is VueRef {
  return !!v && typeof v === 'object' && (v as { __v_isRef?: unknown }).__v_isRef === true;
}

/** Read the underlying value of a possible ref (unwrap), else return as-is. */
export function unwrapMaybeRef(v: unknown): unknown {
  return isVueRef(v) ? v.value : v;
}

/**
 * Write `value` into a `setupState` member. If the member is a ref, assign
 * through `.value` so Vue's reactivity actually propagates (a plain assignment
 * would replace the unwrapped value on the proxy and silently no-op/desync).
 * Returns whether a write target existed.
 */
export function applyVueWrite(
  bag: Record<string, unknown>,
  key: string,
  value: unknown,
): boolean {
  if (!bag || typeof bag !== 'object' || !(key in bag)) return false;
  const cur = bag[key];
  if (isVueRef(cur)) {
    cur.value = value;
    return true;
  }
  bag[key] = value;
  return true;
}

export type { SerializedValue, StateEntry };
