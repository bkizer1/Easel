/**
 * Tests for the main-driven time-travel state capture (State X-Ray, issue #13).
 *
 * `captureStateSnapshot` round-trips a `snapshot-state` command to the guest and
 * awaits its reply on a dedicated up-channel. Its contract is "best-effort and
 * total": it ALWAYS resolves to a valid {@link SerializedValue}, NEVER throws,
 * and NEVER blocks past the timeout — so a hiccup in the snapshot side-channel
 * can never fail or stall the checkpoint/edit pipeline that drives it.
 *
 * `stateCapture.ts` imports `electron` at module top, so — following the same
 * approach as the other main tests — `electron`, `@main/window`, and the logger
 * are mocked with a tiny in-memory `ipcMain` emitter and a swappable guest.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

/** Up-channel the guest replies on (mirrors the private const in stateCapture.ts). */
const REPLY_CHANNEL = 'inspector-state-snapshot';
/** Down-channel the inspector command is sent on. */
const COMMAND_CHANNEL = 'inspector-command';

interface FakeGuest {
  id: number;
  isDestroyed: () => boolean;
  isDevToolsOpened: () => boolean;
  send: (channel: string, cmd: { type: string; requestId: string }) => void;
  lastCommand?: { type: string; requestId: string };
  failSend?: boolean;
}

const h = vi.hoisted(() => {
  type Listener = (event: unknown, payload: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();

  const ipcMain = {
    on(channel: string, fn: Listener): void {
      if (!listeners.has(channel)) listeners.set(channel, new Set());
      listeners.get(channel)!.add(fn);
    },
    removeListener(channel: string, fn: Listener): void {
      listeners.get(channel)?.delete(fn);
    },
    /** Test helper: deliver a payload to every listener on a channel. */
    _emit(channel: string, payload: unknown): void {
      for (const fn of [...(listeners.get(channel) ?? [])]) fn({}, payload);
    },
    /** Test helper: how many listeners remain (leak check). */
    _count(channel: string): number {
      return listeners.get(channel)?.size ?? 0;
    },
  };

  const state: { guest: FakeGuest | null; mainDestroyed: boolean } = {
    guest: null,
    mainDestroyed: false,
  };

  const MAIN_WC_ID = 1;
  const webContents = {
    getAllWebContents(): unknown[] {
      // The main window's WebContents is always present and must be filtered out
      // by findGuestWebContents (same id as the main window's webContents).
      const list: unknown[] = [{ id: MAIN_WC_ID, isDevToolsOpened: () => false }];
      if (state.guest) list.push(state.guest);
      return list;
    },
  };

  return { ipcMain, webContents, state, MAIN_WC_ID };
});

vi.mock('electron', () => ({ ipcMain: h.ipcMain, webContents: h.webContents }));
vi.mock('@main/window', () => ({
  getMainWindow: () =>
    h.state.mainDestroyed
      ? null
      : { isDestroyed: () => false, webContents: { id: h.MAIN_WC_ID } },
}));
vi.mock('@main/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}));

import { captureStateSnapshot } from '@main/stateCapture';

const EMPTY = { kind: 'object', entries: [], truncated: false };

function makeGuest(overrides: Partial<FakeGuest> = {}): FakeGuest {
  const guest: FakeGuest = {
    id: 99,
    isDestroyed: () => false,
    isDevToolsOpened: () => false,
    send(channel, cmd) {
      if (guest.failSend) throw new Error('renderer gone');
      if (channel === COMMAND_CHANNEL) guest.lastCommand = cmd;
    },
    ...overrides,
  };
  return guest;
}

describe('captureStateSnapshot', () => {
  beforeEach(() => {
    h.state.guest = null;
    h.state.mainDestroyed = false;
  });

  it('resolves to a minimal empty snapshot when no guest WebContents exists', async () => {
    h.state.guest = null;
    await expect(captureStateSnapshot(1000)).resolves.toEqual(EMPTY);
    // No listener should be left registered on the no-guest fast path.
    expect(h.ipcMain._count(REPLY_CHANNEL)).toBe(0);
  });

  it('returns empty (never throws) when there is no main window', async () => {
    h.state.mainDestroyed = true;
    h.state.guest = makeGuest();
    await expect(captureStateSnapshot(1000)).resolves.toEqual(EMPTY);
  });

  it('resolves with the guest reply correlated by requestId', async () => {
    const guest = makeGuest();
    h.state.guest = guest;

    const promise = captureStateSnapshot(1000);
    // The command is sent synchronously inside the Promise executor.
    expect(guest.lastCommand?.type).toBe('snapshot-state');
    const requestId = guest.lastCommand!.requestId;

    const data = {
      kind: 'object',
      entries: [{ key: 'react', value: { kind: 'number', value: 1 } }],
      truncated: false,
    };
    h.ipcMain._emit(REPLY_CHANNEL, { requestId, data });

    await expect(promise).resolves.toEqual(data);
    // Listener cleaned up after resolution (no leak across captures).
    expect(h.ipcMain._count(REPLY_CHANNEL)).toBe(0);
  });

  it('ignores a stale reply with a mismatched requestId, then degrades on timeout', async () => {
    const guest = makeGuest();
    h.state.guest = guest;

    const promise = captureStateSnapshot(20);
    h.ipcMain._emit(REPLY_CHANNEL, {
      requestId: 'some-other-capture',
      data: { kind: 'string', value: 'stale' },
    });

    // The mismatched reply must not resolve the capture; the timeout wins.
    await expect(promise).resolves.toEqual(EMPTY);
    expect(h.ipcMain._count(REPLY_CHANNEL)).toBe(0);
  });

  it('degrades to empty on timeout when the guest never replies', async () => {
    h.state.guest = makeGuest();
    await expect(captureStateSnapshot(15)).resolves.toEqual(EMPTY);
    expect(h.ipcMain._count(REPLY_CHANNEL)).toBe(0);
  });

  it('never throws and resolves to empty when guest.send throws', async () => {
    h.state.guest = makeGuest({ failSend: true });
    await expect(captureStateSnapshot(1000)).resolves.toEqual(EMPTY);
    expect(h.ipcMain._count(REPLY_CHANNEL)).toBe(0);
  });
});
