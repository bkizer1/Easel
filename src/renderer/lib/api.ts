/**
 * Easel Renderer — typed window.easel accessor and event-subscription hook.
 *
 * The renderer NEVER imports ipcRenderer directly (contextIsolation: ON).
 * All privileged operations go through `window.easel`, the typed EaselApi
 * surface exposed by the host preload script via contextBridge.
 *
 * Exports:
 *   - `easel`: typed reference to window.easel (EaselApi).
 *   - `useEaselEvent`: React hook for subscribing to push-channel events with
 *     automatic cleanup on unmount.
 */

import { useEffect } from 'react';
import type { EaselApi, Unsubscribe } from '@shared/ipc';

/**
 * Typed reference to the preload-exposed API. window.easel is installed by
 * the host preload before the renderer's first render cycle, so this cast is
 * safe at runtime inside Electron. In a test environment the caller is
 * responsible for mocking `window.easel`.
 */
export const easel: EaselApi = (window as unknown as { easel: EaselApi }).easel;

/**
 * Subscribe to a push-channel event exposed on `window.easel` and
 * automatically unsubscribe when the calling component unmounts or when
 * `handler` changes identity.
 *
 * `handler` should be stable (created with `useCallback`) if it closes over
 * component state, to avoid re-subscribing on every render.
 *
 * @param subscribe - A wrapper that calls the desired `on*` method and returns
 *                    its `Unsubscribe` handle. E.g.:
 *                    `(h) => easel.edit.onEvent(h)`
 * @param handler   - Callback invoked for each inbound event payload.
 *
 * @example
 * useEaselEvent(
 *   (h) => easel.edit.onEvent(h),
 *   useCallback(({ event }) => applyAgentEvent(event), [applyAgentEvent]),
 * );
 */
export function useEaselEvent<T>(
  subscribe: (handler: (payload: T) => void) => Unsubscribe,
  handler: (payload: T) => void,
): void {
  useEffect(() => {
    const unsub = subscribe(handler);
    return unsub;
    // subscribe is structurally stable at call sites (inline arrow).
    // handler is the meaningful dep; include it so callers can swap handlers.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handler]);
}
