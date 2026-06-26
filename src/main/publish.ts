/**
 * Easel — branch & open a PR from accepted checkpoints (#10).
 *
 * Squashes a run's accepted checkpoints onto a fresh real branch off `HEAD`
 * (NEVER off the internal `refs/easel/checkpoint` ref, and NEVER moving the
 * user's HEAD/branches), generates a PR title/body from the instructions +
 * changed files + provenance trailers, then `gh pr create`s it.
 *
 * Git and `gh` access go through injectable runners so the whole flow is
 * unit-testable without shelling out to the network or the real `gh`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Checkpoint, CheckpointProvenance } from '@shared/types';
import { formatProvenanceTrailers } from '@main/provenance';

const execFileAsync = promisify(execFile);

/* -------------------------------------------------------------------------- */
/*  Injectable runners                                                          */
/* -------------------------------------------------------------------------- */

/** Runs a git plumbing command, returning trimmed stdout; rejects on failure. */
export type GitRunner = (args: string[]) => Promise<string>;

/** Result of a non-throwing command run (for `gh`/preflight). */
export interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Runs an arbitrary command and resolves with its output + exit code (never throws). */
export type CommandRunner = (file: string, args: string[]) => Promise<CommandResult>;

/** Real git runner bound to a project root. */
export function defaultGitRunner(root: string): GitRunner {
  return async (args) => {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      env: { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  };
}

/** Real command runner bound to a project root; captures exit codes without throwing. */
export function defaultCommandRunner(root: string): CommandRunner {
  return async (file, args) => {
    try {
      const { stdout, stderr } = await execFileAsync(file, args, {
        cwd: root,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      return { stdout: stdout.trim(), stderr: stderr.trim(), code: 0 };
    } catch (err) {
      const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
      return {
        stdout: (e.stdout ?? '').trim(),
        stderr: (e.stderr ?? e.message ?? '').trim(),
        code: typeof e.code === 'number' ? e.code : 1,
      };
    }
  };
}

/* -------------------------------------------------------------------------- */
/*  gh preflight                                                                */
/* -------------------------------------------------------------------------- */

/** Whether `gh` is installed, authenticated, and the repo has an `origin`. */
export interface GhProbe {
  available: boolean;
  authenticated: boolean;
  hasRemote: boolean;
}

/** Probe `gh`/remote readiness without throwing. */
export async function preflightGh(run: CommandRunner): Promise<GhProbe> {
  const version = await run('gh', ['--version']);
  if (version.code !== 0) return { available: false, authenticated: false, hasRemote: false };

  const auth = await run('gh', ['auth', 'status']);
  const authenticated = auth.code === 0;

  const remote = await run('git', ['remote', 'get-url', 'origin']);
  const hasRemote = remote.code === 0 && remote.stdout.length > 0;

  return { available: true, authenticated, hasRemote };
}

/* -------------------------------------------------------------------------- */
/*  PR content (deterministic, testable)                                        */
/* -------------------------------------------------------------------------- */

export interface PrContentInput {
  /** The user's plain-English instructions, oldest→newest. */
  instructions: string[];
  /** Union of files changed across the checkpoints. */
  changedFiles: string[];
}

/** Build a PR title + Markdown body from the accumulated instructions + files. */
export function buildPrContent(input: PrContentInput): { title: string; body: string } {
  const first = input.instructions.find((i) => i.trim().length > 0);
  const title = first ? truncate(first.trim(), 72) : 'Easel edits';

  const lines: string[] = ['## Summary', ''];
  if (input.instructions.length > 0) {
    lines.push('Changes made via Easel:', '');
    for (const i of input.instructions) lines.push(`- ${i.trim()}`);
  } else {
    lines.push('Edits applied via Easel.');
  }
  if (input.changedFiles.length > 0) {
    lines.push('', '## Files changed', '');
    for (const f of input.changedFiles) lines.push(`- \`${f}\``);
  }
  lines.push('', '🤖 Generated with [Claude Code](https://claude.com/claude-code) via Easel.');
  return { title, body: lines.join('\n') };
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/** A filesystem-safe, lowercase branch slug derived from a string. */
export function slugify(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'edits';
}

/* -------------------------------------------------------------------------- */
/*  Branch creation (squash onto a fresh branch off HEAD)                       */
/* -------------------------------------------------------------------------- */

export interface CreateBranchInput {
  root: string;
  branchName: string;
  /** Checkpoints to include, oldest→newest; the tip's tree is the squashed state. */
  checkpoints: Checkpoint[];
  subject: string;
  body: string;
  provenance?: CheckpointProvenance;
  gitRunner?: GitRunner;
}

/**
 * Create `branchName` off the current `HEAD` with a single squashed commit whose
 * tree is the latest checkpoint's tree. The user's HEAD/index/branches are never
 * modified (we only create a new branch ref).
 */
export async function createBranchFromCheckpoints(
  input: CreateBranchInput,
): Promise<{ branch: string; commitSha: string }> {
  if (input.checkpoints.length === 0) throw new Error('No checkpoints to publish');
  const git = input.gitRunner ?? defaultGitRunner(input.root);

  const head = (await git(['rev-parse', 'HEAD'])).trim();
  const tipSha = input.checkpoints[input.checkpoints.length - 1].commitSha;
  const tree = (await git(['rev-parse', `${tipSha}^{tree}`])).trim();

  const args = ['commit-tree', tree, '-p', head, '-m', input.subject, '-m', input.body];
  const trailers = input.provenance ? formatProvenanceTrailers(input.provenance) : '';
  if (trailers) args.push('-m', trailers);
  const commitSha = (await git(args)).trim();

  // Create the branch ref WITHOUT checking it out — HEAD is untouched.
  await git(['branch', input.branchName, commitSha]);
  return { branch: input.branchName, commitSha };
}

/* -------------------------------------------------------------------------- */
/*  openPr orchestration                                                        */
/* -------------------------------------------------------------------------- */

export type OpenPrResult =
  | { ok: true; branch: string; commitSha: string; prUrl?: string }
  | {
      ok: false;
      code: 'no-checkpoints' | 'gh-not-found' | 'gh-not-authenticated' | 'no-remote' | 'error';
      message: string;
    };

export interface OpenPrOptions {
  root: string;
  checkpoints: Checkpoint[];
  title: string;
  body: string;
  branchName?: string;
  provenance?: CheckpointProvenance;
  gitRunner?: GitRunner;
  commandRunner?: CommandRunner;
}

/** Default branch name: `easel/<slug>-<tip short sha>`. */
function defaultBranchName(title: string, checkpoints: Checkpoint[]): string {
  const tip = checkpoints[checkpoints.length - 1]?.commitSha.slice(0, 7) ?? 'edits';
  return `easel/${slugify(title)}-${tip}`;
}

/** Extract the first http(s) URL from gh's output. */
function extractUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/\S+/);
  return m ? m[0] : undefined;
}

/**
 * Full flow: preflight `gh`, create the squashed branch off HEAD, push it, and
 * open a PR. Returns a typed failure (never throws across the boundary) for the
 * not-installed / not-authenticated / no-remote cases.
 */
export async function openPr(opts: OpenPrOptions): Promise<OpenPrResult> {
  if (opts.checkpoints.length === 0) {
    return { ok: false, code: 'no-checkpoints', message: 'No accepted edits to publish yet.' };
  }
  const git = opts.gitRunner ?? defaultGitRunner(opts.root);
  const run = opts.commandRunner ?? defaultCommandRunner(opts.root);

  const probe = await preflightGh(run);
  if (!probe.available) {
    return { ok: false, code: 'gh-not-found', message: 'GitHub CLI (gh) is not installed.' };
  }
  if (!probe.authenticated) {
    return {
      ok: false,
      code: 'gh-not-authenticated',
      message: 'GitHub CLI is not authenticated. Run `gh auth login`, then retry.',
    };
  }
  if (!probe.hasRemote) {
    return { ok: false, code: 'no-remote', message: 'This repository has no `origin` remote to push to.' };
  }

  const branchName = opts.branchName ?? defaultBranchName(opts.title, opts.checkpoints);

  let created: { branch: string; commitSha: string };
  try {
    created = await createBranchFromCheckpoints({
      root: opts.root,
      branchName,
      checkpoints: opts.checkpoints,
      subject: opts.title,
      body: opts.body,
      provenance: opts.provenance,
      gitRunner: git,
    });
  } catch (err) {
    return { ok: false, code: 'error', message: messageOf(err) };
  }

  const push = await run('git', ['push', '-u', 'origin', created.branch]);
  if (push.code !== 0) {
    return { ok: false, code: 'error', message: `git push failed: ${push.stderr || push.stdout}` };
  }

  const pr = await run('gh', [
    'pr',
    'create',
    '--head',
    created.branch,
    '--title',
    opts.title,
    '--body',
    opts.body,
  ]);
  if (pr.code !== 0) {
    return { ok: false, code: 'error', message: `gh pr create failed: ${pr.stderr || pr.stdout}` };
  }

  return { ok: true, branch: created.branch, commitSha: created.commitSha, prUrl: extractUrl(pr.stdout) };
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
