import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// checkpoints.ts broadcasts to the main window on change; stub it out.
vi.mock('@main/window', () => ({ getMainWindow: () => null }));

import {
  initCheckpoints,
  createCheckpoint,
  startScratch,
  keepScratch,
  discardScratch,
  getScratch,
  listCheckpoints,
} from './checkpoints';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
}

function refExists(dir: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', ref], { cwd: dir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const APP = (body: string): string => `export const App = () => ${body};\n`;

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'easel-scratch-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@easel.dev');
  git(dir, 'config', 'user.name', 'Easel Test');
  writeFileSync(join(dir, 'app.tsx'), APP('null'));
  git(dir, 'add', '--all');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

const created: string[] = [];
function freshRepo(): string {
  const dir = makeRepo();
  created.push(dir);
  return dir;
}
beforeEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe('scratch experiments', () => {
  it('routes scratch checkpoints to a scratch ref and leaves the main ref untouched', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    const headBefore = git(dir, 'rev-parse', 'HEAD');
    const easelBefore = git(dir, 'rev-parse', 'refs/easel/checkpoint');

    const info = await startScratch('try a heading');
    expect(info.active).toBe(true);
    const scratchRef = `refs/easel/scratch/${info.id}`;
    expect(refExists(dir, scratchRef)).toBe(true);

    writeFileSync(join(dir, 'app.tsx'), APP('<h1>Hi</h1>'));
    const c1 = await createCheckpoint('add heading', 'r1');
    writeFileSync(join(dir, 'app.tsx'), APP('<h1>Hello</h1>'));
    const c2 = await createCheckpoint('tweak heading', 'r2');

    // The scratch checkpoints live on the scratch ref, NOT on the main ref.
    expect(git(dir, 'rev-parse', scratchRef)).toBe(c2.commitSha);
    expect(git(dir, 'rev-parse', 'refs/easel/checkpoint')).toBe(easelBefore);
    expect(c1.commitSha).not.toBe(c2.commitSha);

    // The user's real HEAD is never touched.
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('Discard deletes the scratch ref and restores the pre-scratch tree', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);
    const headBefore = git(dir, 'rev-parse', 'HEAD');

    const preScratch = listCheckpoints();
    const preScratchId = preScratch.currentId;

    const info = await startScratch();
    const scratchRef = `refs/easel/scratch/${info.id}`;

    writeFileSync(join(dir, 'app.tsx'), APP('<main>experiment</main>'));
    await createCheckpoint('experiment', 'r1');
    expect(readFileSync(join(dir, 'app.tsx'), 'utf8')).toContain('experiment');

    const result = await discardScratch();
    expect(result.active).toBe(false);
    expect(getScratch().active).toBe(false);
    // Working tree is back to the pre-scratch content.
    expect(readFileSync(join(dir, 'app.tsx'), 'utf8')).toBe(APP('null'));
    // The cursor points back at the pre-scratch checkpoint (not before it).
    expect(listCheckpoints().currentId).toBe(preScratchId);
    // The scratch ref is gone.
    expect(refExists(dir, scratchRef)).toBe(false);
    // HEAD untouched throughout.
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('Keep fast-forwards the main ref to the scratch tip and removes the scratch ref', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);
    const headBefore = git(dir, 'rev-parse', 'HEAD');

    const info = await startScratch();
    const scratchRef = `refs/easel/scratch/${info.id}`;

    writeFileSync(join(dir, 'app.tsx'), APP('<section>kept</section>'));
    const c1 = await createCheckpoint('keep me', 'r1');

    const result = await keepScratch();
    expect(result.active).toBe(false);
    // The main Easel ref now points at the kept scratch tip.
    expect(git(dir, 'rev-parse', 'refs/easel/checkpoint')).toBe(c1.commitSha);
    // The scratch ref is gone.
    expect(refExists(dir, scratchRef)).toBe(false);
    // HEAD untouched.
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
  });

  it('keep/discard with no active scratch are safe no-ops; starting twice reuses the scratch', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    expect((await keepScratch()).active).toBe(false);
    expect((await discardScratch()).active).toBe(false);

    const a = await startScratch('one');
    const b = await startScratch('two'); // already active — reuse, don't fork again
    expect(b.id).toBe(a.id);
    expect(b.name).toBe('one');
    // Exactly one scratch ref exists.
    const refs = git(dir, 'for-each-ref', '--format=%(refname)', 'refs/easel/scratch/');
    expect(refs.split('\n').filter(Boolean)).toHaveLength(1);
  });
});
