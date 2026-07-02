/**
 * Easel Renderer — Responsive Matrix presets & frame assembly (issue #14).
 *
 * The Responsive Matrix renders the dev-server URL in several stacked
 * `<webview>`s at fixed breakpoint widths. On submit each visible breakpoint is
 * captured and the results are assembled into the {@link ResponsiveFrame}[] that
 * rides along on the {@link EditRequest}, so the agent can fix responsive CSS at
 * one breakpoint without regressing the others.
 *
 * This module holds the pure, framework-free pieces (preset table + capture
 * assembly) so they can be unit-tested without React, Electron, or a webview.
 */

import type { ResponsiveFrame } from '@shared/types';

/** One breakpoint column in the Responsive Matrix. */
export interface MatrixFrameDef {
  /** Stable id used for active-frame selection and the live webview registry. */
  id: string;
  /** Human-readable label shown on the frame header. */
  label: string;
  /** CSS px width this frame is rendered (and captured) at. */
  width: number;
}

/**
 * Breakpoints shown in the Responsive Matrix, widest → narrowest. Mirrors the
 * Desktop/Tablet/Mobile entries of `VIEWPORT_PRESETS` in `store.ts`; the `Fill`
 * preset has no fixed width and stays single-preview only. Kept here (rather
 * than derived from the store) to avoid a renderer import cycle.
 */
export const MATRIX_PRESETS: MatrixFrameDef[] = [
  { id: 'desktop', label: 'Desktop', width: 1280 },
  { id: 'tablet', label: 'Tablet', width: 834 },
  { id: 'mobile', label: 'Mobile', width: 390 },
];

/** The default active (interactive) frame when the matrix is enabled. */
export const DEFAULT_MATRIX_FRAME_ID = MATRIX_PRESETS[0].id;

/** A frame's capture outcome, paired with its definition and active flag. */
export interface FrameCaptureResult {
  def: MatrixFrameDef;
  /** Whether this is the breakpoint the user marked the target/annotations on. */
  active: boolean;
  /** PNG data URL, or null when the capture failed (best-effort). */
  screenshotDataUrl: string | null;
}

/**
 * Assemble the successful frame captures into the `ResponsiveFrame[]` carried on
 * an `EditRequest`. Failed captures (null data URL) are dropped so the agent
 * never receives a frame with no image. Returns `undefined` when nothing usable
 * remains, so callers can omit the field entirely.
 */
export function assembleFrames(results: FrameCaptureResult[]): ResponsiveFrame[] | undefined {
  const frames: ResponsiveFrame[] = results
    .filter(
      (r): r is FrameCaptureResult & { screenshotDataUrl: string } =>
        r.screenshotDataUrl !== null,
    )
    .map((r) => ({
      label: r.def.label,
      width: r.def.width,
      active: r.active,
      screenshotDataUrl: r.screenshotDataUrl,
    }));
  return frames.length > 0 ? frames : undefined;
}
