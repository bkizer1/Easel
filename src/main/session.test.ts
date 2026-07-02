/**
 * Tests for session replay pack / unpack / import / replay (`src/main/session.ts`).
 *
 * The pure core functions take every dependency explicitly, so they exercise
 * against throwaway git repos under a temp dir — no Electron required.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { rmrf } from './rmrf';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Checkpoint } from '@shared/types';
import { BUNDLE_SCHEMA_VERSION } from '@shared/types';
import {
  packBundle,
  unpackBundle,
  importBundleInto,
  importedRefName,
  replayCheckpoint,
  ReplayConflictError,
  type PackBundleInput,
} from './session';
import { writeShotAt, readShotsAt } from './checkpointShots';

const CHECKPOINT_REF = 'refs/easel/checkpoint';
const PNG = `data:image/png;base64,${Buffer.from('fake-png-bytes').toString('base64')}`;

const dirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmrf(dirs.pop()!);
});

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
}

/**
 * Initialise a throwaway git repo with a test identity and LF line endings
 * pinned. Disabling `core.autocrlf` is essential on Windows, where git would
 * otherwise rewrite LF -> CRLF on apply/checkout and break the byte-exact
 * content assertions below (the replay itself is faithful; the env must not lie).
 */
function initRepo(dir: string): void {
  gitIn(dir, 'init', '-q');
  gitIn(dir, 'config', 'user.email', 'test@easel.dev');
  gitIn(dir, 'config', 'user.name', 'Easel Test');
  gitIn(dir, 'config', 'core.autocrlf', 'false');
  gitIn(dir, 'config', 'core.eol', 'lf');
}

/**
 * Build a source repo whose `refs/easel/checkpoint` carries two checkpoints:
 *   - `orig`  — creates `app.tsx` = "v0\n" (first commit, no parent)
 *   - `edit1` — modifies `app.tsx` to "v1\n" AND adds `feature.tsx` = "new\n"
 * Returns the repo path + the two checkpoint commit shas.
 */
function makeSourceRepo(): { root: string; origSha: string; edit1Sha: string } {
  const root = tmp('easel-src-');
  initRepo(root);

  writeFileSync(join(root, 'app.tsx'), 'v0\n');
  gitIn(root, 'add', '--all');
  gitIn(root, 'commit', '-q', '-m', 'original');
  const origSha = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'update-ref', CHECKPOINT_REF, origSha);

  writeFileSync(join(root, 'app.tsx'), 'v1\n');
  writeFileSync(join(root, 'feature.tsx'), 'new\n');
  gitIn(root, 'add', '--all');
  gitIn(root, 'commit', '-q', '-m', 'make it v1');
  const edit1Sha = gitIn(root, 'rev-parse', 'HEAD');
  gitIn(root, 'update-ref', CHECKPOINT_REF, edit1Sha);

  return { root, origSha, edit1Sha };
}

function checkpoints(origSha: string, edit1Sha: string): Checkpoint[] {
  return [
    { id: 'orig', commitSha: origSha, message: 'original', createdAt: 1, changedFiles: ['app.tsx'] },
    {
      id: 'edit1',
      commitSha: edit1Sha,
      requestId: 'req-1',
      message: 'make it v1',
      createdAt: 2,
      changedFiles: ['app.tsx', 'feature.tsx'],
    },
  ];
}

async function packFromSource(): Promise<{
  bytes: Buffer;
  origSha: string;
  edit1Sha: string;
}> {
  const { root, origSha, edit1Sha } = makeSourceRepo();
  const shotsBase = tmp('easel-shots-');
  await writeShotAt(shotsBase, 'edit1', 'before', PNG);
  await writeShotAt(shotsBase, 'edit1', 'after', PNG);

  const input: PackBundleInput = {
    root,
    chat: [
      { id: 'm1', role: 'user', content: 'make it v1', createdAt: 1, requestId: 'req-1' },
      { id: 'm2', role: 'assistant', content: 'done', createdAt: 2, checkpointId: 'edit1' },
    ],
    checkpoints: checkpoints(origSha, edit1Sha),
    currentCheckpointId: 'edit1',
    checkpointRef: CHECKPOINT_REF,
    easelVersion: '0.4.0',
    exportedAt: 1234,
    projectName: 'demo',
    framework: 'vite-react',
    devServerUrl: 'http://localhost:3000',
    shotsBaseDir: shotsBase,
  };
  return { bytes: await packBundle(input), origSha, edit1Sha };
}

describe('packBundle / unpackBundle', () => {
  it('round-trips manifest, chat, checkpoints, and shots', async () => {
    const { bytes } = await packFromSource();
    const { manifest, bundleBytes, shots } = unpackBundle(bytes);

    expect(manifest.schemaVersion).toBe(BUNDLE_SCHEMA_VERSION);
    expect(manifest.easelVersion).toBe('0.4.0');
    expect(manifest.session.projectName).toBe('demo');
    expect(manifest.session.framework).toBe('vite-react');
    expect(manifest.chat).toHaveLength(2);
    expect(manifest.checkpoints.map((c) => c.id)).toEqual(['orig', 'edit1']);
    expect(manifest.currentCheckpointId).toBe('edit1');
    expect(manifest.shots).toContain('edit1');

    // The git bundle is real and non-empty.
    expect(bundleBytes.length).toBeGreaterThan(0);
    expect(bundleBytes.toString('utf8', 0, 30)).toContain('# v2 git bundle');

    // Embedded shots survive the round-trip.
    expect(shots.get('edit1')?.before).toBeDefined();
    expect(shots.get('edit1')?.after).toBeDefined();
  });

  it('rejects an unknown schema version', async () => {
    const { bytes } = await packFromSource();
    const { manifest } = unpackBundle(bytes);
    // Re-pack with a bumped schema by mutating the manifest in a fresh zip is
    // overkill; instead assert the guard directly via a hand-built bundle.
    const tampered = { ...manifest, schemaVersion: 999 };
    // Rebuild a minimal zip with the tampered manifest using the public API.
    const { zipSync } = await import('./zip');
    const bad = zipSync([
      { name: 'manifest.json', data: Buffer.from(JSON.stringify(tampered)) },
      { name: 'checkpoints.bundle', data: Buffer.from('x') },
    ]);
    expect(() => unpackBundle(bad)).toThrow(/Unsupported \.easel version/);
  });

  it('rejects a bundle missing its manifest', async () => {
    const { zipSync } = await import('./zip');
    const bad = zipSync([{ name: 'checkpoints.bundle', data: Buffer.from('x') }]);
    expect(() => unpackBundle(bad)).toThrow(/manifest\.json is missing/);
  });
});

describe('importBundleInto', () => {
  it('fetches the checkpoint ref into a namespaced imported ref and persists shots', async () => {
    const { bytes } = await packFromSource();

    // A fresh, unrelated target git repo.
    const target = tmp('easel-tgt-');
    initRepo(target);
    writeFileSync(join(target, 'app.tsx'), 'v0\n');
    gitIn(target, 'add', '--all');
    gitIn(target, 'commit', '-q', '-m', 'target init');

    const shotsBase = tmp('easel-tgt-shots-');
    const imported = await importBundleInto({
      root: target,
      bytes,
      sessionId: 'sess1',
      shotsBaseDir: shotsBase,
    });

    expect(imported.sessionId).toBe('sess1');
    expect(imported.manifest.checkpoints).toHaveLength(2);

    // The imported ref now exists in the target repo.
    const ref = gitIn(target, 'rev-parse', importedRefName('sess1'));
    expect(ref).toMatch(/^[0-9a-f]{40}$/);

    // Shots were persisted under the live shot-store keys.
    const shots = await readShotsAt(shotsBase, 'edit1');
    expect(shots.before).toBeDefined();
  });

  it('throws when the target is not a git repo', async () => {
    const { bytes } = await packFromSource();
    const notRepo = tmp('easel-notrepo-');
    await expect(
      importBundleInto({ root: notRepo, bytes, sessionId: 's', shotsBaseDir: notRepo }),
    ).rejects.toThrow(/git project/);
  });
});

describe('replayCheckpoint', () => {
  async function importedTarget(initialAppTsx: string): Promise<{
    target: string;
    manifest: Awaited<ReturnType<typeof unpackBundle>>['manifest'];
  }> {
    const { bytes } = await packFromSource();
    const target = tmp('easel-replay-');
    initRepo(target);
    writeFileSync(join(target, 'app.tsx'), initialAppTsx);
    gitIn(target, 'add', '--all');
    gitIn(target, 'commit', '-q', '-m', 'target init');

    const imported = await importBundleInto({
      root: target,
      bytes,
      sessionId: 'sess1',
      shotsBaseDir: tmp('easel-replay-shots-'),
    });
    return { target, manifest: imported.manifest };
  }

  it('applies a step cleanly and creates a new live checkpoint', async () => {
    const { target, manifest } = await importedTarget('v0\n'); // matches the step's base

    let createdMessage = '';
    const fakeCheckpoint: Checkpoint = {
      id: 'new1',
      commitSha: 'deadbeef',
      message: 'Replay: make it v1',
      createdAt: 99,
      changedFiles: ['app.tsx', 'feature.tsx'],
    };
    const result = await replayCheckpoint({
      root: target,
      manifest,
      checkpointId: 'edit1',
      createCheckpointFn: async (message) => {
        createdMessage = message;
        return fakeCheckpoint;
      },
    });

    expect(result).toBe(fakeCheckpoint);
    expect(createdMessage).toBe('Replay: make it v1');
    // The recorded delta landed on disk.
    expect(readFileSync(join(target, 'app.tsx'), 'utf8')).toBe('v1\n');
    expect(readFileSync(join(target, 'feature.tsx'), 'utf8')).toBe('new\n');
  });

  it('throws ReplayConflictError and leaves the tree untouched on conflict', async () => {
    const { target, manifest } = await importedTarget('totally different\n');

    await expect(
      replayCheckpoint({
        root: target,
        manifest,
        checkpointId: 'edit1',
        createCheckpointFn: async () => {
          throw new Error('should not be called');
        },
      }),
    ).rejects.toBeInstanceOf(ReplayConflictError);

    // Nothing applied: app.tsx is unchanged and feature.tsx was never created.
    expect(readFileSync(join(target, 'app.tsx'), 'utf8')).toBe('totally different\n');
    expect(existsSync(join(target, 'feature.tsx'))).toBe(false);
  });

  it('replays a parent-less (root) checkpoint via the empty-tree base', async () => {
    // A target that does NOT have app.tsx, so creating it applies cleanly.
    const { bytes } = await packFromSource();
    const target = tmp('easel-root-');
    initRepo(target);
    writeFileSync(join(target, 'readme.md'), 'hi\n');
    gitIn(target, 'add', '--all');
    gitIn(target, 'commit', '-q', '-m', 'target init');

    const imported = await importBundleInto({
      root: target,
      bytes,
      sessionId: 'sess1',
      shotsBaseDir: tmp('easel-root-shots-'),
    });

    await replayCheckpoint({
      root: target,
      manifest: imported.manifest,
      checkpointId: 'orig',
      createCheckpointFn: async () => ({
        id: 'n',
        commitSha: 'x',
        message: 'Replay: original',
        createdAt: 1,
        changedFiles: ['app.tsx'],
      }),
    });

    expect(readFileSync(join(target, 'app.tsx'), 'utf8')).toBe('v0\n');
  });

  it('throws for an unknown checkpoint id', async () => {
    const { target, manifest } = await importedTarget('v0\n');
    await expect(
      replayCheckpoint({
        root: target,
        manifest,
        checkpointId: 'nope',
        createCheckpointFn: async () => {
          throw new Error('unused');
        },
      }),
    ).rejects.toThrow(/Unknown checkpoint/);
  });
});
