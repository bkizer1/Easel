import { describe, it, expect } from 'vitest';
import type { ElementTarget, FileDiff, SourceLocation } from '@shared/types';
import { sourceForDiff } from './reviewSource';

const diff = (filePath: string, unifiedDiff: string, changeType: FileDiff['changeType'] = 'modified'): FileDiff => ({
  filePath,
  changeType,
  unifiedDiff,
  additions: 1,
  deletions: 1,
});

const target = (filePath: string, source?: SourceLocation): ElementTarget => ({
  id: `t-${filePath}`,
  selector: `.${filePath.replace(/\W/g, '-')}`,
  tagName: 'div',
  dataEaselSource: source,
  boundingBox: { x: 0, y: 0, width: 10, height: 10 },
  textSnippet: '',
  attributes: {},
  pluginPresent: source !== undefined,
  confidence: source ? 'high' : 'none',
});

describe('sourceForDiff', () => {
  it('prefers a target whose dataEaselSource.filePath matches the diff', () => {
    const src: SourceLocation = { filePath: 'src/Hero.tsx', line: 42, column: 7 };
    const targets = [
      target('src/Other.tsx', { filePath: 'src/Other.tsx', line: 1, column: 1 }),
      target('src/Hero.tsx', src),
    ];
    const d = diff('src/Hero.tsx', '@@ -10,2 +10,3 @@\n-old\n+new');
    // Target match wins over the hunk-parse fallback (line 10).
    expect(sourceForDiff(d, targets)).toEqual(src);
  });

  it('falls back to the OLD-side first hunk line when no target matches', () => {
    const d = diff('src/Hero.tsx', '@@ -23,4 +25,5 @@\n ctx\n-removed\n+added');
    const targets = [target('src/Unrelated.tsx', { filePath: 'src/Unrelated.tsx', line: 1, column: 1 })];
    expect(sourceForDiff(d, targets)).toEqual({ filePath: 'src/Hero.tsx', line: 23, column: 1 });
  });

  it('uses the FIRST hunk header when several are present', () => {
    const d = diff(
      'src/Hero.tsx',
      '@@ -5,1 +5,1 @@\n-a\n+b\n@@ -40,1 +41,1 @@\n-c\n+d',
    );
    expect(sourceForDiff(d, [])).toEqual({ filePath: 'src/Hero.tsx', line: 5, column: 1 });
  });

  it('handles a single-line hunk header without lengths', () => {
    const d = diff('src/Hero.tsx', '@@ -12 +12 @@\n-a\n+b');
    expect(sourceForDiff(d, [])).toEqual({ filePath: 'src/Hero.tsx', line: 12, column: 1 });
  });

  it('returns undefined for a created file (no old side)', () => {
    const d = diff('src/New.tsx', '@@ -0,0 +1,5 @@\n+line1\n+line2', 'created');
    expect(sourceForDiff(d, [])).toBeUndefined();
  });

  it('returns undefined for a malformed diff with no parseable hunk header', () => {
    expect(sourceForDiff(diff('src/Hero.tsx', 'not a diff at all'), [])).toBeUndefined();
    expect(sourceForDiff(diff('src/Hero.tsx', ''), [])).toBeUndefined();
    // A leading @@ that is not a valid hunk header is also unresolvable.
    expect(sourceForDiff(diff('src/Hero.tsx', '@@ garbage @@'), [])).toBeUndefined();
  });

  it('ignores a target match whose filePath differs even when it has a source', () => {
    const targets = [target('src/Other.tsx', { filePath: 'src/Other.tsx', line: 99, column: 1 })];
    const d = diff('src/Hero.tsx', '@@ -7,1 +7,1 @@\n-a\n+b');
    expect(sourceForDiff(d, targets)).toEqual({ filePath: 'src/Hero.tsx', line: 7, column: 1 });
  });
});
