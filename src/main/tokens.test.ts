import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractCssVars,
  extractTailwindTokens,
  matchValue,
  resolveTokens,
  type DesignToken,
} from './tokens';

describe('extractCssVars', () => {
  it('parses custom properties into var() tokens', () => {
    const css = ':root {\n  --color-slate-800: #1e293b;\n  --space-4: 1rem;\n}';
    const tokens = extractCssVars(css);
    expect(tokens).toContainEqual({
      name: '--color-slate-800',
      value: '#1e293b',
      kind: 'css-var',
      replacement: 'var(--color-slate-800)',
    });
    expect(tokens).toContainEqual({
      name: '--space-4',
      value: '1rem',
      kind: 'css-var',
      replacement: 'var(--space-4)',
    });
  });
});

describe('extractTailwindTokens', () => {
  it('flattens a nested color scale into dashed token names', () => {
    const config = `module.exports = {
      theme: { extend: { colors: { slate: { 800: '#1e293b' }, brand: '#2dd4bf' } } },
    };`;
    const tokens = extractTailwindTokens(config);
    const names = tokens.map((t) => t.name);
    expect(names).toContain('slate-800');
    expect(names).toContain('brand');
    const slate = tokens.find((t) => t.name === 'slate-800');
    expect(slate?.value).toBe('#1e293b');
    expect(slate?.kind).toBe('tailwind');
  });

  it('ignores non-token literals', () => {
    const config = `module.exports = { content: ['./src/**/*.tsx'], theme: {} };`;
    expect(extractTailwindTokens(config)).toEqual([]);
  });
});

describe('matchValue', () => {
  const tokens: DesignToken[] = [
    { name: '--color-slate-800', value: '#1e293b', kind: 'css-var', replacement: 'var(--color-slate-800)' },
    { name: 'slate-800', value: '#1e293b', kind: 'tailwind', replacement: 'slate-800' },
    { name: '--space-4', value: '1rem', kind: 'css-var', replacement: 'var(--space-4)' },
  ];

  it('matches a computed rgb color to a hex token within tolerance', () => {
    const t = matchValue('color', 'rgb(30, 41, 59)', tokens);
    expect(t?.name).toBe('--color-slate-800'); // css-var preferred over tailwind
  });

  it('matches an exact non-color value', () => {
    expect(matchValue('padding', '1rem', tokens)?.name).toBe('--space-4');
  });

  it('returns null for an off-system value', () => {
    expect(matchValue('color', '#abcdef', tokens)).toBeNull();
    expect(matchValue('padding', '13px', tokens)).toBeNull();
  });
});

describe('resolveTokens (filesystem)', () => {
  const dirs: string[] = [];
  const freshDir = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'easel-tokens-'));
    dirs.push(d);
    return d;
  };
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  it('collects tokens from CSS + tailwind config and matches computed values', async () => {
    const root = freshDir();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'theme.css'), ':root { --color-slate-800: #1e293b; }');
    writeFileSync(
      join(root, 'tailwind.config.js'),
      `module.exports = { theme: { extend: { spacing: { '4': '1rem' } } } };`,
    );
    // node_modules must be ignored.
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.css'), ':root { --leak: #ffffff; }');

    const matches = await resolveTokens(root, {
      color: 'rgb(30, 41, 59)',
      padding: '1rem',
      'font-size': '13px',
    });

    const byProp = Object.fromEntries(matches.map((m) => [m.property, m]));
    expect(byProp['color'].token?.name).toBe('--color-slate-800');
    expect(byProp['padding'].token?.name).toBe('4');
    expect(byProp['font-size'].token).toBeNull(); // off-system

    // The node_modules leak must not be indexed.
    expect(matches.some((m) => m.token?.name === '--leak')).toBe(false);
  });
});
