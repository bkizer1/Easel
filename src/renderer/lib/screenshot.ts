/**
 * Easel Renderer — screenshot capture helper.
 *
 * The renderer cannot read <webview> guest pixels directly (cross-origin /
 * process isolation). Instead, it delegates to the main process via
 * window.easel.preview.capture, which uses webContents.capturePage.
 *
 * Returns a data URL (PNG, base64-encoded) of the captured region.
 */

import type { BoundingBox } from '@shared/types';
import type { PreviewCaptureRequest } from '@shared/ipc';
import { easel } from './api';

/**
 * Capture the preview viewport (or an optional sub-region) as a PNG data URL.
 *
 * @param box - Optional bounding box in preview-viewport CSS pixels. When
 *              omitted, the full viewport is captured.
 * @param webContentsId - Optional id of the specific guest `<webview>` to
 *              capture (from `<webview>.getWebContentsId()`). Required to target
 *              one breakpoint in the Responsive Matrix, where several webviews
 *              are live at once; omitted for the single preview.
 * @returns   Data URL string, or null if the capture fails (e.g. no project
 *            open, no dev server reachable).
 */
export async function captureRegion(
  box?: BoundingBox,
  webContentsId?: number,
): Promise<string | null> {
  const req: PreviewCaptureRequest | undefined =
    box !== undefined || webContentsId !== undefined ? { box, webContentsId } : undefined;
  const result = await easel.preview.capture(req);
  if (!result.ok) {
    console.warn('[screenshot] capture failed:', result.error);
    return null;
  }
  return result.value.screenshotDataUrl;
}
