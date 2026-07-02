import { describe, it, expect, vi, beforeEach } from 'vitest';

// networkTap.ts imports `electron` (webContents) and `@main/window` (which itself
// imports electron) at module load time. Stub both so the pure `parseInitiator`
// helper can be unit-tested in a plain Node environment.
vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => [] },
}));
vi.mock('@main/window', () => ({
  getMainWindow: () => null,
}));

import {
  parseInitiator,
  encodeBody,
  toHeaderEntries,
  buildFulfillParams,
  buildContinueParams,
  summarizeRewrite,
  addPausedRequest,
  resolvePausedRequest,
  clearPausedRequests,
  pausedRequests,
} from './networkTap';

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

/* -------------------------------------------------------------------------- */
/*  Interception ("Burp") helpers — Workstream 2                               */
/* -------------------------------------------------------------------------- */

describe('encodeBody', () => {
  it('passes undefined through (no body)', () => {
    expect(encodeBody(undefined)).toBeUndefined();
  });

  it('base64-encodes a UTF-8 string', () => {
    expect(encodeBody('hello')).toBe(Buffer.from('hello', 'utf8').toString('base64'));
    // Round-trips back to the original.
    expect(Buffer.from(encodeBody('{"a":1}')!, 'base64').toString('utf8')).toBe('{"a":1}');
  });

  it('encodes the empty string (distinct from undefined)', () => {
    expect(encodeBody('')).toBe('');
  });
});

describe('toHeaderEntries', () => {
  it('returns [] for undefined headers', () => {
    expect(toHeaderEntries(undefined)).toEqual([]);
  });

  it('lowers a {name: value} map to CDP [{name, value}] pairs', () => {
    expect(toHeaderEntries({ 'Content-Type': 'application/json', 'X-Foo': 'bar' })).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'X-Foo', value: 'bar' },
    ]);
  });
});

describe('buildFulfillParams', () => {
  it('maps a mock response to CDP fulfill params with a base64 body', () => {
    const params = buildFulfillParams('intercept-1', {
      responseCode: 503,
      headers: { 'Content-Type': 'text/plain' },
      body: 'down',
    });
    expect(params).toEqual({
      requestId: 'intercept-1',
      responseCode: 503,
      responseHeaders: [{ name: 'Content-Type', value: 'text/plain' }],
      body: Buffer.from('down', 'utf8').toString('base64'),
    });
  });

  it('omits the body field when the mock has no body', () => {
    const params = buildFulfillParams('intercept-2', { responseCode: 204 });
    expect(params).toEqual({
      requestId: 'intercept-2',
      responseCode: 204,
      responseHeaders: [],
    });
    expect('body' in params).toBe(false);
  });
});

describe('buildContinueParams', () => {
  it('returns just the id for a plain pass-through (no rewrite)', () => {
    expect(buildContinueParams('id-1')).toEqual({ requestId: 'id-1' });
    expect(buildContinueParams('id-1', undefined)).toEqual({ requestId: 'id-1' });
  });

  it('applies url/method overrides and base64-encodes postData', () => {
    const params = buildContinueParams('id-2', {
      url: 'https://example.com/v2',
      method: 'PUT',
      postData: '{"x":1}',
      headers: { Authorization: 'Bearer t' },
    });
    expect(params).toEqual({
      requestId: 'id-2',
      url: 'https://example.com/v2',
      method: 'PUT',
      postData: Buffer.from('{"x":1}', 'utf8').toString('base64'),
      headers: [{ name: 'Authorization', value: 'Bearer t' }],
    });
  });

  it('only includes the overridden fields', () => {
    expect(buildContinueParams('id-3', { method: 'DELETE' })).toEqual({
      requestId: 'id-3',
      method: 'DELETE',
    });
  });
});

describe('summarizeRewrite', () => {
  it('returns undefined for no rewrite / an empty rewrite', () => {
    expect(summarizeRewrite(undefined)).toBeUndefined();
    expect(summarizeRewrite({})).toBeUndefined();
  });

  it('summarizes the changed parts', () => {
    expect(summarizeRewrite({ method: 'PUT' })).toBe('rewrote method PUT');
    expect(summarizeRewrite({ url: 'x', headers: {}, postData: 'b' })).toBe(
      'rewrote url, headers, body',
    );
  });
});

describe('paused-request bookkeeping', () => {
  beforeEach(() => clearPausedRequests());

  it('adds and resolves a paused request, removing it from the map', () => {
    addPausedRequest({ interceptId: 'i1', method: 'GET', url: '/a', stage: 'request' });
    expect(pausedRequests.has('i1')).toBe(true);

    const resolved = resolvePausedRequest('i1');
    expect(resolved?.interceptId).toBe('i1');
    expect(pausedRequests.has('i1')).toBe(false);
  });

  it('returns null when resolving an unknown or already-resolved id (no double-act)', () => {
    addPausedRequest({ interceptId: 'i2', method: 'POST', url: '/b', stage: 'response' });
    expect(resolvePausedRequest('i2')).not.toBeNull();
    // Second resolve of the same id must be a no-op guard, not a throw.
    expect(resolvePausedRequest('i2')).toBeNull();
    expect(resolvePausedRequest('never')).toBeNull();
  });

  it('clearPausedRequests drops all bookkeeping (on disable/detach)', () => {
    addPausedRequest({ interceptId: 'a', method: 'GET', url: '/1', stage: 'request' });
    addPausedRequest({ interceptId: 'b', method: 'GET', url: '/2', stage: 'request' });
    expect(pausedRequests.size).toBe(2);
    clearPausedRequests();
    expect(pausedRequests.size).toBe(0);
  });
});
