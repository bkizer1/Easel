import { describe, it, expect } from 'vitest';
import { bboxUnion, boxFromPoints, pointInBox, translateForScroll, clamp } from './geometry';

describe('geometry', () => {
  it('boxFromPoints encloses all points', () => {
    expect(boxFromPoints([{ x: 10, y: 20 }, { x: 30, y: 5 }])).toEqual({ x: 10, y: 5, width: 20, height: 15 });
  });

  it('boxFromPoints returns a zero box for an empty list', () => {
    expect(boxFromPoints([])).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('bboxUnion merges overlapping and disjoint boxes', () => {
    const u = bboxUnion([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: 5, width: 10, height: 10 },
    ]);
    expect(u).toEqual({ x: 0, y: 0, width: 30, height: 15 });
  });

  it('pointInBox is boundary-inclusive', () => {
    const b = { x: 0, y: 0, width: 10, height: 10 };
    expect(pointInBox({ x: 0, y: 0 }, b)).toBe(true);
    expect(pointInBox({ x: 10, y: 10 }, b)).toBe(true);
    expect(pointInBox({ x: 11, y: 5 }, b)).toBe(false);
  });

  it('translateForScroll applies the scroll delta', () => {
    expect(translateForScroll({ x: 100, y: 100 }, { x: 0, y: 0 }, { x: 0, y: 40 })).toEqual({ x: 100, y: 60 });
  });

  it('clamp bounds a value', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
