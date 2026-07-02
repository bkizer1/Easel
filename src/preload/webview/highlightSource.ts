/**
 * Easel — Review-mode source→element matching (issue #19).
 *
 * The guest inspector's hover path maps DOM→source (click an element → read its
 * `data-easel-source`). Review mode needs the REVERSE: given source locations
 * (file:line from a streamed diff), find the live on-page element(s) the change
 * affects so the PreviewPane can outline them.
 *
 * This module holds the PURE matching logic only — it takes plain data (already
 * parsed `{ el, source }` pairs) and returns the elements to outline, with no
 * DOM access of its own. That keeps it unit-testable in a node environment
 * (vitest, no jsdom). The DOM scanning + overlay drawing live in
 * `inspector.ts`, which calls into this function.
 */

import type { SourceLocation } from '@shared/types';

/**
 * Maximum line drift tolerated when matching a requested source to a stamped
 * element. HMR and minor source edits can shift the stamped `line` by a few
 * lines relative to what the diff reports, so an exact-line match is preferred
 * but a match within ±this many lines is accepted (closest wins). Beyond this
 * window an element is NOT considered a match.
 */
export const LINE_TOLERANCE = 5;

/**
 * One stamped element paired with its parsed `data-easel-source`. The `el` is
 * intentionally typed as the generic `T` (defaulting to `Element`) so callers
 * pass real DOM nodes in the browser while tests pass plain sentinel objects.
 */
export interface StampedElement<T = Element> {
  /** The live element carrying the `data-easel-source` attribute. */
  el: T;
  /** The parsed source location for {@link el}. */
  source: SourceLocation;
}

/**
 * Resolve the requested {@link SourceLocation}s to the on-page elements they
 * affect, by reverse `data-easel-source` lookup.
 *
 * Matching rules:
 *  - A stamped element matches a requested source only when their `filePath`s
 *    are exactly equal AND the absolute line distance is `<= LINE_TOLERANCE`.
 *  - For each requested source we keep every stamped element within tolerance
 *    on the file with the SMALLEST line distance — i.e. an exact-line match
 *    wins over a near-line one, and ties (a component rendered N times at the
 *    same line) all match. So a single source can light up multiple elements.
 *  - Different requested sources resolve independently and may map to different
 *    elements.
 *  - The returned list is de-duplicated (an element matched by two sources
 *    appears once) while preserving first-match order, so the caller draws one
 *    overlay per distinct element.
 *
 * Pure: no DOM, no side effects. `column` is ignored — line granularity is the
 * finest the stamping reliably provides, and the goal is to outline an element,
 * not a character.
 */
export function matchSourcesToElements<T = Element>(
  sources: SourceLocation[] | null | undefined,
  stamped: StampedElement<T>[],
): T[] {
  if (!sources || sources.length === 0) return [];

  const matched: T[] = [];
  const seen = new Set<T>();

  for (const want of sources) {
    // Find the smallest in-tolerance line distance on the matching file, then
    // collect every stamped element at that best distance.
    let bestDistance = Infinity;
    for (const cand of stamped) {
      if (cand.source.filePath !== want.filePath) continue;
      const distance = Math.abs(cand.source.line - want.line);
      if (distance > LINE_TOLERANCE) continue;
      if (distance < bestDistance) bestDistance = distance;
    }
    if (bestDistance === Infinity) continue; // no element within tolerance

    for (const cand of stamped) {
      if (cand.source.filePath !== want.filePath) continue;
      if (Math.abs(cand.source.line - want.line) !== bestDistance) continue;
      if (seen.has(cand.el)) continue;
      seen.add(cand.el);
      matched.push(cand.el);
    }
  }

  return matched;
}
