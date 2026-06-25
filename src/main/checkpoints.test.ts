import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CheckpointProvenance } from '@shared/types';

// checkpoints.ts broadcasts to the main window on change; stub it out so the
// git mechanics can be exercised under plain Node.
vi.mock('@main/window', () => ({ getMainWindow: () => null }));

import {
  initCheckpoints,
  createCheckpoint,
  getCheckpointProvenance,
  listCheckpoints,
} from './checkpoints';

/** Spin up a throwaway git repo with an initial commit and return its path. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'easel-ckpt-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir });
  };
  git('init', '-q');
  git('config', 'user.email', 'test@easel.dev');
  git('config', 'user.name', 'Easel Test');
  writeFileSync(join(dir, 'app.tsx'), 'export const App = () => null;\n');
  git('add', '--all');
  git('commit', '-q', '-m', 'initial');
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

describe('createCheckpoint provenance trailers', () => {
  it('records Easel-* trailers and round-trips them via getCheckpointProvenance', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    // Make an edit, then checkpoint it with full provenance.
    writeFileSync(join(dir, 'app.tsx'), 'export const App = () => <h1>Hi</h1>;\n');
    const provenance: CheckpointProvenance = {
      instruction: 'Add a heading',
      targets: ['div#root'],
      sources: ['app.tsx:1'],
      confidence: 'high',
      model: 'claude-opus-4-8',
      backend: 'claude-agent-sdk',
    };
    const checkpoint = await createCheckpoint('Add a heading', 'req-42', provenance);

    const parsed = await getCheckpointProvenance(checkpoint.commitSha);
    expect(parsed).toEqual(provenance);
  });

  it('falls back to changed files for Easel-Source when none are provided', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    writeFileSync(join(dir, 'app.tsx'), 'export const App = () => <main />;\n');
    const checkpoint = await createCheckpoint('Tweak', 'req-7', {
      instruction: 'Tweak',
      model: 'm',
      backend: 'anthropic-api',
    });

    const parsed = await getCheckpointProvenance(checkpoint.commitSha);
    expect(parsed.sources).toContain('app.tsx');
    expect(parsed.instruction).toBe('Tweak');
  });

  it('still records the requestId on the checkpoint (backward compatible subject)', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    writeFileSync(join(dir, 'app.tsx'), 'export const App = () => <section />;\n');
    await createCheckpoint('Subj', 'req-99', { instruction: 'Subj' });

    const { checkpoints } = listCheckpoints();
    const latest = checkpoints[checkpoints.length - 1];
    expect(latest.requestId).toBe('req-99');
  });

  it('records only the source fallback when called with no provenance', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    writeFileSync(join(dir, 'app.tsx'), 'export const App = () => <p />;\n');
    const checkpoint = await createCheckpoint('No provenance', 'req-1');

    // No instruction/model/backend trailers — but the source fallback still
    // records the changed file, which is the only thing we expect here.
    const parsed = await getCheckpointProvenance(checkpoint.commitSha);
    expect(parsed.instruction).toBeUndefined();
    expect(parsed.model).toBeUndefined();
    expect(parsed.sources).toContain('app.tsx');
  });

  it('writes no trailer paragraph for a checkpoint with no provenance and no changes', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir); // creates the "Original" checkpoint: nothing changed

    const { checkpoints } = listCheckpoints();
    const original = checkpoints[0];
    expect(original.changedFiles).toEqual([]);
    expect(await getCheckpointProvenance(original.commitSha)).toEqual({});
  });
});
