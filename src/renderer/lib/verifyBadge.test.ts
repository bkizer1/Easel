import { describe, it, expect } from 'vitest';
import type { ChatMessage, ChatRole } from '@shared/types';
import { parseVerifyBadge, formatVerifyContent, placeVerifyMessage } from './verifyBadge';

describe('formatVerifyContent', () => {
  it('encodes verdict + rationale', () => {
    expect(formatVerifyContent('pass', 'looks good')).toBe('[verify:pass] looks good');
  });
  it('encodes confidence when provided', () => {
    expect(formatVerifyContent('fail', 'no change', 0.4)).toBe('[verify:fail:0.4] no change');
  });
  it('round-trips through parseVerifyBadge', () => {
    expect(parseVerifyBadge(formatVerifyContent('pass', 'great', 0.9))).toEqual({
      pass: true,
      confidencePct: 90,
      message: 'great',
    });
  });
});

describe('parseVerifyBadge', () => {
  it('parses a pass verdict', () => {
    expect(parseVerifyBadge('[verify:pass] ok')).toEqual({ pass: true, message: 'ok' });
  });
  it('parses a fail verdict with confidence rendered as a percentage', () => {
    expect(parseVerifyBadge('[verify:fail:0.42] nope')).toEqual({
      pass: false,
      confidencePct: 42,
      message: 'nope',
    });
  });
  it('does NOT treat a fail whose rationale contains "[verify:pass]" as a pass (issue #6)', () => {
    const b = parseVerifyBadge('[verify:fail] still shows [verify:pass] in the markup');
    expect(b?.pass).toBe(false);
    expect(b?.message).toBe('still shows [verify:pass] in the markup');
  });
  it('returns null for non-verify content', () => {
    expect(parseVerifyBadge('Warning: x')).toBeNull();
    expect(parseVerifyBadge('[confidence: high] x')).toBeNull();
    expect(parseVerifyBadge('just text')).toBeNull();
  });
  it('returns null for an unknown verdict token', () => {
    expect(parseVerifyBadge('[verify:maybe] x')).toBeNull();
  });
  it('clamps an out-of-range confidence into [0, 100]', () => {
    expect(parseVerifyBadge('[verify:pass:3] x')?.confidencePct).toBe(100);
  });
});

describe('placeVerifyMessage', () => {
  const m = (id: string, role: ChatRole, requestId?: string): ChatMessage => ({
    id,
    role,
    content: id,
    createdAt: 0,
    requestId,
  });
  const verify = (requestId: string): ChatMessage => ({
    id: 'v',
    role: 'system',
    content: '[verify:pass] ok',
    createdAt: 1,
    requestId,
  });

  it('appends when the judged turn is the last in the transcript', () => {
    const out = placeVerifyMessage([m('u', 'user', 'r1'), m('a', 'assistant', 'r1')], verify('r1'));
    expect(out.map((x) => x.id)).toEqual(['u', 'a', 'v']);
  });

  it('inserts after the judged turn (not the tail) when a newer edit is in flight (issue #7)', () => {
    const chat = [
      m('u1', 'user', 'r1'),
      m('a1', 'assistant', 'r1'),
      m('u2', 'user', 'r2'),
      m('a2', 'assistant', 'r2'),
    ];
    const out = placeVerifyMessage(chat, verify('r1'));
    expect(out.map((x) => x.id)).toEqual(['u1', 'a1', 'v', 'u2', 'a2']);
    // The newer edit's assistant turn stays at the tail so its stream keeps coalescing.
    expect(out[out.length - 1].id).toBe('a2');
  });

  it('falls back to appending when the originating turn is gone', () => {
    const out = placeVerifyMessage([m('u2', 'user', 'r2')], verify('r1'));
    expect(out.map((x) => x.id)).toEqual(['u2', 'v']);
  });
});
