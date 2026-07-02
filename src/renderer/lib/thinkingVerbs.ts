/**
 * Easel — "working" affordance copy.
 *
 * Pure helpers that drive the ChatPanel's {@link WorkingIndicator}: the whimsical
 * spinner verbs shown while Claude is thinking, and a human-readable label for
 * whatever tool it is currently running. Factored out of the component so the
 * exact text is unit-testable (components aren't rendered under vitest's `node`
 * environment) and so the store can reuse {@link toolActivityLabel} when it
 * reduces `tool-call` events.
 *
 * The verbs are deliberately on-brand for a design canvas (sketching, sculpting,
 * shading, layering) mixed with the familiar Claude-style present participles.
 * Their only job is to reassure the user that Easel is alive and working — the
 * app must never look hung while an edit is in flight.
 */

/**
 * Curated present-participle "spinner verbs" — deliberately fun. A mix of
 * whimsical Claude-Code-style words, a few classic programmer in-jokes
 * (Reticulating, Frobnicating), and some on-brand design-canvas verbs
 * (Doodling, Sketching, Sculpting, Bedazzling). Order is stable so selection is
 * deterministic (and therefore testable); the component varies the starting
 * index per turn so it doesn't always open on the same word.
 */
export const THINKING_VERBS: readonly string[] = [
  'Cogitating',
  'Noodling',
  'Percolating',
  'Conjuring',
  'Finagling',
  'Marinating',
  'Wrangling',
  'Doodling',
  'Scribbling',
  'Sketching',
  'Sculpting',
  'Whisking',
  'Concocting',
  'Brewing',
  'Simmering',
  'Tinkering',
  'Puttering',
  'Moseying',
  'Vibing',
  'Shimmying',
  'Discombobulating',
  'Reticulating',
  'Hatching',
  'Bedazzling',
  'Smooshing',
  'Boondoggling',
  'Ruminating',
  'Puzzling',
  'Scheming',
  'Frobnicating',
  'Bamboozling',
  'Flibbertigibbeting',
  'Manifesting',
  'Unfurling',
];

/**
 * Select a verb by index, wrapping with modulo so any (possibly ever-growing)
 * tick counter maps to a valid verb. Negative indices are normalized too.
 */
export function thinkingVerb(index: number): string {
  const len = THINKING_VERBS.length;
  const i = ((Math.trunc(index) % len) + len) % len;
  return THINKING_VERBS[i];
}

/** Truncate a snippet for inline display, appending an ellipsis when clipped. */
function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Read a trimmed non-empty string field off an unknown tool-input object. */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Last path segment (basename) of a project-relative path, for compact labels. */
function basename(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const parts = path.split('/').filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : path;
}

/**
 * Map a streamed `tool-call` event to a concrete, human-readable activity label
 * (e.g. "Reading Button.tsx", "Editing App.tsx", "Searching for \"grid\"").
 *
 * Handles BOTH tool-name families Easel emits:
 *  - the Claude Agent SDK's capitalized names (`Read`, `Edit`, `Grep`, `Bash`…);
 *  - Easel's own custom tools (`read_file`, `apply_patch`, `grep`…), whose file
 *    argument is `path` rather than `file_path`.
 *
 * Returns `null` for a tool we have no friendly phrasing for, so the caller can
 * fall back to a generic {@link thinkingVerb}.
 */
export function toolActivityLabel(tool: string, input: unknown): string | null {
  const obj: Record<string, unknown> =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const filePath = basename(str(obj, 'file_path') ?? str(obj, 'path') ?? str(obj, 'output_path'));

  switch (tool) {
    case 'Read':
    case 'read_file':
      return filePath ? `Reading ${filePath}` : 'Reading a file';

    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit':
    case 'write_file':
    case 'apply_patch':
      return filePath ? `Editing ${filePath}` : 'Editing files';

    case 'Grep':
    case 'grep': {
      const pattern = str(obj, 'pattern');
      return pattern ? `Searching for "${truncate(pattern, 32)}"` : 'Searching the code';
    }

    case 'Glob':
    case 'glob':
    case 'LS':
    case 'list_dir':
      return 'Scanning files';

    case 'Bash': {
      const label = str(obj, 'description') ?? str(obj, 'command');
      return label ? truncate(label, 44) : 'Running a command';
    }

    case 'replace_image':
      return filePath ? `Generating ${filePath}` : 'Generating an image';

    case 'set_app_state':
      return 'Adjusting the running app';

    case 'WebFetch':
    case 'WebSearch':
      return 'Researching the web';

    case 'TodoWrite':
      return 'Planning the work';

    case 'Task':
      return 'Delegating a subtask';

    default:
      return null;
  }
}
