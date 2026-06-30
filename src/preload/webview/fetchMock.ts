/**
 * Easel — Guest fetch/XHR interception engine (Live State Puppeteer, issue #17).
 *
 * Provides a self-contained, zero-dependency monkeypatch for `window.fetch` and
 * `XMLHttpRequest` that short-circuits matched requests with canned responses.
 * Designed to be imported by the guest inspector; has NO imports from main or
 * renderer. The only external import is the shared `FetchMockSpec`/`JsonValue`
 * types (pure type, no runtime code).
 *
 * Key design decisions:
 * - Specs are read through a getter on every request so live updates (from
 *   `puppeteer-set-mocks`) take effect immediately without reinstalling the patch.
 * - `once: true` specs auto-remove after they fire; the inspector calls
 *   `onConsumedOnce` to notify main, which removes the spec from authoritative
 *   state and re-pushes the updated list.
 * - The patch is idempotent: calling `enableMocking()` while already enabled is a
 *   no-op; calling `disableMocking()` restores the saved native implementations.
 * - No `eval`, no `new Function`, no arbitrary code — structured mutations only.
 */

import type { FetchMockSpec, JsonValue } from '@shared/puppeteer';

/* -------------------------------------------------------------------------- */
/*  URL glob matcher                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Minimal glob matcher for URL patterns:
 * - `**` matches any sequence of characters including `/` (cross-segment)
 * - `*`  matches any sequence of characters NOT including `/` (within-segment)
 * - all other characters are literal (no regex meta-character injection)
 *
 * Kept intentionally small — no brace expansion, no `?`, no character classes.
 * The pattern is compiled to a `RegExp` by escaping literals and substituting
 * the two wildcard forms.
 */
function matchGlob(pattern: string, url: string): boolean {
  // Build the RegExp source char-by-char (no placeholder sentinels) so the
  // compiled pattern never contains control characters: a run of two or more
  // `*` becomes `.*` (cross-segment); a single `*` becomes `[^/]*`; everything
  // else is a regex-escaped literal.
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern[i] === '*') {
      let stars = 0;
      while (pattern[i] === '*') {
        stars++;
        i++;
      }
      re += stars >= 2 ? '.*' : '[^/]*';
    } else {
      re += pattern[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }

  try {
    return new RegExp(`^${re}$`).test(url);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  matchMock                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Find the first spec in `specs` that matches the given request, or `null` when
 * no spec matches. First match wins (caller controls priority via list order).
 *
 * Method matching is case-insensitive; an omitted `method` or `'ANY'` matches
 * any HTTP method. URL matching is controlled by `spec.match`:
 *   - `'substring'` (default) — the `urlPattern` appears anywhere in the URL
 *   - `'exact'`               — the URL equals `urlPattern` exactly
 *   - `'glob'`                — minimal glob (see {@link matchGlob})
 */
export function matchMock(
  specs: FetchMockSpec[],
  req: { method: string; url: string },
): FetchMockSpec | null {
  const reqMethod = req.method.toUpperCase();

  for (const spec of specs) {
    // Method check.
    const specMethod = (spec.method ?? 'ANY').toUpperCase();
    if (specMethod !== 'ANY' && specMethod !== reqMethod) continue;

    // URL check.
    const mode = spec.match ?? 'substring';
    let urlMatches: boolean;
    switch (mode) {
      case 'exact':
        urlMatches = req.url === spec.urlPattern;
        break;
      case 'glob':
        urlMatches = matchGlob(spec.urlPattern, req.url);
        break;
      case 'substring':
      default:
        urlMatches = req.url.includes(spec.urlPattern);
        break;
    }

    if (urlMatches) return spec;
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/*  buildMockResponseParts                                                     */
/* -------------------------------------------------------------------------- */

/** Default status text for common HTTP status codes. */
function defaultStatusText(status: number): string {
  const texts: Record<number, string> = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
  };
  return texts[status] ?? 'Unknown';
}

/**
 * Derive the fully-resolved response parts from a spec:
 * - `jsonBody` takes priority over `textBody`; when set, serializes to JSON and
 *   injects `content-type: application/json` unless the spec's `headers` override
 *   it explicitly.
 * - `status` defaults to `200`; `statusText` defaults via {@link defaultStatusText}.
 * - `headers` are merged over the defaults (spec-supplied values win).
 */
export function buildMockResponseParts(spec: FetchMockSpec): {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
} {
  const status = spec.status ?? 200;
  const statusText = spec.statusText ?? defaultStatusText(status);

  let body: string;
  const defaultHeaders: Record<string, string> = {};

  if (spec.jsonBody !== undefined) {
    body = JSON.stringify(spec.jsonBody);
    defaultHeaders['content-type'] = 'application/json';
  } else {
    body = spec.textBody ?? '';
  }

  // Spec-supplied headers win over defaults.
  const headers: Record<string, string> = { ...defaultHeaders, ...(spec.headers ?? {}) };

  return { status, statusText, headers, body };
}

/* -------------------------------------------------------------------------- */
/*  Fetch monkeypatch                                                          */
/* -------------------------------------------------------------------------- */

/** Delay helper — resolves after `ms` milliseconds (0 resolves immediately). */
function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build a real `Response` object from a {@link FetchMockSpec}. Uses the DOM
 * `Response` constructor, which is available in Chromium (the Electron guest env)
 * and under jsdom for tests.
 */
function buildFetchResponse(spec: FetchMockSpec): Response {
  const { status, statusText, headers, body } = buildMockResponseParts(spec);
  return new Response(body, { status, statusText, headers });
}

/* -------------------------------------------------------------------------- */
/*  XHR monkeypatch                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Minimal faithful XHR simulation for matched requests.
 *
 * We extend the native `XMLHttpRequest` class (saved before installation) so
 * that unmatched requests fall through to the real network. For matched requests
 * we override `open`/`send` and synthesize the complete set of XHR events that
 * conforming code expects (`loadstart`, `readystatechange` ×4, `load`, `loadend`).
 */
function buildMockXHRClass(
  NativeXHR: typeof XMLHttpRequest,
  getSpecs: () => FetchMockSpec[],
  onConsumedOnce: (id: string) => void,
): typeof XMLHttpRequest {
  // We need to produce a class that TypeScript accepts as assignable to
  // `typeof XMLHttpRequest`. The cleanest way is a class expression that extends
  // NativeXHR, augmenting the send path.
  class MockXMLHttpRequest extends NativeXHR {
    // These track the open() call so send() knows what to match against.
    #method = 'GET';
    #url = '';
    #matched: FetchMockSpec | null = null;

    override open(
      method: string,
      url: string | URL,
      async = true,
      username?: string | null,
      password?: string | null,
    ): void {
      this.#method = method;
      this.#url = typeof url === 'string' ? url : url.toString();
      this.#matched = matchMock(getSpecs(), { method: this.#method, url: this.#url });
      if (!this.#matched) {
        // Not matched — let the real XHR handle it (preserve all open() args).
        super.open(method, url, async, username, password);
      }
      // If matched, we don't call super.open — the XHR never hits the network.
    }

    override send(body?: Document | XMLHttpRequestBodyInit | null): void {
      const spec = this.#matched;
      if (!spec) {
        // Not matched — delegate to the real network.
        super.send(body);
        return;
      }

      const parts = buildMockResponseParts(spec);
      const ms = spec.delayMs ?? 0;

      // Synthesize the XHR lifecycle asynchronously so callers that listen for
      // events get the right sequence even when delayMs is 0.
      void (async () => {
        if (ms > 0) await delay(ms);

        // UNSENT → OPENED
        this.#dispatchReadyState(XMLHttpRequest.OPENED);
        // OPENED → HEADERS_RECEIVED
        this.#dispatchReadyState(XMLHttpRequest.HEADERS_RECEIVED);
        // HEADERS_RECEIVED → LOADING
        this.#dispatchReadyState(XMLHttpRequest.LOADING);

        // Install the response data via non-standard property assignment (the
        // only mechanism available for a subclass to set readOnly XHR attributes).
        // This works in Chromium (which is how it runs in production) and under
        // jsdom (which uses defineProperty internally and allows overrides).
        try {
          Object.defineProperty(this, 'status', { value: parts.status, configurable: true });
          Object.defineProperty(this, 'statusText', {
            value: parts.statusText,
            configurable: true,
          });
          Object.defineProperty(this, 'responseText', { value: parts.body, configurable: true });
          Object.defineProperty(this, 'response', { value: parts.body, configurable: true });
          Object.defineProperty(this, 'responseURL', {
            value: this.#url,
            configurable: true,
          });
          // Inject headers so getAllResponseHeaders() / getResponseHeader() work.
          this.#syntheticHeaders = parts.headers;
        } catch {
          // Ignore property-definition failures — best-effort.
        }

        // LOADING → DONE
        this.#dispatchReadyState(XMLHttpRequest.DONE);

        this.dispatchEvent(new ProgressEvent('load'));
        this.dispatchEvent(new ProgressEvent('loadend'));

        // Handle once-removal after serving the response.
        if (spec.once) {
          onConsumedOnce(spec.id);
        }
      })();
    }

    /** Synthetic response headers storage. */
    #syntheticHeaders: Record<string, string> = {};

    override getAllResponseHeaders(): string {
      if (!this.#matched) return super.getAllResponseHeaders();
      return Object.entries(this.#syntheticHeaders)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n');
    }

    override getResponseHeader(name: string): string | null {
      if (!this.#matched) return super.getResponseHeader(name);
      const lower = name.toLowerCase();
      for (const [k, v] of Object.entries(this.#syntheticHeaders)) {
        if (k.toLowerCase() === lower) return v;
      }
      return null;
    }

    /** Fire a `readystatechange` event with the target `readyState`. */
    #dispatchReadyState(state: number): void {
      try {
        Object.defineProperty(this, 'readyState', { value: state, configurable: true });
      } catch {
        // best-effort
      }
      if (typeof this.onreadystatechange === 'function') {
        try {
          this.onreadystatechange(new Event('readystatechange'));
        } catch {
          // isolate page-code errors
        }
      }
      this.dispatchEvent(new Event('readystatechange'));
    }
  }

  return MockXMLHttpRequest as typeof XMLHttpRequest;
}

/* -------------------------------------------------------------------------- */
/*  Installer                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Install `window.fetch` and `XMLHttpRequest` monkeypatches. Matched requests
 * are short-circuited with synthetic responses (respecting `delayMs` and `once`).
 * Unmatched requests fall through to the saved native implementations.
 *
 * @param getSpecs   Called on every request to read the live spec list. This lets
 *                   callers update specs without reinstalling the patch.
 * @param onConsumedOnce  Called with `spec.id` after a `once: true` spec fires.
 * @returns  An uninstall function that restores native `fetch`/`XHR`.
 */
export function installFetchMock(
  getSpecs: () => FetchMockSpec[],
  onConsumedOnce: (id: string) => void,
): () => void {
  // Guard against non-browser environments (Node test runner without jsdom).
  if (typeof window === 'undefined') return () => undefined;

  // Save the ORIGINAL references so uninstall restores them by identity (tests +
  // callers compare `window.fetch === original`). A separate bound copy is used
  // only for internal fall-through calls — invoking `fetch` unbound throws
  // "Illegal invocation" in some engines.
  const originalFetch: typeof fetch = window.fetch;
  const boundNativeFetch: typeof fetch = window.fetch.bind(window);
  const NativeXHR = window.XMLHttpRequest;

  // Patched fetch.
  window.fetch = async function mockFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? (input as Request).method : undefined) ?? 'GET').toUpperCase();

    const spec = matchMock(getSpecs(), { method, url });
    if (!spec) {
      return boundNativeFetch(input, init);
    }

    const ms = spec.delayMs ?? 0;
    if (ms > 0) await delay(ms);

    const response = buildFetchResponse(spec);

    if (spec.once) {
      onConsumedOnce(spec.id);
    }

    return response;
  };

  // Patched XHR.
  const MockXHR = buildMockXHRClass(NativeXHR, getSpecs, onConsumedOnce);
  window.XMLHttpRequest = MockXHR;

  // Return uninstall function.
  return function uninstall(): void {
    if (typeof window === 'undefined') return;
    window.fetch = originalFetch;
    window.XMLHttpRequest = NativeXHR;
  };
}

/* -------------------------------------------------------------------------- */
/*  Module-level manager (used by the inspector)                              */
/* -------------------------------------------------------------------------- */

/**
 * Module-local puppeteer state. The inspector imports the four functions below
 * and never touches these variables directly.
 */
let _enabled = false;
let _specs: FetchMockSpec[] = [];
let _uninstall: (() => void) | null = null;

/**
 * Called when a `once` spec fires so it is removed from the local list. Main
 * process is notified separately via `onConsumedOnce`; we remove locally so
 * subsequent requests on the same page don't attempt to match the exhausted spec.
 */
function handleConsumedOnce(id: string): void {
  _specs = _specs.filter((s) => s.id !== id);
}

/**
 * Install the fetch/XHR monkeypatch. Idempotent — calling when already enabled
 * is a no-op. The manager keeps the uninstall handle so `disableMocking` can
 * cleanly restore the native implementations.
 */
export function enableMocking(): void {
  if (_enabled) return;
  _enabled = true;
  _uninstall = installFetchMock(() => _specs, handleConsumedOnce);
}

/**
 * Uninstall the monkeypatch and clear all active specs. The guest reverts to
 * native `fetch`/`XHR` immediately.
 */
export function disableMocking(): void {
  if (!_enabled) return;
  _enabled = false;
  if (_uninstall) {
    _uninstall();
    _uninstall = null;
  }
  _specs = [];
}

/**
 * Replace the active mock spec list. Safe to call whether or not mocking is
 * currently enabled — the list is applied immediately on the next request.
 */
export function setMocks(specs: FetchMockSpec[]): void {
  _specs = specs.slice(); // shallow copy so external mutations don't drift
}

/** Read the current active mock list (for introspection / testing). */
export function getMocks(): FetchMockSpec[] {
  return _specs.slice();
}

/* -------------------------------------------------------------------------- */
/*  Re-export types the inspector needs                                        */
/* -------------------------------------------------------------------------- */

export type { FetchMockSpec, JsonValue };
