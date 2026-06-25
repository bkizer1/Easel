/**
 * Easel Renderer — tiny keyboard-chord helpers for instruction-macro hotkeys.
 *
 * A hotkey is stored as a normalized chord string like `mod+1` or
 * `mod+shift+k`. `mod` is the platform-primary modifier (Cmd on macOS, Ctrl
 * elsewhere) so a single stored binding works cross-platform. Pure functions,
 * no React/Electron imports, so they are trivially unit-testable.
 */

/** Order modifiers deterministically so equal chords compare equal as strings. */
const MODIFIER_ORDER = ['mod', 'ctrl', 'alt', 'shift'] as const;

/**
 * Normalize a free-form hotkey string into the canonical `mod+shift+k` form:
 * lower-cased, de-duplicated, modifiers ordered, `cmd`/`meta`/`control`
 * aliased. Returns '' when no usable key remains.
 */
export function normalizeHotkey(raw: string): string {
  const parts = raw
    .toLowerCase()
    .split('+')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';

  const mods = new Set<string>();
  let key = '';
  for (const part of parts) {
    if (part === 'cmd' || part === 'command' || part === 'meta' || part === 'super' || part === 'mod') {
      mods.add('mod');
    } else if (part === 'ctrl' || part === 'control') {
      mods.add('ctrl');
    } else if (part === 'alt' || part === 'option' || part === 'opt') {
      mods.add('alt');
    } else if (part === 'shift') {
      mods.add('shift');
    } else {
      key = part; // last non-modifier token wins as the trigger key
    }
  }
  if (!key) return '';

  const ordered = MODIFIER_ORDER.filter((m) => mods.has(m));
  return [...ordered, key].join('+');
}

/**
 * Whether a keyboard event matches the given normalized hotkey chord. `mod`
 * matches Cmd on macOS (event.metaKey) and Ctrl elsewhere (event.ctrlKey).
 */
export function hotkeyMatches(
  hotkey: string,
  e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>,
  isMac: boolean = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform),
): boolean {
  const normalized = normalizeHotkey(hotkey);
  if (!normalized) return false;

  const tokens = normalized.split('+');
  const key = tokens[tokens.length - 1];
  const mods = new Set(tokens.slice(0, -1));

  if (e.key.toLowerCase() !== key) return false;

  const wantMod = mods.has('mod');
  const modActive = isMac ? e.metaKey : e.ctrlKey;
  if (wantMod !== modActive) return false;

  // A bare `ctrl` (without `mod`) is only meaningful on mac, where mod==meta.
  const wantCtrl = mods.has('ctrl') && !wantMod;
  if (wantCtrl !== (isMac ? e.ctrlKey : false)) return false;

  if (mods.has('alt') !== e.altKey) return false;
  if (mods.has('shift') !== e.shiftKey) return false;

  return true;
}
