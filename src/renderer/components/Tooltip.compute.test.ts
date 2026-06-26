/**
 * Unit tests for the Tooltip positioning math (`compute`). It is a pure function
 * of the trigger rect, tooltip rect, side/align, and viewport size — no DOM — so
 * it runs in the default node environment.
 */

import { describe, it, expect } from 'vitest';
import { compute } from './Tooltip';

/** Build a DOMRect-like object with the fields `compute` reads. */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON() {
      /* no-op */
    },
  } as DOMRect;
}

const VW = 1000;
const VH = 800;
const GAP = 8;
const MARGIN = 8;

describe('Tooltip compute()', () => {
  it('centers a tooltip below the trigger for side="bottom"', () => {
    const trigger = rect(100, 100, 40, 30); // centerX=120, bottom=130
    const tip = rect(0, 0, 80, 24);
    const c = compute(trigger, tip, 'bottom', 'center', VW, VH);
    expect(c.side).toBe('bottom');
    expect(c.y).toBe(130 + GAP);
    expect(c.x).toBe(120 - 40); // centerX - tip.width/2
  });

  it('flips to bottom when there is no room above (side="top")', () => {
    const trigger = rect(100, 4, 40, 20);
    const tip = rect(0, 0, 80, 40);
    const c = compute(trigger, tip, 'top', 'center', VW, VH);
    expect(c.side).toBe('bottom');
  });

  it('flips to top when there is no room below (side="bottom")', () => {
    const trigger = rect(100, VH - 24, 40, 20); // near the viewport bottom
    const tip = rect(0, 0, 80, 40);
    const c = compute(trigger, tip, 'bottom', 'center', VW, VH);
    expect(c.side).toBe('top');
  });

  it('pins an oversized tooltip to the margin instead of off-screen (clamp regression)', () => {
    const trigger = rect(100, 100, 40, 30);
    const tip = rect(0, 0, 400, 24); // wider than the 200px viewport
    const c = compute(trigger, tip, 'bottom', 'center', 200, VH);
    expect(c.x).toBe(MARGIN); // never negative / off the left edge
  });

  it('respects align="start" and align="end"', () => {
    const trigger = rect(300, 100, 60, 30); // left=300, right=360
    const tip = rect(0, 0, 100, 24);
    expect(compute(trigger, tip, 'bottom', 'start', VW, VH).x).toBe(300);
    expect(compute(trigger, tip, 'bottom', 'end', VW, VH).x).toBe(360 - 100);
  });

  it('positions to the right of the trigger and vertically centers for side="right"', () => {
    const trigger = rect(100, 200, 40, 40); // right=140, vCenter=220
    const tip = rect(0, 0, 80, 30);
    const c = compute(trigger, tip, 'right', 'center', VW, VH);
    expect(c.side).toBe('right');
    expect(c.x).toBe(140 + GAP);
    expect(c.y).toBe(220 - 15); // vCenter - tip.height/2
  });

  it('keeps the arrow offset within the tooltip body even when clamped', () => {
    const trigger = rect(0, 100, 10, 10); // far-left trigger, centerX=5
    const tip = rect(0, 0, 120, 24);
    const c = compute(trigger, tip, 'bottom', 'center', VW, VH);
    expect(c.arrow).toBeGreaterThanOrEqual(12);
    expect(c.arrow).toBeLessThanOrEqual(120 - 12);
  });
});
