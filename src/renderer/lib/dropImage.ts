/**
 * Easel — drop-an-image EditRequest builder (#9).
 *
 * Pure logic (no React/Electron) so it is unit-testable under Node. When the
 * user drops an image onto a specific element, this assembles an `EditRequest`
 * that restyles THAT ONE existing component's source to match the image (via
 * the existing vision/screenshot path), without generating a new component tree.
 */

import type { BoundingBox, EditRequest, ElementTarget, Point } from '@shared/types';

/** The fixed instruction telling the agent to restyle one existing component. */
export const DROP_IMAGE_INSTRUCTION =
  "Restyle this element's source to match the attached image. Edit the existing " +
  'JSX/CSS of this one component in place — keep it a maintainable component and ' +
  'do NOT generate a new component tree or throwaway markup.';

/**
 * Build a small query box centered on a drop point, for the `query-region`
 * round-trip that resolves the drop to a single `ElementTarget`. Clamps the
 * top-left to non-negative and never produces a negative size.
 */
export function dropPointToQueryBox(point: Point, size = 8): BoundingBox {
  const s = Math.max(0, size);
  const half = s / 2;
  return {
    x: Math.max(0, point.x - half),
    y: Math.max(0, point.y - half),
    width: s,
    height: s,
  };
}

/** Inputs for {@link buildDropImageEditRequest}. */
export interface DropImageRequestInput {
  id: string;
  target: ElementTarget;
  imageDataUrl: string;
  projectRoot: string;
  devServerUrl: string;
}

/**
 * Assemble the `EditRequest` for a dropped image: the dropped image rides as the
 * `screenshotDataUrl` (vision), `targets` is the single resolved element, and
 * the instruction forbids new codegen.
 */
export function buildDropImageEditRequest(input: DropImageRequestInput): EditRequest {
  return {
    id: input.id,
    instruction: DROP_IMAGE_INSTRUCTION,
    annotations: [],
    targets: [input.target],
    screenshotDataUrl: input.imageDataUrl,
    projectRoot: input.projectRoot,
    devServerUrl: input.devServerUrl,
  };
}
