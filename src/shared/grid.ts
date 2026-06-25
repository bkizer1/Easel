/**
 * Easel — alignment-grid geometry (pure, cross-process).
 *
 * The shared math behind the alignment-grid overlay and the off-grid detector
 * (issue #5). Kept free of DOM / Electron / React so it can be imported from the
 * webview guest (`src/preload/webview/inspector.ts`), the renderer, AND be
 * unit-tested directly under the `node` Vitest environment.
 *
 * Coordinate space: every value here is in preview-viewport CSS pixels, the same
 * space `getBoundingClientRect` reports and the rest of Easel's geometry uses
 * (see `src/shared/types.ts`).
 */

import type { BoundingBox } from './types';

/* -------------------------------------------------------------------------- */
/*  Grid configuration                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A column + baseline grid description. The column grid is a classic
 * margin/gutter layout grid (à la Figma): `columns` equal columns separated by
 * `gutter`, inset from both viewport edges by `margin`. The baseline grid is a
 * single horizontal rhythm of `baseline`-px rows used to check vertical spacing.
 */
export interface GridConfig {
  /** Number of equal-width columns. */
  columns: number;
  /** Horizontal space between adjacent columns, in px. */
  gutter: number;
  /** Inset from the left and right viewport edges, in px. */
  margin: number;
  /** Vertical baseline rhythm (row height), in px. Also the snap unit. */
  baseline: number;
}

/** Sensible default grid: a 12-column layout on an 8px baseline. */
export const DEFAULT_GRID: GridConfig = {
  columns: 12,
  gutter: 24,
  margin: 24,
  baseline: 8,
};

/**
 * Default tolerance (px) for the off-grid detector: an edge is flagged only if
 * it misses the nearest grid line by MORE than this. Sub-pixel rounding from
 * layout and zoom should not trip the detector.
 */
export const DEFAULT_OFF_GRID_THRESHOLD = 2;

/* -------------------------------------------------------------------------- */
/*  Column geometry                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Compute the left x-position of every column boundary (the start of each
 * column AND the end of the last column) for a grid of the given viewport
 * width. The result is a sorted, de-duplicated list of x-coordinates that a
 * well-aligned element's left/right edges are expected to land on.
 *
 * Returns an empty array when the grid cannot fit (non-positive width/columns,
 * or margins/gutters wider than the viewport).
 */
export function columnEdges(grid: GridConfig, viewportWidth: number): number[] {
  const { columns, gutter, margin } = grid;
  if (columns <= 0 || viewportWidth <= 0) return [];

  const contentWidth = viewportWidth - margin * 2;
  const totalGutter = gutter * (columns - 1);
  const columnWidth = (contentWidth - totalGutter) / columns;
  if (columnWidth <= 0) return [];

  const edges: number[] = [];
  let x = margin;
  for (let i = 0; i < columns; i++) {
    edges.push(x); // column start
    x += columnWidth;
    edges.push(x); // column end
    x += gutter; // step over the gutter to the next column start
  }
  return edges;
}

/* -------------------------------------------------------------------------- */
/*  Off-grid detection                                                         */
/* -------------------------------------------------------------------------- */

/** The per-edge misalignment of a box against a grid, in px. */
export interface GridMisalignment {
  /** Distance from the box's left edge to the nearest column edge. */
  left: number;
  /** Distance from the box's right edge to the nearest column edge. */
  right: number;
  /** Distance from the box's top edge to the nearest baseline row. */
  top: number;
  /** Distance from the box's bottom edge to the nearest baseline row. */
  bottom: number;
  /** The single largest of the four edge distances (the headline number). */
  worst: number;
}

/** Distance from `value` to the nearest multiple of `step` (>= 0). */
export function distanceToBaseline(value: number, step: number): number {
  if (step <= 0) return 0;
  const rem = Math.abs(value % step);
  return Math.min(rem, step - rem);
}

/** Distance from `value` to the nearest entry in `edges` (>= 0). */
export function distanceToNearestEdge(value: number, edges: number[]): number {
  if (edges.length === 0) return 0;
  let best = Infinity;
  for (const e of edges) {
    const d = Math.abs(value - e);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Measure how far a box's four edges sit from the grid: horizontal edges
 * (left/right) against the column edges, vertical edges (top/bottom) against
 * the baseline rhythm. `worst` is the maximum, used to rank offenders.
 */
export function measureMisalignment(
  box: BoundingBox,
  grid: GridConfig,
  viewportWidth: number,
): GridMisalignment {
  const edges = columnEdges(grid, viewportWidth);
  const left = distanceToNearestEdge(box.x, edges);
  const right = distanceToNearestEdge(box.x + box.width, edges);
  const top = distanceToBaseline(box.y, grid.baseline);
  const bottom = distanceToBaseline(box.y + box.height, grid.baseline);
  const worst = Math.max(left, right, top, bottom);
  return { left, right, top, bottom, worst };
}

/**
 * Whether a box is "off grid": its worst edge misses the grid by strictly more
 * than `threshold` px. A zero-area box is never off-grid (nothing to align).
 */
export function isOffGrid(
  box: BoundingBox,
  grid: GridConfig,
  viewportWidth: number,
  threshold: number,
): boolean {
  if (box.width <= 0 && box.height <= 0) return false;
  return measureMisalignment(box, grid, viewportWidth).worst > threshold;
}
