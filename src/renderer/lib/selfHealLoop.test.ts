import { describe, it, expect } from 'vitest';
import {
  isStaleSelfHeal,
  shouldDropStreamEvent,
  nextCorrelationOnRetrying,
  selfHealPhaseOnRetrying,
  selfHealPhaseOnVerifying,
} from './selfHealLoop';

describe('shouldDropStreamEvent (issue #31 stale-guard model)', () => {
  it('drops any event when the request already terminated (activeRequestId null)', () => {
    expect(shouldDropStreamEvent('r1', null)).toBe(true);
  });

  it('drops an event whose requestId does not match the active request', () => {
    expect(shouldDropStreamEvent('r1', 'r2')).toBe(true);
  });

  it('processes an event whose requestId matches the active request', () => {
    expect(shouldDropStreamEvent('r1', 'r1')).toBe(false);
  });
});

describe('nextCorrelationOnRetrying re-arms dropped retry events', () => {
  it('a retry reusing the same id is dropped after done, but processed once re-armed', () => {
    // After the first attempt's `done`, activeRequestId is cleared to null, so the
    // retry's same-id events WOULD be dropped.
    const cleared: string | null = null;
    expect(shouldDropStreamEvent('r1', cleared)).toBe(true);

    // The `retrying` event re-arms correlation back to the (reused) id.
    const armed = nextCorrelationOnRetrying('r1');
    expect(armed).toEqual({ activeRequestId: 'r1', streaming: true });

    // Now the retry's same-id stream events are processed, not dropped.
    expect(shouldDropStreamEvent('r1', armed.activeRequestId)).toBe(false);
  });
});

describe('isStaleSelfHeal (issue #31 concurrency guard)', () => {
  it('is NOT stale when no turn is active (normal post-done case) — the re-arm may fire', () => {
    expect(isStaleSelfHeal(null, 'r1')).toBe(false);
  });

  it('is NOT stale when the same turn is active (its own retry events)', () => {
    expect(isStaleSelfHeal('r1', 'r1')).toBe(false);
  });

  it('is STALE when a NEWER turn owns the foreground — an older retry must not hijack it', () => {
    // r1's slow judge fires `retrying` after the user submitted r2; r1 is stale.
    expect(isStaleSelfHeal('r2', 'r1')).toBe(true);
  });
});

describe('selfHeal phase builders', () => {
  it('verifying does NOT re-arm streaming (only a phase marker)', () => {
    expect(selfHealPhaseOnVerifying('r1')).toEqual({ requestId: 'r1', phase: 'verifying' });
    // The verifying builder has no activeRequestId/streaming fields — re-arm is
    // exclusive to `retrying`. Contrast with nextCorrelationOnRetrying above.
    expect('streaming' in selfHealPhaseOnVerifying('r1')).toBe(false);
  });

  it('retrying carries the upcoming attempt number and the judge rationale', () => {
    expect(selfHealPhaseOnRetrying('r1', 2, 'too small')).toEqual({
      requestId: 'r1',
      phase: 'retrying',
      attempt: 2,
      rationale: 'too small',
    });
  });
});
