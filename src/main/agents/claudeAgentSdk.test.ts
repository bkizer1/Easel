import { describe, it, expect, afterEach } from 'vitest';
import { buildChildEnv } from './claudeAgentSdk';

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
