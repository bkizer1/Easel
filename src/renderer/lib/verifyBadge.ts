/**
 * Easel — self-heal verify badge helpers (issue #16).
 *
 * Pure, renderer-side logic for the `verify` system message, factored out of the
 * store and ChatPanel so it is directly unit-testable (the components themselves
 * aren't rendered in the node test env).
 *
 * The store encodes a verdict as a system `ChatMessage` whose content is
 * `[verify:<verdict>[:<confidence>]] <rationale>`. {@link parseVerifyBadge}
 * decodes it for rendering; {@link formatVerifyContent} produces it.
 */

import type { ChatMessage, VerifyVerdict } from '@shared/types';

/** Decoded verify badge for rendering. */
export interface VerifyBadge {
  /** True for a `pass` verdict, false for `fail`. */
  pass: boolean;
  /** Judge confidence as a whole percentage [0, 100], when reported. */
  confidencePct?: number;
  /** The rationale text (everything after the token). */
  message: string;
}

/** Build the system-message content string for a verify verdict. */
export function formatVerifyContent(
  verdict: VerifyVerdict,
  rationale: string,
  confidence?: number,
): string {
  const conf = confidence !== undefined ? `:${confidence}` : '';
  return `[verify:${verdict}${conf}] ${rationale}`.trim();
}

/**
 * Decode a `[verify:…]` system-message content string. Returns `null` when the
 * content is not a verify badge. The match is ANCHORED to the start and only
 * accepts the strict `pass`/`fail` token, so a `fail` whose rationale happens to
 * contain the substring `[verify:pass]` can never render as a pass.
 */
export function parseVerifyBadge(content: string): VerifyBadge | null {
  const m = /^\[verify:\s*(pass|fail)(?::([0-9]*\.?[0-9]+))?\]\s?/.exec(content);
  if (!m) return null;

  const badge: VerifyBadge = { pass: m[1] === 'pass', message: content.slice(m[0].length) };
  if (m[2] !== undefined) {
    const c = Number.parseFloat(m[2]);
    if (Number.isFinite(c)) badge.confidencePct = Math.round(Math.max(0, Math.min(1, c)) * 100);
  }
  return badge;
}

/**
 * Place a verify system message immediately AFTER the last message belonging to
 * its `requestId`, rather than blindly at the tail. The verdict can arrive
 * seconds after `done` (HMR settle + vision call); if the user has already
 * started another edit, a tail-append would land the badge inside that newer
 * edit's stream and split its assistant bubble. Falls back to appending when the
 * originating turn is no longer present.
 */
export function placeVerifyMessage(chat: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  let lastIdx = -1;
  for (let i = chat.length - 1; i >= 0; i--) {
    if (chat[i].requestId === msg.requestId) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) return [...chat, msg];
  const next = chat.slice();
  next.splice(lastIdx + 1, 0, msg);
  return next;
}
