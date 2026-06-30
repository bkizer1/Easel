/**
 * Easel — Claude Agent SDK backend.
 *
 * Built on `@anthropic-ai/claude-agent-sdk`.  The SDK manages the full
 * agentic tool-loop (file reads, edits, git awareness) internally.  This
 * backend's job is to:
 *  1. Translate `ClaudeAuthMode` → env vars set for the SDK subprocess/call.
 *  2. Build the initial prompt from the `EditRequest`.
 *  3. Map SDK progress events → `AgentEvent` union.
 *  4. Call `ctx.createCheckpoint` after edits land.
 *  5. Honour `ctx.signal` for cancellation.
 *
 * Auth modes (from ClaudeAgentSdkConfig.authMode):
 *  - inherit (default): NO credential env vars set, AND any ambient Anthropic
 *    auth/routing vars (ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL, …) are scrubbed
 *    from the child env, so the SDK uses the existing machine credential
 *    (Claude Code login → Pro/Max plan). No extra API spend.
 *  - api-key:   set ANTHROPIC_API_KEY from resolved secret.
 *  - bedrock:   set CLAUDE_CODE_USE_BEDROCK=1 (+ AWS_REGION / AWS_PROFILE).
 *  - vertex:    set CLAUDE_CODE_USE_VERTEX=1 (+ ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION).
 *  - gateway:   set ANTHROPIC_BASE_URL (+ ANTHROPIC_AUTH_TOKEN from secret).
 *
 * NOTE: env vars are set only in the options passed to the SDK call; Easel's
 * own `process.env` is NEVER mutated permanently.
 */

import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import type { AgentBackend, AgentBackendContext, AgentCapabilities, ProjectFs, ValidateContext } from '@shared/agent';
import type { AgentEvent, AppSettings, EditRequest, FileDiff } from '@shared/types';
import { createLogger } from '@main/logger';
import { buildPuppeteerCapability } from '@main/puppeteer';
import { parseToolInput, executeTool } from '@main/agents/tools';

/* -------------------------------------------------------------------------- */
/*  Claude Agent SDK resolution — NOT bundled; uses the user's own install     */
/* -------------------------------------------------------------------------- */

/**
 * The package specifier is held in a variable so the bundler can't statically
 * resolve (and inline) it — Easel deliberately does not ship the proprietary
 * Claude Agent SDK. It's resolved at runtime instead.
 */
const SDK_PKG = '@anthropic-ai/claude-agent-sdk';

/** Shown when the SDK can't be found — Easel doesn't bundle Claude Code. */
const CLAUDE_NOT_INSTALLED =
  "Claude Code isn't installed. Easel uses your own Claude Code rather than bundling it. " +
  'Install it with:  npm install -g @anthropic-ai/claude-agent-sdk  — then sign in by running ' +
  '`claude` in a terminal and restart Easel. (Or switch to the API key / local model backend in Settings.)';

type ClaudeQuery = (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>;

/**
 * Minimal local surface of the SDK's in-process MCP API (issue #17). The SDK is
 * resolved at runtime (never bundled — see resolveClaudeSdk), so we describe only
 * the shapes we call rather than importing the SDK's own generics. Verified
 * against @anthropic-ai/claude-agent-sdk@0.3.190:
 *
 *   tool(name, description, inputSchema, handler, extras?) → SdkMcpToolDefinition
 *     where `inputSchema` is a Zod *raw shape* (Record<string, ZodType>) — at
 *     runtime createSdkMcpServer checks each value has a `_zod` marker (Zod v4),
 *     then hands the shape to MCP's registerTool for JSON-Schema generation.
 *   createSdkMcpServer({ name, version?, tools }) → McpSdkServerConfigWithInstance
 *     (a non-serializable { type: 'sdk', name, instance } passed via mcpServers).
 *
 * The handler returns an MCP CallToolResult: `{ content: [{ type:'text', text }],
 * isError? }`.
 */
type SdkMcpToolHandler = (
  args: Record<string, unknown>,
  extra: unknown,
) => Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }>;

type SdkToolFn = (
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  handler: SdkMcpToolHandler,
) => unknown;

type SdkCreateMcpServerFn = (options: {
  name: string;
  version?: string;
  tools: unknown[];
}) => unknown;

/** The runtime SDK surface this backend uses (resolved, never statically imported). */
interface ClaudeSdk {
  query: ClaudeQuery;
  tool: SdkToolFn;
  createSdkMcpServer: SdkCreateMcpServerFn;
}

/**
 * Minimal slice of Zod's builder API needed to describe the `set_app_state`
 * input shape. Resolved at runtime alongside the SDK (the SDK depends on Zod, so
 * it is reachable wherever the SDK is). We avoid a static `import 'zod'` for the
 * same reason we don't statically import the SDK: Easel does not ship either, and
 * a packaged build may only have the user's global Claude Code install.
 */
interface ZodBuilder {
  string(): ZodLeaf;
  number(): ZodLeaf;
  boolean(): ZodLeaf;
  unknown(): ZodLeaf;
  array(item: unknown): ZodLeaf;
  enum(values: readonly string[]): ZodLeaf;
}

/** A single Zod schema node — only the chained methods we call are modelled. */
interface ZodLeaf {
  optional(): ZodLeaf;
  describe(text: string): ZodLeaf;
}

/** Run a command and return its first stdout line, or null on failure. */
function firstLine(cmd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.toString().split(/\r?\n/)[0]?.trim();
      resolve(line || null);
    });
  });
}

/** Locate the user's `claude` CLI — PATH first, then the usual install dirs. */
async function whichClaude(): Promise<string | null> {
  const viaPath = await firstLine(process.platform === 'win32' ? 'where' : 'which', ['claude']);
  if (viaPath && existsSync(viaPath)) return viaPath;
  const home = os.homedir();
  const guesses = [
    path.join(home, '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
    path.join(home, '.claude/local/claude'),
  ];
  return guesses.find((g) => existsSync(g)) ?? null;
}

/**
 * Candidate global `node_modules` roots to search for the SDK. A GUI-launched
 * app often has a stripped PATH, so we go well beyond `npm root -g`: common
 * global prefixes and the dir tree around the user's `claude` binary (covers
 * nvm/fnm/volta/Homebrew installs).
 */
async function candidateGlobalRoots(): Promise<string[]> {
  const home = os.homedir();
  const roots: string[] = [];

  const npmRoot = await firstLine('npm', ['root', '-g']);
  if (npmRoot) roots.push(npmRoot);

  roots.push(
    '/usr/local/lib/node_modules',
    '/opt/homebrew/lib/node_modules',
    path.join(home, '.npm-global/lib/node_modules'),
    path.join(home, '.local/lib/node_modules'),
    path.join(home, '.config/yarn/global/node_modules'),
    path.join(home, '.bun/install/global/node_modules'),
  );

  const claudeBin = await whichClaude();
  if (claudeBin) {
    // <prefix>/bin/claude → look under <prefix>/lib/node_modules and <prefix>/node_modules.
    const prefix = path.dirname(path.dirname(claudeBin));
    roots.push(path.join(prefix, 'lib/node_modules'), path.join(prefix, 'node_modules'));
  }

  return [...new Set(roots)].filter((r) => existsSync(r));
}

/**
 * Resolve the Claude Agent SDK without bundling it. Tries normal module
 * resolution first (present when running Easel from source / `npm install`),
 * then the user's GLOBAL install across common locations (for packaged builds).
 * Returns null when Claude Code isn't installed anywhere we can find it.
 *
 * Exposes `query` plus the in-process MCP API (`tool`, `createSdkMcpServer`) used
 * to surface Easel's `set_app_state` tool to this backend (issue #17).
 */
async function resolveClaudeSdk(): Promise<ClaudeSdk | null> {
  try {
    return (await import(SDK_PKG)) as unknown as ClaudeSdk;
  } catch {
    /* not resolvable locally — search the user's global installs */
  }
  for (const root of await candidateGlobalRoots()) {
    try {
      const req = createRequire(path.join(root, '_resolve.js'));
      const entry = req.resolve(SDK_PKG);
      return (await import(pathToFileURL(entry).href)) as unknown as ClaudeSdk;
    } catch {
      /* not here — try the next root */
    }
  }
  return null;
}

/**
 * Resolve Zod's runtime builder. Tries the host's own resolution first, then a
 * `createRequire` rooted at the resolved SDK directory (the SDK depends on Zod,
 * so Zod is reachable from there even when Easel itself doesn't ship it). The v4
 * entrypoint is preferred because the SDK's `createSdkMcpServer` recognises a
 * schema by its v4 `_zod` marker; the default entry is a fine fallback (the
 * installed Zod is v4 across both). Returns null when Zod can't be found.
 */
async function resolveZod(): Promise<ZodBuilder | null> {
  for (const spec of ['zod/v4', 'zod']) {
    try {
      const mod = (await import(spec)) as { z?: ZodBuilder } & ZodBuilder;
      return (mod.z ?? mod) as ZodBuilder;
    } catch {
      /* try the next entrypoint / resolution strategy */
    }
  }
  for (const root of await candidateGlobalRoots()) {
    const req = createRequire(path.join(root, '_resolve.js'));
    for (const spec of ['zod/v4', 'zod']) {
      try {
        const mod = (await import(pathToFileURL(req.resolve(spec)).href)) as {
          z?: ZodBuilder;
        } & ZodBuilder;
        return (mod.z ?? mod) as ZodBuilder;
      } catch {
        /* not here — try the next entry / root */
      }
    }
  }
  return null;
}

const log = createLogger('backend:claude-agent-sdk');

/* -------------------------------------------------------------------------- */
/*  Diff synthesis from the SDK's Edit / Write / MultiEdit tool calls          */
/* -------------------------------------------------------------------------- */

function linesOf(s: string): string[] {
  return s.length ? s.split('\n') : [];
}

/** Build a unified FileDiff from an old → new string replacement. */
function buildEditDiff(
  relPath: string,
  oldStr: string,
  newStr: string,
  changeType: FileDiff['changeType'] = 'modified',
): FileDiff {
  const oldLines = linesOf(oldStr);
  const newLines = linesOf(newStr);
  const body = [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)].join('\n');
  const unifiedDiff = `--- a/${relPath}\n+++ b/${relPath}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${body}`;
  return { filePath: relPath, changeType, unifiedDiff, additions: newLines.length, deletions: oldLines.length };
}

/** Append b's hunks onto a (same file) so repeated edits accumulate visibly. */
function mergeFileDiff(a: FileDiff, b: FileDiff): FileDiff {
  const bHunks = b.unifiedDiff.split('\n').slice(2).join('\n'); // drop the --- / +++ header
  return {
    ...a,
    unifiedDiff: `${a.unifiedDiff}\n${bHunks}`,
    additions: a.additions + b.additions,
    deletions: a.deletions + b.deletions,
  };
}

/** Turn an Edit / MultiEdit / Write tool-use input into FileDiff(s). */
async function toolUseToDiffs(
  toolName: string,
  input: Record<string, unknown>,
  projectRoot: string,
  fs: ProjectFs,
): Promise<FileDiff[]> {
  const rawPath = String(input['file_path'] ?? input['path'] ?? '');
  if (!rawPath) return [];
  const rel = rawPath.startsWith(projectRoot) ? rawPath.slice(projectRoot.length).replace(/^\/+/, '') : rawPath;

  if (toolName === 'Edit') {
    return [buildEditDiff(rel, String(input['old_string'] ?? ''), String(input['new_string'] ?? ''))];
  }
  if (toolName === 'MultiEdit') {
    const edits = Array.isArray(input['edits']) ? (input['edits'] as Array<Record<string, unknown>>) : [];
    let combined: FileDiff | null = null;
    for (const e of edits) {
      const d = buildEditDiff(rel, String(e['old_string'] ?? ''), String(e['new_string'] ?? ''));
      combined = combined ? mergeFileDiff(combined, d) : d;
    }
    return combined ? [combined] : [];
  }
  if (toolName === 'Write') {
    const content = String(input['content'] ?? '');
    try {
      // At tool-use time the write usually hasn't hit disk yet, so this diffs
      // the on-disk (old) content against the new content.
      const d = await fs.diff(rel, content);
      if (d.unifiedDiff) return [d];
    } catch {
      /* fall through to all-additions */
    }
    return [buildEditDiff(rel, '', content, 'created')];
  }
  return [];
}

/** Decode a data-URL screenshot to a temp file the agent can Read (for vision). */
async function prepareScreenshot(
  dataUrl: string,
  requestId: string,
): Promise<{ filePath: string; dir: string } | null> {
  const m = /^data:image\/([a-zA-Z]+);base64,(.+)$/s.exec(dataUrl);
  if (!m) return null;
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
  const dir = path.join(os.tmpdir(), 'easel-vision');
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `selection-${requestId}.${ext}`);
  await writeFile(filePath, Buffer.from(m[2], 'base64'));
  return { filePath, dir };
}

const CAPABILITIES: AgentCapabilities = {
  streamsThinking: true,
  streamsToolCalls: true,
  supportsVision: true,
  editsFilesDirectly: true,
  gitAware: true,
  supportsImageTool: true,
  cancellable: true,
  agenticReliability: 'high',
};

/**
 * Env keys that select or route Claude authentication. These are scrubbed from
 * the inherited environment before per-mode overrides are applied, so the chosen
 * authMode is deterministic. Critically, this makes `inherit` fall back to the
 * Claude Code login (subscription) instead of silently using a stray
 * ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL the user has exported in their shell —
 * which would route through (and bill) the metered API or a proxy.
 */
const CLAUDE_AUTH_ENV_KEYS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
];

/**
 * Compose the COMPLETE child environment for the SDK call: the inherited
 * environment (for PATH / HOME / keychain access) with every Claude
 * auth-routing var removed, then the chosen mode's overrides layered on top.
 */
export function buildChildEnv(authEnv: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || CLAUDE_AUTH_ENV_KEYS.includes(k)) continue;
    env[k] = v;
  }
  return { ...env, ...authEnv };
}

/**
 * Build the additional environment variables for the SDK call based on the
 * configured `authMode`.  Returns only the keys to set — the SDK call receives
 * these merged over a scrubbed environment (never raw `process.env`).
 */
function buildAuthEnv(
  settings: AppSettings,
  secrets: Readonly<Record<string, string>>,
): Record<string, string> {
  const cfg = settings.backends['claude-agent-sdk'];
  const env: Record<string, string> = {};

  switch (cfg.authMode) {
    case 'inherit':
      // Explicitly set nothing; let the SDK use whatever credential is already
      // on the machine (Claude Code login → Pro/Max plan).
      break;

    case 'setup-token': {
      const token = secrets['claude-oauth-token'] ?? '';
      if (!token) {
        throw new Error(
          'Setup-token auth requires a Claude setup token. Run `claude setup-token` and paste it in Settings.',
        );
      }
      env['CLAUDE_CODE_OAUTH_TOKEN'] = token;
      break;
    }

    case 'api-key': {
      const key = secrets['anthropic'] ?? '';
      if (!key) throw new Error('api-key auth mode requires the Anthropic API key to be configured in Settings');
      env['ANTHROPIC_API_KEY'] = key;
      break;
    }

    case 'bedrock': {
      env['CLAUDE_CODE_USE_BEDROCK'] = '1';
      if (cfg.bedrock?.region) env['AWS_REGION'] = cfg.bedrock.region;
      if (cfg.bedrock?.profile) env['AWS_PROFILE'] = cfg.bedrock.profile;
      break;
    }

    case 'vertex': {
      env['CLAUDE_CODE_USE_VERTEX'] = '1';
      if (cfg.vertex?.project) env['ANTHROPIC_VERTEX_PROJECT_ID'] = cfg.vertex.project;
      if (cfg.vertex?.region) env['CLOUD_ML_REGION'] = cfg.vertex.region;
      break;
    }

    case 'gateway': {
      const token = secrets['gateway-token'] ?? '';
      if (!token) throw new Error('gateway auth mode requires the gateway token to be configured in Settings');
      if (!cfg.baseUrl) throw new Error('gateway auth mode requires a base URL in Settings');
      env['ANTHROPIC_BASE_URL'] = cfg.baseUrl;
      env['ANTHROPIC_AUTH_TOKEN'] = token;
      break;
    }
  }

  return env;
}

/**
 * Build the natural-language prompt the SDK agent receives as its task
 * description.  This is combined with the source-location context the SDK
 * discovers autonomously through its file tools.
 */
function buildPrompt(request: EditRequest): string {
  const lines: string[] = [
    `You are Easel, an agentic web development assistant editing source files in a live project.`,
    ``,
    `PROJECT ROOT: ${request.projectRoot}`,
    `DEV SERVER: ${request.devServerUrl}`,
    ``,
    `USER INSTRUCTION: ${request.instruction}`,
  ];

  if (request.targets.length > 0) {
    lines.push('', 'ELEMENT TARGETS (DOM elements the user selected):');
    for (const t of request.targets) {
      lines.push(`  - <${t.tagName}> selector: ${t.selector}`);
      if (t.dataEaselSource) {
        lines.push(`    source: ${t.dataEaselSource.filePath}:${t.dataEaselSource.line}:${t.dataEaselSource.column}`);
      }
      if (t.textSnippet) lines.push(`    text: "${t.textSnippet.slice(0, 120)}"`);
      lines.push(`    confidence: ${t.confidence}`);
    }
  }

  if (request.annotations.length > 0) {
    lines.push('', 'FREEFORM ANNOTATIONS (geometry the user drew on the preview):');
    for (const a of request.annotations) {
      lines.push(`  - ${a.kind} at (${Math.round(a.boundingBox.x)},${Math.round(a.boundingBox.y)}) ${Math.round(a.boundingBox.width)}×${Math.round(a.boundingBox.height)}`);
      if (a.label) lines.push(`    label: "${a.label}"`);
    }
  }

  lines.push(
    '',
    'INSTRUCTIONS:',
    '1. Locate the relevant source file(s) using the element targets above.',
    '2. Make the minimal edit that satisfies the user instruction.',
    '3. Edit only files inside the project root.',
    '4. Do not modify package.json, lock files, or git history.',
    '5. Return a brief explanation of what you changed.',
  );

  return lines.join('\n');
}

/**
 * Decide whether an SDK file-tool call (`Edit`/`Write`/`MultiEdit`) is permitted
 * by the project's guardrail policy, via the host's shared write gate. Extracted
 * from the PreToolUse hook so the deny/allow + path-resolution logic is
 * unit-testable without driving the real SDK.
 *
 * Returns a PreToolUse deny payload (`permissionDecision: 'deny'` + reason) when
 * blocked, or `null` to allow (non-file tools and unknown paths always allow).
 */
export async function evaluateSdkWrite(
  toolName: string,
  toolInput: Record<string, unknown>,
  projectRoot: string,
  checkWrite: ((rel: string) => Promise<{ allow: boolean; reason?: string }>) | undefined,
): Promise<{ permissionDecision: 'deny'; permissionDecisionReason: string } | null> {
  if (!/^(Edit|MultiEdit|Write)$/.test(toolName) || !checkWrite) return null;

  const rawPath = String(toolInput['file_path'] ?? toolInput['path'] ?? '');
  if (!rawPath) return null;

  // Normalize to forward-slash, project-relative form so the path handed to the
  // gate (and shown in deny messages) is consistent across platforms — on
  // Windows path.relative() yields backslashes.
  const rel = (path.isAbsolute(rawPath) ? path.relative(projectRoot, rawPath) : rawPath).replace(
    /\\/g,
    '/',
  );
  const verdict = await checkWrite(rel);
  if (verdict.allow) return null;

  return {
    permissionDecision: 'deny',
    permissionDecisionReason:
      verdict.reason ?? `Blocked by Easel policy (.easel/policy.json): ${rel}`,
  };
}

/* -------------------------------------------------------------------------- */
/*  Live State Puppeteer — in-process MCP server (issue #17)                    */
/* -------------------------------------------------------------------------- */

/**
 * Server name for the in-process MCP server that hosts `set_app_state`. The SDK
 * namespaces MCP tools as `mcp__<serverName>__<toolName>`, so the agent sees and
 * must be allow-listed for {@link PUPPETEER_TOOL_NAME}.
 */
const PUPPETEER_MCP_SERVER = 'easel';

/** Fully-qualified tool name the SDK exposes for the puppeteer tool. */
export const PUPPETEER_TOOL_NAME = `mcp__${PUPPETEER_MCP_SERVER}__set_app_state`;

/**
 * Build the Zod *raw shape* for `set_app_state`, mirroring the JSON `input_schema`
 * in `TOOL_DEFINITIONS` (src/main/agents/tools.ts). The actual coercion/validation
 * lives in `parseToolInput`; this shape exists so the SDK can advertise the tool's
 * parameters to the model. Only `action` is required — every other field belongs
 * to one of the three discriminated actions.
 */
function setAppStateInputShape(z: ZodBuilder): Record<string, unknown> {
  return {
    action: z
      .enum(['mock_fetch', 'set_state', 'clear_mocks'])
      .describe('Which puppeteer operation to perform.'),
    // ── mock_fetch fields ──────────────────────────────────────────────────
    url_pattern: z
      .string()
      .optional()
      .describe('(mock_fetch) URL pattern to intercept, matched per `match`.'),
    method: z
      .string()
      .optional()
      .describe('(mock_fetch) HTTP method to match, case-insensitive. Omit to match any.'),
    match: z
      .enum(['substring', 'glob', 'exact'])
      .optional()
      .describe('(mock_fetch) How to interpret url_pattern. Default: "substring".'),
    status: z.number().optional().describe('(mock_fetch) HTTP response status code. Default: 200.'),
    json_body: z
      .unknown()
      .optional()
      .describe('(mock_fetch) JSON response body. Sets content-type: application/json.'),
    text_body: z
      .string()
      .optional()
      .describe('(mock_fetch) Raw text response body (used when json_body is absent).'),
    delay_ms: z
      .number()
      .optional()
      .describe('(mock_fetch) Artificial response latency in milliseconds.'),
    once: z.boolean().optional().describe('(mock_fetch) Fire this mock once then auto-remove it.'),
    label: z
      .string()
      .optional()
      .describe('Human-readable label shown in the Easel panel (e.g. "empty cart").'),
    // ── set_state fields ───────────────────────────────────────────────────
    selector: z
      .string()
      .optional()
      .describe('(set_state) Robust CSS selector for the target component element.'),
    path: z
      .array(z.string())
      .optional()
      .describe('(set_state) Machine path into the component\'s state, e.g. ["state","items"].'),
    value: z.unknown().optional().describe('(set_state) The JSON value to write.'),
  };
}

/**
 * Create the in-process MCP server that exposes Easel's `set_app_state` tool to
 * the Claude Agent SDK backend (issue #17). This is the third backend to surface
 * the tool — `anthropic-api` and `local-openai` call `executeTool` directly; the
 * SDK owns its own tool loop, so we register the tool through its in-process MCP
 * transport instead.
 *
 * The handler is a thin adapter onto the SHARED tool contract: it funnels the raw
 * SDK args through `parseToolInput('set_app_state', …)` (the same parser the other
 * backends use) and runs `executeTool` with a fresh puppeteer capability. The
 * tool's own guards (`isEnabled`/`allowed`/policy) live in `_execSetAppState` and
 * are untouched here. Returns the SDK MCP server config (passed via `mcpServers`)
 * or null when Zod can't be resolved (the tool is then simply not offered).
 */
export function buildPuppeteerMcpServer(
  sdk: ClaudeSdk,
  z: ZodBuilder,
  ctx: AgentBackendContext,
): unknown {
  const setAppState = sdk.tool(
    'set_app_state',
    'Drive the RUNNING app into a hard-to-reach state WITHOUT editing source code. ' +
      'Ephemeral — a reload restores reality. Actions: "mock_fetch" (intercept a fetch/XHR ' +
      'URL and return a canned response), "set_state" (write a JSON value into a running ' +
      'component\'s framework state), "clear_mocks" (remove all active fetch mocks). ' +
      'REQUIRES the user to have enabled the State Puppeteer toggle in Easel first.',
    setAppStateInputShape(z),
    async (args) => {
      const parsed = parseToolInput('set_app_state', args);
      if (!parsed) {
        return {
          content: [{ type: 'text' as const, text: 'Invalid set_app_state input.' }],
          isError: true,
        };
      }
      const result = await executeTool(parsed, {
        fs: ctx.fs,
        imageProvider: ctx.imageProvider,
        nextImageId: () => crypto.randomUUID(),
        puppeteer: buildPuppeteerCapability(ctx.projectRoot),
      });
      return {
        content: [
          { type: 'text' as const, text: result.ok ? result.output : (result.error ?? 'failed') },
        ],
        isError: !result.ok,
      };
    },
  );

  return sdk.createSdkMcpServer({
    name: PUPPETEER_MCP_SERVER,
    version: '1.0.0',
    tools: [setAppState],
  });
}

export function claudeAgentSdkBackend(_settings: AppSettings): AgentBackend {
  return {
    id: 'claude-agent-sdk',
    name: 'Claude Agent SDK',
    capabilities: CAPABILITIES,

    async *editStream(request: EditRequest, ctx: AgentBackendContext): AsyncIterable<AgentEvent> {
      const { signal, settings, secrets } = ctx;

      if (signal.aborted) {
        yield { type: 'error', requestId: request.id, message: 'Cancelled before start', code: 'cancelled', recoverable: false };
        return;
      }

      let authEnv: Record<string, string>;
      try {
        authEnv = buildAuthEnv(settings, secrets);
      } catch (err) {
        yield { type: 'error', requestId: request.id, message: String(err), code: 'auth', recoverable: true };
        return;
      }

      let prompt = buildPrompt(request);
      let screenshot: { filePath: string; dir: string } | null = null;
      if (request.screenshotDataUrl) {
        try {
          screenshot = await prepareScreenshot(request.screenshotDataUrl, request.id);
        } catch (err) {
          ctx.logger.warn('Could not stage screenshot for vision', { err: String(err) });
        }
      }
      if (screenshot) {
        prompt +=
          `\n\nVISUAL CONTEXT: a screenshot of the region the user marked on the live page is saved at:\n  ${screenshot.filePath}\n` +
          `Use the Read tool to view it — it shows what they're pointing at and the surrounding layout. Let it guide your edit.`;
      }

      // Surface which ambient auth vars we removed, so it's verifiable from the
      // logs that `inherit` is using the subscription login (not a proxy/key).
      const scrubbedAmbientAuth = CLAUDE_AUTH_ENV_KEYS.filter(
        (k) => process.env[k] !== undefined && !(k in authEnv),
      );
      log.info('Starting Claude Agent SDK edit', {
        requestId: request.id,
        authMode: settings.backends['claude-agent-sdk'].authMode,
        model: settings.model,
        appliedAuthKeys: Object.keys(authEnv),
        scrubbedAmbientAuth,
      });

      yield { type: 'thinking', requestId: request.id, text: 'Analysing your request...' };

      // Resolve the SDK at runtime — Easel does NOT bundle it (it's proprietary).
      // Present when running from source; for packaged builds it comes from the
      // user's own global Claude Code install. See resolveClaudeSdk.
      const sdk = await resolveClaudeSdk();
      if (!sdk) {
        yield {
          type: 'error',
          requestId: request.id,
          message: CLAUDE_NOT_INSTALLED,
          code: 'sdk-missing',
          recoverable: true,
        };
        return;
      }

      // Live State Puppeteer (issue #17): expose `set_app_state` to this backend
      // via an in-process MCP server. The SDK owns its own tool loop, so unlike
      // the hand-built backends (which call executeTool directly) we register the
      // tool through the SDK's MCP transport. Resolved Zod is required to describe
      // the tool's schema; if it's missing we simply don't offer the tool rather
      // than failing the edit (file-editing — the core flow — still works).
      const zod = await resolveZod();
      const puppeteerServer = zod ? buildPuppeteerMcpServer(sdk, zod, ctx) : null;
      if (!puppeteerServer) {
        log.warn('Skipping set_app_state MCP tool — Zod could not be resolved', {
          requestId: request.id,
        });
      }

      // Build options.  The SDK accepts `env` to override the subprocess env
      // (not `process.env`), and `allowedDirectories` to sandbox file access.
      // Bridge our AbortSignal to the SDK's AbortController option.
      const abortController = new AbortController();
      if (signal.aborted) abortController.abort();
      else signal.addEventListener('abort', () => abortController.abort(), { once: true });

      const sdkOptions: Record<string, unknown> = {
        model: settings.model,
        maxTurns: 20,
        cwd: request.projectRoot,
        additionalDirectories: screenshot ? [request.projectRoot, screenshot.dir] : [request.projectRoot],
        // Auto-apply file edits (no interactive permission prompt is possible
        // here) and restrict to safe file tools so the agent can't hang on a
        // Bash permission request.  set_app_state is intentionally added when
        // available — its name is allow-listed below and the PreToolUse hook only
        // gates Edit/Write/MultiEdit, so the puppeteer tool is never blocked.
        permissionMode: 'acceptEdits',
        allowedTools: puppeteerServer
          ? ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep', PUPPETEER_TOOL_NAME]
          : ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep'],
        // In-process MCP server hosting set_app_state (issue #17). Keys are server
        // names; the SDK exposes its tools as `mcp__<serverName>__<toolName>`
        // (here PUPPETEER_TOOL_NAME). Omitted entirely when Zod is unavailable.
        ...(puppeteerServer ? { mcpServers: { [PUPPETEER_MCP_SERVER]: puppeteerServer } } : {}),
        // The SDK uses `env` as the COMPLETE child environment — it does NOT
        // merge with process.env (passing {} would wipe PATH → `spawn node
        // ENOENT`). buildChildEnv preserves the inherited PATH/HOME/keychain
        // access but scrubs ambient Anthropic auth/routing vars, so `inherit`
        // uses the Claude Code subscription login rather than a stray
        // ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL. See CLAUDE_AUTH_ENV_KEYS.
        env: buildChildEnv(authEnv),
        // Guardrail enforcement: the SDK writes via its own Edit/Write tools
        // (not ProjectFs), so this is the chokepoint where `.easel/policy.json`
        // is applied for this backend, funnelling through the host's shared
        // write gate (ctx.checkWrite) so deny/blast-radius/requireConfirm match
        // the hand-built backends exactly.
        //
        // We use a PreToolUse HOOK rather than `canUseTool`: with `Edit`/`Write`
        // in `allowedTools` and `permissionMode: 'acceptEdits'`, the permission
        // is auto-resolved as "allow" before the `canUseTool` "ask" path, so
        // canUseTool never fires for edits. A PreToolUse hook's deny runs
        // regardless of permission mode (it bypasses canUseTool). The generous
        // timeout lets a `requireConfirm` prompt wait for the user.
        hooks: {
          PreToolUse: [
            {
              timeout: 3600,
              hooks: [
                async (hookInput: unknown) => {
                  const inp = hookInput as {
                    tool_name?: string;
                    tool_input?: Record<string, unknown>;
                  };
                  const deny = await evaluateSdkWrite(
                    String(inp.tool_name ?? ''),
                    (inp.tool_input ?? {}) as Record<string, unknown>,
                    request.projectRoot,
                    ctx.checkWrite,
                  );
                  if (deny) {
                    return {
                      hookSpecificOutput: { hookEventName: 'PreToolUse', ...deny },
                    };
                  }
                  return {};
                },
              ],
            },
          ],
        },
        abortController,
      };

      const diffsByFile = new Map<string, FileDiff>();
      let resultText = '';

      try {
        // The SDK exposes `query({ prompt, options })` returning an async
        // iterable of SDKMessages; we normalise them into our AgentEvent union.
        const runner = sdk.query({ prompt, options: sdkOptions });

        for await (const rawEvent of runner as AsyncIterable<unknown>) {
          if (signal.aborted) break;

          const ev = rawEvent as Record<string, unknown>;
          const evType = ev['type'];

          // Assistant turn: { type: 'assistant', message: { content: [...] } }
          if (evType === 'assistant') {
            const message = ev['message'] as { content?: unknown } | undefined;
            const blocks = Array.isArray(message?.content)
              ? (message!.content as Array<Record<string, unknown>>)
              : [];
            for (const block of blocks) {
              if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) {
                yield { type: 'message', requestId: request.id, text: block['text'] as string };
              } else if (block['type'] === 'tool_use') {
                const toolName = String(block['name'] ?? 'tool');
                yield {
                  type: 'tool-call',
                  requestId: request.id,
                  tool: toolName,
                  input: block['input'] ?? {},
                  callId: String(block['id'] ?? crypto.randomUUID()),
                };
                const input = (block['input'] ?? {}) as Record<string, unknown>;
                if (/^(Edit|MultiEdit|Write)$/.test(toolName)) {
                  const fileDiffs = await toolUseToDiffs(toolName, input, request.projectRoot, ctx.fs);
                  for (const d of fileDiffs) {
                    const merged = diffsByFile.has(d.filePath)
                      ? mergeFileDiff(diffsByFile.get(d.filePath)!, d)
                      : d;
                    diffsByFile.set(d.filePath, merged);
                    yield { type: 'file-edit', requestId: request.id, diff: merged };
                  }
                }
              }
            }
            continue;
          }

          // Terminal result: { type: 'result', subtype, result?: string }
          if (evType === 'result') {
            if (typeof ev['result'] === 'string') resultText = ev['result'] as string;
            const subtype = ev['subtype'];
            if (typeof subtype === 'string' && subtype.startsWith('error')) {
              yield {
                type: 'error',
                requestId: request.id,
                message: resultText || `Claude Code ended with: ${subtype}`,
                code: 'agent-error',
                recoverable: true,
              };
              return;
            }
            continue;
          }
          // Other message kinds (system / user / stream_event / status) are ignored.
        }
      } catch (err) {
        const msg = String(err);
        if (signal.aborted || msg.includes('abort') || msg.includes('cancel')) {
          yield { type: 'error', requestId: request.id, message: 'Edit cancelled', code: 'cancelled', recoverable: false };
          return;
        }
        yield { type: 'error', requestId: request.id, message: msg, recoverable: false };
        return;
      }

      if (screenshot) {
        await rm(screenshot.filePath, { force: true }).catch(() => undefined);
      }

      if (signal.aborted) {
        yield { type: 'error', requestId: request.id, message: 'Edit cancelled', code: 'cancelled', recoverable: false };
        return;
      }

      // Create a checkpoint and emit the terminal done event.
      let checkpoint: import('@shared/types').Checkpoint | undefined;
      try {
        checkpoint = await ctx.createCheckpoint(request.instruction.slice(0, 72), request.id);
        yield { type: 'checkpoint', requestId: request.id, checkpoint };
      } catch (err) {
        ctx.logger.warn('Checkpoint creation failed', { err: String(err) });
        yield { type: 'warning', requestId: request.id, message: `Checkpoint failed: ${String(err)}`, code: 'checkpoint-failed' };
      }

      const diffs = Array.from(diffsByFile.values());
      const changed = diffs.length || checkpoint?.changedFiles?.length || 0;
      const fileWord = changed === 1 ? 'file' : 'files';
      const summary =
        resultText.trim() ||
        (changed > 0 ? `Edit applied — ${changed} ${fileWord} changed.` : 'Done. No file changes were detected.');

      yield {
        type: 'done',
        requestId: request.id,
        summary,
        diffs,
      };
    },

    cancel(requestId: string): void {
      log.info('Cancel hook called (signal already aborted)', { requestId });
    },

    async validate(ctx: ValidateContext): Promise<{ ok: boolean; problem?: string }> {
      const cfg = ctx.settings.backends['claude-agent-sdk'];
      // Easel doesn't bundle the SDK — confirm the user's Claude Code is present.
      if (!(await resolveClaudeSdk())) return { ok: false, problem: CLAUDE_NOT_INSTALLED };
      if (cfg.authMode === 'api-key') {
        const key = ctx.secrets['anthropic'] ?? '';
        if (!key) return { ok: false, problem: 'API key not set. Configure it in Settings → Provider.' };
      }
      if (cfg.authMode === 'setup-token' && !ctx.secrets['claude-oauth-token']) {
        return { ok: false, problem: 'Setup token not set. Run `claude setup-token` and paste it in Settings.' };
      }
      if (cfg.authMode === 'gateway') {
        if (!cfg.baseUrl) return { ok: false, problem: 'Gateway base URL is not set.' };
        if (!ctx.secrets['gateway-token']) return { ok: false, problem: 'Gateway token not set.' };
      }
      // For inherit/bedrock/vertex we trust the SDK to validate credentials at call time.
      return { ok: true };
    },
  };
}
