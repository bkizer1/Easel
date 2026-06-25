import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_POLICY,
  loadPolicy,
  matchGlob,
  evaluateWrite,
  type LoadedPolicy,
} from './policy';

function withTempProject(
  policyJson: string | null,
  fn: (dir: string) => void,
): void {
  const dir = mkdtempSync(join(tmpdir(), 'easel-policy-'));
  try {
    if (policyJson !== null) {
      mkdirSync(join(dir, '.easel'), { recursive: true });
      writeFileSync(join(dir, '.easel', 'policy.json'), policyJson);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('matchGlob', () => {
  it('matches dotenv files at any depth via **/.env*', () => {
    expect(matchGlob('**/.env*', '.env')).toBe(true);
    expect(matchGlob('**/.env*', '.env.local')).toBe(true);
    expect(matchGlob('**/.env*', 'config/.env.production')).toBe(true);
    expect(matchGlob('**/.env*', 'src/environment.ts')).toBe(false);
  });

  it('matches lockfiles and nested files via **/*.lock', () => {
    expect(matchGlob('**/*.lock', 'yarn.lock')).toBe(true);
    expect(matchGlob('**/*.lock', 'a/b/Cargo.lock')).toBe(true);
    expect(matchGlob('**/*.lock', 'lockfile.json')).toBe(false);
  });

  it('anchors directory-prefixed patterns like migrations/**', () => {
    expect(matchGlob('migrations/**', 'migrations/001_init.sql')).toBe(true);
    expect(matchGlob('migrations/**', 'migrations/sub/002.sql')).toBe(true);
    expect(matchGlob('migrations/**', 'src/migrations/x.sql')).toBe(false);
  });

  it('dir/** also matches the directory entry itself (gitignore-style)', () => {
    expect(matchGlob('migrations/**', 'migrations')).toBe(true);
    expect(matchGlob('.git/**', '.git')).toBe(true);
    expect(matchGlob('.git/**', '.git/config')).toBe(true);
    expect(matchGlob('.git/**', 'src/git')).toBe(false);
  });

  it('treats runs of 3+ stars as a globstar', () => {
    expect(matchGlob('a***b', 'aXYZb')).toBe(true);
    expect(matchGlob('a***b', 'aX/Yb')).toBe(true); // globstar crosses /
  });

  it('matches a bare filename at any depth (gitignore-style)', () => {
    expect(matchGlob('package.json', 'package.json')).toBe(true);
    expect(matchGlob('package.json', 'packages/ui/package.json')).toBe(true);
    expect(matchGlob('package.json', 'src/app.json')).toBe(false);
  });

  it('matches config files via **/*.config.*', () => {
    expect(matchGlob('**/*.config.*', 'vite.config.ts')).toBe(true);
    expect(matchGlob('**/*.config.*', 'apps/web/tailwind.config.js')).toBe(true);
    expect(matchGlob('**/*.config.*', 'src/config.ts')).toBe(false);
  });

  it('* does not cross directory separators', () => {
    expect(matchGlob('src/*.ts', 'src/index.ts')).toBe(true);
    expect(matchGlob('src/*.ts', 'src/nested/index.ts')).toBe(false);
  });
});

describe('loadPolicy', () => {
  it('returns the secure default when no policy file exists', () => {
    withTempProject(null, (dir) => {
      const loaded = loadPolicy(dir);
      expect(loaded.source).toBe('default');
      expect(loaded.policy).toEqual(DEFAULT_POLICY);
    });
  });

  it('parses a valid policy file', () => {
    const json = JSON.stringify({
      deny: ['secrets/**'],
      requireConfirm: ['package.json'],
      maxFilesPerEdit: 10,
    });
    withTempProject(json, (dir) => {
      const loaded = loadPolicy(dir);
      expect(loaded.source).toBe('file');
      expect(loaded.policy.deny).toEqual(['secrets/**']);
      expect(loaded.policy.requireConfirm).toEqual(['package.json']);
      expect(loaded.policy.maxFilesPerEdit).toBe(10);
    });
  });

  it('drops non-string array entries defensively', () => {
    withTempProject(JSON.stringify({ deny: ['ok', 42, null, ''] }), (dir) => {
      expect(loadPolicy(dir).policy.deny).toEqual(['ok']);
    });
  });

  it('fails safe (malformed) on invalid JSON', () => {
    withTempProject('{ not json', (dir) => {
      expect(loadPolicy(dir).source).toBe('malformed');
    });
  });

  it('fails safe (malformed) on a wrong-typed field', () => {
    withTempProject(JSON.stringify({ deny: 'should-be-an-array' }), (dir) => {
      expect(loadPolicy(dir).source).toBe('malformed');
    });
  });
});

const filePolicy = (policy: LoadedPolicy['policy']): LoadedPolicy => ({
  policy,
  source: 'file',
});

describe('evaluateWrite', () => {
  it('denies a path matching a deny rule (acceptance: .env is blocked)', () => {
    const loaded = filePolicy({ deny: ['**/.env*'], requireConfirm: [] });
    const result = evaluateWrite(loaded, '.env', 0);
    expect(result.decision).toBe('deny');
  });

  it('allows an ordinary source file', () => {
    const loaded = filePolicy({ deny: ['**/.env*'], requireConfirm: [] });
    expect(evaluateWrite(loaded, 'src/App.tsx', 0).decision).toBe('allow');
  });

  it('requires confirmation for a requireConfirm path', () => {
    const loaded = filePolicy({ deny: [], requireConfirm: ['package.json'] });
    expect(evaluateWrite(loaded, 'package.json', 0).decision).toBe('confirm');
  });

  it('prefers deny over confirm when both match', () => {
    const loaded = filePolicy({ deny: ['**/*.json'], requireConfirm: ['package.json'] });
    expect(evaluateWrite(loaded, 'package.json', 0).decision).toBe('deny');
  });

  it('enforces the blast-radius cap (maxFilesPerEdit)', () => {
    const loaded = filePolicy({ deny: [], requireConfirm: [], maxFilesPerEdit: 2 });
    // 0 and 1 already-written files → the 1st and 2nd writes are allowed.
    expect(evaluateWrite(loaded, 'a.ts', 0).decision).toBe('allow');
    expect(evaluateWrite(loaded, 'b.ts', 1).decision).toBe('allow');
    // A 3rd distinct file would exceed the cap of 2.
    expect(evaluateWrite(loaded, 'c.ts', 2).decision).toBe('deny');
  });

  it('treats maxFilesPerEdit <= 0 as unlimited', () => {
    const loaded = filePolicy({ deny: [], requireConfirm: [], maxFilesPerEdit: 0 });
    expect(evaluateWrite(loaded, 'z.ts', 999).decision).toBe('allow');
  });

  it('denies everything when the policy is malformed (fail safe)', () => {
    const loaded: LoadedPolicy = { policy: { deny: [], requireConfirm: [] }, source: 'malformed' };
    expect(evaluateWrite(loaded, 'src/App.tsx', 0).decision).toBe('deny');
  });

  it('default policy blocks .env and lockfiles but allows source', () => {
    const loaded: LoadedPolicy = { policy: DEFAULT_POLICY, source: 'default' };
    expect(evaluateWrite(loaded, '.env', 0).decision).toBe('deny');
    expect(evaluateWrite(loaded, 'pnpm-lock.yaml', 0).decision).toBe('deny');
    expect(evaluateWrite(loaded, 'src/components/Hero.tsx', 0).decision).toBe('allow');
  });

  it('default policy blocks writes anywhere under .git (and .git itself)', () => {
    const loaded: LoadedPolicy = { policy: DEFAULT_POLICY, source: 'default' };
    expect(evaluateWrite(loaded, '.git/config', 0).decision).toBe('deny');
    expect(evaluateWrite(loaded, '.git', 0).decision).toBe('deny');
  });
});
