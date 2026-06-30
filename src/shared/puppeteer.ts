/**
 * Easel — Live State Puppeteer contract (issue #17).
 *
 * A structured, fully-typed surface for driving the running app into hard-to-reach
 * states *without writing source*: override a component's framework state
 * ("show the empty-cart state") and intercept `fetch`/XHR to fake API responses
 * ("pretend the API returns 50 items").
 *
 * There is deliberately **NO arbitrary eval** — every operation is a validated,
 * JSON-serializable record (the "structured mutations only" decision for #17), so
 * the entire surface is auditable. It is gated two ways: an explicit per-session
 * user opt-in (the puppeteer toggle) and the `.easel/policy.json` trust policy
 * (`allowStatePuppeteer`), both enforced in the main process.
 *
 * Pure types — no runtime logic, no Electron imports. Shared by the guest
 * inspector (which executes the ops), the main dispatcher + agent tool (which
 * owns authoritative state), and the renderer panel (which reflects it).
 */

/** A JSON-serializable value — mock response bodies and state-override values. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** How a mock's `urlPattern` is matched against an outbound request URL. */
export type UrlMatchMode = 'substring' | 'glob' | 'exact';

/**
 * A single fetch/XHR interception rule. The guest's monkeypatch matches each
 * outbound request against the active specs (in list order, first match wins)
 * and, on a match, short-circuits with this canned response instead of letting
 * the request hit the network.
 */
export interface FetchMockSpec {
  /** Stable id (the tool/agent supplies one; used to replace or remove a mock). */
  id: string;
  /** HTTP method to match, case-insensitive. Omit (or `'ANY'`) to match any method. */
  method?: string;
  /** Pattern matched against the full request URL per {@link match}. */
  urlPattern: string;
  /** How `urlPattern` is interpreted. Default: `'substring'`. */
  match?: UrlMatchMode;
  /** Response status code. Default: `200`. */
  status?: number;
  /** Response status text. Default derived from `status`. */
  statusText?: string;
  /**
   * JSON response body. When set, the response carries
   * `content-type: application/json` unless `headers` overrides it.
   */
  jsonBody?: JsonValue;
  /** Raw text response body (ignored when `jsonBody` is set). */
  textBody?: string;
  /** Extra response headers (merged over the defaults). */
  headers?: Record<string, string>;
  /** Artificial latency before the response resolves, in ms. Default `0`. */
  delayMs?: number;
  /** When true, the mock fires once then auto-removes from the active set. */
  once?: boolean;
  /** Optional human label for the panel (e.g. `"50 products"`). */
  label?: string;
}

/**
 * A structured framework-state override applied to the element matching
 * `selector` (reuses the State X-Ray fiber tap). Ephemeral — lost on full reload;
 * recorded by main only so the panel can show what was changed. Baking it into a
 * durable change is a normal source edit (protected by a checkpoint).
 */
export interface StateOverride {
  /** Stable id (supplied, or a hash of selector+path). */
  id: string;
  /** Robust CSS selector for the target element. */
  selector: string;
  /** Machine path into the element's serialized state, e.g. `['state','items']`. */
  path: string[];
  /** The JSON value to write. */
  value: JsonValue;
  /** Optional human label for the panel. */
  label?: string;
}

/**
 * The authoritative puppeteer state, owned by the main process and mirrored to
 * the renderer via the `puppeteer.changed` push channel.
 */
export interface PuppeteerState {
  /** Whether the user has opted in (the guest fetch/XHR monkeypatch is installed). */
  enabled: boolean;
  /** Active fetch/XHR mocks, in application order (first match wins). */
  mocks: FetchMockSpec[];
  /**
   * State overrides applied this session (best-effort record for the panel; not
   * automatically reverted — a reload restores the app's real state).
   */
  overrides: StateOverride[];
  /**
   * Set when `.easel/policy.json` blocks puppeteer entirely; the toggle is
   * disabled and `enabled` is forced false. Undefined when puppeteer is allowed.
   */
  policyBlockedReason?: string;
}

/** An empty puppeteer state (puppeteer off, nothing active). Allowed by policy. */
export const EMPTY_PUPPETEER_STATE: PuppeteerState = {
  enabled: false,
  mocks: [],
  overrides: [],
};
