/**
 * Easel — AnnotationOverlay component.
 *
 * An absolutely-positioned layer that sits on top of the <webview> content area,
 * sized identically to it via CSS (inset-0 / w-full h-full). Delegates to:
 *   - ElementInspector  when mode === 'element-select'
 *   - FreeformCanvas    when mode === 'freeform'
 *
 * In idle / element-select mode the overlay is pointer-events: none so mouse
 * events fall through to the webview for the guest inspector to handle.
 * In freeform mode the overlay captures pointer events for drawing.
 *
 * Props carry live data from PreviewPane (hoverBox, scroll offsets,
 * sendCommand callback) so this component stays presentational.
 */

import React from 'react';
import type { BoundingBox, Point } from '@shared/types';
import type { InspectorCommand } from '@shared/ipc';
import { useEaselStore } from '../store';
import { ElementInspector } from './ElementInspector';
import { FreeformCanvas } from './FreeformCanvas';

interface Props {
  /** Bounding box of the hovered element in element-select mode, or null. */
  hoverBox: BoundingBox | null;
  /** Current scroll offsets from 'viewport-changed' messages. */
  scroll: Point;
  /**
   * Send an InspectorCommand down to the webview guest. Provided by PreviewPane
   * so the overlay never holds a ref to the <webview> element itself.
   */
  sendCommand(cmd: InspectorCommand): void;
}

export function AnnotationOverlay({ hoverBox, scroll, sendCommand }: Props): React.ReactElement {
  const mode = useEaselStore((s) => s.mode);

  // Pointer capture: off in idle/element-select (events fall through to guest),
  // on in freeform (overlay captures draw strokes).
  const capturePointer = mode === 'freeform';

  return (
    <div
      className="absolute inset-0 w-full h-full overflow-hidden"
      style={{ pointerEvents: capturePointer ? 'auto' : 'none' }}
      aria-hidden={mode === 'idle'}
    >
      {mode === 'element-select' && (
        <ElementInspector
          hoverBox={hoverBox}
          scrollX={scroll.x}
          scrollY={scroll.y}
        />
      )}

      {mode === 'freeform' && (
        <FreeformCanvas
          scrollOrigin={scroll}
          sendCommand={(cmd) =>
            sendCommand({ type: cmd.type, box: cmd.box, queryId: cmd.queryId })
          }
        />
      )}
    </div>
  );
}
