import { describe, it, expect } from 'vitest';
import { THINKING_VERBS, thinkingVerb, toolActivityLabel } from './thinkingVerbs';

describe('thinkingVerb', () => {
  it('returns the verb at the given index', () => {
    expect(thinkingVerb(0)).toBe(THINKING_VERBS[0]);
    expect(thinkingVerb(1)).toBe(THINKING_VERBS[1]);
  });

  it('wraps around with modulo for out-of-range indices', () => {
    expect(thinkingVerb(THINKING_VERBS.length)).toBe(THINKING_VERBS[0]);
    expect(thinkingVerb(THINKING_VERBS.length + 3)).toBe(THINKING_VERBS[3]);
  });

  it('normalizes negative indices', () => {
    expect(thinkingVerb(-1)).toBe(THINKING_VERBS[THINKING_VERBS.length - 1]);
  });

  it('truncates fractional indices', () => {
    expect(thinkingVerb(2.9)).toBe(THINKING_VERBS[2]);
  });

  it('only exposes non-empty, unique verbs', () => {
    expect(THINKING_VERBS.length).toBeGreaterThan(0);
    expect(THINKING_VERBS.every((v) => v.trim().length > 0)).toBe(true);
    expect(new Set(THINKING_VERBS).size).toBe(THINKING_VERBS.length);
  });
});

describe('toolActivityLabel', () => {
  it('labels SDK-cased Read with the file basename', () => {
    expect(toolActivityLabel('Read', { file_path: 'src/components/Button.tsx' })).toBe(
      'Reading Button.tsx',
    );
  });

  it('labels the custom read_file tool (which uses `path`)', () => {
    expect(toolActivityLabel('read_file', { path: 'app/App.tsx' })).toBe('Reading App.tsx');
  });

  it('labels edits across every edit-family tool', () => {
    for (const tool of ['Edit', 'MultiEdit', 'Write', 'write_file', 'apply_patch']) {
      expect(toolActivityLabel(tool, { file_path: 'a/b/Header.tsx' })).toBe('Editing Header.tsx');
    }
  });

  it('labels a grep with a truncated, quoted pattern', () => {
    expect(toolActivityLabel('Grep', { pattern: 'useState' })).toBe('Searching for "useState"');
    const long = 'a-really-long-search-pattern-that-should-be-clipped';
    const label = toolActivityLabel('grep', { pattern: long });
    expect(label?.startsWith('Searching for "')).toBe(true);
    expect(label).toContain('…');
  });

  it('prefers a Bash description over the raw command', () => {
    expect(
      toolActivityLabel('Bash', { command: 'npm run build', description: 'Build the project' }),
    ).toBe('Build the project');
    expect(toolActivityLabel('Bash', { command: 'ls -la' })).toBe('ls -la');
  });

  it('labels search / scan / research / planning tools', () => {
    expect(toolActivityLabel('Glob', { pattern: '**/*.tsx' })).toBe('Scanning files');
    expect(toolActivityLabel('list_dir', { path: '.' })).toBe('Scanning files');
    expect(toolActivityLabel('WebSearch', {})).toBe('Researching the web');
    expect(toolActivityLabel('TodoWrite', {})).toBe('Planning the work');
    expect(toolActivityLabel('set_app_state', {})).toBe('Adjusting the running app');
  });

  it('falls back to a generic phrase when the file argument is missing', () => {
    expect(toolActivityLabel('Read', {})).toBe('Reading a file');
    expect(toolActivityLabel('Edit', { garbage: 1 })).toBe('Editing files');
  });

  it('returns null for unknown tools so the caller can cycle verbs', () => {
    expect(toolActivityLabel('SomeFutureTool', { file_path: 'x.ts' })).toBeNull();
  });

  it('never throws on malformed input', () => {
    expect(() => toolActivityLabel('Read', null)).not.toThrow();
    expect(() => toolActivityLabel('Read', 'not-an-object')).not.toThrow();
    expect(toolActivityLabel('Read', null)).toBe('Reading a file');
  });
});
