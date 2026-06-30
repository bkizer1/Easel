/**
 * Easel — review-session reducer helpers (issue #19).
 *
 * Pure functions that mutate a {@link ReviewSession}'s staged-change list in
 * response to streamed diffs and user decisions. Extracted from the store so the
 * accumulation/merge/decision logic is unit-testable without a live store.
 *
 * In review mode the agent's edits are STAGED (shadow worktree) rather than
 * written; these helpers accumulate the streamed `file-edit`/`diff` events into
 * per-file {@link StagedChange}s WITHOUT touching the live timeline/checkpoints.
 */

import type { ElementTarget, FileDiff, ReviewDecision, StagedChange } from '@shared/types';
import { sourceForDiff } from './reviewSource';

/**
 * Upsert one streamed {@link FileDiff} into the staged-change list, keyed by
 * `filePath` (mirrors the live `file-edit` dedupe). An existing change for the
 * same file is REPLACED with the latest diff + freshly-resolved source, but its
 * prior {@link ReviewDecision} is PRESERVED so a streamed re-edit of a file the
 * user already approved/rejected doesn't silently reset that decision. New files
 * are appended `pending`.
 */
export function upsertStagedChange(
  changes: StagedChange[],
  diff: FileDiff,
  targets: ElementTarget[],
): StagedChange[] {
  const source = sourceForDiff(diff, targets);
  const idx = changes.findIndex((c) => c.diff.filePath === diff.filePath);
  if (idx >= 0) {
    const next = [...changes];
    next[idx] = { diff, source, decision: changes[idx].decision };
    return next;
  }
  return [...changes, { diff, source, decision: 'pending' }];
}

/**
 * Replace the whole staged-change list from a full `diff` snapshot (the
 * `AgentEvent` `diff` variant carries the complete accumulated set). Existing
 * decisions are PRESERVED by `filePath`; files dropped from the snapshot are
 * removed; new files are appended `pending`, in snapshot order.
 */
export function replaceStagedChanges(
  changes: StagedChange[],
  diffs: FileDiff[],
  targets: ElementTarget[],
): StagedChange[] {
  const priorDecision = new Map(changes.map((c) => [c.diff.filePath, c.decision]));
  return diffs.map((diff) => ({
    diff,
    source: sourceForDiff(diff, targets),
    decision: priorDecision.get(diff.filePath) ?? 'pending',
  }));
}

/**
 * Set one change's {@link ReviewDecision} by `filePath`. No-op (returns the same
 * reference) when the path is not staged.
 */
export function setStagedDecision(
  changes: StagedChange[],
  filePath: string,
  decision: ReviewDecision,
): StagedChange[] {
  if (!changes.some((c) => c.diff.filePath === filePath)) return changes;
  return changes.map((c) => (c.diff.filePath === filePath ? { ...c, decision } : c));
}

/** The project-relative paths of changes the user has explicitly APPROVED. */
export function approvedPaths(changes: StagedChange[]): string[] {
  return changes.filter((c) => c.decision === 'approved').map((c) => c.diff.filePath);
}

/** Tally of changes by decision, for the panel's footer counts. */
export function reviewCounts(changes: StagedChange[]): {
  approved: number;
  rejected: number;
  pending: number;
  total: number;
} {
  let approved = 0;
  let rejected = 0;
  let pending = 0;
  for (const c of changes) {
    if (c.decision === 'approved') approved++;
    else if (c.decision === 'rejected') rejected++;
    else pending++;
  }
  return { approved, rejected, pending, total: changes.length };
}
