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
import { Tooltip } from './Tooltip';

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
/*  Remove a single element target (+ its bound annotation)                    */
/* -------------------------------------------------------------------------- */

function useRemoveTarget(): (target: ElementTarget) => void {
  return (target: ElementTarget): void => {
    // Atomic: drop the target AND its bound annotation (same id) in a single
    // functional update read from the freshest state, so rapid removals can't
    // race on a stale `targets` snapshot or orphan a target behind a removed mark.
    useEaselStore.setState((s) => ({
      targets: s.targets.filter((t) => t.id !== target.id),
      annotations: s.annotations.filter((a) => a.id !== target.id),
    }));
  };
}

/* -------------------------------------------------------------------------- */
/*  Selected target box — highlight + always-visible corner "×" bubble         */
/* -------------------------------------------------------------------------- */

function TargetBox({
  target,
  scrollX,
  scrollY,
}: {
  target: ElementTarget;
  scrollX: number;
  scrollY: number;
}): React.ReactElement {
  const removeTarget = useRemoveTarget();
  const color = confidenceColor(target.confidence);
  const tx = target.boundingBox.x - scrollX;
  const ty = target.boundingBox.y - scrollY;
  const { width, height } = target.boundingBox;

  return (
    <>
      <div
        className="absolute pointer-events-none"
        style={{
          left: tx,
          top: ty,
          width,
          height,
          outline: `2px solid ${color}`,
          outlineOffset: 2,
          background: `${color}14`, // 8% opacity
          borderRadius: 2,
        }}
        aria-hidden
      />
      {/* Always-visible remove bubble pinned to the box's top-right corner. */}
      <Tooltip label="Remove selection" side="top">
        <button
          onClick={() => removeTarget(target)}
          aria-label="Remove selection"
          className="absolute z-10 grid place-items-center w-[18px] h-[18px] rounded-full bg-ink-900/95 border border-white/25 text-gray-200 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.8)] backdrop-blur-sm pointer-events-auto hover:bg-rose-500 hover:text-white hover:border-rose-400 hover:scale-110 active:scale-95 transition-all duration-150 ease-spring"
          style={{ left: tx + width - 9, top: ty - 9 }}
        >
          <X className="w-3 h-3" />
        </button>
      </Tooltip>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/*  Target chip                                                               */
/* -------------------------------------------------------------------------- */

function TargetChip({ target }: { target: ElementTarget }): React.ReactElement {
  const removeTarget = useRemoveTarget();
  const remove = (): void => removeTarget(target);

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
      <Tooltip label="Remove target" side="top">
        <button
          onClick={remove}
          className="ml-1 text-gray-500 hover:text-gray-200 transition-colors"
          aria-label="Remove target"
        >
          <X className="w-2.5 h-2.5" />
        </button>
      </Tooltip>
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

      {/* Selected target highlights + corner remove bubbles */}
      {targets.map((t) => (
        <TargetBox key={t.id} target={t} scrollX={scrollX} scrollY={scrollY} />
      ))}

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
