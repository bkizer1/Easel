/**
 * Easel — persisted per-checkpoint state snapshots (State X-Ray, issue #13).
 *
 * When a checkpoint is created, the renderer captures the serialized app-state
 * tree and persists it here, keyed by checkpoint id, so any two points on the
 * timeline can be deep-diffed in the History/cockpit time-travel view.
 *
 * Snapshots live under `userData/xray-snapshots/<checkpointId>.json` — they are
 * NEVER written into the user's project tree. A small retention cap keeps the
 * directory bounded. None of these functions throw out to callers; failures are
 * logged and degrade gracefully (save is best-effort, reads return null/[]).
 */

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { StateSnapshot } from '@shared/xray';
import { createLogger } from '@main/logger';

const log = createLogger('snapshots');

/** Maximum snapshot files retained; oldest-by-mtime are pruned past this. */
const MAX_SNAPSHOTS = 50;

/* -------------------------------------------------------------------------- */
/*  Paths                                                                      */
/* -------------------------------------------------------------------------- */

function snapshotsDir(): string {
  return path.join(app.getPath('userData'), 'xray-snapshots');
}

/**
 * Reduce an arbitrary checkpoint id to a safe filename stem (only
 * `[A-Za-z0-9_-]`). Prevents path traversal and invalid filename chars.
 */
function safeId(checkpointId: string): string {
  return String(checkpointId).replace(/[^A-Za-z0-9_-]/g, '_');
}

function snapshotPath(checkpointId: string): string {
  return path.join(snapshotsDir(), `${safeId(checkpointId)}.json`);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Persist a state snapshot (best-effort; never throws). */
export function saveSnapshot(snapshot: StateSnapshot): void {
  try {
    if (!snapshot || !snapshot.checkpointId) {
      log.warn('Refusing to save snapshot without a checkpointId');
      return;
    }
    const dir = snapshotsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(snapshotPath(snapshot.checkpointId), JSON.stringify(snapshot), 'utf8');
    pruneOldSnapshots();
  } catch (err) {
    log.error('Failed to save snapshot', { err: String(err) });
  }
}

/** Read a persisted snapshot for a checkpoint id, or null when missing/invalid. */
export function getSnapshot(checkpointId: string): StateSnapshot | null {
  try {
    const raw = fs.readFileSync(snapshotPath(checkpointId), 'utf8');
    return JSON.parse(raw) as StateSnapshot;
  } catch {
    // Missing file or parse error — both mean "no usable snapshot".
    return null;
  }
}

/** List checkpoint ids that have a persisted snapshot ([] if dir is missing). */
export function listSnapshots(): string[] {
  try {
    const files = fs.readdirSync(snapshotsDir());
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -'.json'.length));
  } catch {
    return [];
  }
}

/* -------------------------------------------------------------------------- */
/*  Retention                                                                  */
/* -------------------------------------------------------------------------- */

/** Delete the oldest-by-mtime snapshot files past {@link MAX_SNAPSHOTS}. */
function pruneOldSnapshots(): void {
  try {
    const dir = snapshotsDir();
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(dir, f);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { full, mtimeMs };
      });

    if (files.length <= MAX_SNAPSHOTS) return;

    files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const toDelete = files.slice(0, files.length - MAX_SNAPSHOTS);
    for (const { full } of toDelete) {
      try {
        fs.unlinkSync(full);
      } catch (err) {
        log.warn('Failed to prune snapshot', { err: String(err) });
      }
    }
  } catch (err) {
    log.warn('Snapshot prune failed', { err: String(err) });
  }
}
