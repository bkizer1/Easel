import { describe, it, expect } from 'vitest';
import type { FileDiff, StagedChange } from '@shared/types';
import {
  approvedPaths,
  replaceStagedChanges,
  reviewCounts,
  setStagedDecision,
  upsertStagedChange,
} from './reviewSession';

const diff = (filePath: string, oldStart = 10, additions = 1): FileDiff => ({
  filePath,
  changeType: 'modified',
  unifiedDiff: `@@ -${oldStart},2 +${oldStart},3 @@\n-old\n+new`,
  additions,
  deletions: 1,
});

describe('upsertStagedChange', () => {
  it('appends a new file as pending with a resolved source', () => {
    const next = upsertStagedChange([], diff('src/A.tsx', 5), []);
    expect(next).toHaveLength(1);
    expect(next[0].decision).toBe('pending');
    expect(next[0].source).toEqual({ filePath: 'src/A.tsx', line: 5, column: 1 });
  });

  it('replaces the diff for an existing file but preserves its decision', () => {
    const start: StagedChange[] = [
      { diff: diff('src/A.tsx', 5, 1), source: undefined, decision: 'approved' },
    ];
    const next = upsertStagedChange(start, diff('src/A.tsx', 5, 9), []);
    expect(next).toHaveLength(1);
    expect(next[0].diff.additions).toBe(9);
    expect(next[0].decision).toBe('approved');
  });

  it('keeps existing files in place when upserting another', () => {
    const start = upsertStagedChange([], diff('src/A.tsx'), []);
    const next = upsertStagedChange(start, diff('src/B.tsx'), []);
    expect(next.map((c) => c.diff.filePath)).toEqual(['src/A.tsx', 'src/B.tsx']);
  });
});

describe('replaceStagedChanges', () => {
  it('replaces from a full snapshot, preserving decisions by filePath', () => {
    const start: StagedChange[] = [
      { diff: diff('src/A.tsx'), source: undefined, decision: 'rejected' },
      { diff: diff('src/B.tsx'), source: undefined, decision: 'pending' },
    ];
    const next = replaceStagedChanges(start, [diff('src/B.tsx'), diff('src/C.tsx')], []);
    expect(next.map((c) => c.diff.filePath)).toEqual(['src/B.tsx', 'src/C.tsx']);
    // A.tsx dropped; B keeps pending; C is new → pending.
    expect(next.map((c) => c.decision)).toEqual(['pending', 'pending']);
  });

  it('preserves an approved decision across a snapshot replace', () => {
    const start: StagedChange[] = [
      { diff: diff('src/A.tsx'), source: undefined, decision: 'approved' },
    ];
    const next = replaceStagedChanges(start, [diff('src/A.tsx', 12)], []);
    expect(next[0].decision).toBe('approved');
    expect(next[0].source).toEqual({ filePath: 'src/A.tsx', line: 12, column: 1 });
  });
});

describe('setStagedDecision', () => {
  it('sets one change decision by filePath', () => {
    const start = upsertStagedChange([], diff('src/A.tsx'), []);
    const next = setStagedDecision(start, 'src/A.tsx', 'approved');
    expect(next[0].decision).toBe('approved');
  });

  it('returns the same reference for an unknown path', () => {
    const start = upsertStagedChange([], diff('src/A.tsx'), []);
    expect(setStagedDecision(start, 'src/Z.tsx', 'approved')).toBe(start);
  });
});

describe('approvedPaths / reviewCounts', () => {
  const changes: StagedChange[] = [
    { diff: diff('a'), source: undefined, decision: 'approved' },
    { diff: diff('b'), source: undefined, decision: 'rejected' },
    { diff: diff('c'), source: undefined, decision: 'pending' },
    { diff: diff('d'), source: undefined, decision: 'approved' },
  ];

  it('collects only approved paths', () => {
    expect(approvedPaths(changes)).toEqual(['a', 'd']);
  });

  it('tallies decisions', () => {
    expect(reviewCounts(changes)).toEqual({ approved: 2, rejected: 1, pending: 1, total: 4 });
  });
});
