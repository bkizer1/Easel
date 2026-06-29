/**
 * Easel — self-heal loop correlation helpers (issue #31).
 *
 * Pure, renderer-side logic for correlating the bounded auto-retry's events,
 * factored out of the store so it is directly unit-testable (the store itself is
 * never imported in tests — see {@link ./verifyBadge} for the same pattern).
 *
 * THE HAZARD this models: a self-heal retry reuses the SAME `requestId`, but by
 * the time the retry runs the renderer has already seen the first attempt's
 * `done` and cleared `activeRequestId`. Every gated event (`thinking`,
 * `message`, `checkpoint`, `done`, …) is dropped when its `requestId` does not
 * match `activeRequestId`. The `retrying` event RE-ARMS correlation so the
 * retry's same-id events are processed again.
 */

import type { SelfHealPhase } from './selfHealTypes';

/**
 * Models the store's stale-guard: a gated stream event is DROPPED when its
 * `requestId` does not match the currently-active request. When `activeRequestId`
 * is `null` (the request already terminated), any event is dropped — which is
 * exactly why a retry must re-arm correlation first.
 */
export function shouldDropStreamEvent(
  eventRequestId: string,
  activeRequestId: string | null,
): boolean {
  return eventRequestId !== activeRequestId;
}

/**
 * Whether a self-heal lifecycle event (`verifying`/`retrying`/`verify`/
 * `verify-skipped`) is STALE — i.e. a *newer* turn already owns the foreground.
 *
 * These events are intentionally un-gated (they arrive after their turn's `done`
 * cleared `activeRequestId`), but a self-heal judge call runs for seconds during
 * which the user can submit a NEW edit. If the older turn's `retrying` then
 * blindly re-armed correlation it would HIJACK `activeRequestId`/`streaming` from
 * the new turn and silently drop its entire stream. An event is stale when a
 * different request is currently active; the only safe times to act are when no
 * turn is active (`null`, the normal post-`done` case) or when this same turn is.
 */
export function isStaleSelfHeal(
  activeRequestId: string | null,
  eventRequestId: string,
): boolean {
  return activeRequestId !== null && activeRequestId !== eventRequestId;
}

/**
 * The correlation re-arm applied on a `retrying` event. Restores
 * `activeRequestId` to the (reused) request id and flips `streaming` back on so
 * the retry attempt's gated events (`thinking`/`message`/`checkpoint`/`done`)
 * are processed instead of silently dropped.
 */
export function nextCorrelationOnRetrying(
  requestId: string,
): { activeRequestId: string; streaming: true } {
  return { activeRequestId: requestId, streaming: true };
}

/**
 * Build the {@link SelfHealPhase} for a `retrying` event (drives #32's UI). The
 * phase carries the upcoming attempt number and the judge's fail rationale.
 */
export function selfHealPhaseOnRetrying(
  requestId: string,
  attempt: number,
  rationale: string,
): SelfHealPhase {
  return { requestId, phase: 'retrying', attempt, rationale };
}

/**
 * Build the {@link SelfHealPhase} for a `verifying` event. Unlike `retrying`,
 * this does NOT re-arm `streaming`/`activeRequestId` — the vision judge runs
 * after `done`, with no further stream events to correlate.
 */
export function selfHealPhaseOnVerifying(requestId: string): SelfHealPhase {
  return { requestId, phase: 'verifying' };
}
