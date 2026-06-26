/**
 * Easel — "use token" instruction builder (Live token inspector, #8).
 *
 * Pure logic (no React/Electron) so it is unit-testable under Node. Turns a
 * matched {@link TokenMatch} into a precise instruction telling the agent to
 * replace a hardcoded value with the project's design token in source.
 */

import type { TokenMatch } from '@shared/types';

/**
 * Build the agent instruction for replacing a hardcoded value with its token.
 * Throws if the match is off-system (no token) — callers gate on `match.token`.
 */
export function buildTokenizeInstruction(match: TokenMatch): string {
  const token = match.token;
  if (!token) {
    throw new Error('buildTokenizeInstruction called for an off-system value');
  }
  const how =
    token.kind === 'css-var'
      ? `the CSS custom property \`${token.replacement}\``
      : `the Tailwind design token \`${token.replacement}\` (e.g. the matching \`${token.replacement}\` utility class)`;
  return (
    `Replace this element's hardcoded \`${match.property}\` value \`${match.value}\` ` +
    `with ${how} in source, so it uses the design system token instead of a raw value.`
  );
}
