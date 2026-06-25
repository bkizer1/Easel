import { describe, it, expect, vi } from 'vitest';

// networkTap.ts imports `electron` (webContents) and `@main/window` (which itself
// imports electron) at module load time. Stub both so the pure `parseInitiator`
// helper can be unit-tested in a plain Node environment.
vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => [] },
}));
vi.mock('@main/window', () => ({
  getMainWindow: () => null,
}));

import { parseInitiator } from './networkTap';

describe('parseInitiator', () => {
  it('returns {} for undefined / garbage input', () => {
    expect(parseInitiator(undefined)).toEqual({});
    // @ts-expect-error — intentionally passing a non-conforming value.
    expect(parseInitiator(42)).toEqual({});
    // @ts-expect-error — intentionally passing a non-conforming value.
    expect(parseInitiator('nope')).toEqual({});
    expect(parseInitiator({})).toEqual({});
    expect(parseInitiator({ type: 'script', stack: { callFrames: [] } })).toEqual({});
  });

  it('strips the origin and query string to a project-relative path', () => {
    const result = parseInitiator({
      type: 'script',
      stack: {
        callFrames: [
          {
            url: 'http://localhost:3000/src/components/Cart.tsx?t=123',
            lineNumber: 0,
            columnNumber: 0,
            functionName: 'fetchCart',
          },
        ],
      },
    });
    expect(result.source?.filePath).toBe('src/components/Cart.tsx');
    expect(result.initiatorUrl).toBe('http://localhost:3000/src/components/Cart.tsx?t=123');
  });

  it('strips a hash fragment as well as the query', () => {
    const result = parseInitiator({
      stack: {
        callFrames: [{ url: 'http://localhost:5173/app/main.ts?v=1#L20', lineNumber: 4, columnNumber: 2 }],
      },
    });
    expect(result.source?.filePath).toBe('app/main.ts');
  });

  it('converts 0-based CDP line/column to 1-based SourceLocation', () => {
    const result = parseInitiator({
      stack: {
        callFrames: [{ url: 'http://localhost:3000/src/api.ts', lineNumber: 41, columnNumber: 7 }],
      },
    });
    expect(result.source?.line).toBe(42);
    expect(result.source?.column).toBe(8);
  });

  it('defaults missing line/column to 1 (0 + 1)', () => {
    const result = parseInitiator({
      stack: { callFrames: [{ url: 'http://localhost:3000/src/x.ts' }] },
    });
    expect(result.source?.line).toBe(1);
    expect(result.source?.column).toBe(1);
  });

  it('skips node_modules frames and picks the next meaningful one', () => {
    const result = parseInitiator({
      stack: {
        callFrames: [
          { url: 'http://localhost:3000/node_modules/axios/dist/axios.js', lineNumber: 100, columnNumber: 5 },
          { url: 'http://localhost:3000/src/data/loader.ts', lineNumber: 9, columnNumber: 1 },
        ],
      },
    });
    expect(result.source?.filePath).toBe('src/data/loader.ts');
    expect(result.source?.line).toBe(10);
  });

  it('skips empty-url frames', () => {
    const result = parseInitiator({
      stack: {
        callFrames: [
          { url: '', lineNumber: 1, columnNumber: 1 },
          { url: 'http://localhost:3000/src/real.ts', lineNumber: 0, columnNumber: 0 },
        ],
      },
    });
    expect(result.source?.filePath).toBe('src/real.ts');
  });

  it('returns {} when every frame is noise', () => {
    const result = parseInitiator({
      stack: {
        callFrames: [
          { url: 'http://localhost:3000/node_modules/react/index.js', lineNumber: 1, columnNumber: 1 },
          { url: '', lineNumber: 2, columnNumber: 2 },
        ],
      },
    });
    expect(result).toEqual({});
  });
});
