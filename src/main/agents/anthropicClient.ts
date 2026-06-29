/**
 * Easel — shared Anthropic SDK client factory.
 *
 * Both the direct Messages-API edit backend (`anthropicApi.ts`) and the
 * self-heal vision judge (`visionJudge.ts` via `ipc.ts`) construct a client the
 * exact same way: dynamic-import `@anthropic-ai/sdk`, honor an optional custom
 * `baseURL`, and narrow to the minimal `{ messages: { create } }` surface they
 * use. Centralizing it here keeps the two call sites from drifting (they already
 * had).
 */

import type { VisionClient } from '@main/agents/visionJudge';

/**
 * Construct an Anthropic client narrowed to {@link VisionClient}. The dynamic
 * import is awaited here; callers wrap this in their own try/catch to surface a
 * missing-SDK condition the way that fits their flow (an `error` event for the
 * edit backend, a fail-open `null` for the verify judge).
 */
export async function createAnthropicClient(
  apiKey: string,
  baseURL?: string,
): Promise<VisionClient> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const client = new Anthropic(baseURL ? { apiKey, baseURL } : { apiKey });
  return client as unknown as VisionClient;
}
