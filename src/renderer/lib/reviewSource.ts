/**
 * Easel — review-mode source resolver (issue #19).
 *
 * Pure helper that maps a streamed {@link FileDiff} to the {@link SourceLocation}
 * the renderer should highlight on the LIVE (still pre-edit) page, so the user
 * can see what each staged change affects before approving it.
 *
 * Resolution order, most-reliable first:
 *  1. A user-picked {@link ElementTarget} whose `dataEaselSource.filePath`
 *     matches the diff's file — the user literally pointed at this element, so
 *     its exact `data-easel-source` is the best anchor.
 *  2. The OLD-side start line of the diff's FIRST hunk header
 *     (`@@ -oldStart,oldLen +newStart,newLen @@`). The live page still shows the
 *     pre-edit source, so the OLD line is what the reverse `data-easel-source`
 *     lookup in the guest should match against.
 *
 * Returns `undefined` when nothing is resolvable: a created file (no old side),
 * a diff with no parseable hunk header, or malformed input. The PreviewPane then
 * simply skips highlighting that change.
 */

import type { ElementTarget, FileDiff, SourceLocation } from '@shared/types';

/**
 * Parse the FIRST `@@ -oldStart,oldLen +newStart,newLen @@` hunk header out of a
 * unified diff and return its OLD-side start line. Returns `undefined` when no
 * hunk header is present (e.g. a pure rename/binary diff) or `oldStart` is 0,
 * which a unified diff uses for a created file (no pre-edit line to anchor to).
 */
function firstOldHunkLine(unifiedDiff: string): number | undefined {
  if (!unifiedDiff) return undefined;
  for (const raw of unifiedDiff.split('\n')) {
    if (!raw.startsWith('@@')) continue;
    const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(raw);
    if (!match) return undefined;
    const oldStart = parseInt(match[1], 10);
    // A created file's hunk reads `@@ -0,0 +1,N @@` — there is no pre-edit line
    // on the live page to highlight, so treat it as unresolvable.
    if (!Number.isFinite(oldStart) || oldStart <= 0) return undefined;
    return oldStart;
  }
  return undefined;
}

/**
 * Resolve the on-page source location to highlight for one staged change.
 *
 * @param diff    The streamed file diff for the staged change.
 * @param targets The element targets the user selected for this edit. A target
 *                whose `dataEaselSource.filePath` matches `diff.filePath` wins.
 * @returns The {@link SourceLocation} to highlight, or `undefined` when none is
 *          resolvable (created file, unparseable diff, or malformed input).
 */
export function sourceForDiff(
  diff: FileDiff,
  targets: ElementTarget[],
): SourceLocation | undefined {
  // 1. Prefer the user-picked element's exact source (most reliable).
  const picked = targets.find(
    (t) => t.dataEaselSource && t.dataEaselSource.filePath === diff.filePath,
  );
  if (picked?.dataEaselSource) return picked.dataEaselSource;

  // 2. Fall back to the OLD-side first-hunk line (the live page is pre-edit).
  const line = firstOldHunkLine(diff.unifiedDiff);
  if (line === undefined) return undefined;

  return { filePath: diff.filePath, line, column: 1 };
}
