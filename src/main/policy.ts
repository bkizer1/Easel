/**
 * Easel — guardrail policy engine (`.easel/policy.json`).
 *
 * A project-level policy bounds what the agent may edit. It is enforced at the
 * single `ProjectFs` write chokepoint in `editRunner.ts` *before* any byte hits
 * disk, so a denied path never changes the working tree.
 *
 * Schema (all fields optional):
 *   {
 *     "deny":           ["**\/.env*", "**\/*.lock", "migrations/**"],
 *     "requireConfirm": ["package.json", "**\/*.config.*"],
 *     "maxFilesPerEdit": 10
 *   }
 *
 * Default (no file present): deny dotenv files, lockfiles and `.git/**`; allow
 * everything else; no file cap. A *malformed* policy file fails safe — every
 * write is denied until the user fixes it.
 *
 * Pure module (the only I/O is reading the policy file in {@link loadPolicy}) so
 * the matcher is exhaustively unit-testable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createLogger } from '@main/logger';

const log = createLogger('policy');

/* -------------------------------------------------------------------------- */
/*  Types                                                                       */
/* -------------------------------------------------------------------------- */

/** Parsed `.easel/policy.json`. */
export interface EaselPolicy {
  /** Glob patterns that are hard-blocked (no write, no prompt). */
  deny: string[];
  /** Glob patterns that pause for explicit allow-once approval before writing. */
  requireConfirm: string[];
  /** Max distinct files one edit may write. `undefined`/`<= 0` means unlimited. */
  maxFilesPerEdit?: number;
  /**
   * When explicitly `false`, disables the Live State Puppeteer feature entirely
   * for this project (the user toggle is greyed out). Omitted or `true` means
   * the user may opt in via the toggle.  Default (unset / no file): allowed.
   */
  allowStatePuppeteer?: boolean;
}

/** A policy as resolved for a project, plus how it was obtained. */
export interface LoadedPolicy {
  policy: EaselPolicy;
  /** `default` (no file), `file` (parsed `.easel/policy.json`), or `malformed`. */
  source: 'default' | 'file' | 'malformed';
}

/** The outcome of checking one write against the policy. */
export type PolicyDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'confirm'; reason: string };

/* -------------------------------------------------------------------------- */
/*  Default policy                                                              */
/* -------------------------------------------------------------------------- */

/** Secure-by-default policy used when no `.easel/policy.json` exists. */
export const DEFAULT_POLICY: EaselPolicy = {
  deny: [
    '**/.env*', // dotenv secrets at any depth
    '**/*.lock', // yarn.lock, Cargo.lock, …
    '**/package-lock.json',
    '**/pnpm-lock.yaml',
    '**/.git/**', // never touch the git internals
  ],
  requireConfirm: [],
};

export const POLICY_FILE = path.join('.easel', 'policy.json');

/* -------------------------------------------------------------------------- */
/*  Loading                                                                    */
/* -------------------------------------------------------------------------- */

/** Coerce an unknown JSON value into a clean string[] (dropping non-strings). */
function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string' && v.length > 0);
}

/**
 * Validate a parsed JSON object into an {@link EaselPolicy}. Returns `null` when
 * the shape is unusable (so the caller can fail safe). Missing arrays default to
 * empty; an explicitly non-array `deny`/`requireConfirm`, or a non-numeric
 * `maxFilesPerEdit`, is treated as malformed.
 */
function validatePolicy(parsed: unknown): EaselPolicy | null {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  if ('deny' in obj && !Array.isArray(obj.deny)) return null;
  if ('requireConfirm' in obj && !Array.isArray(obj.requireConfirm)) return null;
  if ('maxFilesPerEdit' in obj && typeof obj.maxFilesPerEdit !== 'number') return null;
  if ('allowStatePuppeteer' in obj && typeof obj.allowStatePuppeteer !== 'boolean') return null;

  const policy: EaselPolicy = {
    deny: asStringArray(obj.deny),
    requireConfirm: asStringArray(obj.requireConfirm),
  };
  if (typeof obj.maxFilesPerEdit === 'number' && Number.isFinite(obj.maxFilesPerEdit)) {
    policy.maxFilesPerEdit = obj.maxFilesPerEdit;
  }
  if (typeof obj.allowStatePuppeteer === 'boolean') {
    policy.allowStatePuppeteer = obj.allowStatePuppeteer;
  }
  return policy;
}

/**
 * Load the policy for a project root. Reads `<root>/.easel/policy.json` if
 * present; otherwise returns {@link DEFAULT_POLICY}. A present-but-malformed file
 * returns `source: 'malformed'`, which {@link evaluateWrite} treats as deny-all.
 */
export function loadPolicy(projectRoot: string): LoadedPolicy {
  const file = path.join(projectRoot, POLICY_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    // No policy file — secure default.
    return { policy: DEFAULT_POLICY, source: 'default' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('Malformed .easel/policy.json (invalid JSON); failing safe', { err: String(err) });
    return { policy: { deny: [], requireConfirm: [] }, source: 'malformed' };
  }

  const validated = validatePolicy(parsed);
  if (!validated) {
    log.warn('Malformed .easel/policy.json (invalid shape); failing safe');
    return { policy: { deny: [], requireConfirm: [] }, source: 'malformed' };
  }

  log.info('Loaded .easel/policy.json', {
    deny: validated.deny.length,
    requireConfirm: validated.requireConfirm.length,
    maxFilesPerEdit: validated.maxFilesPerEdit,
  });
  return { policy: validated, source: 'file' };
}

/* -------------------------------------------------------------------------- */
/*  Glob matching                                                              */
/* -------------------------------------------------------------------------- */

/** Escape regex metacharacters that are NOT glob wildcards. */
function escapeLiteral(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}

/**
 * Translate a single glob to an anchored RegExp.
 *  - `**` matches any run of characters, including `/`
 *  - `*`  matches any run of characters except `/`
 *  - `?`  matches a single character except `/`
 * A leading `**\/` segment also matches zero directories (so `**\/x` matches
 * `x`). A trailing `/**` matches the directory itself and everything under it
 * (so `dir/**` matches both `dir` and `dir/a/b`, gitignore-style). Runs of more
 * than two `*` are treated as `**`.
 */
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      // Consume the whole run of stars; a run of 2+ is a globstar.
      let stars = 0;
      while (glob[i] === '*') {
        stars++;
        i++;
      }
      if (stars >= 2) {
        if (glob[i] === '/') {
          // `**/` — also matches zero leading directories.
          i++;
          re += '(?:.*/)?';
        } else if (re.endsWith('/')) {
          // Trailing `…/**` — match the directory itself or anything below it.
          re = re.slice(0, -1) + '(?:/.*)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else {
      re += escapeLiteral(c);
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Match a project-relative path against a glob pattern. A pattern containing no
 * `/` matches the path's basename at any depth (gitignore-style), so
 * `package.json` matches both `package.json` and `pkg/package.json`.
 */
export function matchGlob(pattern: string, relativePath: string): boolean {
  const normPath = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const re = globToRegExp(pattern);
  if (re.test(normPath)) return true;
  if (!pattern.includes('/')) {
    const base = normPath.slice(normPath.lastIndexOf('/') + 1);
    return re.test(base);
  }
  return false;
}

function matchesAny(patterns: string[], relativePath: string): string | null {
  for (const p of patterns) {
    if (matchGlob(p, relativePath)) return p;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Decide what should happen when the agent tries to write `relativePath`, given
 * the loaded policy and how many distinct files this edit has already written.
 *
 * Precedence: malformed → deny everything; `deny` patterns → deny; the
 * blast-radius cap → deny; `requireConfirm` patterns → confirm; otherwise allow.
 *
 * @param filesWrittenSoFar Count of *distinct other* files already written this
 *   edit. The cap blocks the write when accepting it would make the total exceed
 *   `maxFilesPerEdit`.
 */
export function evaluateWrite(
  loaded: LoadedPolicy,
  relativePath: string,
  filesWrittenSoFar: number,
): PolicyDecision {
  if (loaded.source === 'malformed') {
    return {
      decision: 'deny',
      reason: 'Edit blocked: .easel/policy.json is malformed. Fix it to re-enable edits.',
    };
  }

  const { policy } = loaded;

  const denied = matchesAny(policy.deny, relativePath);
  if (denied) {
    return { decision: 'deny', reason: `Blocked by policy deny rule "${denied}"` };
  }

  const cap = policy.maxFilesPerEdit;
  if (typeof cap === 'number' && cap > 0 && filesWrittenSoFar + 1 > cap) {
    return {
      decision: 'deny',
      reason: `Blast-radius gate: this edit would touch more than ${cap} file(s)`,
    };
  }

  const confirm = matchesAny(policy.requireConfirm, relativePath);
  if (confirm) {
    return { decision: 'confirm', reason: `Policy requires confirmation for "${confirm}"` };
  }

  return { decision: 'allow' };
}

/**
 * Decide whether Live State Puppeteer is permitted for the given loaded policy.
 *
 * Precedence:
 *  - `malformed` policy → not allowed (the user should fix policy.json first).
 *  - `allowStatePuppeteer === false` → explicitly blocked by the project owner.
 *  - Anything else (unset / `true` / default policy) → allowed (the user toggle
 *    is the opt-in gate; the policy is only a hard-disable mechanism).
 *
 * @returns `{ allowed: true }` or `{ allowed: false, reason: <human message> }`.
 */
export function evaluatePuppeteer(loaded: LoadedPolicy): { allowed: boolean; reason?: string } {
  if (loaded.source === 'malformed') {
    return {
      allowed: false,
      reason:
        'State Puppeteer is unavailable because .easel/policy.json is malformed. ' +
        'Fix the file and try again.',
    };
  }
  if (loaded.policy.allowStatePuppeteer === false) {
    return {
      allowed: false,
      reason:
        'State Puppeteer is disabled by the project policy ' +
        '(.easel/policy.json → allowStatePuppeteer: false).',
    };
  }
  return { allowed: true };
}
