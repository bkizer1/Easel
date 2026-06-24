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
 *  - inherit (default): NO credential env vars set; SDK uses existing machine
 *    credential (e.g. Claude Code login → Pro/Max plan). No extra spend.
 *  - api-key:   set ANTHROPIC_API_KEY from resolved secret.
 *  - bedrock:   set CLAUDE_CODE_USE_BEDROCK=1 (+ AWS_REGION / AWS_PROFILE).
 *  - vertex:    set CLAUDE_CODE_USE_VERTEX=1 (+ ANTHROPIC_VERTEX_PROJECT_ID / CLOUD_ML_REGION).
 *  - gateway:   set ANTHROPIC_BASE_URL (+ ANTHROPIC_AUTH_TOKEN from secret).
 *
 * NOTE: env vars are set only in the options passed to the SDK call; Easel's
 * own `process.env` is NEVER mutated permanently.
 */

import type { AgentBackend, AgentCapabilities, AgentBackendContext, ValidateContext } from '@shared/agent';
import type { AgentEvent, AppSettings, EditRequest } from '@shared/types';
import { createLogger } from '@main/logger';

const log = createLogger('backend:claude-agent-sdk');

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
 * Build the additional environment variables for the SDK call based on the
 * configured `authMode`.  Returns only the keys to set — the SDK call receives
 * these merged over a clean environment (never `process.env`).
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

      const prompt = buildPrompt(request);

      log.info('Starting Claude Agent SDK edit', {
        requestId: request.id,
        authMode: settings.backends['claude-agent-sdk'].authMode,
        model: settings.model,
        envKeys: Object.keys(authEnv),
      });

      yield { type: 'thinking', requestId: request.id, text: 'Analysing your request...' };

      // Import the SDK lazily to avoid bundling it in dev when it may not be needed.
      let sdk: typeof import('@anthropic-ai/claude-agent-sdk');
      try {
        sdk = await import('@anthropic-ai/claude-agent-sdk');
      } catch (err) {
        yield {
          type: 'error',
          requestId: request.id,
          message: `Claude Agent SDK not available: ${String(err)}`,
          code: 'sdk-missing',
          recoverable: false,
        };
        return;
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
        additionalDirectories: [request.projectRoot],
        // Auto-apply file edits (no interactive permission prompt is possible
        // here) and restrict to safe file tools so the agent can't hang on a
        // Bash permission request.
        permissionMode: 'acceptEdits',
        allowedTools: ['Read', 'Edit', 'Write', 'MultiEdit', 'Glob', 'Grep'],
        // CRITICAL: the SDK uses `env` as the COMPLETE child environment — it
        // does NOT merge with process.env. Passing only authEnv (e.g. {} for
        // inherit mode) would wipe PATH and break the `node` spawn
        // (`spawn node ENOENT`). Layer the auth-mode overrides on top of the
        // inherited environment so PATH/HOME/credentials are preserved.
        env: { ...process.env, ...authEnv },
        abortController,
      };

      const changedFiles = new Set<string>();
      let resultText = '';

      try {
        // The SDK exposes `query({ prompt, options })` returning an async
        // iterable of SDKMessages; we normalise them into our AgentEvent union.
        const queryFn = (sdk as unknown as {
          query: (args: { prompt: string; options?: Record<string, unknown> }) => AsyncIterable<unknown>;
        }).query;
        const runner = queryFn({ prompt, options: sdkOptions });

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
                const fp = input['file_path'] ?? input['path'];
                if (typeof fp === 'string' && /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(toolName)) {
                  changedFiles.add(fp.replace(request.projectRoot + '/', ''));
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

      const changed = checkpoint?.changedFiles?.length ?? changedFiles.size;
      const fileWord = changed === 1 ? 'file' : 'files';
      const summary =
        resultText.trim() ||
        (changed > 0 ? `Edit applied — ${changed} ${fileWord} changed.` : 'Done. No file changes were detected.');

      yield {
        type: 'done',
        requestId: request.id,
        summary,
        diffs: [],
      };
    },

    cancel(requestId: string): void {
      log.info('Cancel hook called (signal already aborted)', { requestId });
    },

    async validate(ctx: ValidateContext): Promise<{ ok: boolean; problem?: string }> {
      const cfg = ctx.settings.backends['claude-agent-sdk'];
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
