/**
 * Easel — git-backed checkpoint (undo/redo) manager.
 *
 * Design (see ARCHITECTURE.md §7):
 *  - All Easel snapshots live on the internal ref `refs/easel/checkpoint` inside
 *    the project's existing git repo.  The user's own HEAD, branches, staging area,
 *    and stashes are NEVER touched.
 *  - A checkpoint is one git commit on that internal ref.  The commit's tree
 *    reflects the full working-tree state after an edit was applied.
 *  - An in-memory ordered timeline tracks checkpoints; a cursor (`_currentIndex`)
 *    marks the position matching the current working tree.
 *  - Undo/redo are O(1) pointer walks + a single `git checkout` of the target tree.
 *  - A new edit after undo truncates the redo branch (standard editor semantics).
 *
 * Non-git projects:
 *  - We attempt a `git init` inside the project root on first use and commit the
 *    initial state, then continue normally.
 *  - If that fails (e.g. no git binary) we surface a clear error and disable
 *    checkpointing.
 *
 * Exported surface (the IPC layer calls these):
 *   initCheckpoints(root)               — call when a project is opened
 *   createCheckpoint(msg, reqId?)       → Checkpoint    (called by agent context)
 *   listCheckpoints()                   → { checkpoints, currentId }
 *   restoreCheckpoint(id)               → changedFiles[]
 *   undoCheckpoint()                    → Checkpoint | null
 *   redoCheckpoint()                    → Checkpoint | null
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import type { Checkpoint, CheckpointProvenance } from '@shared/types';
import type { CheckpointChangedPayload } from '@shared/ipc';
import { IpcChannels } from '@shared/ipc';
import { getMainWindow } from '@main/window';
import { createLogger } from '@main/logger';
import { formatProvenanceTrailers, parseProvenance } from '@main/provenance';

const execFileAsync = promisify(execFile);
const log = createLogger('checkpoints');

/* -------------------------------------------------------------------------- */
/*  Constants                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The internal git ref Easel uses.  Lives in `refs/easel/` so it is invisible
 * to `git branch --list` and will not show in the user's branch list.
 */
const EASEL_REF = 'refs/easel/checkpoint';

/** Maximum message length stored in the commit subject line. */
const MAX_MSG_LEN = 72;

/* -------------------------------------------------------------------------- */
/*  In-memory state                                                            */
/* -------------------------------------------------------------------------- */

let _projectRoot: string | null = null;
/** Ordered timeline — index 0 is the oldest checkpoint. */
let _timeline: Checkpoint[] = [];
/**
 * Index into `_timeline` that the working tree currently matches.
 * -1 means the working tree is before any checkpoint (initial state).
 */
let _currentIndex = -1;

/* -------------------------------------------------------------------------- */
/*  Git shell helpers                                                          */
/* -------------------------------------------------------------------------- */

async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    // Prevent Git from opening an interactive editor.
    env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

/** Returns true if `root` is inside a git repository. */
async function isGitRepo(root: string): Promise<boolean> {
  try {
    await git(root, 'rev-parse', '--is-inside-work-tree');
    return true;
  } catch {
    return false;
  }
}

/* gitRoot helper removed (was unused). */

/** Returns the short SHA of a ref, or null if the ref does not exist. */
async function resolveRef(root: string, ref: string): Promise<string | null> {
  try {
    return await git(root, 'rev-parse', '--short', ref);
  } catch {
    return null;
  }
}

/** Returns the full SHA of a ref, or null. */
async function resolveRefFull(root: string, ref: string): Promise<string | null> {
  try {
    return await git(root, 'rev-parse', ref);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Initialise the checkpoint manager for the given project root.  Must be
 * called each time a project is opened.  Idempotent.
 */
export async function initCheckpoints(root: string): Promise<void> {
  _projectRoot = root;
  _timeline = [];
  _currentIndex = -1;

  // Ensure the project is a git repo.
  if (!(await isGitRepo(root))) {
    log.info('Project is not a git repo; initialising one', { root });
    try {
      await git(root, 'init');
      // Create an initial commit so the ref can be created.
      await git(root, 'add', '--all');
      try {
        await git(root, 'commit', '-m', 'chore: initial commit (Easel)');
      } catch {
        // Commit may fail if there's nothing to commit; that is fine.
      }
    } catch (err) {
      log.error('Failed to git init project', { err: String(err) });
      throw new Error(`Could not initialise git in ${root}: ${String(err)}`);
    }
  }

  // Load existing Easel checkpoints from git log on EASEL_REF.
  const existing = await resolveRef(root, EASEL_REF);
  if (existing) {
    await _loadTimelineFromGit(root);
    // Position cursor at the newest checkpoint (head of timeline).
    _currentIndex = _timeline.length - 1;
    log.info('Loaded existing checkpoints', { count: _timeline.length });
  } else {
    log.info('No existing Easel checkpoints for this project');
    // Capture the original (pre-Easel) state as checkpoint 0 so the user can
    // always revert all the way back. Best-effort — a git hiccup here must not
    // block opening the project.
    try {
      await createCheckpoint('Original — before Easel edits');
    } catch (err) {
      log.warn('Could not create the initial checkpoint', { err: String(err) });
    }
  }

  _broadcastChanged();
}

/**
 * Read git log on EASEL_REF and reconstruct the in-memory timeline.
 * Commits are listed oldest-first (ascending by timestamp).
 */
async function _loadTimelineFromGit(root: string): Promise<void> {
  // %H = full SHA, %s = subject, %at = author timestamp (unix), %N = notes (abused
  // for metadata). We encode requestId in the commit subject as JSON after '|||'.
  const logOutput = await git(
    root,
    'log',
    '--reverse',
    '--format=%H|||%s|||%at',
    EASEL_REF,
  ).catch(() => '');

  if (!logOutput) return;

  const checkpoints: Checkpoint[] = [];
  for (const line of logOutput.split('\n')) {
    const parts = line.split('|||');
    if (parts.length < 3) continue;
    const [sha, subject, atStr] = parts;

    // Subject format: "<message>[:::requestId=<id>][:::files=<csv>]"
    const { message, requestId, changedFiles } = _parseSubject(subject);

    checkpoints.push({
      id: sha.slice(0, 8),
      commitSha: sha,
      requestId,
      message,
      createdAt: parseInt(atStr, 10) * 1000,
      changedFiles,
    });
  }

  _timeline = checkpoints;
}

/** Encode metadata into the git commit subject. */
function _encodeSubject(message: string, requestId?: string, changedFiles?: string[]): string {
  let s = message.slice(0, MAX_MSG_LEN);
  if (requestId) s += `:::requestId=${requestId}`;
  if (changedFiles && changedFiles.length > 0) s += `:::files=${changedFiles.join(',')}`;
  return s;
}

/** Decode metadata from the git commit subject. */
function _parseSubject(subject: string): {
  message: string;
  requestId?: string;
  changedFiles: string[];
} {
  const parts = subject.split(':::');
  const message = parts[0].trim();
  let requestId: string | undefined;
  let changedFiles: string[] = [];

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    if (part.startsWith('requestId=')) requestId = part.slice('requestId='.length);
    if (part.startsWith('files=')) changedFiles = part.slice('files='.length).split(',').filter(Boolean);
  }

  return { message, requestId, changedFiles };
}

/**
 * Ensure the provenance has at least the changed files as `Easel-Source` entries.
 * When the edit pipeline resolved explicit source locations (file:line) we keep
 * those; otherwise we fall back to the files git observed as changed so the
 * source trailer is never empty for a real edit.
 */
function _withSourceFallback(
  provenance: CheckpointProvenance | undefined,
  changedFiles: string[],
): CheckpointProvenance {
  const base = provenance ?? {};
  if (base.sources && base.sources.length > 0) return base;
  if (changedFiles.length === 0) return base;
  return { ...base, sources: changedFiles };
}

/**
 * Read and parse the {@link CheckpointProvenance} trailers from a checkpoint
 * commit. Used by the Branch/PR feature to promote checkpoint metadata onto a
 * real commit. Returns an empty object if the commit has no Easel trailers.
 */
export async function getCheckpointProvenance(
  commitSha: string,
): Promise<CheckpointProvenance> {
  const root = _requireRoot();
  try {
    const body = await git(root, 'log', '-1', '--format=%B', commitSha);
    return parseProvenance(body);
  } catch (err) {
    log.warn('Could not read checkpoint provenance', { commitSha, err: String(err) });
    return {};
  }
}

/* -------------------------------------------------------------------------- */
/*  Core checkpoint operations                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Create a git checkpoint after edits have been applied to disk.
 *
 * Strategy:
 *  1. Stage all changes relative to the current EASEL_REF tree (or HEAD if no
 *     Easel ref exists yet).
 *  2. Compute a tree object from the working-tree state.
 *  3. Create a commit on EASEL_REF.
 *  4. If this is an edit after an undo (cursor < head), truncate the redo branch.
 *
 * This does NOT touch the user's HEAD or staging area for other changes.
 */
export async function createCheckpoint(
  message: string,
  requestId?: string,
  provenance?: CheckpointProvenance,
): Promise<Checkpoint> {
  const root = _requireRoot();

  log.info('Creating checkpoint', { message: message.slice(0, 60), requestId });

  // Determine changed files relative to last checkpoint (or HEAD).
  const changedFiles = await _getChangedFiles(root);

  // Stage all changes (including untracked) into the index — but only the
  // working-tree changes, not the user's staging area.
  // We use `git add --all` which is safe because we immediately commit to our
  // own ref and do not touch HEAD.
  await git(root, 'add', '--all');

  // Write a tree from the current index state.
  const treeHash = await git(root, 'write-tree');

  // Build the commit. Parent is the current EASEL_REF if it exists.
  // The subject carries the legacy requestId/files encoding (still parsed by
  // _loadTimelineFromGit); structured provenance rides in a trailing trailer
  // paragraph appended as a second `-m` (git separates them with a blank line).
  const parentSha = await resolveRefFull(root, EASEL_REF);
  const commitArgs = ['commit-tree', treeHash, '-m', _encodeSubject(message, requestId, changedFiles)];
  const trailers = formatProvenanceTrailers(_withSourceFallback(provenance, changedFiles));
  if (trailers) commitArgs.push('-m', trailers);
  if (parentSha) commitArgs.push('-p', parentSha);
  const commitSha = await git(root, ...commitArgs);

  // Update EASEL_REF to point to the new commit.
  await git(root, 'update-ref', EASEL_REF, commitSha);

  // Truncate redo branch if we had undone edits.
  if (_currentIndex < _timeline.length - 1) {
    _timeline = _timeline.slice(0, _currentIndex + 1);
  }

  const checkpoint: Checkpoint = {
    id: commitSha.slice(0, 8),
    commitSha,
    requestId,
    message: message.slice(0, MAX_MSG_LEN),
    createdAt: Date.now(),
    changedFiles,
  };

  _timeline.push(checkpoint);
  _currentIndex = _timeline.length - 1;

  log.info('Checkpoint created', {
    id: checkpoint.id,
    sha: commitSha.slice(0, 8),
    files: changedFiles.length,
  });

  _broadcastChanged();
  return checkpoint;
}

/** List all checkpoints in the current project's timeline (oldest first). */
export function listCheckpoints(): { checkpoints: Checkpoint[]; currentId?: string } {
  const current = _currentIndex >= 0 ? _timeline[_currentIndex]?.id : undefined;
  return { checkpoints: [..._timeline], currentId: current };
}

/**
 * Restore the working tree to the given checkpoint.  This is the "history jump"
 * operation — it may skip multiple checkpoints.
 *
 * Mechanics:
 *  1. Look up the commit SHA for the target checkpoint.
 *  2. Restore the working tree to that commit's tree via `git checkout <tree> -- .`
 *     while keeping the user's HEAD intact.
 *  3. Update the cursor.
 */
export async function restoreCheckpoint(checkpointId: string): Promise<string[]> {
  const root = _requireRoot();
  const idx = _timeline.findIndex((c) => c.id === checkpointId);
  if (idx === -1) throw new Error(`Unknown checkpoint id: ${checkpointId}`);

  const checkpoint = _timeline[idx];
  log.info('Restoring checkpoint', { id: checkpointId, sha: checkpoint.commitSha.slice(0, 8) });

  const changedFiles = await _applyTree(root, checkpoint.commitSha);

  _currentIndex = idx;
  _broadcastChanged();
  return changedFiles;
}

/**
 * Undo: move cursor back one position and restore the previous tree.
 * Returns the checkpoint now active, or null if already at the beginning.
 */
export async function undoCheckpoint(): Promise<Checkpoint | null> {
  const root = _requireRoot();

  if (_currentIndex <= 0) {
    log.info('Nothing to undo');
    return null;
  }

  // The "previous" state is the checkpoint before the current one.
  const targetIdx = _currentIndex - 1;
  const target = _timeline[targetIdx];
  log.info('Undoing to checkpoint', { id: target.id });

  await _applyTree(root, target.commitSha);

  _currentIndex = targetIdx;
  _broadcastChanged();
  return target;
}

/**
 * Redo: move cursor forward one position and restore the next tree.
 * Returns the checkpoint now active, or null if already at the head.
 */
export async function redoCheckpoint(): Promise<Checkpoint | null> {
  const root = _requireRoot();

  if (_currentIndex >= _timeline.length - 1) {
    log.info('Nothing to redo');
    return null;
  }

  const targetIdx = _currentIndex + 1;
  const target = _timeline[targetIdx];
  log.info('Redoing to checkpoint', { id: target.id });

  await _applyTree(root, target.commitSha);

  _currentIndex = targetIdx;
  _broadcastChanged();
  return target;
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

function _requireRoot(): string {
  if (!_projectRoot) throw new Error('Checkpoint manager not initialised — call initCheckpoints first');
  return _projectRoot;
}

/**
 * Apply the tree from `commitSha` to the working directory WITHOUT changing
 * HEAD or the user's index for other changes.
 *
 * Strategy: use `git restore --source=<commit> --worktree -- .`
 * (git 2.23+) which is the clean non-destructive way to restore files.
 * We fall back to `git checkout <commit> -- .` on older git.
 */
async function _applyTree(root: string, commitSha: string): Promise<string[]> {
  // Capture changed files before we overwrite the working tree.
  const changedFiles = await _getChangedFiles(root);

  try {
    await git(root, 'restore', `--source=${commitSha}`, '--worktree', '--', '.');
  } catch {
    // Older git; fall back.
    log.info('git restore unavailable; falling back to git checkout');
    await git(root, 'checkout', commitSha, '--', '.');
  }

  // Re-stage the restored state so the working tree and index agree.
  await git(root, 'add', '--all');

  return changedFiles;
}

/**
 * List files that differ from the current EASEL_REF (or from HEAD if no ref
 * exists). Used to populate `Checkpoint.changedFiles`.
 */
async function _getChangedFiles(root: string): Promise<string[]> {
  // Stage everything first to get an accurate diff.
  try {
    await git(root, 'add', '--all');
  } catch {
    // Silently ignore — this is best-effort before the real stage.
  }

  const refExists = await resolveRef(root, EASEL_REF);
  const base = refExists ? EASEL_REF : null;

  try {
    let diffOutput: string;
    if (base) {
      // Diff working tree against the checkpoint ref's tree.
      diffOutput = await git(root, 'diff', '--name-only', base);
    } else {
      // No prior checkpoint — diff against HEAD (may be empty for fresh repos).
      diffOutput = await git(root, 'diff', '--name-only', '--cached').catch(() => '');
    }
    return diffOutput.split('\n').map((f) => f.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Push `checkpoint.changed` to the renderer. */
function _broadcastChanged(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;

  const { checkpoints, currentId } = listCheckpoints();
  const payload: CheckpointChangedPayload = { checkpoints, currentId };
  win.webContents.send(IpcChannels.checkpointChanged, payload);
}

/**
 * Generate a stable short id.  Used for checkpoints created outside of the
 * normal git flow (e.g. in tests).
 */
export function generateCheckpointId(): string {
  return crypto.randomBytes(4).toString('hex');
}
