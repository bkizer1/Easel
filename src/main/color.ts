/**
 * Easel — color parsing & comparison (Live token inspector, #8).
 *
 * Pure logic (no Node/Electron/DOM) so it is unit-testable. Normalizes the
 * common CSS color forms (hex 3/4/6/8, `rgb()`/`rgba()`, a small set of named
 * colors) to RGBA and compares two colors within a perceptual-ish tolerance so
 * a computed `rgb(30, 41, 59)` can be matched to a `#1e293b` design token.
 */

/** A parsed color in 0–255 channels with 0–1 alpha. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** The handful of named colors worth resolving without a full CSS table. */
const NAMED_COLORS: Record<string, string> = {
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  transparent: '#00000000',
};

/** Parse a CSS color string to {@link Rgba}, or null if unrecognized. */
export function parseColor(input: string): Rgba | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();

  if (s in NAMED_COLORS) s = NAMED_COLORS[s];

  // Hex: #rgb, #rgba, #rrggbb, #rrggbbaa
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const r = parseInt(hex[0] + hex[0], 16);
      const g = parseInt(hex[1] + hex[1], 16);
      const b = parseInt(hex[2] + hex[2], 16);
      const a = hex.length === 4 ? parseInt(hex[3] + hex[3], 16) / 255 : 1;
      return valid(r, g, b) ? { r, g, b, a } : null;
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      return valid(r, g, b) ? { r, g, b, a } : null;
    }
    return null;
  }

  // rgb()/rgba()
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    const a = parts[3] !== undefined ? alpha(parts[3]) : 1;
    if (r === null || g === null || b === null || a === null) return null;
    return { r, g, b, a };
  }

  return null;
}

function valid(...nums: number[]): boolean {
  return nums.every((n) => Number.isFinite(n) && n >= 0 && n <= 255);
}

/** Parse a single rgb channel: `255` or `50%`. */
function channel(raw: string): number | null {
  const t = raw.trim();
  if (t.endsWith('%')) {
    const p = parseFloat(t);
    return Number.isFinite(p) ? Math.round((Math.max(0, Math.min(100, p)) / 100) * 255) : null;
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(255, Math.round(n))) : null;
}

/** Parse an alpha value: `0.5` or `50%`. */
function alpha(raw: string): number | null {
  const t = raw.trim();
  if (t.endsWith('%')) {
    const p = parseFloat(t);
    return Number.isFinite(p) ? Math.max(0, Math.min(1, p / 100)) : null;
  }
  const n = parseFloat(t);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
}

/**
 * Euclidean distance between two colors in RGBA space (channels 0–255, alpha
 * scaled to 0–255). 0 = identical. Two equal opaque colors are distance 0;
 * black vs white is ~441.
 */
export function colorDistance(a: Rgba, b: Rgba): number {
  const dr = a.r - b.r;
  const dg = a.g - b.g;
  const db = a.b - b.b;
  const da = (a.a - b.a) * 255;
  return Math.sqrt(dr * dr + dg * dg + db * db + da * da);
}

/** Default tolerance: small rounding/AA differences match; distinct colors don't. */
export const DEFAULT_COLOR_TOLERANCE = 8;

/** Whether two color strings represent the same color within `tolerance`. */
export function colorsMatch(a: string, b: string, tolerance = DEFAULT_COLOR_TOLERANCE): boolean {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return false;
  return colorDistance(ca, cb) <= tolerance;
}
