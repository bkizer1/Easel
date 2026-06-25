// @vitest-environment jsdom
/**
 * Contract test for the React side of the State X-Ray state tap (issue #13).
 *
 * `inspector.ts` reads a picked element's live state by reaching React's private
 * fiber internals (`__reactFiber$…` → component fiber → `memoizedProps` + the
 * `memoizedState` hook chain) and lowering values with the shared
 * `serializeValue`. That file imports `electron` at module top, so it can't be
 * imported under vitest; this test instead renders a REAL React 18 tree and
 * walks the same internals, guarding the assumption most likely to break on a
 * React upgrade — the shape of the fiber/hook objects — plus the serializer.
 *
 * If this test breaks after bumping React, the fiber-walk in `inspector.ts`
 * (`findReactFiber` / `nearestComponentFiber` / `collectReactEntries`) needs the
 * same update.
 */
import { describe, it, expect } from 'vitest';
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { serializeValue } from '@shared/xray';

interface Fiber {
  type?: unknown;
  return?: Fiber | null;
  memoizedProps?: unknown;
  memoizedState?: Hook | null;
}
interface Hook {
  memoizedState?: unknown;
  next?: Hook | null;
  queue?: { dispatch?: (v: unknown) => void } | null;
}

// Mirrors inspector.ts::findReactFiber.
function findReactFiber(el: Element): Fiber | undefined {
  for (const k of Object.keys(el)) {
    if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
      return (el as unknown as Record<string, Fiber>)[k];
    }
  }
  return undefined;
}

// Mirrors inspector.ts::nearestComponentFiber.
function nearestComponentFiber(f: Fiber): Fiber | undefined {
  let c: Fiber | undefined = f;
  let g = 0;
  while (c && g++ < 1000) {
    if (typeof c.type === 'function') return c;
    c = c.return ?? undefined;
  }
  return undefined;
}

function Counter({ label }: { label: string }): React.ReactElement {
  const [count] = useState(7);
  const [name] = useState('ada');
  return React.createElement('button', { 'data-testid': 'btn' }, `${label}:${count}:${name}`);
}

describe('React fiber state tap (real React 18 internals)', () => {
  it('recovers component props + hook state from a rendered DOM node', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(React.createElement(Counter, { label: 'Cart' })));

    const btn = container.querySelector('[data-testid="btn"]');
    expect(btn).toBeTruthy();

    const fiber = findReactFiber(btn as Element);
    expect(fiber, 'a __reactFiber$ key must exist on the rendered node').toBeTruthy();

    const comp = nearestComponentFiber(fiber!);
    expect(comp && typeof comp.type === 'function').toBe(true);

    // Props, via the real shipped serializer.
    const props = comp!.memoizedProps as { label: string };
    expect(serializeValue(props.label)).toEqual({ kind: 'string', value: 'Cart' });

    // Hook chain → state values (skipping function slots, as inspector.ts does).
    const states: unknown[] = [];
    let h = comp!.memoizedState;
    let guard = 0;
    while (h && guard++ < 50) {
      if (typeof h.memoizedState !== 'function') states.push(h.memoizedState);
      h = h.next ?? null;
    }
    expect(states).toContain(7);
    expect(states).toContain('ada');

    root.unmount();
  });

  it('detects writable useState hooks via queue.dispatch (drives `set-value`)', () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    flushSync(() => root.render(React.createElement(Counter, { label: 'x' })));

    const fiber = findReactFiber(container.querySelector('[data-testid="btn"]') as Element);
    const comp = nearestComponentFiber(fiber!);
    expect(typeof comp!.memoizedState?.queue?.dispatch).toBe('function');

    root.unmount();
  });
});
