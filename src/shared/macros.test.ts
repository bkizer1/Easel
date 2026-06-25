/**
 * Tests for instruction-macro interpolation (`src/shared/macros.ts`).
 */

import { describe, it, expect } from 'vitest';
import { describeElement, interpolateMacro, resolveMacroInstruction } from './macros';
import type { ElementTarget, InstructionMacro } from './types';

function makeTarget(overrides: Partial<ElementTarget> = {}): ElementTarget {
  return {
    id: 't1',
    selector: 'button.submit',
    tagName: 'button',
    boundingBox: { x: 0, y: 0, width: 10, height: 10 },
    textSnippet: 'Submit',
    attributes: {},
    pluginPresent: false,
    confidence: 'medium',
    ...overrides,
  };
}

describe('describeElement', () => {
  it('combines tag and selector', () => {
    expect(describeElement(makeTarget())).toBe('the <button> element (button.submit)');
  });

  it('falls back to the neutral phrase when no target', () => {
    expect(describeElement(undefined)).toBe('the selected element');
  });

  it('uses just the selector when tag is missing', () => {
    const desc = describeElement(makeTarget({ tagName: '' }));
    expect(desc).toContain('button.submit');
  });
});

describe('interpolateMacro', () => {
  it('replaces {element} and {text} from the target', () => {
    const out = interpolateMacro('Restyle {element} that says "{text}"', makeTarget());
    expect(out).toBe('Restyle the <button> element (button.submit) that says "Submit"');
  });

  it('is case- and whitespace-insensitive inside braces', () => {
    const out = interpolateMacro('Fix { Element } / {  TEXT  }', makeTarget());
    expect(out).toBe('Fix the <button> element (button.submit) / Submit');
  });

  it('replaces every occurrence', () => {
    const out = interpolateMacro('{text} then {text}', makeTarget({ textSnippet: 'Go' }));
    expect(out).toBe('Go then Go');
  });

  it('returns templates without placeholders unchanged', () => {
    expect(interpolateMacro('Add an aria-label', makeTarget())).toBe('Add an aria-label');
  });

  it('uses neutral fallbacks and trims when no target is selected', () => {
    const out = interpolateMacro('Update {element}: {text}', undefined);
    // {text} → '' so the trailing ": " collapses; output is trimmed.
    expect(out).toBe('Update the selected element:');
  });

  it('collapses doubled spaces left by an empty {text}', () => {
    const out = interpolateMacro('Tweak {text} here', makeTarget({ textSnippet: '' }));
    expect(out).toBe('Tweak here');
  });
});

describe('resolveMacroInstruction', () => {
  it('reads the template off the macro', () => {
    const macro: InstructionMacro = {
      id: 'm1',
      name: 'Aria',
      instructionTemplate: 'Add an aria-label to {element}',
    };
    expect(resolveMacroInstruction(macro, makeTarget())).toBe(
      'Add an aria-label to the <button> element (button.submit)',
    );
  });
});
