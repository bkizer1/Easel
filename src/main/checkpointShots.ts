/**
 * Easel — checkpoint before/after screenshot store (Visual diff, #7).
 *
 * Persists a PNG of the preview before an edit and after HMR settles, keyed by
 * the resulting `Checkpoint.id`, under Electron's `userData` (NEVER in the
 * user's project tree). A retention cap bounds disk usage by pruning the oldest
 * checkpoints' images.
 *
 * The `*At` functions take an explicit base directory so they are unit-testable
 * against a temp dir with no Electron; the exported wrappers resolve the real
 * `userData` path lazily (so importing this module never requires `electron`).
 */

import fs from 'node:fs';
import path from 'node:path';

/** Which side of the edit a screenshot represents. */
export type ShotSide = 'before' | 'after';

/** Both PNG data URLs for one checkpoint (either may be absent). */
export interface CheckpointShots {
  before?: string;
  after?: string;
}

/** Keep images for at most this many checkpoints. */
export const DEFAULT_RETENTION = 25;

/** The directory under `baseDir` where per-checkpoint image folders live. */
function shotsRoot(baseDir: string): string {
  return path.join(baseDir, 'checkpoints');
}

/* -------------------------------------------------------------------------- */
/*  Pure data-URL <-> PNG-bytes helpers                                         */
/* -------------------------------------------------------------------------- */

/** Decode a `data:image/png;base64,...` URL to raw bytes, or null if malformed. */
export function dataUrlToPngBytes(dataUrl: string): Buffer | null {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!m) return null;
  try {
    return Buffer.from(m[1], 'base64');
  } catch {
    return null;
  }
}

/** Encode raw PNG bytes as a data URL. */
export function pngBytesToDataUrl(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString('base64')}`;
}

/* -------------------------------------------------------------------------- */
/*  Root-injectable filesystem operations (testable)                            */
/* -------------------------------------------------------------------------- */

/** Write one side's PNG for `checkpointId` under `baseDir`, then prune. */
export async function writeShotAt(
  baseDir: string,
  checkpointId: string,
  side: ShotSide,
  dataUrl: string,
  retention = DEFAULT_RETENTION,
): Promise<void> {
  const bytes = dataUrlToPngBytes(dataUrl);
  if (!bytes) return;
  const dir = path.join(shotsRoot(baseDir), checkpointId);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, `${side}.png`), bytes);
  await pruneOldShotDirs(baseDir, retention);
}

/** Read both sides for `checkpointId` under `baseDir` as data URLs. */
export async function readShotsAt(baseDir: string, checkpointId: string): Promise<CheckpointShots> {
  const dir = path.join(shotsRoot(baseDir), checkpointId);
  const out: CheckpointShots = {};
  for (const side of ['before', 'after'] as const) {
    try {
      const buf = await fs.promises.readFile(path.join(dir, `${side}.png`));
      out[side] = pngBytesToDataUrl(buf);
    } catch {
      // Missing side — leave undefined.
    }
  }
  return out;
}

/** Delete the image folder for `checkpointId` under `baseDir`. */
export async function deleteShotsAt(baseDir: string, checkpointId: string): Promise<void> {
  await fs.promises.rm(path.join(shotsRoot(baseDir), checkpointId), { recursive: true, force: true });
}

/** Remove image folders beyond the `keep` most-recently-modified ones. */
export async function pruneOldShotDirs(baseDir: string, keep: number): Promise<void> {
  const root = shotsRoot(baseDir);
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs = entries.filter((e) => e.isDirectory());
  if (dirs.length <= keep) return;

  const stats = await Promise.all(
    dirs.map(async (d) => {
      const p = path.join(root, d.name);
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.promises.stat(p)).mtimeMs;
      } catch {
        // ignore
      }
      return { p, mtimeMs };
    }),
  );
  // Oldest first; remove everything beyond the newest `keep`.
  stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const toRemove = stats.slice(0, stats.length - keep);
  await Promise.all(toRemove.map((s) => fs.promises.rm(s.p, { recursive: true, force: true })));
}

/* -------------------------------------------------------------------------- */
/*  Electron wrappers (resolve userData lazily)                                  */
/* -------------------------------------------------------------------------- */

async function userDataDir(): Promise<string> {
  const { app } = await import('electron');
  return app.getPath('userData');
}

/** Persist one side's PNG for a checkpoint under the app's userData dir. */
export async function writeShot(checkpointId: string, side: ShotSide, dataUrl: string): Promise<void> {
  await writeShotAt(await userDataDir(), checkpointId, side, dataUrl);
}

/** Read both sides' PNGs for a checkpoint from the app's userData dir. */
export async function readShots(checkpointId: string): Promise<CheckpointShots> {
  return readShotsAt(await userDataDir(), checkpointId);
}
