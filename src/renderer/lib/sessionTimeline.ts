/**
 * Easel — Session replay timeline derivation.
 *
 * Pure helper: given an {@link EaselBundleManifest}, derive an ordered array of
 * {@link ReplayStep}s (oldest → newest), one per checkpoint, with the correlated
 * user and assistant {@link ChatMessage}s attached.
 *
 * Correlation rules (from spec §2):
 *  - assistantMessage: first message where role==='assistant' AND
 *    m.checkpointId === checkpoint.id
 *  - userMessage: first message where role==='user' AND m.requestId is set AND
 *    m.requestId === checkpoint.requestId
 *
 * No side effects. No React/Electron imports. Safe to unit-test in node env.
 */

import type { Checkpoint, ChatMessage } from '@shared/types';
import type { EaselBundleManifest } from '@shared/types';

export interface ReplayStep {
  checkpoint: Checkpoint;
  /** The user turn whose requestId matches checkpoint.requestId, if any. */
  userMessage?: ChatMessage;
  /** The assistant turn whose checkpointId === checkpoint.id, if any. */
  assistantMessage?: ChatMessage;
}

/**
 * Build the ordered replay timeline from a bundle manifest.
 *
 * Returns one {@link ReplayStep} per checkpoint, oldest-first.
 * Missing correlations result in the optional message fields being absent.
 */
export function buildReplaySteps(manifest: EaselBundleManifest): ReplayStep[] {
  const { checkpoints, chat } = manifest;

  // Sort checkpoints oldest-first by createdAt for a stable timeline.
  const sorted = [...checkpoints].sort((a, b) => a.createdAt - b.createdAt);

  return sorted.map((checkpoint) => {
    const assistantMessage = chat.find(
      (m) => m.role === 'assistant' && m.checkpointId === checkpoint.id,
    );

    const userMessage =
      checkpoint.requestId != null
        ? chat.find(
            (m) => m.role === 'user' && m.requestId != null && m.requestId === checkpoint.requestId,
          )
        : undefined;

    return {
      checkpoint,
      ...(userMessage != null ? { userMessage } : {}),
      ...(assistantMessage != null ? { assistantMessage } : {}),
    };
  });
}
