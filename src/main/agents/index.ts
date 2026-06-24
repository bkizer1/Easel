/**
 * Easel — agent backend registry.
 *
 * Populates a {@link BackendRegistry} that maps every {@link AgentBackendId} to
 * a {@link BackendFactory}.  The type system (mapped type) forces exhaustive
 * coverage — adding a new id to the union will immediately surface a type error
 * here.
 *
 * Current implementations:
 *  - `claude-agent-sdk`  → `./claudeAgentSdk.ts`
 *  - `anthropic-api`     → `./anthropicApi.ts`
 *  - `local-openai`      → `./localOpenAi.ts`
 *
 * The registry is stateless; factories create lightweight backend instances on
 * each call.  All per-edit state lives in `AgentBackendContext`.
 */

import type { BackendRegistry } from '@shared/agent';
import type { AppSettings } from '@shared/types';
import { claudeAgentSdkBackend } from '@main/agents/claudeAgentSdk';
import { anthropicApiBackend } from '@main/agents/anthropicApi';
import { localOpenAiBackend } from '@main/agents/localOpenAi';

const registry: BackendRegistry = {
  'claude-agent-sdk': (settings: AppSettings) => claudeAgentSdkBackend(settings),
  'anthropic-api': (settings: AppSettings) => anthropicApiBackend(settings),
  'local-openai': (settings: AppSettings) => localOpenAiBackend(settings),
};

/** Return the global backend registry. */
export function getBackendRegistry(): BackendRegistry {
  return registry;
}
