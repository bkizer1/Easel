import { describe, it, expect } from 'vitest';
import { buildTokenizeInstruction } from './tokenize';
import type { TokenMatch } from '@shared/types';

describe('buildTokenizeInstruction', () => {
  it('references a CSS custom property for a css-var token', () => {
    const match: TokenMatch = {
      property: 'color',
      value: '#1e293b',
      token: {
        name: '--color-slate-800',
        value: '#1e293b',
        kind: 'css-var',
        replacement: 'var(--color-slate-800)',
      },
    };
    const out = buildTokenizeInstruction(match);
    expect(out).toContain('#1e293b');
    expect(out).toContain('var(--color-slate-800)');
    expect(out).toContain('color');
  });

  it('references the Tailwind token for a tailwind match', () => {
    const match: TokenMatch = {
      property: 'color',
      value: '#1e293b',
      token: { name: 'slate-800', value: '#1e293b', kind: 'tailwind', replacement: 'slate-800' },
    };
    const out = buildTokenizeInstruction(match);
    expect(out).toContain('Tailwind');
    expect(out).toContain('slate-800');
  });

  it('throws for an off-system value', () => {
    const match: TokenMatch = { property: 'color', value: '#abcdef', token: null };
    expect(() => buildTokenizeInstruction(match)).toThrow();
  });
});
