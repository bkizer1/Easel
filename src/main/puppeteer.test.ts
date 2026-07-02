import { describe, it, expect, vi, beforeEach } from 'vitest';

// puppeteer.ts imports `electron` (webContents) and `@main/window` at module-load
// time; stub both so the module runs in a plain Node environment. `@main/policy`
// is mocked so we can drive the allow/deny verdict per test. No guest WebContents
// and a null main window make `dispatchToGuest` / `emitChanged` safe no-ops.
vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => [] },
}));
vi.mock('@main/window', () => ({
  getMainWindow: () => null,
}));

let mockVerdict: { allowed: boolean; reason?: string } = { allowed: true };
vi.mock('@main/policy', () => ({
  loadPolicy: () => ({ policy: { deny: [], requireConfirm: [] }, source: 'default' }),
  evaluatePuppeteer: () => mockVerdict,
}));

import {
  getState,
  setEnabled,
  setMock,
  removeMock,
  clearMocks,
  clearAll,
  setStateOverride,
  resync,
  buildPuppeteerCapability,
  disposePuppeteer,
} from './puppeteer';
import type { FetchMockSpec } from '@shared/puppeteer';

function mock(id: string, over: Partial<FetchMockSpec> = {}): FetchMockSpec {
  return { id, urlPattern: `/api/${id}`, ...over };
}

describe('puppeteer main module', () => {
  beforeEach(() => {
    mockVerdict = { allowed: true };
    disposePuppeteer(); // reset module state to empty between tests
  });

  it('starts disabled and empty', () => {
    const s = getState();
    expect(s.enabled).toBe(false);
    expect(s.mocks).toEqual([]);
    expect(s.overrides).toEqual([]);
  });

  describe('setEnabled', () => {
    it('enables when policy allows', () => {
      const { state, detail } = setEnabled(true, '/proj');
      expect(state.enabled).toBe(true);
      expect(state.policyBlockedReason).toBeUndefined();
      expect(detail).toBeUndefined();
    });

    it('stays disabled and surfaces the reason when policy blocks', () => {
      mockVerdict = { allowed: false, reason: 'blocked by policy' };
      const { state, detail } = setEnabled(true, '/proj');
      expect(state.enabled).toBe(false);
      expect(state.policyBlockedReason).toBe('blocked by policy');
      expect(detail).toBe('blocked by policy');
    });

    it('clears a prior policyBlockedReason once allowed again', () => {
      mockVerdict = { allowed: false, reason: 'nope' };
      setEnabled(true, '/proj');
      mockVerdict = { allowed: true };
      const { state } = setEnabled(true, '/proj');
      expect(state.enabled).toBe(true);
      expect(state.policyBlockedReason).toBeUndefined();
    });

    it('disables', () => {
      setEnabled(true, '/proj');
      const { state } = setEnabled(false, '/proj');
      expect(state.enabled).toBe(false);
    });
  });

  describe('mocks', () => {
    it('setMock upserts by id (replace, not duplicate)', () => {
      setMock(mock('a'));
      setMock(mock('b'));
      expect(getState().mocks.map((m) => m.id)).toEqual(['a', 'b']);
      setMock(mock('a', { status: 500 }));
      const mocks = getState().mocks;
      expect(mocks).toHaveLength(2);
      expect(mocks.find((m) => m.id === 'a')?.status).toBe(500);
    });

    it('removeMock removes a single mock', () => {
      setMock(mock('a'));
      setMock(mock('b'));
      removeMock('a');
      expect(getState().mocks.map((m) => m.id)).toEqual(['b']);
    });

    it('clearMocks clears mocks but keeps state overrides', () => {
      setMock(mock('a'));
      setStateOverride({ id: 'o1', selector: '.x', path: ['hooks', '0'], value: [] });
      clearMocks();
      expect(getState().mocks).toEqual([]);
      expect(getState().overrides).toHaveLength(1);
    });

    it('clearAll clears both mocks and overrides', () => {
      setMock(mock('a'));
      setStateOverride({ id: 'o1', selector: '.x', path: ['hooks', '0'], value: [] });
      clearAll();
      expect(getState().mocks).toEqual([]);
      expect(getState().overrides).toEqual([]);
    });
  });

  describe('setStateOverride', () => {
    it('upserts by id', () => {
      setStateOverride({ id: 'o1', selector: '.x', path: ['hooks', '0'], value: 1 });
      setStateOverride({ id: 'o1', selector: '.x', path: ['hooks', '0'], value: 2 });
      const overrides = getState().overrides;
      expect(overrides).toHaveLength(1);
      expect(overrides[0].value).toBe(2);
    });
  });

  describe('buildPuppeteerCapability', () => {
    it('isEnabled reflects live module state', () => {
      const cap = buildPuppeteerCapability('/proj');
      expect(cap.isEnabled()).toBe(false);
      setEnabled(true, '/proj');
      expect(cap.isEnabled()).toBe(true);
    });

    it('allowed() reflects the policy verdict', () => {
      const cap = buildPuppeteerCapability('/proj');
      expect(cap.allowed()).toEqual({ ok: true });
      mockVerdict = { allowed: false, reason: 'nope' };
      expect(cap.allowed()).toEqual({ ok: false, reason: 'nope' });
    });

    it('setMock / setStateOverride / clearMocks delegate to module state', () => {
      const cap = buildPuppeteerCapability('/proj');
      cap.setMock(mock('z'));
      expect(getState().mocks.map((m) => m.id)).toEqual(['z']);
      cap.setStateOverride({ id: 'ov', selector: '.y', path: ['hooks', '0'], value: null });
      expect(getState().overrides.map((o) => o.id)).toEqual(['ov']);
      cap.clearMocks();
      expect(getState().mocks).toEqual([]);
    });

    it('genId returns distinct non-empty strings', () => {
      const cap = buildPuppeteerCapability('/proj');
      const a = cap.genId();
      const b = cap.genId();
      expect(typeof a).toBe('string');
      expect(a.length).toBeGreaterThan(0);
      expect(a).not.toBe(b);
    });
  });

  it('resync is a no-op when disabled and never throws', () => {
    expect(() => resync('/proj')).not.toThrow();
    expect(getState().enabled).toBe(false);
  });
});
