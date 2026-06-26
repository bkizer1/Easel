import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dataUrlToPngBytes,
  pngBytesToDataUrl,
  writeShotAt,
  readShotsAt,
  pruneOldShotDirs,
} from './checkpointShots';

// A 1x1 transparent PNG as a data URL.
const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'easel-shots-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('dataUrl <-> png bytes', () => {
  it('round-trips a PNG data URL through bytes', () => {
    const bytes = dataUrlToPngBytes(PNG_1x1);
    expect(bytes).not.toBeNull();
    expect(pngBytesToDataUrl(bytes!)).toBe(PNG_1x1);
  });

  it('returns null for non-PNG / malformed data URLs', () => {
    expect(dataUrlToPngBytes('data:image/jpeg;base64,AAAA')).toBeNull();
    expect(dataUrlToPngBytes('not a data url')).toBeNull();
    expect(dataUrlToPngBytes('')).toBeNull();
  });
});

describe('writeShotAt / readShotsAt', () => {
  it('writes and reads back before/after PNGs by checkpoint id', async () => {
    const base = freshDir();
    await writeShotAt(base, 'ckpt-1', 'before', PNG_1x1);
    await writeShotAt(base, 'ckpt-1', 'after', PNG_1x1);

    const shots = await readShotsAt(base, 'ckpt-1');
    expect(shots.before).toBe(PNG_1x1);
    expect(shots.after).toBe(PNG_1x1);
  });

  it('returns an empty object when no shots exist', async () => {
    const base = freshDir();
    expect(await readShotsAt(base, 'missing')).toEqual({});
  });

  it('ignores malformed data URLs without writing a file', async () => {
    const base = freshDir();
    await writeShotAt(base, 'ckpt-x', 'before', 'data:text/plain;base64,AAAA');
    expect(await readShotsAt(base, 'ckpt-x')).toEqual({});
  });
});

describe('pruneOldShotDirs (retention cap)', () => {
  it('keeps only the newest N checkpoint folders', async () => {
    const base = freshDir();
    const root = join(base, 'checkpoints');
    mkdirSync(root, { recursive: true });

    // Create 10 folders with strictly increasing mtimes so order is deterministic.
    for (let i = 0; i < 10; i++) {
      const dir = join(root, `ckpt-${i}`);
      mkdirSync(dir, { recursive: true });
      const t = new Date((i + 1) * 1000);
      utimesSync(dir, t, t);
    }

    await pruneOldShotDirs(base, 4);

    // The 6 oldest (0..5) are removed; the 4 newest (6..9) remain.
    for (let i = 0; i < 6; i++) expect(existsSync(join(root, `ckpt-${i}`))).toBe(false);
    for (let i = 6; i < 10; i++) expect(existsSync(join(root, `ckpt-${i}`))).toBe(true);
  });

  it('is a no-op when under the cap', async () => {
    const base = freshDir();
    await writeShotAt(base, 'only', 'before', PNG_1x1, 25);
    await pruneOldShotDirs(base, 25);
    expect((await readShotsAt(base, 'only')).before).toBe(PNG_1x1);
  });
});
