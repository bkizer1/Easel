/**
 * Easel — session replay: the runnable `.easel` artifact (Issue #18).
 *
 * A `.easel` file is a ZIP bundle (see `@main/zip`) containing:
 *   - `manifest.json`        — {@link EaselBundleManifest}: chat transcript,
 *                              checkpoint timeline, and project context.
 *   - `checkpoints.bundle`   — a `git bundle` of the internal checkpoint ref, so
 *                              every checkpoint commit (and its tree) travels too.
 *   - `shots/<id>/*.png`     — per-checkpoint before/after preview frames, so the
 *                              scrubber can show what each gesture looked like.
 *
 * Export folds the renderer's chat snapshot together with main's checkpoint
 * timeline + a git bundle + the persisted preview shots. Import verifies the
 * bundle, fetches its ref into a namespaced `refs/easel/imported/<id>` (never
 * clobbering the importing project's own checkpoint ref), and persists the shots
 * so the existing `checkpoint.getShots` path serves them to the scrubber.
 *
 * "Re-run this step" replays one checkpoint deterministically: it computes that
 * checkpoint commit's delta against its parent and `git apply`s it to the
 * current working tree, failing cleanly (a {@link ReplayConflictError}) when the
 * patch does not apply — the code has moved too far since the session was
 * recorded. A successful replay lands a brand-new live checkpoint.
 *
 * The pure core functions (`packBundle`, `unpackBundle`, `importBundleInto`,
 * `replayCheckpoint`) take every dependency as a parameter and import no Electron
 * module, so they are unit-testable against a temp git repo. The thin wrappers at
 * the bottom resolve the live project / dialogs / userData lazily.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {
  ChatMessage,
  Checkpoint,
  EaselBundleManifest,
  ImportedSession,
  ProjectFramework,
} from '@shared/types';
import { BUNDLE_SCHEMA_VERSION } from '@shared/types';
import type {
  SessionExportRequest,
  SessionExportResponse,
  SessionImportResponse,
  SessionReplayStepRequest,
  SessionReplayStepResponse,
} from '@shared/ipc';
import { zipSync, unzipSync, type ZipEntry } from '@main/zip';
import {
  readShotsAt,
  writeShotAt,
  dataUrlToPngBytes,
  pngBytesToDataUrl,
} from '@main/checkpointShots';

const execFileAsync = promisify(execFile);

/**
 * The well-known SHA-1 empty-tree object id. git synthesizes it on demand, so
 * diffing a first (parent-less) checkpoint against it yields that checkpoint's
 * full creation patch.
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/** Raise this when a recorded step's patch will not apply to current code. */
export class ReplayConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayConflictError';
  }
}

/* -------------------------------------------------------------------------- */
/*  git helpers                                                                 */
/* -------------------------------------------------------------------------- */

/** Run git for textual output (trimmed). Mirrors `checkpoints.ts`. */
async function git(root: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout.trim();
}

/** Run git for raw binary output (e.g. a `git diff --binary` patch). */
async function gitBuffer(root: string, ...args: string[]): Promise<Buffer> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: root,
    encoding: 'buffer',
    // Diffs can carry base64-encoded binary blobs (images); allow ample room.
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

/** Whether `root` is inside a git work tree. */
async function isGitRepo(root: string): Promise<boolean> {
  try {
    const out = await git(root, 'rev-parse', '--is-inside-work-tree');
    return out === 'true';
  } catch {
    return false;
  }
}

/** A short, filesystem-/ref-safe random id. */
function randomId(): string {
  return randomBytes(6).toString('hex');
}

async function mkTmpDir(prefix: string): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
}

/* -------------------------------------------------------------------------- */
/*  Pack / unpack (pure, testable)                                              */
/* -------------------------------------------------------------------------- */

/** Everything the bundle writer needs, passed explicitly for testability. */
export interface PackBundleInput {
  root: string;
  chat: ChatMessage[];
  checkpoints: Checkpoint[];
  currentCheckpointId?: string;
  checkpointRef: string;
  easelVersion: string;
  exportedAt: number;
  projectName: string;
  framework: ProjectFramework;
  devServerUrl: string;
  /** Base dir whose `checkpoints/<id>/{before,after}.png` shots get embedded. */
  shotsBaseDir: string;
}

/** Build a `.easel` bundle (a ZIP) as a Buffer. */
export async function packBundle(input: PackBundleInput): Promise<Buffer> {
  const tmp = await mkTmpDir('easel-export-');
  try {
    // 1. git bundle of the checkpoint ref's full history.
    const bundlePath = path.join(tmp, 'checkpoints.bundle');
    await git(input.root, 'bundle', 'create', bundlePath, input.checkpointRef);
    const bundleBytes = await fs.promises.readFile(bundlePath);

    // 2. Per-checkpoint preview shots.
    const shotEntries: ZipEntry[] = [];
    const shotIds: string[] = [];
    for (const cp of input.checkpoints) {
      const shots = await readShotsAt(input.shotsBaseDir, cp.id);
      let has = false;
      if (shots.before) {
        const bytes = dataUrlToPngBytes(shots.before);
        if (bytes) {
          shotEntries.push({ name: `shots/${cp.id}/before.png`, data: bytes });
          has = true;
        }
      }
      if (shots.after) {
        const bytes = dataUrlToPngBytes(shots.after);
        if (bytes) {
          shotEntries.push({ name: `shots/${cp.id}/after.png`, data: bytes });
          has = true;
        }
      }
      if (has) shotIds.push(cp.id);
    }

    // 3. Manifest.
    const manifest: EaselBundleManifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      easelVersion: input.easelVersion,
      exportedAt: input.exportedAt,
      session: {
        projectName: input.projectName,
        framework: input.framework,
        devServerUrl: input.devServerUrl,
      },
      chat: input.chat,
      checkpoints: input.checkpoints,
      currentCheckpointId: input.currentCheckpointId,
      checkpointRef: input.checkpointRef,
      shots: shotIds,
    };

    const entries: ZipEntry[] = [
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      { name: 'checkpoints.bundle', data: bundleBytes },
      ...shotEntries,
    ];
    return zipSync(entries);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/** A shot's PNG bytes, either side optional. */
export interface UnpackedShots {
  before?: Buffer;
  after?: Buffer;
}

/** The result of reading a `.easel` bundle's bytes. */
export interface UnpackedBundle {
  manifest: EaselBundleManifest;
  bundleBytes: Buffer;
  /** checkpoint id -> its embedded before/after PNG bytes. */
  shots: Map<string, UnpackedShots>;
}

/** Parse + validate a `.easel` bundle from its raw bytes. Throws on corruption. */
export function unpackBundle(bytes: Buffer): UnpackedBundle {
  const files = unzipSync(bytes);

  const manifestBuf = files.get('manifest.json');
  if (!manifestBuf) throw new Error('Invalid .easel bundle: manifest.json is missing.');

  let manifest: EaselBundleManifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8')) as EaselBundleManifest;
  } catch {
    throw new Error('Invalid .easel bundle: manifest.json is not valid JSON.');
  }
  if (manifest.schemaVersion !== BUNDLE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported .easel version ${manifest.schemaVersion} (this Easel reads v${BUNDLE_SCHEMA_VERSION}).`,
    );
  }

  const bundleBytes = files.get('checkpoints.bundle');
  if (!bundleBytes) throw new Error('Invalid .easel bundle: checkpoints.bundle is missing.');

  const shots = new Map<string, UnpackedShots>();
  for (const id of manifest.shots ?? []) {
    const before = files.get(`shots/${id}/before.png`);
    const after = files.get(`shots/${id}/after.png`);
    if (before || after) shots.set(id, { before, after });
  }

  return { manifest, bundleBytes, shots };
}

/* -------------------------------------------------------------------------- */
/*  Import (pure, testable)                                                      */
/* -------------------------------------------------------------------------- */

export interface ImportBundleInput {
  /** The (open) project's root — must be a git repo. */
  root: string;
  /** Raw `.easel` bytes. */
  bytes: Buffer;
  /** Stable id for this import (becomes the `refs/easel/imported/<id>` segment). */
  sessionId: string;
  /** Where to persist the embedded shots (so `checkpoint.getShots` finds them). */
  shotsBaseDir: string;
}

/** The imported-ref namespace; never collides with the user's own refs. */
export function importedRefName(sessionId: string): string {
  return `refs/easel/imported/${sessionId}`;
}

/**
 * Verify + import a bundle into `root`: fetch its checkpoint history into a
 * namespaced ref and persist its preview shots. Returns the live session handle.
 */
export async function importBundleInto(input: ImportBundleInput): Promise<ImportedSession> {
  if (!(await isGitRepo(input.root))) {
    throw new Error('Importing a session needs an open git project.');
  }

  const { manifest, bundleBytes, shots } = unpackBundle(input.bytes);

  const tmp = await mkTmpDir('easel-import-');
  try {
    const bundlePath = path.join(tmp, 'in.bundle');
    await fs.promises.writeFile(bundlePath, bundleBytes);

    try {
      await git(input.root, 'bundle', 'verify', bundlePath);
    } catch {
      throw new Error('The .easel bundle is corrupt or incomplete (git bundle verify failed).');
    }

    const importedRef = importedRefName(input.sessionId);
    await git(input.root, 'fetch', bundlePath, `${manifest.checkpointRef}:${importedRef}`);

    // Persist the embedded shots under the same keys the live shot store uses,
    // so the scrubber fetches them via the existing checkpoint.getShots path.
    for (const [id, sides] of shots) {
      if (sides.before) {
        await writeShotAt(input.shotsBaseDir, id, 'before', pngBytesToDataUrl(sides.before));
      }
      if (sides.after) {
        await writeShotAt(input.shotsBaseDir, id, 'after', pngBytesToDataUrl(sides.after));
      }
    }

    return { sessionId: input.sessionId, manifest };
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/*  Replay (pure, testable)                                                      */
/* -------------------------------------------------------------------------- */

export interface ReplayInput {
  root: string;
  manifest: EaselBundleManifest;
  checkpointId: string;
  /** Host-owned checkpoint creator (so replay lands a real live checkpoint). */
  createCheckpointFn: (message: string) => Promise<Checkpoint>;
}

/** Resolve the diff base for a checkpoint commit: its parent, or the empty tree. */
async function resolveBase(root: string, commitSha: string): Promise<string> {
  try {
    await git(root, 'rev-parse', '--verify', '-q', `${commitSha}^`);
    return `${commitSha}^`;
  } catch {
    return EMPTY_TREE;
  }
}

/**
 * Deterministically re-apply one recorded checkpoint's delta to the current
 * working tree, then create a new live checkpoint. Throws {@link
 * ReplayConflictError} when the patch does not apply cleanly.
 */
export async function replayCheckpoint(input: ReplayInput): Promise<Checkpoint> {
  const cp = input.manifest.checkpoints.find((c) => c.id === input.checkpointId);
  if (!cp) throw new Error(`Unknown checkpoint ${input.checkpointId} in this session.`);

  const base = await resolveBase(input.root, cp.commitSha);
  const patch = await gitBuffer(input.root, 'diff', '--binary', base, cp.commitSha);

  if (patch.length === 0) {
    throw new Error('This step recorded no file changes, so there is nothing to re-run.');
  }

  const tmp = await mkTmpDir('easel-replay-');
  const patchPath = path.join(tmp, 'step.patch');
  try {
    await fs.promises.writeFile(patchPath, patch);

    // Dry-run first so a conflict never leaves a half-applied tree.
    try {
      await git(input.root, 'apply', '--check', '--binary', patchPath);
    } catch {
      throw new ReplayConflictError(
        "This step couldn't be replayed cleanly — the code has changed too much since it was recorded.",
      );
    }
    await git(input.root, 'apply', '--binary', patchPath);
  } finally {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  }

  return input.createCheckpointFn(`Replay: ${cp.message}`);
}

/* -------------------------------------------------------------------------- */
/*  Electron-facing wrappers (lazy imports; not unit-tested)                     */
/* -------------------------------------------------------------------------- */

/** The session currently loaded for replay, if any. */
let activeImport: { sessionId: string; manifest: EaselBundleManifest; root: string } | null = null;

async function userDataDir(): Promise<string> {
  const { app } = await import('electron');
  return app.getPath('userData');
}

/** Export the current project's session to a `.easel` file (shows a save dialog). */
export async function exportSessionToFile(
  req: SessionExportRequest,
): Promise<SessionExportResponse> {
  const { getCurrentProject } = await import('@main/project');
  const { listCheckpoints, checkpointRefName } = await import('@main/checkpoints');
  const { getMainWindow } = await import('@main/window');
  const { app, dialog } = await import('electron');

  const project = getCurrentProject();
  if (!project) throw new Error('Open a project before exporting a session.');

  const { checkpoints, currentId } = listCheckpoints();
  if (checkpoints.length === 0) {
    throw new Error('No checkpoints to export yet — make an edit first.');
  }

  const win = getMainWindow();
  const result = await dialog.showSaveDialog(win ?? undefined!, {
    title: 'Export Session',
    defaultPath: `${project.name}.easel`,
    filters: [{ name: 'Easel session', extensions: ['easel'] }],
  });
  if (result.canceled || !result.filePath) return { savedPath: null };

  const bytes = await packBundle({
    root: project.root,
    chat: req.chat,
    checkpoints,
    currentCheckpointId: req.currentCheckpointId ?? currentId,
    checkpointRef: checkpointRefName(),
    easelVersion: app.getVersion(),
    exportedAt: Date.now(),
    projectName: project.name,
    framework: project.framework,
    devServerUrl: project.devServerUrl,
    shotsBaseDir: await userDataDir(),
  });
  await fs.promises.writeFile(result.filePath, bytes);
  return { savedPath: result.filePath };
}

/** Import a `.easel` file for replay (shows an open dialog). */
export async function importSessionFromFile(): Promise<SessionImportResponse> {
  const { getCurrentProject } = await import('@main/project');
  const { getMainWindow } = await import('@main/window');
  const { dialog } = await import('electron');

  const project = getCurrentProject();
  if (!project) throw new Error('Open a project before importing a session.');

  const win = getMainWindow();
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    title: 'Import Session',
    properties: ['openFile'],
    filters: [{ name: 'Easel session', extensions: ['easel'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return { session: null };

  const bytes = await fs.promises.readFile(result.filePaths[0]);
  const sessionId = randomId();
  const imported = await importBundleInto({
    root: project.root,
    bytes,
    sessionId,
    shotsBaseDir: await userDataDir(),
  });
  activeImport = { sessionId, manifest: imported.manifest, root: project.root };
  return { session: imported };
}

/** Replay one step of the active imported session against current code. */
export async function replayActiveStep(
  req: SessionReplayStepRequest,
): Promise<SessionReplayStepResponse> {
  if (!activeImport) {
    throw new Error('No imported session to replay — import a .easel first.');
  }
  const { createCheckpoint } = await import('@main/checkpoints');
  const checkpoint = await replayCheckpoint({
    root: activeImport.root,
    manifest: activeImport.manifest,
    checkpointId: req.checkpointId,
    createCheckpointFn: (message) => createCheckpoint(message),
  });
  return { checkpoint };
}

/** Test-only: clear the active imported session. */
export function _resetActiveImport(): void {
  activeImport = null;
}
