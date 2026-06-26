/**
 * Easel — FreeformCanvas.
 *
 * Mounted inside AnnotationOverlay when mode === 'freeform'. Lets the user draw
 * rect / ellipse / arrow / freehand / pin marks, and then edit committed marks:
 * move (drag), resize (corner handles, rect/ellipse), and remove (×).
 *
 * The toolbar and per-annotation frames stop pointer propagation so they don't
 * trigger a new draw on the canvas underneath.
 */

import React, { useCallback, useRef, useState } from 'react';
import { Circle, Square, ArrowRight, PenLine, MapPin, X } from 'lucide-react';
import type { Annotation, AnnotationKind, BoundingBox, Point } from '@shared/types';
import { boxFromPoints } from '../lib/geometry';
import { useEaselStore } from '../store';
import { Tooltip } from './Tooltip';

export type DrawTool = AnnotationKind;

const COLORS = ['#2dd4bf', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#ff375f'];

interface Props {
  scrollOrigin: Point;
  sendCommand(cmd: { type: 'query-region'; box: BoundingBox; queryId: string }): void;
}

/* -------------------------------------------------------------------------- */
/*  Toolbar                                                                   */
/* -------------------------------------------------------------------------- */

function ToolBar({
  activeTool,
  activeColor,
  onTool,
  onColor,
}: {
  activeTool: DrawTool;
  activeColor: string;
  onTool(t: DrawTool): void;
  onColor(c: string): void;
}): React.ReactElement {
  const tools: Array<{ id: DrawTool; icon: React.ReactNode; label: string }> = [
    { id: 'rect', icon: <Square className="w-3.5 h-3.5" />, label: 'Rectangle' },
    { id: 'ellipse', icon: <Circle className="w-3.5 h-3.5" />, label: 'Ellipse' },
    { id: 'arrow', icon: <ArrowRight className="w-3.5 h-3.5" />, label: 'Arrow' },
    { id: 'freehand', icon: <PenLine className="w-3.5 h-3.5" />, label: 'Freehand' },
    { id: 'pin', icon: <MapPin className="w-3.5 h-3.5" />, label: 'Pin' },
  ];

  // Stop pointer propagation so clicking the toolbar never starts a draw on the
  // canvas (which would also steal the click via setPointerCapture).
  const stop = (e: React.PointerEvent) => e.stopPropagation();

  return (
    <div
      onPointerDown={stop}
      onPointerUp={stop}
      className="glass-panel animate-slide-up absolute top-3 left-1/2 -translate-x-1/2 flex items-center gap-1 px-2 py-1.5 pointer-events-auto select-none z-20"
    >
      {tools.map((t) => (
        <Tooltip key={t.id} label={t.label} side="bottom">
          <button
            onClick={() => onTool(t.id)}
            aria-label={t.label}
            className={`grid place-items-center w-8 h-8 rounded-lg transition-all duration-150 ease-spring active:scale-90 ${
              activeTool === t.id
                ? 'bg-brand-500/20 text-brand-300 ring-1 ring-brand-500/40 shadow-glow-brand'
                : 'text-gray-400 hover:text-gray-100 hover:bg-white/[0.07]'
            }`}
          >
            {t.icon}
          </button>
        </Tooltip>
      ))}
      <span className="w-px h-5 bg-white/10 mx-1" />
      {COLORS.map((c) => (
        <Tooltip key={c} label="Marker colour" side="bottom">
          <button
            onClick={() => onColor(c)}
            aria-label={`Colour ${c}`}
            className={`w-4 h-4 rounded-full transition-transform duration-150 ease-spring hover:scale-125 ${
              activeColor === c ? 'ring-2 ring-white ring-offset-2 ring-offset-ink-900 scale-110' : ''
            }`}
            style={{ background: c }}
          />
        </Tooltip>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shape rendering (visual only)                                             */
/* -------------------------------------------------------------------------- */

function Shape({ a }: { a: Annotation }): React.ReactElement | null {
  const pts = a.points;
  const stroke = a.color;
  const fill = `${a.color}22`;

  if (a.kind === 'rect' && pts.length >= 2) {
    const b = boxFromPoints(pts);
    return <rect x={b.x} y={b.y} width={b.width} height={b.height} fill={fill} stroke={stroke} strokeWidth={2} rx={2} />;
  }
  if (a.kind === 'ellipse' && pts.length >= 2) {
    const b = boxFromPoints(pts);
    return <ellipse cx={b.x + b.width / 2} cy={b.y + b.height / 2} rx={b.width / 2} ry={b.height / 2} fill={fill} stroke={stroke} strokeWidth={2} />;
  }
  if (a.kind === 'arrow' && pts.length >= 2) {
    return (
      <g>
        <defs>
          <marker id={`ah-${a.id}`} markerWidth="8" markerHeight="6" refX="6" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={stroke} />
          </marker>
        </defs>
        <line x1={pts[0].x} y1={pts[0].y} x2={pts[1].x} y2={pts[1].y} stroke={stroke} strokeWidth={2.5} markerEnd={`url(#ah-${a.id})`} />
      </g>
    );
  }
  if (a.kind === 'freehand' && pts.length >= 2) {
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    return <path d={d} stroke={stroke} strokeWidth={2.5} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
  }
  if (a.kind === 'pin' && pts.length >= 1) {
    return (
      <g>
        <circle cx={pts[0].x} cy={pts[0].y} r={6} fill={stroke} />
        <circle cx={pts[0].x} cy={pts[0].y} r={11} stroke={stroke} strokeWidth={1.5} fill="none" opacity={0.5} />
      </g>
    );
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  Interactive frame (move / resize / remove)                                */
/* -------------------------------------------------------------------------- */

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;
type Corner = (typeof CORNERS)[number];
const CORNER_CLASS: Record<Corner, string> = {
  tl: '-top-1 -left-1 cursor-nwse-resize',
  tr: '-top-1 -right-1 cursor-nesw-resize',
  bl: '-bottom-1 -left-1 cursor-nesw-resize',
  br: '-bottom-1 -right-1 cursor-nwse-resize',
};

interface DragState {
  mode: 'move' | 'resize';
  corner?: Corner;
  startPts: Point[];
  startBox: BoundingBox;
  startX: number;
  startY: number;
}

function AnnotationFrame({
  a,
  toLocal,
  onUpdate,
  onRemove,
}: {
  a: Annotation;
  toLocal(clientX: number, clientY: number): Point;
  onUpdate(id: string, patch: Partial<Annotation>): void;
  onRemove(id: string): void;
}): React.ReactElement {
  const drag = useRef<DragState | null>(null);
  const resizable = a.kind === 'rect' || a.kind === 'ellipse';
  const b = a.boundingBox;

  const beginMove = (e: React.PointerEvent): void => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { mode: 'move', startPts: a.points, startBox: b, startX: e.clientX, startY: e.clientY };
  };

  const beginResize = (e: React.PointerEvent, corner: Corner): void => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { mode: 'resize', corner, startPts: a.points, startBox: b, startX: e.clientX, startY: e.clientY };
  };

  const onMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    if (d.mode === 'move') {
      const dx = e.clientX - d.startX;
      const dy = e.clientY - d.startY;
      const pts = d.startPts.map((p) => ({ x: p.x + dx, y: p.y + dy }));
      onUpdate(a.id, {
        points: pts,
        boundingBox: { x: d.startBox.x + dx, y: d.startBox.y + dy, width: d.startBox.width, height: d.startBox.height },
      });
    } else {
      const local = toLocal(e.clientX, e.clientY);
      const sb = d.startBox;
      let l = sb.x;
      let t = sb.y;
      let r = sb.x + sb.width;
      let bot = sb.y + sb.height;
      const c = d.corner!;
      if (c === 'tl') { l = local.x; t = local.y; }
      else if (c === 'tr') { r = local.x; t = local.y; }
      else if (c === 'bl') { l = local.x; bot = local.y; }
      else { r = local.x; bot = local.y; }
      const x = Math.min(l, r);
      const y = Math.min(t, bot);
      const width = Math.max(Math.abs(r - l), 4);
      const height = Math.max(Math.abs(bot - t), 4);
      onUpdate(a.id, { points: [{ x, y }, { x: x + width, y: y + height }], boundingBox: { x, y, width, height } });
    }
  };

  const endDrag = (e: React.PointerEvent): void => {
    if (!drag.current) return;
    e.stopPropagation();
    drag.current = null;
  };

  return (
    <div
      className="group absolute pointer-events-auto"
      style={{ left: b.x, top: b.y, width: Math.max(b.width, 12), height: Math.max(b.height, 12) }}
      onPointerDown={beginMove}
      onPointerMove={onMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      {/* Hover hit-area + outline */}
      <div className="absolute inset-0 rounded-[3px] border border-transparent group-hover:border-white/40 cursor-move" />

      {/* Remove bubble — always visible so a drawn selection can be cleared at a
          glance. Brightens on hover; positioned just outside the top-right corner. */}
      <Tooltip label="Remove selection" side="top">
        <button
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove(a.id);
          }}
          aria-label="Remove selection"
          className="absolute -top-2.5 -right-2.5 z-10 grid place-items-center w-[18px] h-[18px] rounded-full bg-ink-900/95 border border-white/25 text-gray-200 shadow-[0_2px_8px_-2px_rgba(0,0,0,0.8)] backdrop-blur-sm hover:bg-rose-500 hover:text-white hover:border-rose-400 hover:scale-110 active:scale-95 transition-all duration-150 ease-spring"
        >
          <X className="w-3 h-3" />
        </button>
      </Tooltip>

      {/* Resize handles (rect / ellipse) */}
      {resizable &&
        CORNERS.map((c) => (
          <div
            key={c}
            onPointerDown={(e) => beginResize(e, c)}
            onPointerMove={onMove}
            onPointerUp={endDrag}
            className={`absolute w-2.5 h-2.5 rounded-sm bg-white border border-ink-900 shadow opacity-0 group-hover:opacity-100 transition-opacity ${CORNER_CLASS[c]}`}
          />
        ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  In-progress stroke preview                                                */
/* -------------------------------------------------------------------------- */

function StrokePreview({ tool, points, color }: { tool: DrawTool; points: Point[]; color: string }): React.ReactElement | null {
  if (points.length < 1) return null;
  const stroke = { stroke: color, strokeWidth: 2, fill: 'none' as const };
  const filled = { fill: `${color}22`, stroke: color, strokeWidth: 2, strokeDasharray: '4 3' };

  if ((tool === 'rect' || tool === 'ellipse') && points.length >= 2) {
    const b = boxFromPoints(points);
    return tool === 'rect' ? (
      <rect x={b.x} y={b.y} width={b.width} height={b.height} rx={2} {...filled} />
    ) : (
      <ellipse cx={b.x + b.width / 2} cy={b.y + b.height / 2} rx={b.width / 2} ry={b.height / 2} {...filled} />
    );
  }
  if (tool === 'arrow' && points.length >= 2) {
    return <line x1={points[0].x} y1={points[0].y} x2={points[1].x} y2={points[1].y} {...stroke} strokeWidth={2.5} />;
  }
  if (tool === 'freehand' && points.length >= 2) {
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    return <path d={d} {...stroke} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" />;
  }
  if (tool === 'pin') {
    return <circle cx={points[0].x} cy={points[0].y} r={6} fill={color} opacity={0.8} />;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/*  FreeformCanvas                                                            */
/* -------------------------------------------------------------------------- */

let annotationSeq = 0;

export function FreeformCanvas({ scrollOrigin, sendCommand }: Props): React.ReactElement {
  const addAnnotation = useEaselStore((s) => s.addAnnotation);
  const removeAnnotation = useEaselStore((s) => s.removeAnnotation);
  const updateAnnotation = useEaselStore((s) => s.updateAnnotation);
  const annotations = useEaselStore((s) => s.annotations);
  const freeformAnnotations = annotations.filter((a) => a.mode === 'freeform');

  const [tool, setTool] = useState<DrawTool>('rect');
  const [color, setColor] = useState(COLORS[0]);
  const [currentPoints, setCurrentPoints] = useState<Point[]>([]);
  const [isDrawing, setIsDrawing] = useState(false);
  const canvasRef = useRef<HTMLDivElement>(null);

  const toLocal = useCallback((clientX: number, clientY: number): Point => {
    const rect = canvasRef.current?.getBoundingClientRect();
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) };
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsDrawing(true);
      setCurrentPoints([toLocal(e.clientX, e.clientY)]);
    },
    [toLocal],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawing) return;
      const pt = toLocal(e.clientX, e.clientY);
      setCurrentPoints((prev) => {
        if (tool === 'freehand') return [...prev, pt];
        if (prev.length === 0) return [pt];
        return [prev[0], pt];
      });
    },
    [isDrawing, tool, toLocal],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!isDrawing) return;
      setIsDrawing(false);
      e.currentTarget.releasePointerCapture(e.pointerId);

      const pts = [...currentPoints];
      if (pts.length < 1) return;

      const finalPoints = tool === 'pin' ? [pts[0]] : pts;
      const bbox = boxFromPoints(finalPoints);
      if (tool !== 'pin' && bbox.width < 4 && bbox.height < 4) {
        setCurrentPoints([]);
        return;
      }

      annotationSeq += 1;
      const id = `ann-${annotationSeq}-${finalPoints.length}`;
      addAnnotation({ id, mode: 'freeform', kind: tool, points: finalPoints, boundingBox: bbox, color, scrollOrigin });
      setCurrentPoints([]);

      if (tool !== 'pin') sendCommand({ type: 'query-region', box: bbox, queryId: id });
    },
    [isDrawing, currentPoints, tool, color, scrollOrigin, addAnnotation, sendCommand],
  );

  return (
    <div
      ref={canvasRef}
      className="absolute inset-0 cursor-crosshair"
      style={{ touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setIsDrawing(false);
        setCurrentPoints([]);
      }}
    >
      <ToolBar activeTool={tool} activeColor={color} onTool={setTool} onColor={setColor} />

      {/* Committed shapes + in-progress preview (visual, non-interactive).
          Only freeform marks belong to this canvas — element-pick annotations
          are owned by ElementInspector, which manages their bound target. */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none">
        {freeformAnnotations.map((a) => (
          <Shape key={a.id} a={a} />
        ))}
        {isDrawing && <StrokePreview tool={tool} points={currentPoints} color={color} />}
      </svg>

      {/* Interactive frames (move / resize / remove) */}
      {freeformAnnotations.map((a) => (
        <AnnotationFrame
          key={`frame-${a.id}`}
          a={a}
          toLocal={toLocal}
          onUpdate={updateAnnotation}
          onRemove={removeAnnotation}
        />
      ))}
    </div>
  );
}
