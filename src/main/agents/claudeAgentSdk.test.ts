import { describe, it, expect, afterEach } from 'vitest';
import { buildChildEnv, evaluateSdkWrite, buildPrompt } from './claudeAgentSdk';
import type { EditRequest } from '@shared/types';

/**
 * Regression tests for the "use the Claude Code subscription, not the metered
 * API" guarantee: in inherit mode (authEnv = {}) the child env must NOT carry
 * any ambient Anthropic auth/routing vars, so the bundled CLI falls back to the
 * machine's Claude Code login.
 */
describe('buildChildEnv', () => {
  const ORIGINAL = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, ORIGINAL);
  });

  it('scrubs ambient Anthropic auth/routing vars in inherit mode', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:4000';
    process.env.ANTHROPIC_API_KEY = 'sk-should-not-leak';
    process.env.ANTHROPIC_AUTH_TOKEN = 'tok-should-not-leak';

    const env = buildChildEnv({}); // inherit: no overrides

    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    // PATH must survive so the SDK can still spawn the CLI.
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('applies the mode overrides on top of the scrubbed env', () => {
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:4000';

    const env = buildChildEnv({ ANTHROPIC_API_KEY: 'sk-explicit' });

    expect(env.ANTHROPIC_API_KEY).toBe('sk-explicit'); // explicit api-key mode
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined(); // ambient proxy still removed
  });
});

/**
 * The default backend writes via the SDK's own Edit/Write tools, so policy is
 * enforced in the PreToolUse hook through `evaluateSdkWrite`. These cover the
 * deny/allow mapping + path resolution the hook relies on (the SDK wiring itself
 * is verified manually against a live backend).
 */
describe('evaluateSdkWrite (SDK guardrail hook decision)', () => {
  const root = '/proj';
  const allowGate = async () => ({ allow: true });
  const denyGate = async () => ({ allow: false, reason: 'blocked: .env' });

  it('returns null (allow) for non-file tools', async () => {
    expect(await evaluateSdkWrite('Read', { file_path: '/proj/.env' }, root, denyGate)).toBeNull();
    expect(await evaluateSdkWrite('Grep', { pattern: 'x' }, root, denyGate)).toBeNull();
  });

  it('denies a blocked Write with the gate reason', async () => {
    const decision = await evaluateSdkWrite('Write', { file_path: '/proj/.env' }, root, denyGate);
    expect(decision).toEqual({
      permissionDecision: 'deny',
      permissionDecisionReason: 'blocked: .env',
    });
  });

  it('relativizes an absolute file_path against the project root before checking', async () => {
    const seen: string[] = [];
    await evaluateSdkWrite('Edit', { file_path: '/proj/src/App.tsx' }, root, async (rel) => {
      seen.push(rel);
      return { allow: true };
    });
    expect(seen).toEqual(['src/App.tsx']);
  });

  it('handles MultiEdit (also keyed by file_path) and allows when the gate allows', async () => {
    expect(
      await evaluateSdkWrite('MultiEdit', { file_path: '/proj/src/x.ts', edits: [] }, root, allowGate),
    ).toBeNull();
  });

  it('allows when no path or no gate is present', async () => {
    expect(await evaluateSdkWrite('Write', {}, root, denyGate)).toBeNull();
    expect(await evaluateSdkWrite('Write', { file_path: '/proj/.env' }, root, undefined)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  buildPrompt — refactor brief                                               */
/* -------------------------------------------------------------------------- */

function makeBaseRequest(overrides: Partial<EditRequest> = {}): EditRequest {
  return {
    id: 'req-1',
    instruction: 'Make it look nicer',
    annotations: [],
    targets: [],
    projectRoot: '/proj',
    devServerUrl: 'http://localhost:3000',
    ...overrides,
  };
}

describe('buildPrompt — refactor section', () => {
  it('does NOT include the refactor heading when refactor is absent', () => {
    const prompt = buildPrompt(makeBaseRequest());
    expect(prompt).not.toContain('REFACTOR — EXTRACT A REUSABLE COMPONENT');
  });

  it('includes the refactor heading when refactor is present', () => {
    const request = makeBaseRequest({
      refactor: {
        kind: 'extract-component',
        memberTargetIds: ['t1', 't2'],
        files: ['src/A.tsx', 'src/B.tsx'],
        suggestedName: 'ProductCard',
      },
    });
    const prompt = buildPrompt(request);
    expect(prompt).toContain('REFACTOR — EXTRACT A REUSABLE COMPONENT');
  });

  it('includes the suggested component name in the prompt', () => {
    const request = makeBaseRequest({
      refactor: {
        kind: 'extract-component',
        memberTargetIds: ['t1', 't2'],
        files: ['src/A.tsx', 'src/B.tsx'],
        suggestedName: 'ProductCard',
      },
    });
    const prompt = buildPrompt(request);
    expect(prompt).toContain('ProductCard');
  });

  it('includes both source file paths in the prompt', () => {
    const request = makeBaseRequest({
      refactor: {
        kind: 'extract-component',
        memberTargetIds: ['t1', 't2'],
        files: ['src/A.tsx', 'src/B.tsx'],
        suggestedName: 'ProductCard',
      },
    });
    const prompt = buildPrompt(request);
    expect(prompt).toContain('src/A.tsx');
    expect(prompt).toContain('src/B.tsx');
  });

  it('includes key refactor verbs: reusable component, call site, props', () => {
    const request = makeBaseRequest({
      refactor: {
        kind: 'extract-component',
        memberTargetIds: ['t1', 't2'],
        files: ['src/A.tsx', 'src/B.tsx'],
        suggestedName: 'ProductCard',
      },
    });
    const prompt = buildPrompt(request);
    expect(prompt).toContain('reusable component');
    expect(prompt).toContain('call site');
    expect(prompt).toContain('props');
  });

  it('falls back to a generic name description when suggestedName is omitted', () => {
    const request = makeBaseRequest({
      refactor: {
        kind: 'extract-component',
        memberTargetIds: ['t1'],
        files: ['src/A.tsx', 'src/B.tsx'],
      },
    });
    const prompt = buildPrompt(request);
    expect(prompt).toContain('PascalCase');
  });
});
