/**
 * Easel — ElementInspector overlay component.
 *
 * Rendered inside AnnotationOverlay when mode === 'element-select'.
 * - Draws a highlight rect over the hovered element (driven by hoveredSelector
 *   bbox carried in a ref passed from PreviewPane).
 * - Shows chips for each already-selected ElementTarget.
 * - On click (relayed from PreviewPane's 'element-picked' message), calls
 *   store.addTarget and pushes a derived rect Annotation so the target is
 *   visually anchored on the overlay.
 *
 * NOTE: This component never hits the DOM directly. The actual click / hover
 * events happen inside the <webview> guest; the guest inspector posts
 * InspectorMessage events and PreviewPane relays them to the store.
 */

import React from 'react';
import { X } from 'lucide-react';
import type { BoundingBox, ElementTarget } from '@shared/types';
import { useEaselStore } from '../store';

interface Props {
  /** Bounding box of the currently hovered element, or null. */
  hoverBox: BoundingBox | null;
  /** Current scroll offset of the preview (for coordinate alignment). */
  scrollX: number;
  scrollY: number;
}

/* -------------------------------------------------------------------------- */
/*  Confidence color                                                          */
/* -------------------------------------------------------------------------- */

function confidenceColor(confidence: ElementTarget['confidence']): string {
  switch (confidence) {
    case 'high':
      return '#34d399'; // emerald-400
    case 'medium':
      return '#fbbf24'; // amber-400
    case 'low':
      return '#f87171'; // red-400
    case 'none':
    default:
      return '#9ca3af'; // gray-400
  }
}

/* -------------------------------------------------------------------------- */
/*  Target chip                                                               */
/* -------------------------------------------------------------------------- */

function TargetChip({ target }: { target: ElementTarget }): React.ReactElement {
  const removeAnnotation = useEaselStore((s) => s.removeAnnotation);
  const clearTargets = useEaselStore((s) => s.clearTargets);
  const targets = useEaselStore((s) => s.targets);

  function remove(): void {
    // Remove any annotation bound to this target.
    removeAnnotation(target.id);
    // If this is the last target, clear all.
    if (targets.length <= 1) {
      clearTargets();
    } else {
      useEaselStore.setState((s) => ({
        targets: s.targets.filter((t) => t.id !== target.id),
      }));
    }
  }

  const color = confidenceColor(target.confidence);
  const label = target.dataEaselSource
    ? `${target.dataEaselSource.filePath}:${target.dataEaselSource.line}`
    : target.selector;

  return (
    <div
      className="flex items-center gap-1 px-2 py-0.5 rounded text-xs bg-gray-800/90 text-gray-200 border max-w-[200px]"
      style={{ borderColor: color }}
      title={`<${target.tagName}> — ${label}`}
    >
      <span
        className="w-1.5 h-1.5 rounded-full flex-shrink-0"
        style={{ background: color }}
      />
      <span className="truncate">{`<${target.tagName}>`}</span>
      <button
        onClick={remove}
        className="ml-1 text-gray-500 hover:text-gray-200 transition-colors"
        title="Remove target"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  ElementInspector                                                          */
/* -------------------------------------------------------------------------- */

export function ElementInspector({ hoverBox, scrollX, scrollY }: Props): React.ReactElement {
  const targets = useEaselStore((s) => s.targets);

  // Translate the hover box by scroll delta (annotations are in viewport space
  // at the time of drawing; scroll may have changed).
  const translatedHover =
    hoverBox !== null
      ? {
          x: hoverBox.x - scrollX,
          y: hoverBox.y - scrollY,
          width: hoverBox.width,
          height: hoverBox.height,
        }
      : null;

  return (
    <>
      {/* Hover highlight */}
      {translatedHover && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: translatedHover.x,
            top: translatedHover.y,
            width: translatedHover.width,
            height: translatedHover.height,
            outline: '2px solid #a684ff',
            outlineOffset: 1,
            background: 'rgba(166, 132, 255, 0.08)',
            borderRadius: 2,
          }}
          aria-hidden
        />
      )}

      {/* Selected target bounding box highlights */}
      {targets.map((t) => {
        const tx = t.boundingBox.x - scrollX;
        const ty = t.boundingBox.y - scrollY;
        const color = confidenceColor(t.confidence);
        return (
          <div
            key={t.id}
            className="absolute pointer-events-none"
            style={{
              left: tx,
              top: ty,
              width: t.boundingBox.width,
              height: t.boundingBox.height,
              outline: `2px solid ${color}`,
              outlineOffset: 2,
              background: `${color}14`, // 8% opacity
              borderRadius: 2,
            }}
            aria-hidden
          />
        );
      })}

      {/* Target chips panel (bottom-left of overlay) */}
      {targets.length > 0 && (
        <div className="absolute bottom-3 left-3 flex flex-col gap-1 pointer-events-auto">
          {targets.map((t) => (
            <TargetChip key={t.id} target={t} />
          ))}
        </div>
      )}
    </>
  );
}
