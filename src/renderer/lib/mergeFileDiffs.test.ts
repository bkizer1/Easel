import { describe, it, expect } from 'vitest';
import type { FileDiff } from '@shared/types';
import { mergeFileDiffs } from './mergeFileDiffs';

const diff = (filePath: string, additions = 1): FileDiff => ({
  filePath,
  changeType: 'modified',
  unifiedDiff: `@@ ${filePath} @@\n+line`,
  additions,
  deletions: 0,
});

describe('mergeFileDiffs', () => {
  it('keeps a file only the earlier attempt touched (the fix-B regression)', () => {
    const attempt1 = [diff('a.tsx'), diff('b.tsx')];
    const attempt2 = [diff('b.tsx', 5)]; // retry only re-touched b
    const merged = mergeFileDiffs(attempt1, attempt2);
    expect(merged.map((d) => d.filePath)).toEqual(['a.tsx', 'b.tsx']);
  });

  it('lets the incoming diff WIN for a file present in both', () => {
    const merged = mergeFileDiffs([diff('b.tsx', 1)], [diff('b.tsx', 9)]);
    expect(merged).toHaveLength(1);
    expect(merged[0].additions).toBe(9);
  });

  it('appends files new to the incoming attempt in incoming order', () => {
    const merged = mergeFileDiffs([diff('a.tsx')], [diff('c.tsx'), diff('d.tsx')]);
    expect(merged.map((d) => d.filePath)).toEqual(['a.tsx', 'c.tsx', 'd.tsx']);
  });

  it('preserves the order of existing files when incoming overlaps', () => {
    const existing = [diff('a.tsx'), diff('b.tsx'), diff('c.tsx')];
    const incoming = [diff('c.tsx', 2), diff('a.tsx', 2)];
    const merged = mergeFileDiffs(existing, incoming);
    expect(merged.map((d) => d.filePath)).toEqual(['a.tsx', 'b.tsx', 'c.tsx']);
    expect(merged.map((d) => d.additions)).toEqual([2, 1, 2]);
  });

  it('returns the incoming set when there is no existing accumulation', () => {
    expect(mergeFileDiffs([], [diff('a.tsx')]).map((d) => d.filePath)).toEqual(['a.tsx']);
  });

  it('returns the existing set when there is nothing incoming', () => {
    expect(mergeFileDiffs([diff('a.tsx')], []).map((d) => d.filePath)).toEqual(['a.tsx']);
  });
});
