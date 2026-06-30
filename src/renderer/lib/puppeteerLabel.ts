/**
 * Easel — puppeteer panel label helpers (issue #17).
 *
 * Pure formatting for the PuppeteerPanel's mock and override rows. Factored
 * out of the component so the exact output is unit-testable without rendering.
 */

import type { FetchMockSpec, StateOverride } from '@shared/puppeteer';

/**
 * One-line summary of a {@link FetchMockSpec} for the panel's mock list:
 *
 *   METHOD urlPattern → status [label]
 *
 * When a `label` is set, it is appended in parentheses. The method defaults
 * to `'ANY'` when omitted. The status defaults to `200`.
 *
 * @example
 *   describeMock({ id: '1', urlPattern: '/api/products', method: 'GET', status: 200, label: '50 items' })
 *   // → 'GET /api/products → 200 (50 items)'
 *
 * @example
 *   describeMock({ id: '2', urlPattern: '/api/cart' })
 *   // → 'ANY /api/cart → 200'
 */
export function describeMock(spec: FetchMockSpec): string {
  const method = spec.method ? spec.method.toUpperCase() : 'ANY';
  const status = spec.status ?? 200;
  const base = `${method} ${spec.urlPattern} → ${status}`;
  return spec.label ? `${base} (${spec.label})` : base;
}

/**
 * One-line summary of a {@link StateOverride} for the panel's overrides list:
 *
 *   selector › path.joined [label]
 *
 * The path segments are joined with `.` for readability. When a `label` is
 * set, it is appended in parentheses.
 *
 * @example
 *   describeOverride({ id: '1', selector: '.Cart', path: ['state','items'], value: [], label: 'empty cart' })
 *   // → '.Cart › state.items (empty cart)'
 *
 * @example
 *   describeOverride({ id: '2', selector: '#count', path: ['props','value'], value: 0 })
 *   // → '#count › props.value'
 */
export function describeOverride(override: StateOverride): string {
  const pathStr = override.path.join('.');
  const base = `${override.selector} › ${pathStr}`;
  return override.label ? `${base} (${override.label})` : base;
}
