/**
 * Easel — cumulative file-diff merge across a self-heal retry (issue #32, fix B).
 *
 * A bounded self-heal retry reuses the SAME requestId but each backend
 * invocation reports ONLY its own diffs. On FAIL→PASS, the retry's terminal
 * `done` would otherwise REPLACE the bubble's diffs with attempt 2's diffs only,
 * dropping files that attempt 1 edited but the retry didn't re-touch.
 *
 * This unions the two diff sets keyed by `filePath`: the incoming (newer) diff
 * WINS for a file present in both, while files only the earlier attempt touched
 * are preserved. Order is STABLE — existing files keep their position, and files
 * new to `incoming` are appended in their incoming order. This mirrors the
 * `file-edit`/`checkpoint` dedupe-by-`filePath` accumulation elsewhere.
 */

import type { FileDiff } from '@shared/types';

/**
 * Merge `incoming` over `existing`, deduped by `filePath` (incoming wins),
 * preserving the order of `existing` and appending genuinely-new files.
 */
export function mergeFileDiffs(existing: FileDiff[], incoming: FileDiff[]): FileDiff[] {
  const incomingByPath = new Map(incoming.map((d) => [d.filePath, d]));
  const seen = new Set<string>();

  const merged: FileDiff[] = existing.map((d) => {
    seen.add(d.filePath);
    return incomingByPath.get(d.filePath) ?? d;
  });

  for (const d of incoming) {
    if (!seen.has(d.filePath)) {
      seen.add(d.filePath);
      merged.push(d);
    }
  }

  return merged;
}
