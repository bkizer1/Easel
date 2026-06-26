import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Checkpoint, CheckpointProvenance } from '@shared/types';

vi.mock('@main/window', () => ({ getMainWindow: () => null }));

import { initCheckpoints, createCheckpoint } from './checkpoints';
import {
  buildPrContent,
  slugify,
  preflightGh,
  createBranchFromCheckpoints,
  openPr,
  defaultGitRunner,
  type CommandResult,
  type CommandRunner,
} from './publish';

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: dir }).toString().trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'easel-publish-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@easel.dev');
  git(dir, 'config', 'user.name', 'Easel Test');
  writeFileSync(join(dir, 'app.tsx'), 'export const App = () => null;\n');
  git(dir, 'add', '--all');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

const created: string[] = [];
function freshRepo(): string {
  const d = makeRepo();
  created.push(d);
  return d;
}
beforeEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe('buildPrContent', () => {
  it('derives a title from the first instruction and lists files', () => {
    const { title, body } = buildPrContent({
      instructions: ['Make the hero heading bigger', 'Add a border to the card'],
      changedFiles: ['src/Hero.tsx', 'src/Card.tsx'],
    });
    expect(title).toBe('Make the hero heading bigger');
    expect(body).toContain('- Make the hero heading bigger');
    expect(body).toContain('- Add a border to the card');
    expect(body).toContain('`src/Hero.tsx`');
    expect(body).toContain('Claude Code');
  });

  it('falls back to a default title when there are no instructions', () => {
    expect(buildPrContent({ instructions: [], changedFiles: [] }).title).toBe('Easel edits');
  });
});

describe('slugify', () => {
  it('produces a filesystem-safe slug', () => {
    expect(slugify('Make the Hero BIGGER!')).toBe('make-the-hero-bigger');
    expect(slugify('')).toBe('edits');
  });
});

describe('preflightGh', () => {
  const okResult = (stdout = ''): CommandResult => ({ stdout, stderr: '', code: 0 });
  const failResult = (): CommandResult => ({ stdout: '', stderr: 'no', code: 1 });

  it('reports gh missing', async () => {
    const run: CommandRunner = async () => failResult();
    expect(await preflightGh(run)).toEqual({ available: false, authenticated: false, hasRemote: false });
  });

  it('reports not authenticated', async () => {
    const run: CommandRunner = async (file, args) => {
      if (file === 'gh' && args[0] === '--version') return okResult('gh version 2.x');
      if (file === 'gh' && args[0] === 'auth') return failResult();
      if (file === 'git') return okResult('git@github.com:me/repo.git');
      return failResult();
    };
    expect(await preflightGh(run)).toEqual({ available: true, authenticated: false, hasRemote: true });
  });

  it('reports no remote', async () => {
    const run: CommandRunner = async (file, args) => {
      if (file === 'gh' && args[0] === '--version') return okResult('gh version 2.x');
      if (file === 'gh' && args[0] === 'auth') return okResult('Logged in');
      if (file === 'git') return failResult();
      return failResult();
    };
    expect(await preflightGh(run)).toEqual({ available: true, authenticated: true, hasRemote: false });
  });
});

describe('createBranchFromCheckpoints', () => {
  it('squashes onto a new branch off HEAD without touching HEAD/branches, with trailers', async () => {
    const dir = freshRepo();
    await initCheckpoints(dir);

    writeFileSync(join(dir, 'app.tsx'), 'export const App = () => <h1>Hi</h1>;\n');
    const c1 = await createCheckpoint('add heading', 'r1');
    writeFileSync(join(dir, 'app.tsx'), 'export const App = () => <h1>Hello</h1>;\n');
    const c2 = await createCheckpoint('tweak heading', 'r2');

    const headBefore = git(dir, 'rev-parse', 'HEAD');
    const branchesBefore = git(dir, 'branch', '--format=%(refname)')
      .split('\n')
      .filter(Boolean);
    const defaultBranch = branchesBefore[0].replace('refs/heads/', '');

    const provenance: CheckpointProvenance = {
      instruction: 'add + tweak heading',
      model: 'claude-opus-4-8',
      backend: 'claude-agent-sdk',
    };
    const { branch, commitSha } = await createBranchFromCheckpoints({
      root: dir,
      branchName: 'easel/headings',
      checkpoints: [c1, c2],
      subject: 'Add a heading',
      body: 'Body text',
      provenance,
      gitRunner: defaultGitRunner(dir),
    });

    // Branch was created and points to the squashed commit.
    expect(branch).toBe('easel/headings');
    expect(git(dir, 'rev-parse', 'easel/headings')).toBe(commitSha);

    // The squashed commit's parent is HEAD, and its tree equals the tip tree.
    expect(git(dir, 'rev-parse', `${commitSha}^`)).toBe(headBefore);
    expect(git(dir, 'rev-parse', `${commitSha}^{tree}`)).toBe(git(dir, 'rev-parse', `${c2.commitSha}^{tree}`));

    // Provenance trailers rode onto the squashed commit.
    const message = git(dir, 'log', '-1', '--format=%B', commitSha);
    expect(message).toContain('Easel-Backend: claude-agent-sdk');

    // HEAD and the pre-existing default branch are unchanged.
    expect(git(dir, 'rev-parse', 'HEAD')).toBe(headBefore);
    expect(git(dir, 'rev-parse', defaultBranch)).toBe(headBefore);

    // Exactly one new branch was added (the existing ones are untouched).
    const branchesAfter = git(dir, 'branch', '--format=%(refname)')
      .split('\n')
      .filter(Boolean);
    expect(branchesAfter).toContain('refs/heads/easel/headings');
    expect(branchesAfter).toContain(`refs/heads/${defaultBranch}`);
    expect(branchesAfter.length).toBe(branchesBefore.length + 1);
  });
});

describe('openPr', () => {
  const ckpt = (sha: string): Checkpoint => ({
    id: sha.slice(0, 8),
    commitSha: sha,
    requestId: 'r1',
    message: 'edit',
    createdAt: 0,
    changedFiles: ['app.tsx'],
  });

  it('fails clearly when gh is not authenticated (no branch created, no throw)', async () => {
    const run: CommandRunner = async (file, args) => {
      if (file === 'gh' && args[0] === '--version') return { stdout: 'gh', stderr: '', code: 0 };
      if (file === 'gh' && args[0] === 'auth') return { stdout: '', stderr: 'x', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const result = await openPr({
      root: '/tmp/x',
      checkpoints: [ckpt('abc1234deadbeef')],
      title: 'T',
      body: 'B',
      commandRunner: run,
      gitRunner: async () => 'unused',
    });
    expect(result).toEqual({
      ok: false,
      code: 'gh-not-authenticated',
      message: expect.stringContaining('gh auth login'),
    });
  });

  it('fails clearly with no remote', async () => {
    const run: CommandRunner = async (file, args) => {
      if (file === 'gh' && args[0] === '--version') return { stdout: 'gh', stderr: '', code: 0 };
      if (file === 'gh' && args[0] === 'auth') return { stdout: 'ok', stderr: '', code: 0 };
      if (file === 'git') return { stdout: '', stderr: 'no remote', code: 1 };
      return { stdout: '', stderr: '', code: 0 };
    };
    const result = await openPr({
      root: '/tmp/x',
      checkpoints: [ckpt('abc1234deadbeef')],
      title: 'T',
      body: 'B',
      commandRunner: run,
      gitRunner: async () => 'unused',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no-remote');
  });

  it('returns no-checkpoints when there is nothing to publish', async () => {
    const result = await openPr({ root: '/tmp/x', checkpoints: [], title: 'T', body: 'B' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no-checkpoints');
  });

  it('happy path: branches, pushes, and opens a PR, returning the URL', async () => {
    const calls: string[] = [];
    const gitRunner = async (args: string[]): Promise<string> => {
      calls.push(`git ${args.join(' ')}`);
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'HEADSHA';
      if (args[0] === 'rev-parse' && args[1]?.endsWith('^{tree}')) return 'TREESHA';
      if (args[0] === 'commit-tree') return 'NEWCOMMITSHA';
      if (args[0] === 'branch') return '';
      return '';
    };
    const run: CommandRunner = async (file, args) => {
      calls.push(`${file} ${args.join(' ')}`);
      if (file === 'gh' && args[0] === '--version') return { stdout: 'gh', stderr: '', code: 0 };
      if (file === 'gh' && args[0] === 'auth') return { stdout: 'ok', stderr: '', code: 0 };
      if (file === 'git' && args[0] === 'remote') return { stdout: 'origin-url', stderr: '', code: 0 };
      if (file === 'git' && args[0] === 'push') return { stdout: '', stderr: '', code: 0 };
      if (file === 'gh' && args[0] === 'pr') {
        return { stdout: 'https://github.com/me/repo/pull/42', stderr: '', code: 0 };
      }
      return { stdout: '', stderr: '', code: 0 };
    };

    const result = await openPr({
      root: '/tmp/x',
      checkpoints: [ckpt('abc1234deadbeef')],
      title: 'My change',
      body: 'Body',
      commandRunner: run,
      gitRunner,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.prUrl).toBe('https://github.com/me/repo/pull/42');
      expect(result.branch).toBe('easel/my-change-abc1234');
    }
    // It pushed and created the PR.
    expect(calls).toContain('git push -u origin easel/my-change-abc1234');
    expect(calls.some((c) => c.startsWith('gh pr create'))).toBe(true);
  });
});
