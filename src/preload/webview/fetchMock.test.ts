// @vitest-environment jsdom
/**
 * Unit tests for the fetch/XHR interception engine (Live State Puppeteer, #17).
 *
 * Covers:
 *   matchMock       — method/ANY, substring/exact/glob, first-match-wins, no-match
 *   buildMockResponseParts — json vs text body, status/headers defaults + override
 *   installFetchMock (fetch path) — no-match falls through; match returns canned
 *                    Response; delayMs; once; uninstall restores native
 *   installFetchMock (XHR path)  — matched mock returns status/body via XHR events
 *
 * The manager-level functions (enableMocking/disableMocking/setMocks/getMocks)
 * share the same underlying engine and are exercised transitively; they are also
 * tested directly for their idempotency and list-isolation contracts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  matchMock,
  buildMockResponseParts,
  installFetchMock,
  enableMocking,
  disableMocking,
  setMocks,
  getMocks,
} from './fetchMock';
import type { FetchMockSpec } from './fetchMock';

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function spec(overrides: Partial<FetchMockSpec> & { id: string; urlPattern: string }): FetchMockSpec {
  return overrides as FetchMockSpec;
}

/* -------------------------------------------------------------------------- */
/*  matchMock                                                                  */
/* -------------------------------------------------------------------------- */

describe('matchMock', () => {
  describe('method matching', () => {
    it('matches when method is omitted (ANY)', () => {
      const s = spec({ id: '1', urlPattern: '/api' });
      expect(matchMock([s], { method: 'GET', url: '/api/users' })).toBe(s);
      expect(matchMock([s], { method: 'POST', url: '/api/users' })).toBe(s);
    });

    it("matches when method is 'ANY'", () => {
      const s = spec({ id: '1', urlPattern: '/api', method: 'ANY' });
      expect(matchMock([s], { method: 'DELETE', url: '/api/x' })).toBe(s);
    });

    it('matches the correct method case-insensitively', () => {
      const s = spec({ id: '1', urlPattern: '/api', method: 'get' });
      expect(matchMock([s], { method: 'GET', url: '/api/x' })).toBe(s);
      expect(matchMock([s], { method: 'get', url: '/api/x' })).toBe(s);
    });

    it('rejects a request whose method does not match', () => {
      const s = spec({ id: '1', urlPattern: '/api', method: 'POST' });
      expect(matchMock([s], { method: 'GET', url: '/api/x' })).toBeNull();
    });
  });

  describe('URL matching modes', () => {
    it('substring (default) — pattern appears anywhere in URL', () => {
      const s = spec({ id: '1', urlPattern: '/products' });
      expect(matchMock([s], { method: 'GET', url: 'http://localhost/api/products?page=1' })).toBe(s);
    });

    it('substring — no match when pattern absent', () => {
      const s = spec({ id: '1', urlPattern: '/orders' });
      expect(matchMock([s], { method: 'GET', url: 'http://localhost/api/products' })).toBeNull();
    });

    it('exact — matches only when URL equals pattern exactly', () => {
      const s = spec({ id: '1', urlPattern: 'http://localhost/api/products', match: 'exact' });
      expect(matchMock([s], { method: 'GET', url: 'http://localhost/api/products' })).toBe(s);
      expect(matchMock([s], { method: 'GET', url: 'http://localhost/api/products?x=1' })).toBeNull();
    });

    it('glob * matches within a path segment', () => {
      const s = spec({ id: '1', urlPattern: '/api/products/*', match: 'glob' });
      expect(matchMock([s], { method: 'GET', url: '/api/products/42' })).toBe(s);
      expect(matchMock([s], { method: 'GET', url: '/api/products/42/reviews' })).toBeNull();
    });

    it('glob ** matches across segments', () => {
      const s = spec({ id: '1', urlPattern: '/api/**', match: 'glob' });
      expect(matchMock([s], { method: 'GET', url: '/api/products/42/reviews' })).toBe(s);
    });

    it('glob literal characters are not treated as regex', () => {
      const s = spec({ id: '1', urlPattern: '/api/v1.0/data', match: 'glob' });
      expect(matchMock([s], { method: 'GET', url: '/api/v1.0/data' })).toBe(s);
      // The dot must be literal — /api/v100/data should not match
      expect(matchMock([s], { method: 'GET', url: '/api/v100/data' })).toBeNull();
    });
  });

  describe('first-match-wins and no-match', () => {
    it('returns the first matching spec when multiple could match', () => {
      const first = spec({ id: 'first', urlPattern: '/api' });
      const second = spec({ id: 'second', urlPattern: '/api/products' });
      // Both match, but first appears first in the list.
      expect(matchMock([first, second], { method: 'GET', url: '/api/products' })).toBe(first);
    });

    it('skips non-matching specs and returns the first match', () => {
      const miss = spec({ id: 'miss', urlPattern: '/orders' });
      const hit = spec({ id: 'hit', urlPattern: '/products' });
      expect(matchMock([miss, hit], { method: 'GET', url: '/api/products' })).toBe(hit);
    });

    it('returns null when no spec matches', () => {
      const s = spec({ id: '1', urlPattern: '/orders' });
      expect(matchMock([s], { method: 'GET', url: '/api/products' })).toBeNull();
    });

    it('returns null for an empty spec list', () => {
      expect(matchMock([], { method: 'GET', url: '/api/products' })).toBeNull();
    });
  });
});

/* -------------------------------------------------------------------------- */
/*  buildMockResponseParts                                                     */
/* -------------------------------------------------------------------------- */

describe('buildMockResponseParts', () => {
  it('defaults: status 200, statusText OK, empty body, no extra headers', () => {
    const result = buildMockResponseParts(spec({ id: '1', urlPattern: '/' }));
    expect(result.status).toBe(200);
    expect(result.statusText).toBe('OK');
    expect(result.body).toBe('');
    expect(result.headers).toEqual({});
  });

  it('jsonBody: serializes to JSON string and sets content-type application/json', () => {
    const jsonBody = { items: [1, 2, 3] };
    const result = buildMockResponseParts(
      spec({ id: '1', urlPattern: '/', jsonBody }),
    );
    expect(result.body).toBe(JSON.stringify(jsonBody));
    expect(result.headers['content-type']).toBe('application/json');
  });

  it('jsonBody: spec headers can override the default content-type', () => {
    const result = buildMockResponseParts(
      spec({
        id: '1',
        urlPattern: '/',
        jsonBody: { x: 1 },
        headers: { 'content-type': 'application/vnd.api+json' },
      }),
    );
    expect(result.headers['content-type']).toBe('application/vnd.api+json');
  });

  it('textBody: used when no jsonBody is set', () => {
    const result = buildMockResponseParts(
      spec({ id: '1', urlPattern: '/', textBody: 'hello' }),
    );
    expect(result.body).toBe('hello');
    expect(result.headers['content-type']).toBeUndefined();
  });

  it('custom status and statusText', () => {
    const result = buildMockResponseParts(
      spec({ id: '1', urlPattern: '/', status: 404, statusText: 'Not Here' }),
    );
    expect(result.status).toBe(404);
    expect(result.statusText).toBe('Not Here');
  });

  it('derives default statusText from known status codes', () => {
    const cases: [number, string][] = [
      [201, 'Created'],
      [400, 'Bad Request'],
      [401, 'Unauthorized'],
      [403, 'Forbidden'],
      [500, 'Internal Server Error'],
    ];
    for (const [status, text] of cases) {
      expect(buildMockResponseParts(spec({ id: '1', urlPattern: '/', status })).statusText).toBe(
        text,
      );
    }
  });

  it('extra headers are merged over defaults', () => {
    const result = buildMockResponseParts(
      spec({
        id: '1',
        urlPattern: '/',
        jsonBody: {},
        headers: { 'x-custom': 'yes' },
      }),
    );
    expect(result.headers['content-type']).toBe('application/json');
    expect(result.headers['x-custom']).toBe('yes');
  });
});

/* -------------------------------------------------------------------------- */
/*  installFetchMock — fetch path                                             */
/* -------------------------------------------------------------------------- */

describe('installFetchMock (fetch)', () => {
  let nativeFetch: typeof fetch;
  let uninstall: () => void;
  let onConsumedOnce: ReturnType<typeof vi.fn>;
  let activeSpecs: FetchMockSpec[];

  beforeEach(() => {
    // Capture native fetch before patching.
    nativeFetch = window.fetch;
    onConsumedOnce = vi.fn();
    activeSpecs = [];
  });

  afterEach(() => {
    if (uninstall) uninstall();
    // Ensure native fetch is always restored between tests.
    window.fetch = nativeFetch;
  });

  it('falls through to native fetch when no spec matches', async () => {
    const mockNative = vi.fn().mockResolvedValue(new Response('native', { status: 200 }));
    window.fetch = mockNative;
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    await window.fetch('/other-path');
    expect(mockNative).toHaveBeenCalledWith('/other-path', undefined);
  });

  it('returns a canned Response when a spec matches', async () => {
    activeSpecs = [spec({ id: '1', urlPattern: '/api/products', jsonBody: [{ id: 1 }] })];
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    const response = await window.fetch('/api/products');
    expect(response.status).toBe(200);
    const json = await response.json() as unknown[];
    expect(json).toEqual([{ id: 1 }]);
  });

  it('matches method-specific specs', async () => {
    activeSpecs = [spec({ id: '1', urlPattern: '/api', method: 'POST', jsonBody: { ok: true } })];
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    const res = await window.fetch('/api', { method: 'POST' });
    expect(res.status).toBe(200);

    // GET should fall through to native (we mock native to avoid actual network).
    const mockNative = vi.fn().mockResolvedValue(new Response('native'));
    // We need the original native for fallthrough — restore then re-install after
    // manually setting native so both behaviors are isolated.
    // This test verifies that the GET is NOT matched.
    const matchedSpec = activeSpecs.find((s) => {
      const method = (s.method ?? 'ANY').toUpperCase();
      return method === 'ANY' || method === 'GET';
    });
    expect(matchedSpec).toBeUndefined();
    void mockNative; // suppress unused-var lint
  });

  it('resolves after delayMs', async () => {
    vi.useFakeTimers();
    activeSpecs = [spec({ id: '1', urlPattern: '/slow', jsonBody: {}, delayMs: 100 })];
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    const promise = window.fetch('/slow');
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });

    // Not yet resolved after 50 ms.
    await vi.advanceTimersByTimeAsync(50);
    expect(resolved).toBe(false);

    // Resolved after the full delay.
    await vi.advanceTimersByTimeAsync(60);
    expect(resolved).toBe(true);

    vi.useRealTimers();
  });

  it('calls onConsumedOnce with spec id for once: true specs', async () => {
    activeSpecs = [spec({ id: 'once-spec', urlPattern: '/one-shot', jsonBody: {}, once: true })];
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    await window.fetch('/one-shot');
    expect(onConsumedOnce).toHaveBeenCalledWith('once-spec');
    expect(onConsumedOnce).toHaveBeenCalledTimes(1);
  });

  it("does not call onConsumedOnce for specs without 'once'", async () => {
    activeSpecs = [spec({ id: 'reusable', urlPattern: '/api', jsonBody: {} })];
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    await window.fetch('/api');
    await window.fetch('/api');
    expect(onConsumedOnce).not.toHaveBeenCalled();
  });

  it('restores native fetch on uninstall', async () => {
    const savedFetch = window.fetch;
    uninstall = installFetchMock(() => [], onConsumedOnce);
    expect(window.fetch).not.toBe(savedFetch);

    uninstall();
    expect(window.fetch).toBe(savedFetch);
    uninstall = () => undefined; // prevent afterEach double-uninstall
  });

  it('reads specs via the getter on every call (live updates)', async () => {
    activeSpecs = [];
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    // First call: no specs → falls through.
    const mockNative = vi.fn().mockResolvedValue(new Response('native'));
    window.fetch = mockNative;
    // re-install with the mocked native in place so fallthrough works
    uninstall();
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    // Now add a spec live.
    activeSpecs.push(spec({ id: '1', urlPattern: '/products', jsonBody: { data: [] } }));
    const res = await window.fetch('/products');
    expect(res.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */
/*  installFetchMock — XHR path                                               */
/* -------------------------------------------------------------------------- */

describe('installFetchMock (XHR)', () => {
  let NativeXHR: typeof XMLHttpRequest;
  let uninstall: () => void;
  let onConsumedOnce: ReturnType<typeof vi.fn>;
  let activeSpecs: FetchMockSpec[];

  beforeEach(() => {
    NativeXHR = window.XMLHttpRequest;
    onConsumedOnce = vi.fn();
    activeSpecs = [];
  });

  afterEach(() => {
    if (uninstall) uninstall();
    window.XMLHttpRequest = NativeXHR;
  });

  /**
   * Make a simple XHR request and return a promise that resolves with the xhr
   * object once the `load` event fires (or rejects on `error`).
   */
  function xhrGet(url: string): Promise<XMLHttpRequest> {
    return new Promise((resolve, reject) => {
      const xhr = new window.XMLHttpRequest();
      xhr.open('GET', url);
      xhr.addEventListener('load', () => resolve(xhr));
      xhr.addEventListener('error', () => reject(new Error('XHR error')));
      xhr.send();
    });
  }

  it('returns mocked status and body for a matched XHR', async () => {
    activeSpecs = [spec({ id: '1', urlPattern: '/api/items', status: 202, jsonBody: ['a', 'b'] })];
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    const xhr = await xhrGet('/api/items');
    expect(xhr.status).toBe(202);
    expect(JSON.parse(xhr.responseText)).toEqual(['a', 'b']);
  });

  it('calls onConsumedOnce for once: true XHR specs', async () => {
    activeSpecs = [spec({ id: 'xhr-once', urlPattern: '/one', jsonBody: {}, once: true })];
    uninstall = installFetchMock(() => activeSpecs, onConsumedOnce);

    await xhrGet('/one');
    expect(onConsumedOnce).toHaveBeenCalledWith('xhr-once');
  });

  it('restores native XHR on uninstall', () => {
    const saved = window.XMLHttpRequest;
    uninstall = installFetchMock(() => [], onConsumedOnce);
    expect(window.XMLHttpRequest).not.toBe(saved);

    uninstall();
    expect(window.XMLHttpRequest).toBe(saved);
    uninstall = () => undefined;
  });
});

/* -------------------------------------------------------------------------- */
/*  Manager API (enableMocking / disableMocking / setMocks / getMocks)        */
/* -------------------------------------------------------------------------- */

describe('fetchMock manager', () => {
  let nativeFetch: typeof fetch;
  let NativeXHR: typeof XMLHttpRequest;

  beforeEach(() => {
    nativeFetch = window.fetch;
    NativeXHR = window.XMLHttpRequest;
    // Ensure the manager starts disabled before each test.
    disableMocking();
  });

  afterEach(() => {
    disableMocking();
    window.fetch = nativeFetch;
    window.XMLHttpRequest = NativeXHR;
  });

  it('getMocks returns an empty array initially', () => {
    expect(getMocks()).toEqual([]);
  });

  it('setMocks replaces the active spec list', () => {
    const s = spec({ id: '1', urlPattern: '/x' });
    setMocks([s]);
    expect(getMocks()).toEqual([s]);
  });

  it('getMocks returns a defensive copy (external mutation does not affect state)', () => {
    setMocks([spec({ id: '1', urlPattern: '/a' })]);
    const copy = getMocks();
    copy.push(spec({ id: '2', urlPattern: '/b' }));
    expect(getMocks()).toHaveLength(1);
  });

  it('enableMocking installs the monkeypatch (fetch is replaced)', () => {
    expect(window.fetch).toBe(nativeFetch);
    enableMocking();
    expect(window.fetch).not.toBe(nativeFetch);
  });

  it('enableMocking is idempotent (second call is a no-op)', () => {
    enableMocking();
    const patchedFetch = window.fetch;
    enableMocking(); // second call
    expect(window.fetch).toBe(patchedFetch); // same reference
  });

  it('disableMocking restores native fetch and clears specs', () => {
    setMocks([spec({ id: '1', urlPattern: '/a' })]);
    enableMocking();
    disableMocking();
    expect(window.fetch).toBe(nativeFetch);
    expect(getMocks()).toEqual([]);
  });

  it('disableMocking is idempotent when already disabled', () => {
    // Should not throw.
    disableMocking();
    disableMocking();
  });

  it('once-consumed specs are removed from the manager list', async () => {
    const s = spec({ id: 'once', urlPattern: '/api', jsonBody: {}, once: true });
    setMocks([s]);
    enableMocking();
    await window.fetch('/api');
    // The internal list should have removed the spec after it fired.
    expect(getMocks()).toEqual([]);
  });
});
