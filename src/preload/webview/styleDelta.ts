/**
 * Easel — style-tweak delta accumulation (Live DOM/CSS tweak, #6).
 *
 * Pure logic (no electron/DOM import) so it is unit-testable under Node. The
 * guest inspector applies ephemeral inline-style tweaks to a picked element and
 * accumulates a `{property, oldValue, newValue}[]` delta; "Apply to source"
 * ships that exact delta to the agent.
 */

import type { StyleEdit } from '@shared/types';

export type { StyleEdit };

/**
 * Merge `edit` into the accumulated `deltas` for one element:
 *  - First tweak of a property → appended (its `oldValue` is the original).
 *  - Repeat tweak of a property → collapsed: keep the ORIGINAL `oldValue`, take
 *    the latest `newValue`.
 *  - If a tweak returns a property to its original value (`newValue === oldValue`)
 *    → the entry is dropped (no net change to ship).
 *
 * Returns a new array; never mutates the input.
 */
export function accumulateStyleEdit(deltas: StyleEdit[], edit: StyleEdit): StyleEdit[] {
  const idx = deltas.findIndex((d) => d.property === edit.property);

  if (idx === -1) {
    if (edit.newValue === edit.oldValue) return deltas.slice();
    return [...deltas, edit];
  }

  const original = deltas[idx].oldValue;
  if (edit.newValue === original) {
    // Net no-op for this property — remove it from the delta.
    return deltas.filter((_, i) => i !== idx);
  }

  const next = deltas.slice();
  next[idx] = { property: edit.property, oldValue: original, newValue: edit.newValue };
  return next;
}
