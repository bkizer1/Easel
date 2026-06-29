import { describe, it, expect } from 'vitest';
import type { Checkpoint, ChatMessage } from '@shared/types';
import { earliestTurnCheckpointId, resolveRollbackTarget } from './rollback';

const cp = (id: string): Checkpoint => ({
  id,
  commitSha: id,
  message: id,
  createdAt: 0,
  changedFiles: [],
});

const asst = (requestId: string, checkpointId?: string, retryAttempt?: number): ChatMessage => ({
  id: `${requestId}-${checkpointId ?? 'none'}-${retryAttempt ?? 0}`,
  role: 'assistant',
  content: '',
  createdAt: 0,
  requestId,
  ...(checkpointId ? { checkpointId } : {}),
  ...(retryAttempt !== undefined ? { retryAttempt } : {}),
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

describe('earliestTurnCheckpointId (issue #32 whole-turn rollback)', () => {
  it('returns the only checkpoint for a single-attempt turn', () => {
    const chat = [asst('rA', 'c2')];
    expect(earliestTurnCheckpointId(chat, 'rA')).toBe('c2');
  });

  it('FAIL→FAIL: picks the EARLIEST (attempt-1) checkpoint, not the retry’s', () => {
    // A self-heal turn rA: attempt-1 bubble carries C1, the retry bubble carries C2
    // (appended later). Rolling the turn back must target C1 so resolveRollbackTarget
    // lands on the PRE-EDIT state (before C1), not the intermediate state after C1.
    const chat = [asst('rA', 'c1'), asst('rA', 'c2', 2)];
    const earliest = earliestTurnCheckpointId(chat, 'rA');
    expect(earliest).toBe('c1');
    // checkpoints newest-first = [c2, c1, c0]; from c1 the pre-edit state is c0.
    const cps = [cp('c2'), cp('c1'), cp('c0')];
    expect(resolveRollbackTarget(cps, earliest)).toBe('c0');
    // The buggy "latest checkpoint" (c2) would have stranded the user on c1.
    expect(resolveRollbackTarget(cps, 'c2')).toBe('c1');
  });

  it('ignores other turns’ checkpoints and skips bubbles without one', () => {
    const chat = [asst('rOther', 'cX'), asst('rA'), asst('rA', 'c1')];
    expect(earliestTurnCheckpointId(chat, 'rA')).toBe('c1');
  });

  it('returns undefined when the turn made no checkpoint or no requestId given', () => {
    expect(earliestTurnCheckpointId([asst('rA')], 'rA')).toBeUndefined();
    expect(earliestTurnCheckpointId([asst('rA', 'c1')], undefined)).toBeUndefined();
  });
});
