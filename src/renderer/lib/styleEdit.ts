/**
 * Easel — "Apply to source" instruction builder (Live DOM/CSS tweak, #6).
 *
 * Pure logic (no React/Electron) so it is unit-testable under Node. Turns an
 * accumulated style delta into a precise instruction telling the agent to edit
 * the element's durable source (Tailwind class / CSS rule / styled-component),
 * not an inline style.
 */

import type { StyleEdit } from '@shared/types';

/** Format one `{property, oldValue, newValue}` change as a readable line. */
export function formatStyleEdit(edit: StyleEdit): string {
  const from = edit.oldValue.trim() === '' ? '(unset)' : edit.oldValue;
  return `${edit.property}: ${from} → ${edit.newValue}`;
}

/**
 * Build the agent instruction for applying an accumulated style delta to source.
 * The phrasing forbids inline styles and names the structured change set so the
 * agent edits the precise class / rule.
 */
export function buildStyleEditInstruction(deltas: StyleEdit[]): string {
  const lines = deltas.map((d) => `  - ${formatStyleEdit(d)}`).join('\n');
  return (
    "Apply these exact style changes to this element's source. Edit the element's " +
    'Tailwind classes / CSS rule / styled-component — do NOT add an inline `style` ' +
    `attribute:\n${lines}`
  );
}
