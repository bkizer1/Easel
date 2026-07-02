/**
 * Easel — Review mode (propose-don't-write) shadow-worktree session manager.
 *
 * Issue #19. Normally an Easel edit writes directly to the live project on disk;
 * HMR re-renders the preview and a git checkpoint lands on `refs/easel/checkpoint`.
 * In REVIEW mode the edit must instead be STAGED in a shadow git worktree so the
 * live project (and thus the live preview) is never touched — "the page never
 * flickers with edits you didn't sign off on." Diffs still stream to the
 * renderer. Only when the user approves do the approved files copy into the live
 * project + a real checkpoint is created. Discard tears the worktree down with
 * the live project untouched.
 *
 * Mechanics:
 *  - A worktree is added against the LIVE repo's `.git` (so refs created from the
 *    worktree are visible to the live repo), detached at the BASE commit — the
 *    current Easel checkpoint tip. Because the existing edit flow snapshots the
 *    working tree on every checkpoint, at submit time the live tree matches the
 *    current checkpoint SHA, so `worktree add <baseSha>` reproduces the live
 *    state. For robustness on a fresh/uncheckpointed repo we capture the live
 *    working tree with `git stash create` (or fall back to HEAD / the empty
 *    tree) so a brand-new project still works.
 *  - The agent's edits land in the worktree (the IPC layer points
 *    `runEditStream` at `worktreePath`). `stagedCheckpointFn` commits the
 *    worktree's changes onto `refs/easel/staging/<requestId>` WITHOUT advancing
 *    the live `refs/easel/checkpoint`, mutating the timeline, or broadcasting.
 *  - `applyReviewSession` copies the approved subset of staged files into the
 *    live tree and then calls the real `createCheckpoint`, so the live preview
 *    HMRs and the change lands on the real timeline.
 *  - Teardown removes the worktree, deletes the staging ref, removes the temp
 *    dir, and forgets the session. Idempotent + best-effort.
 *
 * Files owned by this slice: this module + reviewSession.test.ts. See issue #19.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, mkdir, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Checkpoint, CheckpointProvenance } from '@shared/types';
import { createLogger } from '@main/logger';
import { createCheckpoint } from '@main/checkpoints';
import { formatProvenanceTrailers } from '@main/provenance';

const execFileAsync = promisify(execFile);
const log = createLogger('review-session');

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/** Staging refs live exclusively under this prefix (visible to the live repo). */
const STAGING_REF_PREFIX = 'refs/easel/staging/';

/** Max message length stored in the staging commit subject (mirrors checkpoints). */
const MAX_MSG_LEN = 72;

/* -------------------------------------------------------------------------- */
/*  Git shell helper                                                           */
/* -------------------------------------------------------------------------- */

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    // Prevent Git from opening an interactive editor / prompting for input.
    env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

/** Resolve a ref to its full SHA, or null if it does not exist. */
async function resolveRefFull(cwd: string, ref: string): Promise<string | null> {
  try {
    return await git(cwd, 'rev-parse', '--verify', ref);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Session state                                                              */
/* -------------------------------------------------------------------------- */

/** Function the edit pipeline calls to commit the worktree's edits to staging. */
export type StagedCheckpointFn = (
  message: string,
  requestId: string,
  provenance?: CheckpointProvenance,
) => Promise<Checkpoint>;

interface ReviewSessionState {
  /** Echoes {@link EditRequest.id}. */
  requestId: string;
  /** Absolute path to the live project root (the repo whose `.git` is shared). */
  liveRoot: string;
  /** Absolute path to the shadow worktree the agent edits. */
  worktreePath: string;
  /** Full staging ref, e.g. `refs/easel/staging/<requestId>`. */
  stagingRef: string;
  /** The base commit SHA the worktree forked from. */
  baseSha: string;
}

/** Active review sessions keyed by requestId. */
const _sessions = new Map<string, ReviewSessionState>();

/* -------------------------------------------------------------------------- */
/*  Base-commit resolution                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Determine the base commit SHA the worktree should fork from so it reflects the
 * live tree's CURRENT state. Order of preference:
 *  1. The current Easel checkpoint tip (`getCurrentCheckpointSha`). At submit
 *     time the live working tree matches this (the edit flow snapshots the tree
 *     on each checkpoint), so `worktree add <sha>` reproduces the live state.
 *  2. `git stash create` of the live working tree — a commit object capturing
 *     all tracked changes WITHOUT modifying the user's stash list / index /
 *     working tree. Covers a checkpoint-less repo that nonetheless has commits.
 *  3. `HEAD` — a repo with commits but no working-tree changes.
 *  4. The empty tree (a fresh repo with no commits at all): we synthesise a base
 *     commit from it so `worktree add` always has something to detach onto.
 */
async function resolveBaseSha(liveRoot: string): Promise<string> {
  const { getCurrentCheckpointSha } = await import('@main/checkpoints');

  const checkpointSha = getCurrentCheckpointSha();
  if (checkpointSha) {
    const verified = await resolveRefFull(liveRoot, checkpointSha);
    if (verified) return verified;
  }

  // No usable checkpoint tip — capture the live working tree precisely.
  try {
    const stashSha = (await git(liveRoot, 'stash', 'create')).trim();
    if (stashSha) return stashSha;
  } catch {
    // `stash create` fails when there is nothing to stash; fall through.
  }

  const headSha = await resolveRefFull(liveRoot, 'HEAD');
  if (headSha) return headSha;

  // Fresh repo with no commits: build a commit from the empty tree so the
  // worktree has a base to detach onto.
  const emptyTree = await git(liveRoot, 'hash-object', '-t', 'tree', '/dev/null').catch(
    async () => git(liveRoot, 'mktree'),
  );
  return git(liveRoot, 'commit-tree', emptyTree.trim(), '-m', 'Easel review base (empty)');
}

/* -------------------------------------------------------------------------- */
/*  Session lifecycle                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Create a shadow-worktree review session for `requestId`. Returns the worktree
 * path the agent should edit and a `stagedCheckpointFn` the edit pipeline calls
 * instead of the live `createCheckpoint`.
 *
 * If a session already exists for `requestId` it is torn down first (so a retry
 * starts from a clean worktree).
 */
export async function createReviewSession(
  liveRoot: string,
  requestId: string,
): Promise<{ worktreePath: string; stagedCheckpointFn: StagedCheckpointFn }> {
  // A stale session for the same id (e.g. an aborted earlier attempt) must not
  // leak a worktree; tear it down before re-creating.
  if (_sessions.has(requestId)) {
    await discardReviewSession(liveRoot, requestId).catch(() => undefined);
  }

  const baseSha = await resolveBaseSha(liveRoot);
  const stagingRef = `${STAGING_REF_PREFIX}${requestId}`;

  // Seed the staging ref at the base so the first staged commit chains from it.
  await git(liveRoot, 'update-ref', stagingRef, baseSha);

  // Create the worktree under the OS temp dir, detached at the base commit.
  const parent = await mkdtemp(path.join(os.tmpdir(), `easel-review-${requestId}-`));
  const worktreePath = path.join(parent, 'worktree');
  try {
    await git(liveRoot, 'worktree', 'add', '--detach', worktreePath, baseSha);
  } catch (err) {
    // Half-created: clean up the temp dir + staging ref so nothing leaks.
    await git(liveRoot, 'update-ref', '-d', stagingRef).catch(() => undefined);
    await rm(parent, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }

  const session: ReviewSessionState = {
    requestId,
    liveRoot,
    worktreePath,
    stagingRef,
    baseSha,
  };
  _sessions.set(requestId, session);

  log.info('Created review session', { requestId, worktreePath, baseSha: baseSha.slice(0, 8) });

  return {
    worktreePath,
    stagedCheckpointFn: (message, rid, provenance) =>
      _stageCheckpoint(session, message, rid, provenance),
  };
}

/**
 * Commit the worktree's current changes onto the staging ref WITHOUT touching the
 * live timeline / `refs/easel/checkpoint` / broadcasts. Mirrors
 * `createCheckpoint`'s tree+commit-tree mechanics but scoped to the worktree:
 * stage everything in the worktree's index, write a tree, commit it onto the
 * staging ref tip, and advance the staging ref. Returns a {@link Checkpoint}
 * describing the staged commit so the backend can emit a `checkpoint` event.
 */
async function _stageCheckpoint(
  session: ReviewSessionState,
  message: string,
  _requestId: string,
  provenance?: CheckpointProvenance,
): Promise<Checkpoint> {
  const { worktreePath, stagingRef, liveRoot } = session;

  // Files changed in the worktree relative to the staging ref tip (its base).
  const changedFiles = await _changedFilesAgainst(worktreePath, stagingRef);

  // Stage all worktree changes into the worktree's index, then write its tree.
  // The worktree has its own index; this never touches the live repo's index.
  await git(worktreePath, 'add', '--all');
  const treeHash = await git(worktreePath, 'write-tree');

  // Commit the tree, chaining from the staging ref tip (which started at base).
  const parentSha = await resolveRefFull(worktreePath, stagingRef);
  const commitArgs = ['commit-tree', treeHash, '-m', _encodeSubject(message, session.requestId, changedFiles)];
  if (provenance) {
    const trailers = _formatTrailers(provenance, changedFiles);
    if (trailers) commitArgs.push('-m', trailers);
  }
  if (parentSha) commitArgs.push('-p', parentSha);
  const commitSha = await git(worktreePath, ...commitArgs);

  // Advance the staging ref. Using the worktree (shared .git) keeps it visible
  // to the live repo, so apply/teardown can read it from `liveRoot` too.
  await git(worktreePath, 'update-ref', stagingRef, commitSha);

  log.info('Staged checkpoint', {
    requestId: session.requestId,
    sha: commitSha.slice(0, 8),
    files: changedFiles.length,
    ref: stagingRef,
  });
  // Touch liveRoot in a debug breadcrumb so the shared-.git assumption is
  // explicit in logs (the ref is visible from the live repo too).
  void liveRoot;

  return {
    id: commitSha.slice(0, 8),
    commitSha,
    requestId: session.requestId,
    message: message.slice(0, MAX_MSG_LEN),
    createdAt: Date.now(),
    changedFiles,
  };
}

/**
 * Apply the approved subset of a staged session to the LIVE project, then create
 * a real checkpoint on the live timeline (so the preview HMRs + the change is
 * undoable). Tears the session down afterward. Unknown `requestId` resolves to a
 * typed failure (never throws across IPC).
 *
 * For each approved project-relative path: read its content from the staging ref
 * tip and write it into the live project. Files absent from the staging tip are
 * treated as deletions (best-effort removal from the live tree). When
 * `approvedPaths` is empty, nothing is applied but the session is still torn
 * down — equivalent to discard.
 */
export async function applyReviewSession(
  liveRoot: string,
  requestId: string,
  approvedPaths: string[],
  message?: string,
  provenance?: CheckpointProvenance,
): Promise<{ checkpoint: Checkpoint | null; appliedFiles: string[] }> {
  const session = _sessions.get(requestId);
  if (!session) {
    throw new Error(`Unknown review session: ${requestId}`);
  }

  const { stagingRef } = session;
  const appliedFiles: string[] = [];

  // Normalise + de-dupe the approved paths to project-relative, forward-slash form.
  const approved = [...new Set(approvedPaths.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')))].filter(
    Boolean,
  );

  for (const rel of approved) {
    // Guard against path traversal escaping the live root.
    const abs = path.resolve(liveRoot, rel);
    if (abs !== liveRoot && !abs.startsWith(liveRoot + path.sep)) {
      log.warn('Skipping approved path that escapes the project root', { requestId, rel });
      continue;
    }

    const content = await _readBlobFromRef(session, stagingRef, rel);
    if (content === null) {
      // The path does not exist at the staging tip → treat as a deletion.
      await unlink(abs).catch(() => undefined);
      appliedFiles.push(rel);
      continue;
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    appliedFiles.push(rel);
  }

  let checkpoint: Checkpoint | null = null;
  if (appliedFiles.length > 0) {
    // Land the applied files on the real timeline (broadcasts + preview HMR).
    const msg = (message ?? `Review applied (${appliedFiles.length} file(s))`).slice(0, MAX_MSG_LEN);
    checkpoint = await createCheckpoint(msg, requestId, provenance);
  }

  await _teardown(session);

  log.info('Applied review session', {
    requestId,
    appliedFiles: appliedFiles.length,
    checkpoint: checkpoint?.id,
  });

  return { checkpoint, appliedFiles };
}

/**
 * Discard a staged session: tear the shadow worktree down + delete the staging
 * ref without applying anything to the live project. Unknown `requestId` is a
 * no-op success (idempotent — the renderer may discard a session twice or after
 * an apply already cleaned it up).
 */
export async function discardReviewSession(liveRoot: string, requestId: string): Promise<void> {
  const session = _sessions.get(requestId);
  if (!session) {
    // Idempotent: nothing to do. Best-effort delete a dangling staging ref.
    await git(liveRoot, 'update-ref', '-d', `${STAGING_REF_PREFIX}${requestId}`).catch(() => undefined);
    return;
  }
  await _teardown(session);
  log.info('Discarded review session', { requestId });
}

/* -------------------------------------------------------------------------- */
/*  Teardown                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Tear a session down: remove the worktree, delete the staging ref, remove the
 * temp dir, and forget the session. Every step is best-effort + idempotent so a
 * double teardown (apply-then-discard, or a half-failed create) never throws.
 */
async function _teardown(session: ReviewSessionState): Promise<void> {
  const { liveRoot, worktreePath, stagingRef, requestId } = session;

  await git(liveRoot, 'worktree', 'remove', '--force', worktreePath).catch(() => undefined);
  await git(liveRoot, 'update-ref', '-d', stagingRef).catch(() => undefined);
  // Prune any lingering worktree administrative state.
  await git(liveRoot, 'worktree', 'prune').catch(() => undefined);
  // Remove the temp parent dir (one level above the worktree).
  await rm(path.dirname(worktreePath), { recursive: true, force: true }).catch(() => undefined);

  _sessions.delete(requestId);
}

/* -------------------------------------------------------------------------- */
/*  Git helpers                                                                */
/* -------------------------------------------------------------------------- */

/** List files in the worktree that differ from `ref`'s tree (staged + unstaged). */
async function _changedFilesAgainst(worktreePath: string, ref: string): Promise<string[]> {
  // Stage first so untracked files participate in the diff, then compare the
  // worktree against the ref tree.
  await git(worktreePath, 'add', '--all').catch(() => undefined);
  try {
    const out = await git(worktreePath, 'diff', '--name-only', ref);
    return out.split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Read a project-relative path's content from a git ref's tree. Returns `null`
 * when the path does not exist at that ref (signals a deletion to the caller).
 */
async function _readBlobFromRef(
  session: ReviewSessionState,
  ref: string,
  relPath: string,
): Promise<Buffer | null> {
  try {
    const { stdout } = await execFileAsync('git', ['show', `${ref}:${relPath}`], {
      cwd: session.worktreePath,
      env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'buffer',
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout as Buffer;
  } catch {
    return null;
  }
}

/** Encode metadata into the staging commit subject (mirrors checkpoints.ts). */
function _encodeSubject(message: string, requestId?: string, changedFiles?: string[]): string {
  let s = message.slice(0, MAX_MSG_LEN);
  if (requestId) s += `:::requestId=${requestId}`;
  if (changedFiles && changedFiles.length > 0) s += `:::files=${changedFiles.join(',')}`;
  return s;
}

/**
 * Build the provenance trailer block for a staging commit, defaulting the
 * `Easel-Source` trailer to the changed files when none are supplied (matches
 * the live checkpoint behaviour).
 */
function _formatTrailers(provenance: CheckpointProvenance, changedFiles: string[]): string {
  const withSources =
    provenance.sources && provenance.sources.length > 0
      ? provenance
      : changedFiles.length > 0
        ? { ...provenance, sources: changedFiles }
        : provenance;
  return formatProvenanceTrailers(withSources);
}

/* -------------------------------------------------------------------------- */
/*  Test / introspection helpers                                               */
/* -------------------------------------------------------------------------- */

/** Whether a review session is currently tracked for `requestId`. */
export function hasReviewSession(requestId: string): boolean {
  return _sessions.has(requestId);
}
