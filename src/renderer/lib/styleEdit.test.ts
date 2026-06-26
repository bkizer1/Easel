import { describe, it, expect } from 'vitest';
import { buildStyleEditInstruction, formatStyleEdit } from './styleEdit';
import type { StyleEdit } from '@shared/types';

describe('formatStyleEdit', () => {
  it('renders a property change as from → to', () => {
    expect(formatStyleEdit({ property: 'padding', oldValue: '8px', newValue: '16px' })).toBe(
      'padding: 8px → 16px',
    );
  });

  it('labels an empty oldValue as (unset)', () => {
    expect(formatStyleEdit({ property: 'color', oldValue: '', newValue: 'red' })).toBe(
      'color: (unset) → red',
    );
  });
});

describe('buildStyleEditInstruction', () => {
  it('lists every delta and forbids inline styles', () => {
    const deltas: StyleEdit[] = [
      { property: 'padding', oldValue: '8px', newValue: '16px' },
      { property: 'border-radius', oldValue: '0px', newValue: '8px' },
    ];
    const out = buildStyleEditInstruction(deltas);
    expect(out).toContain('padding: 8px → 16px');
    expect(out).toContain('border-radius: 0px → 8px');
    expect(out).toContain('do NOT add an inline');
    expect(out.toLowerCase()).toContain('tailwind');
  });
});
