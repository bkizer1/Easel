/**
 * Easel — self-heal affordance label (issue #32, Deliverable 1).
 *
 * Pure formatting for the transient "verifying…/retrying…" inline indicator the
 * ChatPanel renders from {@link SelfHealPhase}. Factored out of the component so
 * the exact label text is unit-testable (components aren't rendered in tests).
 */

import type { SelfHealPhase } from './selfHealTypes';

/**
 * Human-readable label for the current {@link SelfHealPhase}:
 *  - `verifying`  → "Verifying edit…".
 *  - `retrying`   → "Retrying (attempt N)… — <rationale>", with the rationale
 *    omitted when it is empty/whitespace so the trailing dash never dangles.
 */
export function selfHealPhaseLabel(phase: SelfHealPhase): string {
  if (phase.phase === 'verifying') return 'Verifying edit…';
  const rationale = phase.rationale.trim();
  const base = `Retrying (attempt ${phase.attempt})…`;
  return rationale ? `${base} — ${rationale}` : base;
}
