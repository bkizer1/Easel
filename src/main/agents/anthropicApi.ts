/**
 * Easel — raw Anthropic Messages API backend.
 *
 * A hand-built agentic tool-loop on `@anthropic-ai/sdk`. Unlike the Claude
 * Agent SDK backend, this drives the read/edit loop itself using the shared
 * tools in `./tools.ts`. Requires an Anthropic API key (always API-billed).
 */
import type {
  AgentBackend,
  AgentBackendContext,
  AgentCapabilities,
  ValidateContext,
} from '@shared/agent';
import type { AgentEvent, AppSettings, EditRequest, FileDiff } from '@shared/types';
import { createLogger } from '@main/logger';
import {
  TOOL_DEFINITIONS,
  executeTool,
  parseToolInput,
  type ToolExecutorContext,
} from '@main/agents/tools';
import { createAnthropicClient } from '@main/agents/anthropicClient';
import type { VisionClient } from '@main/agents/visionJudge';

const log = createLogger('backend:anthropic-api');

const CAPABILITIES: AgentCapabilities = {
  streamsThinking: false,
  streamsToolCalls: true,
  supportsVision: true,
  editsFilesDirectly: true,
  gitAware: false,
  supportsImageTool: true,
  cancellable: true,
  agenticReliability: 'high',
};

const MAX_TURNS = 24;

function systemPrompt(request: EditRequest): string {
  return [
    'You are Easel, an agentic web-development assistant editing source files in a live project.',
    `Project root: ${request.projectRoot}`,
    'Use the provided tools to read and edit files. Make the minimal change that satisfies the user.',
    'Only edit files inside the project root. Do not touch package.json, lock files, or git history.',
    'When done, briefly explain what you changed.',
  ].join('\n');
}

function userPrompt(request: EditRequest): string {
  const lines = [`INSTRUCTION: ${request.instruction}`];
  if (request.targets.length) {
    lines.push('', 'SELECTED ELEMENTS:');
    for (const t of request.targets) {
      lines.push(
        `- <${t.tagName}> selector ${t.selector}` +
          (t.dataEaselSource
            ? ` (source ${t.dataEaselSource.filePath}:${t.dataEaselSource.line})`
            : ''),
      );
      if (t.textSnippet) lines.push(`  text: "${t.textSnippet.slice(0, 120)}"`);
    }
  }
  if (request.annotations.length) {
    lines.push('', 'ANNOTATIONS:');
    for (const a of request.annotations) lines.push(`- ${a.kind}${a.label ? ` "${a.label}"` : ''}`);
  }
  return lines.join('\n');
}

export function anthropicApiBackend(_settings: AppSettings): AgentBackend {
  return {
    id: 'anthropic-api',
    name: 'Anthropic API (direct)',
    capabilities: CAPABILITIES,

    async *editStream(request: EditRequest, ctx: AgentBackendContext): AsyncIterable<AgentEvent> {
      const apiKey = ctx.secrets['anthropic'] ?? '';
      if (!apiKey) {
        yield {
          type: 'error',
          requestId: request.id,
          message: 'Anthropic API key not set. Add it in Settings → Provider.',
          code: 'auth',
          recoverable: true,
        };
        return;
      }

      let client: VisionClient;
      try {
        client = await createAnthropicClient(apiKey, ctx.settings.backends['anthropic-api'].baseUrl);
      } catch (err) {
        yield {
          type: 'error',
          requestId: request.id,
          message: `Anthropic SDK unavailable: ${String(err)}`,
          code: 'sdk-missing',
          recoverable: false,
        };
        return;
      }

      const toolCtx: ToolExecutorContext = {
        fs: ctx.fs,
        imageProvider: ctx.imageProvider,
        nextImageId: () => crypto.randomUUID(),
      };

      type Block = Record<string, unknown>;
      const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
        { role: 'user', content: userPrompt(request) },
      ];
      const diffs: FileDiff[] = [];

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (ctx.signal.aborted) {
          yield { type: 'error', requestId: request.id, message: 'Edit cancelled', code: 'cancelled', recoverable: false };
          return;
        }

        let response: { content: Block[]; stop_reason?: string };
        try {
          response = (await (
            client as unknown as {
              messages: {
                create: (
                  p: Record<string, unknown>,
                  o?: { signal?: AbortSignal },
                ) => Promise<unknown>;
              };
            }
          ).messages.create(
            {
              model: ctx.settings.model,
              max_tokens: 4096,
              system: systemPrompt(request),
              tools: TOOL_DEFINITIONS,
              messages,
            },
            { signal: ctx.signal },
          )) as { content: Block[]; stop_reason?: string };
        } catch (err) {
          const msg = String(err);
          if (ctx.signal.aborted || /abort|cancel/i.test(msg)) {
            yield { type: 'error', requestId: request.id, message: 'Edit cancelled', code: 'cancelled', recoverable: false };
            return;
          }
          yield { type: 'error', requestId: request.id, message: msg, code: 'api', recoverable: true };
          return;
        }

        // Emit any assistant text.
        for (const b of response.content) {
          if (b['type'] === 'text' && typeof b['text'] === 'string') {
            yield { type: 'message', requestId: request.id, text: b['text'] as string };
          }
        }

        const toolUses = response.content.filter((b) => b['type'] === 'tool_use');
        if (toolUses.length === 0) break; // model finished

        messages.push({ role: 'assistant', content: response.content });
        const toolResults: Block[] = [];

        for (const tu of toolUses) {
          const name = String(tu['name'] ?? '');
          const input = tu['input'] ?? {};
          const callId = String(tu['id'] ?? crypto.randomUUID());
          yield { type: 'tool-call', requestId: request.id, tool: name, input, callId };

          const parsed = parseToolInput(name, input);
          if (!parsed) {
            toolResults.push({ type: 'tool_result', tool_use_id: callId, content: `Unknown tool: ${name}`, is_error: true });
            continue;
          }
          const result = await executeTool(parsed, toolCtx);
          if (result.diff) {
            diffs.push(result.diff);
            yield { type: 'file-edit', requestId: request.id, diff: result.diff };
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: callId,
            content: result.ok ? result.output : `Error: ${result.error ?? 'failed'}`,
            is_error: !result.ok,
          });
        }

        messages.push({ role: 'user', content: toolResults });
      }

      if (ctx.signal.aborted) {
        yield { type: 'error', requestId: request.id, message: 'Edit cancelled', code: 'cancelled', recoverable: false };
        return;
      }

      let checkpointed = false;
      try {
        const cp = await ctx.createCheckpoint(request.instruction.slice(0, 72), request.id);
        checkpointed = true;
        yield { type: 'checkpoint', requestId: request.id, checkpoint: cp };
      } catch (err) {
        yield { type: 'warning', requestId: request.id, message: `Checkpoint failed: ${String(err)}`, code: 'checkpoint-failed' };
      }

      yield {
        type: 'done',
        requestId: request.id,
        summary: `${diffs.length} file${diffs.length !== 1 ? 's' : ''} changed${checkpointed ? ' and checkpointed' : ''}.`,
        diffs,
      };
    },

    cancel(requestId: string): void {
      log.info('Cancel hook (signal-driven)', { requestId });
    },

    async validate(ctx: ValidateContext): Promise<{ ok: boolean; problem?: string }> {
      if (!ctx.secrets['anthropic']) return { ok: false, problem: 'Anthropic API key not set.' };
      return { ok: true };
    },
  };
}
