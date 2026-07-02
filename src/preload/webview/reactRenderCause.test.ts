// @vitest-environment jsdom
/**
 * Contract test for the DEEPER (alternate-based) render-cause of the State X-Ray
 * state tap (Workstream 3 of issue #13).
 *
 * The shallow cache diff (`renderCauseCache` in inspector.ts) only knew what
 * changed "since you last inspected this element". The real render cause is the
 * key that differs at the LAST REACT COMMIT — found by diffing the component
 * fiber's `memoizedProps` + hook chain against `fiber.alternate` (React's
 * previously-committed fiber). That diff is the pure, DOM/Electron-free
 * `diffFiberRenderCause` in `@shared/xray`, so we can exercise it directly here
 * against a REAL React 18 tree (inspector.ts itself imports `electron` at module
 * top and cannot be loaded under vitest — mirrors reactFiberTap.test.ts).
 *
 * If this breaks after a React upgrade, the fiber/alternate shape changed and
 * `diffFiberRenderCause` (or the `RenderCauseFiber` narrowing) needs updating.
 */
import { describe, it, expect } from 'vitest';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  deriveRenderNote,
  diffFiberRenderCause,
  formatSerializedValue,
  serializeValue,
  type RenderCauseFiber,
} from '@shared/xray';

/** Mirror of inspector.ts::formatRawValue — share the cockpit's exact formatting. */
function fmt(v: unknown): string {
  return formatSerializedValue(serializeValue(v, { maxDepth: 2, maxEntries: 12 }));
}

interface Fiber {
  type?: unknown;
  return?: Fiber | null;
  memoizedProps?: unknown;
  memoizedState?: { memoizedState?: unknown; next?: unknown } | null;
  alternate?: Fiber | null;
}

function findReactFiber(el: Element): Fiber | undefined {
  for (const k of Object.keys(el)) {
    if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
      return (el as unknown as Record<string, Fiber>)[k];
    }
  }
  return undefined;
}

function nearestComponentFiber(f: Fiber): Fiber | undefined {
  let c: Fiber | undefined = f;
  let g = 0;
  while (c && g++ < 1000) {
    if (typeof c.type === 'function') return c;
    c = c.return ?? undefined;
  }
  return undefined;
}

// A component that exposes its setState so the test can commit a real update.
let setCount: ((n: number) => void) | undefined;
function Counter({ label }: { label: string }): React.ReactElement {
  const [count, setCountState] = useState(0);
  const [name] = useState('ada');
  setCount = setCountState;
  return React.createElement('button', { 'data-testid': 'btn' }, `${label}:${count}:${name}`);
}

describe('alternate-based render cause (real React 18 commit)', () => {
  it('identifies the changed hook-state key from fiber.alternate after a commit', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(React.createElement(Counter, { label: 'Cart' })));

    // Commit a state change: count 0 → 1. This produces a new current fiber whose
    // `.alternate` is the previously-committed (count === 0) fiber.
    flushSync(() => setCount!(1));

    const fiber = findReactFiber(container.querySelector('[data-testid="btn"]') as Element);
    const comp = nearestComponentFiber(fiber!);
    expect(comp).toBeTruthy();
    expect(comp!.memoizedState, 'an alternate must exist after a second commit').toBeTruthy();

    const changed = diffFiberRenderCause(comp as RenderCauseFiber, fmt);
    expect(changed, 'an alternate existed → non-null result').not.toBeNull();
    // Only the first hook (count) changed; the second (name) and the `label`
    // prop did not.
    expect(changed).toContain('state[0]');
    expect(changed).not.toContain('state[1]');
    expect(changed).not.toContain('label');

    root.unmount();
  });

  it('returns null when no alternate exists (first commit) so the caller falls back', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(React.createElement(Counter, { label: 'x' })));

    const fiber = findReactFiber(container.querySelector('[data-testid="btn"]') as Element);
    const comp = nearestComponentFiber(fiber!);
    // On the very first commit React has not retained an alternate for this node.
    expect(comp!.alternate ?? null).toBeNull();
    expect(diffFiberRenderCause(comp as RenderCauseFiber, fmt)).toBeNull();

    root.unmount();
  });

  it('detects a changed prop across a parent-driven re-render', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(React.createElement(Counter, { label: 'before' })));
    // Re-render the same component instance with a different prop value.
    flushSync(() => root.render(React.createElement(Counter, { label: 'after' })));

    const fiber = findReactFiber(container.querySelector('[data-testid="btn"]') as Element);
    const comp = nearestComponentFiber(fiber!);

    const changed = diffFiberRenderCause(comp as RenderCauseFiber, fmt);
    expect(changed).not.toBeNull();
    expect(changed).toContain('label');
    // Hook state was untouched.
    expect(changed).not.toContain('state[0]');

    root.unmount();
  });
});

describe('diffFiberRenderCause unit behavior (synthetic fibers)', () => {
  it('ignores the `children` prop and unchanged keys', () => {
    const fiber: RenderCauseFiber = {
      memoizedProps: { a: 1, b: 2, children: ['x'] },
      memoizedState: null,
      alternate: {
        memoizedProps: { a: 1, b: 99, children: [] },
        memoizedState: null,
      },
    };
    const changed = diffFiberRenderCause(fiber, fmt);
    expect(changed).toEqual(['b']); // `a` unchanged, `children` ignored
  });

  it('walks the hook chain, skipping function slots, and labels by state index', () => {
    const fiber: RenderCauseFiber = {
      memoizedProps: {},
      memoizedState: {
        memoizedState: 1,
        next: { memoizedState: () => {}, next: { memoizedState: 'b', next: null } },
      },
      alternate: {
        memoizedProps: {},
        memoizedState: {
          memoizedState: 1,
          next: { memoizedState: () => {}, next: { memoizedState: 'a', next: null } },
        },
      },
    };
    // state[0] === 1 unchanged; the function slot is skipped; state[1] 'a'→'b'.
    expect(diffFiberRenderCause(fiber, fmt)).toEqual(['state[1]']);
  });

  it('returns null when no alternate is present', () => {
    expect(diffFiberRenderCause({ memoizedProps: { a: 1 } }, fmt)).toBeNull();
    expect(diffFiberRenderCause(null, fmt)).toBeNull();
    expect(diffFiberRenderCause(undefined, fmt)).toBeNull();
  });

  it('reports a key added since the previous commit', () => {
    const fiber: RenderCauseFiber = {
      memoizedProps: { a: 1, b: 2 },
      alternate: { memoizedProps: { a: 1 } },
    };
    expect(diffFiberRenderCause(fiber, fmt)).toEqual(['b']);
  });
});

describe('deriveRenderNote — honest "why is this shown" signal', () => {
  it('reports explicit visibility gates first, without overclaiming', () => {
    expect(deriveRenderNote({ hidden: true, ariaHidden: null, classList: ['x'] })).toBe(
      'gated by [hidden] attribute',
    );
    expect(deriveRenderNote({ hidden: false, ariaHidden: 'true', classList: [] })).toBe(
      'gated by [aria-hidden]',
    );
  });

  it('prefers gate-looking classes and hedges the wording ("possibly gated by")', () => {
    const note = deriveRenderNote({
      hidden: false,
      ariaHidden: null,
      classList: ['card', 'is-open', 'p-4', 'is-active'],
    });
    expect(note).toBe('possibly gated by .is-open, .is-active');
  });

  it('falls back to "classed" (not "gated") when no class looks like a gate', () => {
    const note = deriveRenderNote({
      hidden: false,
      ariaHidden: null,
      classList: ['card', 'rounded', 'shadow'],
    });
    expect(note).toBe('classed .card, .rounded, .shadow');
  });

  it('truncates long class lists with a "+N more" suffix', () => {
    const note = deriveRenderNote({
      hidden: false,
      ariaHidden: null,
      classList: ['a', 'b', 'c', 'd', 'e'],
    });
    expect(note).toBe('classed .a, .b, .c, +2 more');
  });

  it('returns undefined when nothing is observable (note is omitted, not hollow)', () => {
    expect(deriveRenderNote({ hidden: false, ariaHidden: null, classList: [] })).toBeUndefined();
    expect(
      deriveRenderNote({ hidden: false, ariaHidden: 'false', classList: [] }),
    ).toBeUndefined();
  });
});
