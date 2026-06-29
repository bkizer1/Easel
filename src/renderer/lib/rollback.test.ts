import { describe, it, expect } from 'vitest';
import type { Checkpoint } from '@shared/types';
import { resolveRollbackTarget } from './rollback';

const cp = (id: string): Checkpoint => ({
  id,
  commitSha: id,
  message: id,
  createdAt: 0,
  changedFiles: [],
});

// Newest-first, mirroring the store's prepend order.
const checkpoints: Checkpoint[] = [cp('c3'), cp('c2'), cp('c1')];

describe('resolveRollbackTarget', () => {
  it('restores the next-older checkpoint (pre-edit state) for the failed turn', () => {
    // Undoing c2's edit restores c1 (the state before c2).
    expect(resolveRollbackTarget(checkpoints, 'c2')).toBe('c1');
  });

  it('restores the next-older checkpoint for the newest turn', () => {
    expect(resolveRollbackTarget(checkpoints, 'c3')).toBe('c2');
  });

  it('returns undefined for the OLDEST checkpoint (no pre-edit state)', () => {
    expect(resolveRollbackTarget(checkpoints, 'c1')).toBeUndefined();
  });

  it('returns undefined when the checkpoint id is unknown', () => {
    expect(resolveRollbackTarget(checkpoints, 'nope')).toBeUndefined();
  });

  it('returns undefined when no checkpoint id is provided', () => {
    expect(resolveRollbackTarget(checkpoints, undefined)).toBeUndefined();
  });

  it('matches DiffViewer Reject semantics: idx+1 of the newest-first list', () => {
    // This is the exact computation DiffViewer.handleReject performed inline.
    const idx = checkpoints.findIndex((c) => c.id === 'c2');
    const previous = idx >= 0 ? checkpoints[idx + 1] : undefined;
    expect(resolveRollbackTarget(checkpoints, 'c2')).toBe(previous?.id);
  });
});
