/**
 * Tests for the pure groupRefactorDiffs helper exported from DiffViewer.
 *
 * Vitest environment is `node` (see vitest.config.ts), so React rendering via
 * @testing-library/react is not available here. We test only the exported pure
 * function — which is the unit that carries the grouping logic.
 *
 * DiffViewer.tsx imports useEaselStore (→ store.ts → window.easel) at module
 * load time, so we mock the store module before importing the component module.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the store and its transitive deps so `window` is never accessed.
vi.mock('../store', () => ({
  useEaselStore: vi.fn(() => undefined),
}));

// Also mock Tooltip and Lucide since they may pull in browser globals.
vi.mock('./Tooltip', () => ({ Tooltip: vi.fn() }));

import type { FileDiff } from '@shared/types';
import { groupRefactorDiffs } from './DiffViewer';

/* -------------------------------------------------------------------------- */
/*  Fixtures                                                                  */
/* -------------------------------------------------------------------------- */

function makeDiff(filePath: string, changeType: FileDiff['changeType'] = 'modified'): FileDiff {
  return {
    filePath,
    changeType,
    unifiedDiff: `@@ -1,1 +1,1 @@\n-old\n+new`,
    additions: 1,
    deletions: 1,
  };
}

/* -------------------------------------------------------------------------- */
/*  groupRefactorDiffs                                                         */
/* -------------------------------------------------------------------------- */

describe('groupRefactorDiffs', () => {
  it('returns empty arrays for empty input', () => {
    const { created, callSites } = groupRefactorDiffs([]);
    expect(created).toEqual([]);
    expect(callSites).toEqual([]);
  });

  it('puts a created diff into the created group', () => {
    const diff = makeDiff('src/components/Card.tsx', 'created');
    const { created, callSites } = groupRefactorDiffs([diff]);
    expect(created).toHaveLength(1);
    expect(created[0].filePath).toBe('src/components/Card.tsx');
    expect(callSites).toHaveLength(0);
  });

  it('puts modified diffs into callSites, not created', () => {
    const diffs = [
      makeDiff('src/pages/Home.tsx', 'modified'),
      makeDiff('src/pages/About.tsx', 'modified'),
    ];
    const { created, callSites } = groupRefactorDiffs(diffs);
    expect(created).toHaveLength(0);
    expect(callSites).toHaveLength(2);
    expect(callSites.map((d) => d.filePath)).toEqual([
      'src/pages/Home.tsx',
      'src/pages/About.tsx',
    ]);
  });

  it('puts renamed diffs into callSites', () => {
    const diff = makeDiff('src/old/Widget.tsx', 'renamed');
    const { created, callSites } = groupRefactorDiffs([diff]);
    expect(created).toHaveLength(0);
    expect(callSites).toHaveLength(1);
  });

  it('puts deleted diffs into callSites', () => {
    const diff = makeDiff('src/old/Widget.tsx', 'deleted');
    const { created, callSites } = groupRefactorDiffs([diff]);
    expect(created).toHaveLength(0);
    expect(callSites).toHaveLength(1);
  });

  it('handles the typical refactor shape: 1 created + N modified', () => {
    const diffs: FileDiff[] = [
      makeDiff('src/components/ProductCard.tsx', 'created'),
      makeDiff('src/pages/Home.tsx', 'modified'),
      makeDiff('src/pages/Shop.tsx', 'modified'),
      makeDiff('src/pages/Featured.tsx', 'modified'),
    ];
    const { created, callSites } = groupRefactorDiffs(diffs);
    expect(created).toHaveLength(1);
    expect(callSites).toHaveLength(3);
    expect(created[0].filePath).toBe('src/components/ProductCard.tsx');
  });

  it('handles multiple created files (preserves order)', () => {
    const diffs: FileDiff[] = [
      makeDiff('src/components/ButtonA.tsx', 'created'),
      makeDiff('src/components/ButtonB.tsx', 'created'),
      makeDiff('src/pages/Page.tsx', 'modified'),
    ];
    const { created, callSites } = groupRefactorDiffs(diffs);
    expect(created).toHaveLength(2);
    expect(created.map((d) => d.filePath)).toEqual([
      'src/components/ButtonA.tsx',
      'src/components/ButtonB.tsx',
    ]);
    expect(callSites).toHaveLength(1);
  });

  it('handles all-modified input (no created files)', () => {
    const diffs = [
      makeDiff('a.tsx', 'modified'),
      makeDiff('b.tsx', 'modified'),
    ];
    const { created, callSites } = groupRefactorDiffs(diffs);
    expect(created).toHaveLength(0);
    expect(callSites).toHaveLength(2);
  });

  it('preserves relative input order within each group', () => {
    const diffs: FileDiff[] = [
      makeDiff('pages/c.tsx', 'modified'),
      makeDiff('components/X.tsx', 'created'),
      makeDiff('pages/a.tsx', 'modified'),
      makeDiff('components/Y.tsx', 'created'),
      makeDiff('pages/b.tsx', 'modified'),
    ];
    const { created, callSites } = groupRefactorDiffs(diffs);
    expect(created.map((d) => d.filePath)).toEqual([
      'components/X.tsx',
      'components/Y.tsx',
    ]);
    expect(callSites.map((d) => d.filePath)).toEqual([
      'pages/c.tsx',
      'pages/a.tsx',
      'pages/b.tsx',
    ]);
  });
});
