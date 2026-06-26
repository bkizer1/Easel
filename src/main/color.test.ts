import { describe, it, expect } from 'vitest';
import { parseColor, colorDistance, colorsMatch } from './color';

describe('parseColor', () => {
  it('parses 6-digit hex', () => {
    expect(parseColor('#1e293b')).toEqual({ r: 30, g: 41, b: 59, a: 1 });
  });

  it('parses 3-digit hex by doubling nibbles', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('parses 8-digit hex with alpha', () => {
    expect(parseColor('#1e293b80')).toEqual({ r: 30, g: 41, b: 59, a: 128 / 255 });
  });

  it('parses rgb() and rgba()', () => {
    expect(parseColor('rgb(30, 41, 59)')).toEqual({ r: 30, g: 41, b: 59, a: 1 });
    expect(parseColor('rgba(30,41,59,0.5)')).toEqual({ r: 30, g: 41, b: 59, a: 0.5 });
  });

  it('parses named colors', () => {
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it('returns null for unrecognized input', () => {
    expect(parseColor('not-a-color')).toBeNull();
    expect(parseColor('')).toBeNull();
    expect(parseColor('#12')).toBeNull();
  });
});

describe('colorDistance', () => {
  it('is zero for identical colors', () => {
    expect(colorDistance({ r: 1, g: 2, b: 3, a: 1 }, { r: 1, g: 2, b: 3, a: 1 })).toBe(0);
  });

  it('is large for black vs white', () => {
    const d = colorDistance({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(d).toBeGreaterThan(400);
  });
});

describe('colorsMatch', () => {
  it('matches the same color across hex and rgb forms', () => {
    expect(colorsMatch('#1e293b', 'rgb(30, 41, 59)')).toBe(true);
  });

  it('matches a near-miss within tolerance', () => {
    expect(colorsMatch('#1e293b', 'rgb(31, 41, 59)')).toBe(true);
  });

  it('rejects a clearly different color', () => {
    expect(colorsMatch('#1e293b', '#ffffff')).toBe(false);
  });

  it('rejects unparseable colors', () => {
    expect(colorsMatch('#1e293b', 'chartreuse')).toBe(false);
  });
});
