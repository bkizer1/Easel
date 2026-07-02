/**
 * Easel — main-driven time-travel state capture (State X-Ray, issue #13).
 *
 * The spec requires a `snapshot-state` capture fired BEFORE a checkpoint is
 * created, keyed by the resulting checkpoint id, captured UNCONDITIONALLY (no
 * element need be inspected). The guest inspector owns the only cycle-safe view
 * of the page's framework/app state, so MAIN drives the capture by:
 *
 *   1. locating the guest `<webview>` WebContents (same technique as
 *      `capturePreview` / the network tap),
 *   2. sending it an `inspector-command` of type `snapshot-state` (the guest
 *      already listens on that channel via `ipcRenderer.on`), and
 *   3. awaiting the guest's reply on a dedicated up-channel that reaches
 *      `ipcMain.on` (the guest replies via `ipcRenderer.send`, distinct from the
 *      `sendToHost` path that goes to the renderer).
 *
 * The round-trip is bounded by a short timeout and is STRICTLY best-effort: any
 * failure (no guest, no reply, timeout) resolves to a minimal-but-valid snapshot
 * so the caller can still persist a usable, diffable tree. It NEVER throws and
 * NEVER blocks the edit pipeline beyond the timeout.
 */

import { ipcMain, webContents as WebContentsRegistry } from 'electron';
import type { WebContents } from 'electron';
import type { InspectorCommand } from '@shared/ipc';
import type { SerializedValue } from '@shared/xray';
import { getMainWindow } from '@main/window';
import { createLogger } from '@main/logger';

const log = createLogger('state-capture');

/** Inbound channel main listens on for the guest's `state-snapshot` reply. */
const SNAPSHOT_REPLY_CHANNEL = 'inspector-state-snapshot';

/** Outbound channel the guest inspector listens on (matches the preload). */
const INSPECTOR_COMMAND_CHANNEL = 'inspector-command';

/** Default round-trip budget. Degrades gracefully past this — never blocks. */
const DEFAULT_TIMEOUT_MS = 500;

/** A minimal but valid snapshot tree, used when no state could be captured. */
function emptySnapshotData(): SerializedValue {
  return { kind: 'object', entries: [], truncated: false };
}

/**
 * Locate the guest `<webview>` WebContents — the first non-main, non-devtools
 * WebContents attached to the app (same heuristic as `capturePreview` and the
 * network tap). Returns null when no preview is loaded.
 */
function findGuestWebContents(): WebContents | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;
  const all = WebContentsRegistry.getAllWebContents();
  const guests = all.filter((wc) => wc.id !== win.webContents.id && !wc.isDevToolsOpened());
  return guests.length > 0 ? guests[0] : null;
}

/** Monotonic counter so concurrent captures don't collide on requestId. */
let _requestCounter = 0;

/**
 * Request a bounded time-travel state snapshot from the guest inspector and await
 * its reply, bounded by `timeoutMs`. Best-effort and total: resolves to a valid
 * {@link SerializedValue} either way (the guest's reply, or a minimal empty tree
 * on no-guest / timeout / error). Never throws; never blocks past the timeout.
 */
export async function captureStateSnapshot(
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<SerializedValue> {
  const guest = findGuestWebContents();
  if (!guest || guest.isDestroyed()) {
    return emptySnapshotData();
  }

  const requestId = `snap-${Date.now()}-${++_requestCounter}`;

  return new Promise<SerializedValue>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      ipcMain.removeListener(SNAPSHOT_REPLY_CHANNEL, onReply);
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const finish = (data: SerializedValue): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(data);
    };

    // The guest replies with { requestId, data }. Correlate by requestId so a
    // stale reply from a previous capture can never resolve this one.
    function onReply(
      _event: Electron.IpcMainEvent,
      payload: { requestId?: string; data?: SerializedValue },
    ): void {
      if (!payload || payload.requestId !== requestId) return;
      finish(payload.data ?? emptySnapshotData());
    }

    ipcMain.on(SNAPSHOT_REPLY_CHANNEL, onReply);

    timer = setTimeout(() => {
      log.info('Snapshot capture timed out; using empty snapshot', { requestId });
      finish(emptySnapshotData());
    }, Math.max(1, timeoutMs));

    try {
      const cmd: InspectorCommand = { type: 'snapshot-state', requestId };
      guest.send(INSPECTOR_COMMAND_CHANNEL, cmd);
    } catch (err) {
      log.warn('Failed to send snapshot-state to guest', { err: String(err) });
      finish(emptySnapshotData());
    }
  });
}
