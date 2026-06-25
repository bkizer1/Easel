/**
 * Tests for macro hotkey normalization + matching (`src/renderer/lib/hotkeys.ts`).
 */

import { describe, it, expect } from 'vitest';
import { normalizeHotkey, hotkeyMatches } from './hotkeys';

type KeyEventLike = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

function ev(overrides: Partial<KeyEventLike>): KeyEventLike {
  return { key: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...overrides };
}

describe('normalizeHotkey', () => {
  it('lower-cases and orders modifiers deterministically', () => {
    expect(normalizeHotkey('Shift+Mod+K')).toBe('mod+shift+k');
  });

  it('aliases cmd/command/meta to mod', () => {
    expect(normalizeHotkey('Cmd+1')).toBe('mod+1');
    expect(normalizeHotkey('Meta+1')).toBe('mod+1');
    expect(normalizeHotkey('Command+1')).toBe('mod+1');
  });

  it('de-duplicates repeated modifiers', () => {
    expect(normalizeHotkey('mod+mod+a')).toBe('mod+a');
  });

  it('returns empty string when there is no trigger key', () => {
    expect(normalizeHotkey('mod+shift')).toBe('');
    expect(normalizeHotkey('')).toBe('');
  });
});

describe('hotkeyMatches', () => {
  it('matches mod to metaKey on mac', () => {
    expect(hotkeyMatches('mod+1', ev({ key: '1', metaKey: true }), true)).toBe(true);
    expect(hotkeyMatches('mod+1', ev({ key: '1', ctrlKey: true }), true)).toBe(false);
  });

  it('matches mod to ctrlKey off mac', () => {
    expect(hotkeyMatches('mod+1', ev({ key: '1', ctrlKey: true }), false)).toBe(true);
    expect(hotkeyMatches('mod+1', ev({ key: '1', metaKey: true }), false)).toBe(false);
  });

  it('requires the exact set of modifiers', () => {
    expect(hotkeyMatches('mod+shift+k', ev({ key: 'k', metaKey: true, shiftKey: true }), true)).toBe(true);
    // Missing shift should not match.
    expect(hotkeyMatches('mod+shift+k', ev({ key: 'k', metaKey: true }), true)).toBe(false);
    // Extra alt should not match.
    expect(hotkeyMatches('mod+k', ev({ key: 'k', metaKey: true, altKey: true }), true)).toBe(false);
  });

  it('is case-insensitive on the trigger key', () => {
    expect(hotkeyMatches('mod+k', ev({ key: 'K', metaKey: true }), true)).toBe(true);
  });

  it('never matches an empty/invalid hotkey', () => {
    expect(hotkeyMatches('', ev({ key: '1', metaKey: true }), true)).toBe(false);
  });
});
