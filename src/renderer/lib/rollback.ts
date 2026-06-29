/**
 * Easel — rollback target resolution (issue #32, Deliverable 2).
 *
 * Pure logic shared by {@link DiffViewer}'s "Reject" action and the verify-fail
 * "Roll back" affordance so both agree on exactly which checkpoint to restore.
 *
 * The `checkpoints` array is NEWEST-FIRST (the store prepends on each new
 * checkpoint — see store.ts `checkpoint` case). To revert an edit we restore the
 * checkpoint that existed immediately BEFORE it — i.e. the next-older entry,
 * `checkpoints[idx + 1]`, where `idx` is the failed turn's own checkpoint.
 */

import type { Checkpoint } from '@shared/types';

/**
 * Resolve the id of the checkpoint to restore in order to undo the edit whose
 * checkpoint is `checkpointId`. Returns `undefined` when there is nothing to roll
 * back to — the id is unknown/missing, or it is the OLDEST checkpoint (no
 * pre-edit state to restore). Callers should hide/disable the action then.
 */
export function resolveRollbackTarget(
  checkpoints: Checkpoint[],
  checkpointId: string | undefined,
): string | undefined {
  if (!checkpointId) return undefined;
  const idx = checkpoints.findIndex((c) => c.id === checkpointId);
  if (idx < 0) return undefined;
  // checkpoints are newest-first, so the pre-edit state is the next-older entry.
  return checkpoints[idx + 1]?.id;
}
