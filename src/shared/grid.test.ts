import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GRID,
  columnEdges,
  distanceToBaseline,
  distanceToNearestEdge,
  measureMisalignment,
  isOffGrid,
  type GridConfig,
} from './grid';
import type { BoundingBox } from './types';

describe('grid geometry', () => {
  describe('columnEdges', () => {
    it('produces start+end x for each column, inset by the margin', () => {
      // 2 columns, 10px gutter, 20px margin, 100px wide:
      // content = 100 - 40 = 60; column = (60 - 10) / 2 = 25.
      // col0: 20..45, gutter -> 55, col1: 55..80.
      const grid: GridConfig = { columns: 2, gutter: 10, margin: 20, baseline: 8 };
      expect(columnEdges(grid, 100)).toEqual([20, 45, 55, 80]);
    });

    it('returns [] when the grid cannot fit', () => {
      expect(columnEdges(DEFAULT_GRID, 0)).toEqual([]);
      expect(columnEdges({ columns: 0, gutter: 0, margin: 0, baseline: 8 }, 1000)).toEqual([]);
      // Margins wider than the viewport => non-positive column width.
      expect(columnEdges({ columns: 4, gutter: 100, margin: 10, baseline: 8 }, 200)).toEqual([]);
    });
  });

  describe('distanceToBaseline', () => {
    it('measures distance to the nearest multiple', () => {
      expect(distanceToBaseline(16, 8)).toBe(0);
      expect(distanceToBaseline(18, 8)).toBe(2); // nearest is 16
      expect(distanceToBaseline(20, 8)).toBe(4); // equidistant 16/24
      expect(distanceToBaseline(23, 8)).toBe(1); // nearest is 24
    });

    it('is safe for a non-positive step', () => {
      expect(distanceToBaseline(5, 0)).toBe(0);
    });
  });

  describe('distanceToNearestEdge', () => {
    it('finds the closest edge', () => {
      expect(distanceToNearestEdge(47, [20, 45, 55, 80])).toBe(2);
      expect(distanceToNearestEdge(20, [20, 45, 55, 80])).toBe(0);
    });

    it('returns 0 when there are no edges', () => {
      expect(distanceToNearestEdge(123, [])).toBe(0);
    });
  });

  describe('measureMisalignment / isOffGrid', () => {
    const grid: GridConfig = { columns: 2, gutter: 10, margin: 20, baseline: 8 };
    const viewportWidth = 100;

    it('reports zero for a perfectly aligned box', () => {
      // left 20 (col edge), right 45 (col edge), top 16 (baseline), bottom 24.
      const box: BoundingBox = { x: 20, y: 16, width: 25, height: 8 };
      const m = measureMisalignment(box, grid, viewportWidth);
      expect(m).toEqual({ left: 0, right: 0, top: 0, bottom: 0, worst: 0 });
      expect(isOffGrid(box, grid, viewportWidth, 2)).toBe(false);
    });

    it('flags a box whose edges miss the grid by more than the threshold', () => {
      // left 23 -> 3px off col edge 20; this should trip a 2px threshold.
      const box: BoundingBox = { x: 23, y: 16, width: 22, height: 8 };
      const m = measureMisalignment(box, grid, viewportWidth);
      expect(m.left).toBe(3);
      expect(m.worst).toBeGreaterThan(2);
      expect(isOffGrid(box, grid, viewportWidth, 2)).toBe(true);
    });

    it('ignores zero-area boxes', () => {
      expect(isOffGrid({ x: 7, y: 3, width: 0, height: 0 }, grid, viewportWidth, 2)).toBe(false);
    });
  });
});
