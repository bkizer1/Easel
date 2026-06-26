/**
 * Easel — design-token resolver (Live token inspector, #8).
 *
 * Greps a project's token sources — CSS custom properties (`--name: value`) and
 * Tailwind config color/spacing/typography literals — and matches a picked
 * element's computed values against them. Colors match within a tolerance (so
 * `rgb(30,41,59)` resolves to a `#1e293b` token); other values match exactly
 * after light normalization. Values with no match are reported "off-system".
 *
 * The file-walking entry points take an explicit `root` so they are testable
 * against a temp directory with no Electron.
 */

import fs from 'node:fs';
import path from 'node:path';
import { colorsMatch, parseColor } from '@main/color';
import type { DesignToken, TokenMatch } from '@shared/types';

export type { DesignToken, TokenKind, TokenMatch } from '@shared/types';

/** Properties whose values are colors (compared with tolerance). */
const COLOR_PROPERTIES = new Set([
  'color',
  'background-color',
  'border-color',
  'outline-color',
  'fill',
  'stroke',
]);

/** Tailwind config nesting keys that are containers, not token names. */
const WRAPPER_KEYS = new Set([
  'module',
  'exports',
  'theme',
  'extend',
  'colors',
  'spacing',
  'borderradius',
  'fontsize',
  'fontfamily',
  'screens',
  'default',
  'presets',
  'config',
  'plugins',
  'content',
]);

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', '.cache']);
/** Bound the walk so a huge repo never stalls token resolution. */
const MAX_FILES = 400;

/* -------------------------------------------------------------------------- */
/*  Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/** Extract `--name: value;` custom properties from a CSS source string. */
export function extractCssVars(css: string): DesignToken[] {
  const tokens: DesignToken[] = [];
  const re = /--([\w-]+)\s*:\s*([^;{}]+);/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css))) {
    const name = `--${m[1]}`;
    const value = m[2].trim();
    if (!value) continue;
    tokens.push({ name, value, kind: 'css-var', replacement: `var(${name})` });
  }
  return tokens;
}

/**
 * Extract leaf token literals from a Tailwind config's object literal, joining
 * the nesting path (minus wrapper keys) into a token name, e.g.
 * `colors: { slate: { 800: '#1e293b' } }` → `slate-800`.
 */
export function extractTailwindTokens(source: string): DesignToken[] {
  const leaves: Array<{ path: string[]; value: string }> = [];
  const stack: string[] = [];
  let lastIdent: string | null = null;
  let keyForValue: string | null = null;

  const re = /('[^']*'|"[^"]*"|`[^`]*`|[A-Za-z0-9_$.-]+|[:{},])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const tok = m[1];
    if (tok === '{') {
      if (keyForValue !== null) {
        stack.push(keyForValue);
        keyForValue = null;
      }
      lastIdent = null;
    } else if (tok === '}') {
      stack.pop();
      keyForValue = null;
      lastIdent = null;
    } else if (tok === ':') {
      keyForValue = lastIdent;
      lastIdent = null;
    } else if (tok === ',') {
      keyForValue = null;
      lastIdent = null;
    } else {
      const val = unquote(tok);
      if (keyForValue !== null) {
        leaves.push({ path: [...stack, keyForValue], value: val });
        keyForValue = null;
      } else {
        lastIdent = val;
      }
    }
  }

  const tokens: DesignToken[] = [];
  for (const leaf of leaves) {
    if (!isTokenValue(leaf.value)) continue;
    const parts = leaf.path.filter((p) => !WRAPPER_KEYS.has(p.toLowerCase()));
    if (parts.length === 0) continue;
    const name = parts.join('-').replace(/^-+|-+$/g, '');
    if (!name) continue;
    tokens.push({ name, value: leaf.value, kind: 'tailwind', replacement: name });
  }
  return tokens;
}

function unquote(s: string): string {
  if (s.length >= 2 && /^['"`]/.test(s)) return s.slice(1, -1);
  return s;
}

/** Whether a literal is worth indexing as a token (a color or a sized value). */
function isTokenValue(value: string): boolean {
  if (parseColor(value)) return true;
  return /^-?\d*\.?\d+(px|rem|em|%)$/.test(value.trim());
}

/* -------------------------------------------------------------------------- */
/*  Matching                                                                   */
/* -------------------------------------------------------------------------- */

/** Normalize a non-color value for exact comparison (collapse whitespace). */
function normalize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Find the best token for one computed `value` of `property`, or null. */
export function matchValue(
  property: string,
  value: string,
  tokens: readonly DesignToken[],
): DesignToken | null {
  const isColor = COLOR_PROPERTIES.has(property);
  if (isColor) {
    if (!parseColor(value)) return null;
    // Prefer css-var matches over tailwind hints when both match.
    const colorTokens = tokens.filter((t) => parseColor(t.value));
    const matches = colorTokens.filter((t) => colorsMatch(value, t.value));
    if (matches.length === 0) return null;
    return matches.find((t) => t.kind === 'css-var') ?? matches[0];
  }
  const norm = normalize(value);
  const matches = tokens.filter((t) => normalize(t.value) === norm);
  if (matches.length === 0) return null;
  return matches.find((t) => t.kind === 'css-var') ?? matches[0];
}

/** Match a set of `{property: computedValue}` pairs against `tokens`. */
export function matchComputedValues(
  values: Record<string, string>,
  tokens: readonly DesignToken[],
): TokenMatch[] {
  return Object.entries(values).map(([property, value]) => ({
    property,
    value,
    token: matchValue(property, value, tokens),
  }));
}

/* -------------------------------------------------------------------------- */
/*  Collection (filesystem)                                                     */
/* -------------------------------------------------------------------------- */

/** Collect all design tokens from a project's CSS + Tailwind config files. */
export async function collectTokens(root: string): Promise<DesignToken[]> {
  const tokens: DesignToken[] = [];
  let count = 0;

  const walk = async (dir: string): Promise<void> => {
    if (count >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= MAX_FILES) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const name = entry.name;
      const isCss = /\.(css|scss|sass|less)$/.test(name);
      const isTw = /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(name);
      if (!isCss && !isTw) continue;
      count++;
      let text: string;
      try {
        text = await fs.promises.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (isCss) tokens.push(...extractCssVars(text));
      if (isTw) tokens.push(...extractTailwindTokens(text));
    }
  };

  await walk(root);
  return dedupe(tokens);
}

/** De-duplicate tokens by name+value, preferring the first occurrence. */
function dedupe(tokens: DesignToken[]): DesignToken[] {
  const seen = new Set<string>();
  const out: DesignToken[] = [];
  for (const t of tokens) {
    const key = `${t.kind}:${t.name}:${t.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Collect tokens from `root` and match the given computed values against them. */
export async function resolveTokens(
  root: string,
  values: Record<string, string>,
): Promise<TokenMatch[]> {
  const tokens = await collectTokens(root);
  return matchComputedValues(values, tokens);
}
