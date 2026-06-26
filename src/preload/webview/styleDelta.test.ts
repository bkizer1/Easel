import { describe, it, expect } from 'vitest';
import { accumulateStyleEdit } from './styleDelta';
import type { StyleEdit } from '@shared/types';

const edit = (property: string, oldValue: string, newValue: string): StyleEdit => ({
  property,
  oldValue,
  newValue,
});

describe('accumulateStyleEdit', () => {
  it('appends the first tweak of a property', () => {
    const out = accumulateStyleEdit([], edit('padding', '8px', '16px'));
    expect(out).toEqual([edit('padding', '8px', '16px')]);
  });

  it('accumulates distinct properties', () => {
    let d: StyleEdit[] = [];
    d = accumulateStyleEdit(d, edit('padding', '8px', '16px'));
    d = accumulateStyleEdit(d, edit('color', 'rgb(0, 0, 0)', 'rgb(255, 0, 0)'));
    expect(d).toHaveLength(2);
    expect(d.map((e) => e.property)).toEqual(['padding', 'color']);
  });

  it('collapses repeat tweaks, keeping the original oldValue and latest newValue', () => {
    let d: StyleEdit[] = [];
    d = accumulateStyleEdit(d, edit('padding', '8px', '16px'));
    // A later tweak reports its own oldValue (the previous newValue) — ignore it,
    // keep the original 8px.
    d = accumulateStyleEdit(d, edit('padding', '16px', '24px'));
    expect(d).toEqual([edit('padding', '8px', '24px')]);
  });

  it('drops a property whose tweak returns it to the original value', () => {
    let d: StyleEdit[] = [];
    d = accumulateStyleEdit(d, edit('padding', '8px', '16px'));
    d = accumulateStyleEdit(d, edit('padding', '16px', '8px')); // back to original
    expect(d).toEqual([]);
  });

  it('does not record a first tweak that is already a no-op', () => {
    const out = accumulateStyleEdit([], edit('margin', '0px', '0px'));
    expect(out).toEqual([]);
  });

  it('never mutates the input array', () => {
    const input: StyleEdit[] = [edit('padding', '8px', '16px')];
    const snapshot = JSON.parse(JSON.stringify(input));
    accumulateStyleEdit(input, edit('color', 'a', 'b'));
    expect(input).toEqual(snapshot);
  });
});
