/**
 * Unit tests for the puppeteer panel label helpers (issue #17).
 *
 * Pure formatting — no Electron, no DOM. Fast vitest run.
 */

import { describe, it, expect } from 'vitest';
import { describeMock, describeOverride } from './puppeteerLabel';
import type { FetchMockSpec, StateOverride } from '@shared/puppeteer';

/* -------------------------------------------------------------------------- */
/*  describeMock                                                               */
/* -------------------------------------------------------------------------- */

describe('describeMock', () => {
  it('formats a fully-specified mock', () => {
    const spec: FetchMockSpec = {
      id: '1',
      method: 'GET',
      urlPattern: '/api/products',
      status: 200,
      label: '50 items',
    };
    expect(describeMock(spec)).toBe('GET /api/products → 200 (50 items)');
  });

  it('defaults method to ANY when omitted', () => {
    const spec: FetchMockSpec = { id: '2', urlPattern: '/api/cart' };
    expect(describeMock(spec)).toBe('ANY /api/cart → 200');
  });

  it('defaults status to 200 when omitted', () => {
    const spec: FetchMockSpec = { id: '3', method: 'POST', urlPattern: '/api/checkout' };
    expect(describeMock(spec)).toBe('POST /api/checkout → 200');
  });

  it('uppercases the method', () => {
    const spec: FetchMockSpec = { id: '4', method: 'delete', urlPattern: '/api/item/1', status: 204 };
    expect(describeMock(spec)).toBe('DELETE /api/item/1 → 204');
  });

  it('omits the label parenthetical when label is undefined', () => {
    const spec: FetchMockSpec = { id: '5', method: 'PUT', urlPattern: '/api/user', status: 201 };
    expect(describeMock(spec)).toBe('PUT /api/user → 201');
  });

  it('includes label in parentheses when present', () => {
    const spec: FetchMockSpec = {
      id: '6',
      urlPattern: '/api/search',
      status: 500,
      label: 'server error',
    };
    expect(describeMock(spec)).toBe('ANY /api/search → 500 (server error)');
  });

  it('handles an empty string label gracefully (shows parentheses)', () => {
    // An empty label is still appended — authors who set label='' opted in.
    const spec: FetchMockSpec = { id: '7', urlPattern: '/api/x', label: '' };
    // An empty label is falsy, so it is treated the same as undefined.
    expect(describeMock(spec)).toBe('ANY /api/x → 200');
  });
});

/* -------------------------------------------------------------------------- */
/*  describeOverride                                                           */
/* -------------------------------------------------------------------------- */

describe('describeOverride', () => {
  it('formats a fully-specified override', () => {
    const override: StateOverride = {
      id: '1',
      selector: '.Cart',
      path: ['state', 'items'],
      value: [],
      label: 'empty cart',
    };
    expect(describeOverride(override)).toBe('.Cart › state.items (empty cart)');
  });

  it('omits the label parenthetical when label is undefined', () => {
    const override: StateOverride = {
      id: '2',
      selector: '#count',
      path: ['props', 'value'],
      value: 0,
    };
    expect(describeOverride(override)).toBe('#count › props.value');
  });

  it('joins a single-segment path without a dot separator', () => {
    const override: StateOverride = {
      id: '3',
      selector: 'header',
      path: ['title'],
      value: 'Hello',
    };
    expect(describeOverride(override)).toBe('header › title');
  });

  it('joins a deep multi-segment path with dots', () => {
    const override: StateOverride = {
      id: '4',
      selector: '.App',
      path: ['state', 'user', 'profile', 'name'],
      value: 'Blake',
      label: 'rename user',
    };
    expect(describeOverride(override)).toBe('.App › state.user.profile.name (rename user)');
  });

  it('handles an empty path array (edge case — produces empty joined string)', () => {
    const override: StateOverride = {
      id: '5',
      selector: 'div',
      path: [],
      value: null,
    };
    // path.join('.') of [] is ''. We render what we have.
    expect(describeOverride(override)).toBe('div › ');
  });
});
