/**
 * Easel — instruction-macro interpolation (pure, no Electron/Node imports).
 *
 * A macro's {@link InstructionMacro.instructionTemplate} may contain two
 * placeholders that are filled in from the element the user has selected:
 *
 *   `{element}` → a human description of the target (its tag + robust selector)
 *   `{text}`    → the target's trimmed visible text snippet
 *
 * Interpolation is intentionally simple and deterministic so it behaves the
 * same in the renderer, in tests, and (potentially) in the main process. When
 * no target is selected the placeholders collapse to neutral fallbacks so the
 * resulting instruction still reads sensibly (e.g. "the selected element").
 *
 * Shared by the renderer store (`submitEdit` call site) and unit tests.
 */

import type { ElementTarget, InstructionMacro } from './types';

/** Fallback used for `{element}` when nothing is selected. */
const NO_ELEMENT = 'the selected element';
/** Fallback used for `{text}` when the target has no text snippet. */
const NO_TEXT = '';

/**
 * Build the human-readable `{element}` substitution for a target: the tag name
 * plus its selector, e.g. `the <button> element (#submit.btn)`. Falls back to
 * just the selector, or the neutral phrase when no target is available.
 */
export function describeElement(target: ElementTarget | undefined): string {
  if (!target) return NO_ELEMENT;
  const tag = target.tagName ? `<${target.tagName}>` : '';
  const selector = target.selector?.trim();
  if (tag && selector) return `the ${tag} element (${selector})`;
  if (selector) return `the element matching \`${selector}\``;
  if (tag) return `the ${tag} element`;
  return NO_ELEMENT;
}

/**
 * Interpolate a macro template against the (optionally) selected target.
 *
 * Replaces every `{element}` and `{text}` occurrence (case-insensitive,
 * whitespace-tolerant inside the braces). Templates with no placeholders are
 * returned unchanged. The result is always trimmed of leading/trailing space so
 * an empty `{text}` substitution does not leave dangling whitespace.
 */
export function interpolateMacro(
  template: string,
  target: ElementTarget | undefined,
): string {
  const element = describeElement(target);
  const text = target?.textSnippet?.trim() || NO_TEXT;
  return template
    .replace(/\{\s*element\s*\}/gi, element)
    .replace(/\{\s*text\s*\}/gi, text)
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/**
 * Resolve a macro to the concrete instruction string to submit. Convenience
 * wrapper over {@link interpolateMacro} that reads the template off the macro.
 */
export function resolveMacroInstruction(
  macro: InstructionMacro,
  target: ElementTarget | undefined,
): string {
  return interpolateMacro(macro.instructionTemplate, target);
}
