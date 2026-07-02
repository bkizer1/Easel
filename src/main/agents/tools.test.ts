import { describe, it, expect } from 'vitest';
import {
  parseToolInput,
  executeTool,
  type PuppeteerCapability,
  type ToolExecutorContext,
} from './tools';
import type { FetchMockSpec, StateOverride } from '@shared/puppeteer';

describe('parseToolInput', () => {
  it('parses read_file', () => {
    expect(parseToolInput('read_file', { path: 'src/a.ts' })).toEqual({
      tool: 'read_file',
      input: { path: 'src/a.ts' },
    });
  });

  it('parses write_file', () => {
    expect(parseToolInput('write_file', { path: 'a.ts', content: 'hi' })).toEqual({
      tool: 'write_file',
      input: { path: 'a.ts', content: 'hi' },
    });
  });

  it('parses grep pattern and flags', () => {
    const r = parseToolInput('grep', { pattern: 'foo', is_regex: true });
    expect(r?.tool).toBe('grep');
    if (r?.tool === 'grep') {
      expect(r.input.pattern).toBe('foo');
      expect(r.input.is_regex).toBe(true);
    }
  });

  it('returns null for an unknown tool', () => {
    expect(parseToolInput('does-not-exist', {})).toBeNull();
  });

  // ── set_app_state (Live State Puppeteer, issue #17) ─────────────────────────

  it('parses set_app_state mock_fetch', () => {
    const r = parseToolInput('set_app_state', {
      action: 'mock_fetch',
      url_pattern: '/api/products',
      method: 'GET',
      status: 200,
      json_body: [{ id: 1 }],
    });
    expect(r?.tool).toBe('set_app_state');
    if (r?.tool === 'set_app_state' && r.input.action === 'mock_fetch') {
      expect(r.input.url_pattern).toBe('/api/products');
      expect(r.input.method).toBe('GET');
      expect(r.input.status).toBe(200);
      expect(r.input.json_body).toEqual([{ id: 1 }]);
    } else {
      throw new Error('expected a mock_fetch action');
    }
  });

  it('parses set_app_state set_state', () => {
    const r = parseToolInput('set_app_state', {
      action: 'set_state',
      selector: '[data-easel-component="Cart"]',
      path: ['hooks', '0'],
      value: [],
    });
    expect(r?.tool).toBe('set_app_state');
    if (r?.tool === 'set_app_state' && r.input.action === 'set_state') {
      expect(r.input.selector).toBe('[data-easel-component="Cart"]');
      expect(r.input.path).toEqual(['hooks', '0']);
      expect(r.input.value).toEqual([]);
    } else {
      throw new Error('expected a set_state action');
    }
  });

  it('parses set_app_state clear_mocks', () => {
    expect(parseToolInput('set_app_state', { action: 'clear_mocks' })).toEqual({
      tool: 'set_app_state',
      input: { action: 'clear_mocks' },
    });
  });

  it('returns null for an unknown set_app_state action', () => {
    expect(parseToolInput('set_app_state', { action: 'nope' })).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/*  set_app_state executor                                                     */
/* -------------------------------------------------------------------------- */

function makeCapability(opts: { enabled?: boolean; allowed?: { ok: boolean; reason?: string } } = {}) {
  const calls = { mocks: [] as FetchMockSpec[], overrides: [] as StateOverride[], clearMocks: 0 };
  const cap: PuppeteerCapability = {
    isEnabled: () => opts.enabled ?? true,
    allowed: () => opts.allowed ?? { ok: true },
    setMock: (s) => void calls.mocks.push(s),
    setStateOverride: (o) => void calls.overrides.push(o),
    clearMocks: () => void (calls.clearMocks += 1),
    genId: () => 'test-id',
  };
  return { cap, calls };
}

/** A tool context whose fs/imageProvider are never touched by set_app_state. */
function ctxWith(cap?: PuppeteerCapability): ToolExecutorContext {
  return {
    fs: {} as unknown as ToolExecutorContext['fs'],
    imageProvider: {} as unknown as ToolExecutorContext['imageProvider'],
    nextImageId: () => 'img',
    puppeteer: cap,
  };
}

describe('executeTool set_app_state', () => {
  it('installs a fetch mock when enabled + allowed', async () => {
    const { cap, calls } = makeCapability();
    const res = await executeTool(
      {
        tool: 'set_app_state',
        input: { action: 'mock_fetch', url_pattern: '/api/products', json_body: [{ id: 1 }] },
      },
      ctxWith(cap),
    );
    expect(res.ok).toBe(true);
    expect(calls.mocks).toHaveLength(1);
    expect(calls.mocks[0]).toMatchObject({
      id: 'test-id',
      urlPattern: '/api/products',
      jsonBody: [{ id: 1 }],
    });
  });

  it('applies a state override for set_state', async () => {
    const { cap, calls } = makeCapability();
    const res = await executeTool(
      {
        tool: 'set_app_state',
        input: { action: 'set_state', selector: '.cart', path: ['hooks', '0'], value: [] },
      },
      ctxWith(cap),
    );
    expect(res.ok).toBe(true);
    expect(calls.overrides).toHaveLength(1);
    expect(calls.overrides[0]).toMatchObject({ selector: '.cart', path: ['hooks', '0'], value: [] });
  });

  it('clears mocks for clear_mocks', async () => {
    const { cap, calls } = makeCapability();
    const res = await executeTool(
      { tool: 'set_app_state', input: { action: 'clear_mocks' } },
      ctxWith(cap),
    );
    expect(res.ok).toBe(true);
    expect(calls.clearMocks).toBe(1);
  });

  it('fails when the puppeteer capability is absent', async () => {
    const res = await executeTool(
      { tool: 'set_app_state', input: { action: 'clear_mocks' } },
      ctxWith(undefined),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/unavailable/i);
  });

  it('fails with a helpful message when puppeteer is not enabled', async () => {
    const { cap, calls } = makeCapability({ enabled: false });
    const res = await executeTool(
      { tool: 'set_app_state', input: { action: 'clear_mocks' } },
      ctxWith(cap),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not enabled/i);
    expect(calls.clearMocks).toBe(0);
  });

  it('rejects mock_fetch with an empty url_pattern (would match every request)', async () => {
    const { cap, calls } = makeCapability();
    const res = await executeTool(
      { tool: 'set_app_state', input: { action: 'mock_fetch', url_pattern: '' } },
      ctxWith(cap),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/non-empty url_pattern/i);
    expect(calls.mocks).toHaveLength(0);
  });

  it('rejects mock_fetch with a whitespace-only url_pattern', async () => {
    const { cap, calls } = makeCapability();
    const res = await executeTool(
      { tool: 'set_app_state', input: { action: 'mock_fetch', url_pattern: '   ' } },
      ctxWith(cap),
    );
    expect(res.ok).toBe(false);
    expect(calls.mocks).toHaveLength(0);
  });

  it('rejects mock_fetch with an out-of-range status', async () => {
    const { cap, calls } = makeCapability();
    for (const status of [100, 199, 600, 999, 200.5]) {
      const res = await executeTool(
        { tool: 'set_app_state', input: { action: 'mock_fetch', url_pattern: '/api', status } },
        ctxWith(cap),
      );
      expect(res.ok).toBe(false);
      expect(res.error).toMatch(/between 200 and 599/i);
    }
    expect(calls.mocks).toHaveLength(0);
  });

  it('accepts mock_fetch with an in-range custom status', async () => {
    const { cap, calls } = makeCapability();
    const res = await executeTool(
      { tool: 'set_app_state', input: { action: 'mock_fetch', url_pattern: '/api', status: 503 } },
      ctxWith(cap),
    );
    expect(res.ok).toBe(true);
    expect(calls.mocks).toHaveLength(1);
    expect(calls.mocks[0]).toMatchObject({ urlPattern: '/api', status: 503 });
  });

  it('fails with the policy reason when policy blocks it', async () => {
    const { cap, calls } = makeCapability({ allowed: { ok: false, reason: 'blocked by .easel/policy.json' } });
    const res = await executeTool(
      {
        tool: 'set_app_state',
        input: { action: 'mock_fetch', url_pattern: '/x' },
      },
      ctxWith(cap),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toBe('blocked by .easel/policy.json');
    expect(calls.mocks).toHaveLength(0);
  });
});
