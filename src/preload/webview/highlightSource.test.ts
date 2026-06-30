import { describe, it, expect } from 'vitest';
import {
  matchSourcesToElements,
  LINE_TOLERANCE,
  type StampedElement,
} from './highlightSource';
import type { SourceLocation } from '@shared/types';

const loc = (filePath: string, line: number, column = 1): SourceLocation => ({
  filePath,
  line,
  column,
});

/**
 * The matcher is generic over the element type, so tests use plain string
 * sentinels in place of real DOM nodes. Identity (===) is what matters for
 * de-duplication, so distinct strings stand in for distinct elements.
 */
const stamp = (el: string, source: SourceLocation): StampedElement<string> => ({ el, source });

describe('matchSourcesToElements', () => {
  it('matches an element by exact file + line', () => {
    const stamped = [
      stamp('hero', loc('src/Hero.tsx', 12)),
      stamp('nav', loc('src/Nav.tsx', 4)),
    ];
    const out = matchSourcesToElements([loc('src/Hero.tsx', 12)], stamped);
    expect(out).toEqual(['hero']);
  });

  it('matches multiple elements for one source (component rendered N times)', () => {
    // Same file:line stamped on three live elements (e.g. a Card mapped 3x).
    const stamped = [
      stamp('card-1', loc('src/Card.tsx', 8)),
      stamp('card-2', loc('src/Card.tsx', 8)),
      stamp('card-3', loc('src/Card.tsx', 8)),
      stamp('other', loc('src/Card.tsx', 99)),
    ];
    const out = matchSourcesToElements([loc('src/Card.tsx', 8)], stamped);
    expect(out).toEqual(['card-1', 'card-2', 'card-3']);
  });

  it('falls back to the nearest element within tolerance when no exact line matches', () => {
    // Requested line 10; nearest stamped is line 12 (distance 2, within ±5).
    const stamped = [
      stamp('far', loc('src/App.tsx', 30)),
      stamp('near', loc('src/App.tsx', 12)),
    ];
    const out = matchSourcesToElements([loc('src/App.tsx', 10)], stamped);
    expect(out).toEqual(['near']);
  });

  it('prefers the exact line over a near one, and keeps ties at the best distance', () => {
    const stamped = [
      stamp('near', loc('src/App.tsx', 11)), // distance 1
      stamp('exact-a', loc('src/App.tsx', 10)), // distance 0
      stamp('exact-b', loc('src/App.tsx', 10)), // distance 0 (tie)
    ];
    const out = matchSourcesToElements([loc('src/App.tsx', 10)], stamped);
    expect(out).toEqual(['exact-a', 'exact-b']);
  });

  it('returns no match when the file differs', () => {
    const stamped = [stamp('hero', loc('src/Hero.tsx', 12))];
    const out = matchSourcesToElements([loc('src/Other.tsx', 12)], stamped);
    expect(out).toEqual([]);
  });

  it('returns no match when the line is outside tolerance', () => {
    // Distance LINE_TOLERANCE + 1 must NOT match.
    const stamped = [stamp('hero', loc('src/Hero.tsx', 12 + LINE_TOLERANCE + 1))];
    const out = matchSourcesToElements([loc('src/Hero.tsx', 12)], stamped);
    expect(out).toEqual([]);
  });

  it('matches at exactly the tolerance boundary', () => {
    const stamped = [stamp('edge', loc('src/Hero.tsx', 12 + LINE_TOLERANCE))];
    const out = matchSourcesToElements([loc('src/Hero.tsx', 12)], stamped);
    expect(out).toEqual(['edge']);
  });

  it('resolves multiple distinct sources to their respective elements', () => {
    const stamped = [
      stamp('hero', loc('src/Hero.tsx', 12)),
      stamp('nav', loc('src/Nav.tsx', 4)),
      stamp('footer', loc('src/Footer.tsx', 20)),
    ];
    const out = matchSourcesToElements(
      [loc('src/Hero.tsx', 12), loc('src/Footer.tsx', 20)],
      stamped,
    );
    expect(out).toEqual(['hero', 'footer']);
  });

  it('de-duplicates an element matched by two overlapping sources', () => {
    const stamped = [stamp('hero', loc('src/Hero.tsx', 12))];
    // Two sources, both within tolerance of the same element.
    const out = matchSourcesToElements(
      [loc('src/Hero.tsx', 12), loc('src/Hero.tsx', 13)],
      stamped,
    );
    expect(out).toEqual(['hero']);
  });

  it('ignores the column when matching (line granularity only)', () => {
    const stamped = [stamp('hero', loc('src/Hero.tsx', 12, 9))];
    const out = matchSourcesToElements([loc('src/Hero.tsx', 12, 1)], stamped);
    expect(out).toEqual(['hero']);
  });

  it('returns an empty list for null/empty sources (clear semantics)', () => {
    const stamped = [stamp('hero', loc('src/Hero.tsx', 12))];
    expect(matchSourcesToElements(null, stamped)).toEqual([]);
    expect(matchSourcesToElements([], stamped)).toEqual([]);
  });

  it('returns an empty list when there are no stamped elements', () => {
    expect(matchSourcesToElements([loc('src/Hero.tsx', 12)], [])).toEqual([]);
  });
});
