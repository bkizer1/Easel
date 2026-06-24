/**
 * Easel — tiny constructors for the {@link IpcResult} discriminated union.
 *
 * Importing these avoids the sharp edge of hand-building results — e.g. writing
 * `{ ok: true }` for a `void` payload (a type error) instead of
 * `{ ok: true, value: undefined }`. Runtime-only helpers with no Electron/Node
 * imports; safe to use from main, preload, or renderer.
 */
import type { IpcResult } from './ipc';

/** Wrap a successful value. */
export function ok<T>(value: T): IpcResult<T> {
  return { ok: true, value };
}

/** Successful result for a `void` channel. */
export function okVoid(): IpcResult<void> {
  return { ok: true, value: undefined };
}

/** Wrap a failure with a message and optional stable code. */
export function fail(error: string, code?: string): IpcResult<never> {
  return { ok: false, error, code };
}
