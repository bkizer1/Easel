import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rmrf } from './rmrf';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Both checkpoints.ts and reviewSession.ts broadcast to the main window on
// change; stub it out so the git mechanics run under plain Node.
vi.mock('@main/window', () => ({ getMainWindow: () => null }));

import { initCheckpoints, listCheckpoints } from './checkpoints';
import {
  createReviewSession,
  applyReviewSession,
  discardReviewSession,
  hasReviewSession,
} from './reviewSession';

/** Run git synchronously in `dir`. stderr is captured (not inherited) so an
 *  expected failure (e.g. verifying a deleted ref) does not spam the test log. */
function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .toString()
    .trim();
}

/** Spin up a throwaway git repo with two committed files; return its path. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'easel-review-'));
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'config', 'user.email', 'test@easel.dev');
  gitIn(dir, 'config', 'user.name', 'Easel Test');
  writeFileSync(join(dir, 'app.tsx'), 'export const App = () => null;\n');
  writeFileSync(join(dir, 'other.tsx'), 'export const Other = () => null;\n');
  gitIn(dir, 'add', '--all');
  gitIn(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

const created: string[] = [];
function freshRepo(): string {
  const dir = makeRepo();
  created.push(dir);
  return dir;
}

/** Snapshot the live working-tree files we care about, byte-for-byte. */
function snapshot(dir: string): Record<string, string> {
  return {
    'app.tsx': readFileSync(join(dir, 'app.tsx'), 'utf8'),
    'other.tsx': readFileSync(join(dir, 'other.tsx'), 'utf8'),
  };
}

/** Whether a ref exists in the repo at `dir`. */
function refExists(dir: string, ref: string): boolean {
  try {
    gitIn(dir, 'rev-parse', '--verify', ref);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  while (created.length) rmrf(created.pop()!);
});

afterEach(() => {
  while (created.length) rmrf(created.pop()!);
});

describe('reviewSession — propose-don\'t-write (Issue #19)', () => {
  it('(a)+(b) staging an edit leaves the LIVE tree unchanged and lands on refs/easel/staging/<id>', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    const requestId = 'req-stage-1';
    const before = snapshot(dir);

    const { worktreePath, stagedCheckpointFn } = await createReviewSession(dir, requestId);
    expect(existsSync(worktreePath)).toBe(true);

    // The agent edits in the WORKTREE, not the live tree.
    writeFileSync(join(worktreePath, 'app.tsx'), 'export const App = () => <h1>Staged</h1>;\n');
    const checkpoint = await stagedCheckpointFn('Add a heading', requestId);

    // (a) The live working tree is byte-for-byte unchanged.
    expect(snapshot(dir)).toEqual(before);

    // (b) The staging ref exists and its tree carries the staged change.
    const stagingRef = `refs/easel/staging/${requestId}`;
    expect(refExists(dir, stagingRef)).toBe(true);
    const stagedContent = gitIn(dir, 'show', `${stagingRef}:app.tsx`);
    expect(stagedContent).toContain('<h1>Staged</h1>');

    // The returned checkpoint reflects the staged commit.
    expect(checkpoint.commitSha).toBeTruthy();
    expect(checkpoint.changedFiles).toContain('app.tsx');

    // The live checkpoint timeline was NOT advanced by staging.
    const { checkpoints } = listCheckpoints();
    expect(checkpoints.every((c) => c.requestId !== requestId)).toBe(true);

    await discardReviewSession(dir, requestId);
  });

  it('(c) apply writes ONLY the approved subset into the live tree and creates exactly one checkpoint', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    const requestId = 'req-apply-1';
    const { worktreePath, stagedCheckpointFn } = await createReviewSession(dir, requestId);

    // Stage edits to BOTH files in the worktree.
    writeFileSync(join(worktreePath, 'app.tsx'), 'export const App = () => <h1>Approved</h1>;\n');
    writeFileSync(join(worktreePath, 'other.tsx'), 'export const Other = () => <p>Rejected</p>;\n');
    await stagedCheckpointFn('Edit both', requestId);

    const beforeOther = readFileSync(join(dir, 'other.tsx'), 'utf8');
    const checkpointsBefore = listCheckpoints().checkpoints.length;

    // Approve ONLY app.tsx.
    const result = await applyReviewSession(dir, requestId, ['app.tsx']);

    // Only app.tsx was written to the live tree; other.tsx is untouched.
    expect(readFileSync(join(dir, 'app.tsx'), 'utf8')).toContain('<h1>Approved</h1>');
    expect(readFileSync(join(dir, 'other.tsx'), 'utf8')).toBe(beforeOther);
    expect(result.appliedFiles).toEqual(['app.tsx']);

    // Exactly one new checkpoint landed on the live timeline.
    const checkpointsAfter = listCheckpoints().checkpoints.length;
    expect(checkpointsAfter).toBe(checkpointsBefore + 1);
    expect(result.checkpoint).not.toBeNull();
    expect(result.checkpoint?.requestId).toBe(requestId);

    // The session is torn down after apply.
    expect(hasReviewSession(requestId)).toBe(false);
    expect(refExists(dir, `refs/easel/staging/${requestId}`)).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('(c) empty approvedPaths applies nothing but still tears the session down', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    const requestId = 'req-apply-empty';
    const before = snapshot(dir);
    const checkpointsBefore = listCheckpoints().checkpoints.length;

    const { worktreePath, stagedCheckpointFn } = await createReviewSession(dir, requestId);
    writeFileSync(join(worktreePath, 'app.tsx'), 'export const App = () => <h1>Nope</h1>;\n');
    await stagedCheckpointFn('Edit', requestId);

    const result = await applyReviewSession(dir, requestId, []);

    expect(result.checkpoint).toBeNull();
    expect(result.appliedFiles).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
    expect(listCheckpoints().checkpoints.length).toBe(checkpointsBefore);
    expect(hasReviewSession(requestId)).toBe(false);
    expect(existsSync(worktreePath)).toBe(false);
  });

  it('(d) discard removes the worktree + staging ref and leaves the live tree unchanged', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    const requestId = 'req-discard-1';
    const before = snapshot(dir);
    const checkpointsBefore = listCheckpoints().checkpoints.length;

    const { worktreePath, stagedCheckpointFn } = await createReviewSession(dir, requestId);
    writeFileSync(join(worktreePath, 'app.tsx'), 'export const App = () => <h1>Discarded</h1>;\n');
    await stagedCheckpointFn('Edit', requestId);

    expect(refExists(dir, `refs/easel/staging/${requestId}`)).toBe(true);
    expect(existsSync(worktreePath)).toBe(true);

    await discardReviewSession(dir, requestId);

    // Worktree gone, staging ref gone, live tree unchanged, no new checkpoint.
    expect(existsSync(worktreePath)).toBe(false);
    expect(refExists(dir, `refs/easel/staging/${requestId}`)).toBe(false);
    expect(snapshot(dir)).toEqual(before);
    expect(listCheckpoints().checkpoints.length).toBe(checkpointsBefore);
    expect(hasReviewSession(requestId)).toBe(false);
  });

  it('apply/discard on an unknown session is handled gracefully', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    // Apply throws (caught + typed by the IPC layer); discard is idempotent.
    await expect(applyReviewSession(dir, 'no-such-id', ['app.tsx'])).rejects.toThrow(/Unknown review session/);
    await expect(discardReviewSession(dir, 'no-such-id')).resolves.toBeUndefined();
  });

  it('handles a created file staged then approved into the live tree', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    const requestId = 'req-create-1';
    const { worktreePath, stagedCheckpointFn } = await createReviewSession(dir, requestId);

    // Create a brand-new file in the worktree.
    writeFileSync(join(worktreePath, 'new.tsx'), 'export const New = () => null;\n');
    const checkpoint = await stagedCheckpointFn('Create file', requestId);
    expect(checkpoint.changedFiles).toContain('new.tsx');

    // Not yet in the live tree.
    expect(existsSync(join(dir, 'new.tsx'))).toBe(false);

    const result = await applyReviewSession(dir, requestId, ['new.tsx']);
    expect(result.appliedFiles).toEqual(['new.tsx']);
    expect(readFileSync(join(dir, 'new.tsx'), 'utf8')).toContain('export const New');
  });
});
