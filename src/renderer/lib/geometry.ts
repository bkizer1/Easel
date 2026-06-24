/**
 * Easel Renderer — geometric utility functions.
 *
 * All geometry in Easel is expressed in preview-viewport CSS pixels — the
 * coordinate space of the <webview> content area. The overlay and the guest
 * inspector share this coordinate space.
 *
 * Functions here are pure (no side effects) and have no React / Electron
 * dependencies, so they can be unit-tested in isolation.
 */

import type { BoundingBox, Point } from '@shared/types';

/**
 * Compute the smallest axis-aligned bounding box that encloses all of the
 * given boxes. Returns a zero-sized box at the origin if the array is empty.
 */
export function bboxUnion(boxes: BoundingBox[]): BoundingBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const b of boxes) {
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width);
    maxY = Math.max(maxY, b.y + b.height);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Return true if point `p` lies within (or on the boundary of) box `b`.
 */
export function pointInBox(p: Point, b: BoundingBox): boolean {
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
}

/**
 * Derive the smallest axis-aligned bounding box that encloses a list of
 * points. Useful for computing the bbox of a freehand stroke or an
 * arrow/ellipse defined by two corner points.
 *
 * Returns a zero-sized box at the origin if the array is empty.
 */
export function boxFromPoints(points: Point[]): BoundingBox {
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * Translate annotation points (stored in viewport-relative coordinates at
 * the time of drawing) to current screen coordinates, accounting for the
 * scroll delta since the annotation was created.
 *
 * Formula: `screenPoint = point - (currentScroll - scrollOrigin)`
 *
 * @param point          - Original point in viewport space.
 * @param scrollOrigin   - Scroll offset when the annotation was drawn.
 * @param currentScroll  - Current scroll offset of the preview.
 */
export function translateForScroll(point: Point, scrollOrigin: Point, currentScroll: Point): Point {
  return {
    x: point.x - (currentScroll.x - scrollOrigin.x),
    y: point.y - (currentScroll.y - scrollOrigin.y),
  };
}

/**
 * Clamp a number to [min, max].
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
