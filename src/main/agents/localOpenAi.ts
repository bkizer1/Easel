/**
 * Easel — local / OpenAI-compatible backend.
 *
 * A hand-built agentic tool-loop against any OpenAI-compatible
 * `/chat/completions` endpoint (Ollama, LM Studio, llama.cpp, vLLM, …).
 * `agenticReliability` is 'variable' because smaller local models may struggle
 * with multi-step tool use; the UI surfaces a warning.
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
import { buildPuppeteerCapability } from '@main/puppeteer';

const log = createLogger('backend:local-openai');

const CAPABILITIES: AgentCapabilities = {
  streamsThinking: false,
  streamsToolCalls: true,
  supportsVision: false,
  editsFilesDirectly: true,
  gitAware: false,
  supportsImageTool: true,
  cancellable: true,
  agenticReliability: 'variable',
};

const MAX_TURNS = 24;

// Map our Anthropic-style tool schema to the OpenAI function-tool format.
const OPENAI_TOOLS = TOOL_DEFINITIONS.map((t) => ({
  type: 'function' as const,
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

function systemPrompt(request: EditRequest): string {
  return [
    'You are Easel, an agentic web-development assistant editing source files in a live project.',
    `Project root: ${request.projectRoot}.`,
    'Use the tools to read and edit files. Make the minimal change that satisfies the user instruction.',
    'Only edit files inside the project root. When finished, briefly explain what you changed.',
    `User instruction: ${request.instruction}`,
  ].join('\n');
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export function localOpenAiBackend(_settings: AppSettings): AgentBackend {
  return {
    id: 'local-openai',
    name: 'Local / OpenAI-compatible',
    capabilities: CAPABILITIES,

    async *editStream(request: EditRequest, ctx: AgentBackendContext): AsyncIterable<AgentEvent> {
      const cfg = ctx.settings.backends['local-openai'];
      if (!cfg.baseUrl) {
        yield {
          type: 'error',
          requestId: request.id,
          message: 'Local model base URL not set (e.g. http://localhost:11434/v1).',
          code: 'config',
          recoverable: true,
        };
        return;
      }
      const apiKey = ctx.secrets['local'] ?? 'not-needed';
      const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';

      const toolCtx: ToolExecutorContext = {
        fs: ctx.fs,
        imageProvider: ctx.imageProvider,
        nextImageId: () => crypto.randomUUID(),
        puppeteer: buildPuppeteerCapability(ctx.projectRoot),
      };

      const messages: OpenAiMessage[] = [
        { role: 'system', content: systemPrompt(request) },
        { role: 'user', content: request.instruction },
      ];
      const diffs: FileDiff[] = [];

      yield {
        type: 'warning',
        requestId: request.id,
        message: 'Local models vary in tool-use reliability; results may be inconsistent.',
        code: 'local-model',
      };

      for (let turn = 0; turn < MAX_TURNS; turn++) {
        if (ctx.signal.aborted) {
          yield { type: 'error', requestId: request.id, message: 'Edit cancelled', code: 'cancelled', recoverable: false };
          return;
        }

        let data: {
          choices?: Array<{ message?: OpenAiMessage }>;
          error?: { message?: string };
        };
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              model: cfg.model,
              messages,
              tools: OPENAI_TOOLS,
              tool_choice: 'auto',
            }),
            signal: ctx.signal,
          });
          if (!res.ok) {
            yield {
              type: 'error',
              requestId: request.id,
              message: `Local endpoint returned ${res.status}: ${await res.text()}`,
              code: 'api',
              recoverable: true,
            };
            return;
          }
          data = (await res.json()) as typeof data;
        } catch (err) {
          const msg = String(err);
          if (ctx.signal.aborted || /abort|cancel/i.test(msg)) {
            yield { type: 'error', requestId: request.id, message: 'Edit cancelled', code: 'cancelled', recoverable: false };
            return;
          }
          yield { type: 'error', requestId: request.id, message: `Local request failed: ${msg}`, code: 'network', recoverable: true };
          return;
        }

        const choice = data.choices?.[0]?.message;
        if (!choice) {
          yield {
            type: 'error',
            requestId: request.id,
            message: data.error?.message ?? 'No response from local model.',
            code: 'api',
            recoverable: true,
          };
          return;
        }

        if (choice.content) {
          yield { type: 'message', requestId: request.id, text: choice.content };
        }

        const calls = choice.tool_calls ?? [];
        if (calls.length === 0) break;

        messages.push({ role: 'assistant', content: choice.content ?? null, tool_calls: calls });

        for (const call of calls) {
          let input: unknown = {};
          try {
            input = JSON.parse(call.function.arguments || '{}');
          } catch {
            input = {};
          }
          yield { type: 'tool-call', requestId: request.id, tool: call.function.name, input, callId: call.id };

          const parsed = parseToolInput(call.function.name, input);
          let content: string;
          if (!parsed) {
            content = `Unknown tool: ${call.function.name}`;
          } else {
            const result = await executeTool(parsed, toolCtx);
            if (result.diff) {
              diffs.push(result.diff);
              yield { type: 'file-edit', requestId: request.id, diff: result.diff };
            }
            content = result.ok ? result.output : `Error: ${result.error ?? 'failed'}`;
          }
          messages.push({ role: 'tool', content, tool_call_id: call.id });
        }
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
      const cfg = ctx.settings.backends['local-openai'];
      if (!cfg.baseUrl) return { ok: false, problem: 'Local model base URL not set.' };
      if (!cfg.model) return { ok: false, problem: 'Local model name not set.' };
      return { ok: true };
    },
  };
}
