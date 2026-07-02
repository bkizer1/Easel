import { describe, it, expect, afterEach } from 'vitest';
import type { AgentBackendContext } from '@shared/agent';
import type { EditRequest } from '@shared/types';
import {
  buildChildEnv,
  buildResponsiveMatrixContext,
  evaluateSdkWrite,
  buildPuppeteerMcpServer,
  buildPrompt,
  PUPPETEER_TOOL_NAME,
} from './claudeAgentSdk';

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

/**
 * Issue #14 (Responsive Matrix edit): the prompt block that tells the model
 * about the staged breakpoint frames. Pure string assembly — no filesystem/SDK.
 */
describe('buildResponsiveMatrixContext', () => {
  it('returns an empty string when there are no frames', () => {
    expect(buildResponsiveMatrixContext([])).toBe('');
  });

  it('lists every frame with its label, width, active marker, and filePath', () => {
    const frames = [
      {
        label: 'Desktop',
        width: 1280,
        active: false,
        filePath: '/tmp/easel-vision/selection-req-1-frame-desktop.png',
      },
      {
        label: 'Tablet',
        width: 768,
        active: true,
        filePath: '/tmp/easel-vision/selection-req-1-frame-tablet.png',
      },
      {
        label: 'Mobile',
        width: 375,
        active: false,
        filePath: '/tmp/easel-vision/selection-req-1-frame-mobile.png',
      },
    ];
    const out = buildResponsiveMatrixContext(frames);

    // Every label, width, and filePath is present.
    for (const f of frames) {
      expect(out).toContain(f.label);
      expect(out).toContain(`${f.width}px`);
      expect(out).toContain(f.filePath);
    }

    // The active frame (Tablet) is marked; the inactive ones are not.
    const tabletLine = out.split('\n').find((l) => l.includes('Tablet · '));
    expect(tabletLine).toMatch(/ACTIVE/);
    const desktopLine = out.split('\n').find((l) => l.includes('Desktop · '));
    expect(desktopLine).not.toMatch(/ACTIVE/);

    // It frames the task as fixing responsive CSS and tells the model to Read.
    expect(out).toMatch(/responsive/i);
    expect(out).toMatch(/Read/);
  });
});

/**
 * Live State Puppeteer (issue #17): `set_app_state` is surfaced to this backend
 * through an in-process MCP server. These tests stand in fakes for the SDK's
 * `tool`/`createSdkMcpServer` and Zod (resolved at runtime in production) and
 * assert the registration shape + that the handler funnels raw args through the
 * SHARED tool contract (parseToolInput → executeTool) and maps the result to the
 * SDK MCP CallToolResult shape. The tool's own guards live in `_execSetAppState`
 * (puppeteer is disabled by default, so the handler returns that guard error),
 * which proves the end-to-end wiring without driving the real SDK.
 */
describe('buildPuppeteerMcpServer (issue #17 SDK MCP wiring)', () => {
  /** Minimal Zod stand-in: each leaf is chainable and identity-returning. */
  const leaf = () => {
    const node = {
      optional: () => node,
      describe: () => node,
    };
    return node;
  };
  const fakeZod = {
    string: leaf,
    number: leaf,
    boolean: leaf,
    unknown: leaf,
    array: leaf,
    enum: leaf,
  } as unknown as Parameters<typeof buildPuppeteerMcpServer>[1];

  type ToolArgs = [string, string, Record<string, unknown>, (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>];
  type ServerArgs = { name: string; version?: string; tools: unknown[] };

  function makeSdk() {
    const calls: { tool?: ToolArgs; server?: ServerArgs } = {};
    const sdk = {
      query: () => (async function* () {})(),
      tool: (...args: ToolArgs) => {
        calls.tool = args;
        return { __tool: args[0] };
      },
      createSdkMcpServer: (opts: ServerArgs) => {
        calls.server = opts;
        return { type: 'sdk', name: opts.name, instance: {} };
      },
    } as unknown as Parameters<typeof buildPuppeteerMcpServer>[0];
    return { sdk, calls };
  }

  const ctx = {
    projectRoot: '/proj',
    fs: {} as AgentBackendContext['fs'],
    imageProvider: {} as AgentBackendContext['imageProvider'],
  } as AgentBackendContext;

  it('registers a single set_app_state tool under the "easel" server', () => {
    const { sdk, calls } = makeSdk();
    buildPuppeteerMcpServer(sdk, fakeZod, ctx);

    expect(calls.tool?.[0]).toBe('set_app_state');
    expect(calls.server?.name).toBe('easel');
    expect(calls.server?.tools).toHaveLength(1);
    // The fully-qualified name the agent must be allow-listed for.
    expect(PUPPETEER_TOOL_NAME).toBe('mcp__easel__set_app_state');
  });

  it('advertises the set_app_state input shape (action + both action field sets)', () => {
    const { sdk, calls } = makeSdk();
    buildPuppeteerMcpServer(sdk, fakeZod, ctx);
    const shape = calls.tool?.[2] ?? {};
    expect(Object.keys(shape)).toEqual(
      expect.arrayContaining(['action', 'url_pattern', 'json_body', 'selector', 'path', 'value']),
    );
  });

  it('handler returns an MCP error result when the input is unparseable', async () => {
    const { sdk, calls } = makeSdk();
    buildPuppeteerMcpServer(sdk, fakeZod, ctx);
    const handler = calls.tool![3];

    const res = await handler({ action: 'nonsense' }, undefined);
    expect(res.isError).toBe(true);
    expect(res.content[0]).toEqual({ type: 'text', text: 'Invalid set_app_state input.' });
  });

  it('handler funnels valid input through the shared contract (puppeteer-disabled guard)', async () => {
    const { sdk, calls } = makeSdk();
    buildPuppeteerMcpServer(sdk, fakeZod, ctx);
    const handler = calls.tool![3];

    // Puppeteer is off by default, so executeTool hits the isEnabled guard in
    // _execSetAppState and returns ok:false — confirming the handler reached the
    // real shared executor and mapped the failure onto the MCP result shape.
    const res = await handler({ action: 'clear_mocks' }, undefined);
    expect(res.isError).toBe(true);
    expect(res.content[0].type).toBe('text');
    expect(res.content[0].text).toMatch(/not enabled/i);
  });
});
