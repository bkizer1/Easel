/**
 * Tests for the pure multi-framework state collectors (State X-Ray, issue #13,
 * Workstream 4). These operate on synthesized framework-internal shapes so they
 * run without a live app or the electron-coupled inspector — the same approach
 * as reactFiberTap/reactRenderCause.
 */
import { describe, it, expect } from 'vitest';
import {
  collectSvelteEntries,
  collectReactContextEntries,
  isVueRef,
  unwrapMaybeRef,
  applyVueWrite,
  type StateEntry,
  type SvelteInstance,
} from './frameworkTaps';

describe('collectSvelteEntries', () => {
  it('labels ctx entries by prop name (via $$.props) and falls back to ctx[i]', () => {
    const instance: SvelteInstance = {
      $$: {
        ctx: [5, 'hello', true],
        props: { count: 0, label: 1 }, // index 2 has no name
      },
    };
    const entries: StateEntry[] = [];
    collectSvelteEntries(instance, entries);

    expect(entries.map((e) => [e.label, e.value])).toEqual([
      ['count', { kind: 'number', value: 5 }],
      ['label', { kind: 'string', value: 'hello' }],
      ['ctx[2]', { kind: 'boolean', value: true }],
    ]);
    expect(entries.every((e) => e.group === 'state' && e.writable === false)).toBe(true);
    expect(entries[0].path).toEqual(['ctx', '0']);
  });

  it('skips function ctx slots (compiled handlers/derived helpers)', () => {
    const instance: SvelteInstance = { $$: { ctx: [1, () => {}, 2] } };
    const entries: StateEntry[] = [];
    collectSvelteEntries(instance, entries);
    expect(entries.map((e) => e.label)).toEqual(['ctx[0]', 'ctx[2]']);
  });

  it('is a no-op when no instance / no ctx array is reachable', () => {
    const entries: StateEntry[] = [];
    collectSvelteEntries(null, entries);
    collectSvelteEntries(undefined, entries);
    collectSvelteEntries({}, entries);
    collectSvelteEntries({ $$: {} }, entries);
    expect(entries).toEqual([]);
  });

  it('respects the entry cap', () => {
    const instance: SvelteInstance = { $$: { ctx: [1, 2, 3, 4, 5] } };
    const entries: StateEntry[] = [];
    collectSvelteEntries(instance, entries, 2);
    expect(entries).toHaveLength(2);
  });
});

describe('collectReactContextEntries', () => {
  it('walks the context dependency chain, labelling by displayName', () => {
    const fiber = {
      dependencies: {
        firstContext: {
          context: { displayName: 'ThemeContext', _currentValue: 'stale' },
          memoizedValue: 'dark',
          next: {
            context: { _currentValue: { user: 'ada' } }, // no displayName
            next: null,
          },
        },
      },
    };
    const entries: StateEntry[] = [];
    collectReactContextEntries(fiber, entries);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      group: 'context',
      label: 'ThemeContext',
      value: { kind: 'string', value: 'dark' }, // prefers memoizedValue over _currentValue
      writable: false,
    });
    expect(entries[1].label).toBe('Context[1]');
    // Falls back to _currentValue when memoizedValue is absent; serialized as an
    // object carrying the user field (exact serialize shape is covered by xray).
    expect(entries[1].value).toMatchObject({ kind: 'object' });
    const v1 = entries[1].value as { kind: 'object'; entries: Array<{ key: string; value: unknown }> };
    expect(v1.entries).toContainEqual({ key: 'user', value: { kind: 'string', value: 'ada' } });
  });

  it('is a no-op with no dependencies', () => {
    const entries: StateEntry[] = [];
    collectReactContextEntries(null, entries);
    collectReactContextEntries({}, entries);
    collectReactContextEntries({ dependencies: { firstContext: null } }, entries);
    expect(entries).toEqual([]);
  });
});

describe('Vue ref helpers', () => {
  it('isVueRef detects the __v_isRef brand only', () => {
    expect(isVueRef({ __v_isRef: true, value: 1 })).toBe(true);
    expect(isVueRef({ value: 1 })).toBe(false); // a plain {value} is not a ref
    expect(isVueRef(5)).toBe(false);
    expect(isVueRef(null)).toBe(false);
  });

  it('unwrapMaybeRef reads through a ref, passes plain values as-is', () => {
    expect(unwrapMaybeRef({ __v_isRef: true, value: 42 })).toBe(42);
    expect(unwrapMaybeRef('plain')).toBe('plain');
  });

  it('applyVueWrite writes through .value for refs (reactivity-safe)', () => {
    const ref = { __v_isRef: true, value: 1 };
    const bag: Record<string, unknown> = { count: ref };
    expect(applyVueWrite(bag, 'count', 9)).toBe(true);
    // The ref object is preserved and its .value updated (not replaced).
    expect(bag.count).toBe(ref);
    expect(ref.value).toBe(9);
  });

  it('applyVueWrite assigns plain (non-ref) members directly', () => {
    const bag: Record<string, unknown> = { name: 'a' };
    expect(applyVueWrite(bag, 'name', 'b')).toBe(true);
    expect(bag.name).toBe('b');
  });

  it('applyVueWrite returns false when the key is absent', () => {
    expect(applyVueWrite({}, 'missing', 1)).toBe(false);
  });
});
