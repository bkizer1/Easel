import { describe, it, expect } from 'vitest';
import {
  serializeValue,
  formatSerializedValue,
  diffSerialized,
  type SerializedValue,
} from './xray';

describe('serializeValue', () => {
  it('lowers primitives to tagged nodes', () => {
    expect(serializeValue('hi')).toEqual({ kind: 'string', value: 'hi' });
    expect(serializeValue(42)).toEqual({ kind: 'number', value: 42 });
    expect(serializeValue(true)).toEqual({ kind: 'boolean', value: true });
    expect(serializeValue(null)).toEqual({ kind: 'null' });
    expect(serializeValue(undefined)).toEqual({ kind: 'undefined' });
    expect(serializeValue(10n)).toEqual({ kind: 'bigint', value: '10' });
  });

  it('truncates long strings and flags them', () => {
    const long = 'x'.repeat(500);
    const out = serializeValue(long, { maxStringLen: 10 });
    expect(out).toEqual({ kind: 'string', value: 'xxxxxxxxxx…', truncated: true });
  });

  it('captures functions by name', () => {
    function namedFn() {}
    expect(serializeValue(namedFn)).toEqual({ kind: 'function', name: 'namedFn' });
    expect(serializeValue(() => 0)).toMatchObject({ kind: 'function' });
  });

  it('serializes plain objects and arrays recursively', () => {
    const out = serializeValue({ a: 1, b: [true, 'x'] });
    expect(out).toEqual({
      kind: 'object',
      entries: [
        { key: 'a', value: { kind: 'number', value: 1 } },
        {
          key: 'b',
          value: {
            kind: 'array',
            length: 2,
            truncated: false,
            items: [
              { kind: 'boolean', value: true },
              { kind: 'string', value: 'x' },
            ],
          },
        },
      ],
      truncated: false,
    });
  });

  it('records non-plain constructor names', () => {
    const out = serializeValue(new Map()) as Extract<SerializedValue, { kind: 'object' }>;
    expect(out.kind).toBe('object');
    expect(out.ctor).toBe('Map');
  });

  it('is cycle-safe (no infinite recursion)', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a.self = a;
    const out = serializeValue(a) as Extract<SerializedValue, { kind: 'object' }>;
    expect(out.kind).toBe('object');
    const selfEntry = out.entries.find((e) => e.key === 'self');
    expect(selfEntry?.value).toEqual({ kind: 'circular' });
  });

  it('honors maxDepth', () => {
    const deep = { l1: { l2: { l3: { l4: { l5: 'deep' } } } } };
    const out = serializeValue(deep, { maxDepth: 2 });
    // root object (depth0) -> l1 value (object, depth1) -> l2 value (max-depth, depth2)
    const l1 = (out as Extract<SerializedValue, { kind: 'object' }>).entries[0].value as Extract<
      SerializedValue,
      { kind: 'object' }
    >;
    expect(l1.kind).toBe('object');
    expect(l1.entries[0].value.kind).toBe('max-depth');
  });

  it('caps the number of entries and flags truncation', () => {
    const wide: Record<string, number> = {};
    for (let i = 0; i < 100; i++) wide['k' + i] = i;
    const out = serializeValue(wide, { maxEntries: 5 }) as Extract<SerializedValue, { kind: 'object' }>;
    expect(out.entries).toHaveLength(5);
    expect(out.truncated).toBe(true);
  });

  it('survives throwing getters', () => {
    const obj = {
      get boom(): number {
        throw new Error('nope');
      },
      ok: 1,
    };
    const out = serializeValue(obj) as Extract<SerializedValue, { kind: 'object' }>;
    const boom = out.entries.find((e) => e.key === 'boom');
    expect(boom?.value.kind).toBe('unserializable');
    expect(out.entries.find((e) => e.key === 'ok')?.value).toEqual({ kind: 'number', value: 1 });
  });

  it('identifies DOM-like nodes without serializing them', () => {
    const fakeEl = { nodeType: 1, tagName: 'DIV', innerHTML: '<huge/>' };
    expect(serializeValue(fakeEl)).toEqual({ kind: 'dom', tagName: 'div' });
  });

  it('serializes Date to ISO', () => {
    const d = new Date('2026-01-02T03:04:05.000Z');
    expect(serializeValue(d)).toEqual({ kind: 'date', value: '2026-01-02T03:04:05.000Z' });
  });
});

describe('formatSerializedValue', () => {
  it('renders nested structures compactly', () => {
    const v = serializeValue({ a: 1, b: ['x'], c: null });
    expect(formatSerializedValue(v)).toBe('{a: 1, b: ["x"], c: null}');
  });

  it('quotes strings and marks truncation', () => {
    const v = serializeValue('hi');
    expect(formatSerializedValue(v)).toBe('"hi"');
  });
});

describe('diffSerialized', () => {
  it('returns nothing for identical trees', () => {
    const a = serializeValue({ x: 1, y: [1, 2] });
    const b = serializeValue({ x: 1, y: [1, 2] });
    expect(diffSerialized(a, b)).toEqual([]);
  });

  it('detects changed leaves with before/after', () => {
    const a = serializeValue({ count: 1 });
    const b = serializeValue({ count: 2 });
    expect(diffSerialized(a, b)).toEqual([
      { path: 'count', kind: 'changed', before: '1', after: '2' },
    ]);
  });

  it('detects added and removed keys', () => {
    const a = serializeValue({ keep: 1, gone: 2 });
    const b = serializeValue({ keep: 1, added: 3 });
    const diff = diffSerialized(a, b);
    expect(diff).toContainEqual({ path: 'gone', kind: 'removed', before: '2' });
    expect(diff).toContainEqual({ path: 'added', kind: 'added', after: '3' });
  });

  it('diffs nested object paths', () => {
    const a = serializeValue({ user: { name: 'ada', age: 30 } });
    const b = serializeValue({ user: { name: 'ada', age: 31 } });
    expect(diffSerialized(a, b)).toEqual([
      { path: 'user.age', kind: 'changed', before: '30', after: '31' },
    ]);
  });

  it('diffs arrays element-wise and reports length changes', () => {
    const a = serializeValue({ items: [1, 2] });
    const b = serializeValue({ items: [1, 2, 3] });
    const diff = diffSerialized(a, b);
    expect(diff).toContainEqual({ path: 'items[2]', kind: 'added', after: '3' });
    expect(diff).toContainEqual({ path: 'items.length', kind: 'changed', before: '2', after: '3' });
  });

  it('treats a kind mismatch as a change', () => {
    const a = serializeValue({ v: 1 });
    const b = serializeValue({ v: 'one' });
    expect(diffSerialized(a, b)).toEqual([
      { path: 'v', kind: 'changed', before: '1', after: '"one"' },
    ]);
  });
});
