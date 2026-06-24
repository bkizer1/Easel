import { describe, it, expect } from 'vitest';
import { parseToolInput } from './tools';

describe('parseToolInput', () => {
  it('parses read_file', () => {
    expect(parseToolInput('read_file', { path: 'src/a.ts' })).toEqual({
      tool: 'read_file',
      input: { path: 'src/a.ts' },
    });
  });

  it('parses write_file', () => {
    expect(parseToolInput('write_file', { path: 'a.ts', content: 'hi' })).toEqual({
      tool: 'write_file',
      input: { path: 'a.ts', content: 'hi' },
    });
  });

  it('parses grep pattern and flags', () => {
    const r = parseToolInput('grep', { pattern: 'foo', is_regex: true });
    expect(r?.tool).toBe('grep');
    if (r?.tool === 'grep') {
      expect(r.input.pattern).toBe('foo');
      expect(r.input.is_regex).toBe(true);
    }
  });

  it('returns null for an unknown tool', () => {
    expect(parseToolInput('does-not-exist', {})).toBeNull();
  });
});
