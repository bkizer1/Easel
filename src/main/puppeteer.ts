/**
 * Easel — Live State Puppeteer main-process module (issue #17).
 *
 * Owns the authoritative {@link PuppeteerState} (in-memory, ephemeral, reset on
 * app restart) and is the single point that dispatches {@link InspectorCommand}s
 * to the guest WebContents. All mutations go through the exported API; callers
 * never write state directly.
 *
 * Architecture:
 *  - State lives here; the renderer only holds a mirror (via `puppeteer.changed`).
 *  - Guest commands are sent via `guestWc.send('inspector-command', cmd)` — the
 *    SAME channel constant (`IN_CHANNEL`) used by the host renderer for its own
 *    commands; both paths land on the same handler in the guest inspector.
 *  - Policy is evaluated on every `setEnabled(true)` call so a freshly-committed
 *    policy file takes effect immediately without a restart.
 */

import { randomUUID } from 'node:crypto';
import { webContents as WebContentsRegistry } from 'electron';
import type { WebContents } from 'electron';
import { IpcChannels } from '@shared/ipc';
import type { InspectorCommand, PuppeteerChangedPayload } from '@shared/ipc';
import {
  EMPTY_PUPPETEER_STATE,
  type FetchMockSpec,
  type PuppeteerState,
  type StateOverride,
} from '@shared/puppeteer';
import type { PuppeteerCapability } from '@main/agents/tools';
import { getMainWindow } from '@main/window';
import { loadPolicy, evaluatePuppeteer } from '@main/policy';
import { createLogger } from '@main/logger';

const log = createLogger('puppeteer');

/* -------------------------------------------------------------------------- */
/*  Module state                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Authoritative in-memory puppeteer state.  Reset on app restart (ephemeral by
 * design — a reload restores the app's real state).
 */
let state: PuppeteerState = { ...EMPTY_PUPPETEER_STATE, mocks: [], overrides: [] };

/* -------------------------------------------------------------------------- */
/*  Guest WebContents lookup (mirrors networkTap's technique)                 */
/* -------------------------------------------------------------------------- */

/**
 * Find the guest `<webview>` WebContents — the first non-main, non-devtools
 * WebContents registered in the process.  Reuses the same technique as
 * `networkTap.ts` (which cannot be exported from there without broader refactor;
 * the function is small enough to replicate rather than create an unnecessary
 * coupling between unrelated modules).
 *
 * Returns `null` when no preview is loaded (no guest WebContents present).
 */
function findGuestWebContents(): WebContents | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  const all = WebContentsRegistry.getAllWebContents();
  const guests = all.filter(
    (wc) => wc.id !== win.webContents.id && !wc.isDevToolsOpened(),
  );
  return guests.length > 0 ? guests[0] : null;
}

/* -------------------------------------------------------------------------- */
/*  Guest dispatch                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Send an {@link InspectorCommand} directly to the guest WebContents.
 *
 * Channel string: `'inspector-command'` — this is the guest's `IN_CHANNEL`
 * constant (hard-coded in `src/preload/webview/inspector.ts`). Both main and
 * the host renderer send on this literal; the guest handler is the same.
 */
function dispatchToGuest(cmd: InspectorCommand): void {
  const guestWc = findGuestWebContents();
  if (!guestWc || guestWc.isDestroyed()) {
    log.debug('dispatchToGuest: no guest WebContents; command deferred until next resync', {
      type: cmd.type,
    });
    return;
  }
  // 'inspector-command' matches IN_CHANNEL in the guest inspector (issue #17).
  guestWc.send('inspector-command', cmd);
  log.debug('Dispatched inspector command to guest', { type: cmd.type });
}

/* -------------------------------------------------------------------------- */
/*  Renderer push (puppeteer.changed)                                         */
/* -------------------------------------------------------------------------- */

/** Push the current state to the renderer. Guards against a destroyed window. */
function emitChanged(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const payload: PuppeteerChangedPayload = { state };
  win.webContents.send(IpcChannels.puppeteerChanged, payload);
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Return the current authoritative puppeteer state (a reference — do not mutate). */
export function getState(): PuppeteerState {
  return state;
}

/**
 * Opt in or out of Live State Puppeteer.
 *
 * On enable: loads the project policy and calls {@link evaluatePuppeteer}. When
 * the policy blocks it, `state.policyBlockedReason` is set, `enabled` stays
 * `false`, and `detail` in the return value carries the human reason. On
 * success: installs the guest monkeypatch + pushes the current mock set.
 *
 * On disable: uninstalls the guest monkeypatch.
 *
 * @param enabled  Desired enabled state.
 * @param projectRoot  Absolute project root used to load `.easel/policy.json`.
 */
export function setEnabled(
  enabled: boolean,
  projectRoot: string,
): { state: PuppeteerState; detail?: string } {
  if (!enabled) {
    state = { ...state, enabled: false };
    dispatchToGuest({ type: 'puppeteer-enable', enabled: false });
    emitChanged();
    log.info('Puppeteer disabled');
    return { state };
  }

  // Evaluate policy before enabling.
  const loaded = loadPolicy(projectRoot);
  const verdict = evaluatePuppeteer(loaded);

  if (!verdict.allowed) {
    const reason = verdict.reason ?? 'State Puppeteer is blocked by policy.';
    state = { ...state, enabled: false, policyBlockedReason: reason };
    emitChanged();
    log.warn('Puppeteer enable blocked by policy', { reason });
    return { state, detail: reason };
  }

  // Policy cleared — enable.
  state = { ...state, enabled: true, policyBlockedReason: undefined };
  dispatchToGuest({ type: 'puppeteer-enable', enabled: true });
  dispatchToGuest({ type: 'puppeteer-set-mocks', mocks: state.mocks });
  emitChanged();
  log.info('Puppeteer enabled');
  return { state };
}

/**
 * Upsert a fetch-mock spec (replace if same `id`, append otherwise).  Pushes the
 * updated full mock list to the guest.
 */
export function setMock(spec: FetchMockSpec): void {
  const existing = state.mocks.findIndex((m) => m.id === spec.id);
  const mocks =
    existing >= 0
      ? state.mocks.map((m, i) => (i === existing ? spec : m))
      : [...state.mocks, spec];
  state = { ...state, mocks };
  dispatchToGuest({ type: 'puppeteer-set-mocks', mocks: state.mocks });
  emitChanged();
  log.info('Mock upserted', { id: spec.id, urlPattern: spec.urlPattern });
}

/** Remove the mock with `id` from the active set and re-push the list. */
export function removeMock(id: string): void {
  state = { ...state, mocks: state.mocks.filter((m) => m.id !== id) };
  dispatchToGuest({ type: 'puppeteer-set-mocks', mocks: state.mocks });
  emitChanged();
  log.info('Mock removed', { id });
}

/**
 * Clear all active mocks and recorded state overrides (stays enabled).  Pushes
 * an empty mock list to the guest.
 */
export function clearAll(): void {
  state = { ...state, mocks: [], overrides: [] };
  dispatchToGuest({ type: 'puppeteer-set-mocks', mocks: [] });
  emitChanged();
  log.info('Puppeteer mocks + overrides cleared');
}

/**
 * Remove all active fetch mocks but keep recorded state overrides (the focused
 * counterpart to {@link clearAll}, used by the agent tool's `clear_mocks` action).
 */
export function clearMocks(): void {
  state = { ...state, mocks: [] };
  dispatchToGuest({ type: 'puppeteer-set-mocks', mocks: [] });
  emitChanged();
  log.info('Puppeteer mocks cleared');
}

/**
 * Apply a structured state override (upsert by `id`) and dispatch it to the
 * guest as a one-shot `puppeteer-set-state` command.  The override is recorded
 * in state for the panel; it is NOT automatically re-dispatched on reload (a
 * reload restores real state).
 */
export function setStateOverride(override: StateOverride): void {
  const existing = state.overrides.findIndex((o) => o.id === override.id);
  const overrides =
    existing >= 0
      ? state.overrides.map((o, i) => (i === existing ? override : o))
      : [...state.overrides, override];
  state = { ...state, overrides };
  dispatchToGuest({
    type: 'puppeteer-set-state',
    selector: override.selector,
    path: override.path,
    value: override.value,
  });
  emitChanged();
  log.info('State override applied', { id: override.id, selector: override.selector });
}

/**
 * Re-push the active enabled state + mock list into a freshly (re)loaded guest.
 *
 * Called by the renderer (or the IPC handler) when the guest emits
 * `inspector-ready` after an HMR/reload cycle, so mocks survive without the
 * user toggling puppeteer off and on again.
 *
 * State overrides are intentionally NOT re-dispatched: the component that was
 * being overridden may no longer exist post-reload, and the values displayed in
 * the panel are already marked as ephemeral.
 *
 * @param projectRoot  Optional; re-evaluates policy when supplied and puppeteer
 *   is currently enabled, so a policy change that happened mid-session takes
 *   effect immediately.
 */
export function resync(projectRoot?: string): void {
  if (!state.enabled) {
    log.debug('resync: puppeteer is off; nothing to re-push');
    return;
  }

  // If a root is provided, re-check policy (non-blocking; fail-open on error).
  if (projectRoot) {
    try {
      const loaded = loadPolicy(projectRoot);
      const verdict = evaluatePuppeteer(loaded);
      if (!verdict.allowed) {
        const reason = verdict.reason ?? 'State Puppeteer is blocked by policy.';
        state = { ...state, enabled: false, policyBlockedReason: reason };
        dispatchToGuest({ type: 'puppeteer-enable', enabled: false });
        emitChanged();
        log.warn('Puppeteer disabled during resync due to policy change', { reason });
        return;
      }
    } catch (err) {
      log.warn('resync: policy re-check failed; continuing with current state', {
        err: String(err),
      });
    }
  }

  dispatchToGuest({ type: 'puppeteer-enable', enabled: true });
  dispatchToGuest({ type: 'puppeteer-set-mocks', mocks: state.mocks });
  log.info('Puppeteer resynced to guest', { mockCount: state.mocks.length });
}

/**
 * Build the {@link PuppeteerCapability} injected into the agent tool executor so
 * the `set_app_state` tool can drive this module across every backend. The
 * enabled + policy checks are evaluated lazily on each call, so a mid-session
 * toggle or `.easel/policy.json` change is honoured without rebuilding the tool
 * context.
 *
 * @param projectRoot  Absolute project root used to (re)load `.easel/policy.json`.
 */
export function buildPuppeteerCapability(projectRoot: string): PuppeteerCapability {
  return {
    isEnabled: () => state.enabled,
    allowed: () => {
      const verdict = evaluatePuppeteer(loadPolicy(projectRoot));
      return verdict.allowed ? { ok: true } : { ok: false, reason: verdict.reason };
    },
    setMock: (spec) => setMock(spec),
    setStateOverride: (override) => setStateOverride(override),
    clearMocks: () => clearMocks(),
    genId: () => randomUUID(),
  };
}

/**
 * Dispose puppeteer state on app quit.  Resets to the empty state and (best-
 * effort) sends a disable command to the guest if one is still reachable.
 * No-op when no guest is present.
 */
export function disposePuppeteer(): void {
  if (state.enabled) {
    dispatchToGuest({ type: 'puppeteer-enable', enabled: false });
  }
  state = { ...EMPTY_PUPPETEER_STATE, mocks: [], overrides: [] };
  log.info('Puppeteer disposed');
}
