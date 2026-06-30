/**
 * Easel — ScrubberDialog component (Issue #18: Session replay).
 *
 * A modal frame-by-frame scrubber for reviewing an imported `.easel` session
 * bundle. Mirrors SettingsDialog's modal structure (backdrop + glass-raised
 * dialog + header/X + scrollable body + footer).
 *
 * Layout per frame:
 *  LEFT "Gesture" pane — BEFORE shot + static SVG annotation overlay + user
 *    instruction text.
 *  RIGHT "Edit" pane — AFTER shot + <DiffViewer> (read-only) + assistant
 *    summary text.
 *  Footer — "Re-run this step" (replayStep) + Close.
 *
 * Shot fetching: uses easel.checkpoint.getShots (same channel as HistoryPanel's
 * VisualDiff), keyed by checkpoint id, cached in local state per dialog
 * lifetime to avoid redundant IPC calls.
 *
 * Annotation rendering: static read-only SVG shapes, using the same geometry
 * as FreeformCanvas's <Shape> sub-component (rect/ellipse/arrow/freehand/pin).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  Loader2,
} from 'lucide-react';
import type { Annotation } from '@shared/types';
import { useEaselStore } from '../store';
import { easel } from '../lib/api';
import { buildReplaySteps } from '../lib/sessionTimeline';
import type { ReplayStep } from '../lib/sessionTimeline';
import { DiffViewer } from './DiffViewer';
import { boxFromPoints } from '../lib/geometry';
import { Tooltip } from './Tooltip';

/* -------------------------------------------------------------------------- */
/*  Shot cache type                                                            */
/* -------------------------------------------------------------------------- */

type ShotEntry = { before?: string; after?: string };

/* -------------------------------------------------------------------------- */
/*  Static annotation shape (read-only SVG, mirrors FreeformCanvas's Shape)   */
/* -------------------------------------------------------------------------- */

function AnnotationShape({ a }: { a: Annotation }): React.ReactElement | null {
  const pts = a.points;
  const stroke = a.color;
  const fill = `${a.color}22`;

  if (a.kind === 'rect' && pts.length >= 2) {
    const b = boxFromPoints(pts);
    return (
      <rect
        x={b.x}
        y={b.y}
        width={b.width}
        height={b.height}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
        rx={2}
      />
    );
  }
  if (a.kind === 'ellipse' && pts.length >= 2) {
    const b = boxFromPoints(pts);
    return (
      <ellipse
        cx={b.x + b.width / 2}
        cy={b.y + b.height / 2}
        rx={b.width / 2}
        ry={b.height / 2}
        fill={fill}
        stroke={stroke}
        strokeWidth={2}
      />
    );
  }
  if (a.kind === 'arrow' && pts.length >= 2) {
    return (
      <g>
        <defs>
          <marker id={`replay-ah-${a.id}`} markerWidth="8" markerHeight="6" refX="6" refY="3" orient="auto">
            <polygon points="0 0, 8 3, 0 6" fill={stroke} />
          </marker>
        </defs>
        <line
          x1={pts[0].x}
          y1={pts[0].y}
          x2={pts[1].x}
          y2={pts[1].y}
          stroke={stroke}
          strokeWidth={2.5}
          markerEnd={`url(#replay-ah-${a.id})`}
        />
      </g>
    );
  }
  if (a.kind === 'freehand' && pts.length >= 2) {
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
    return (
      <path
        d={d}
        stroke={stroke}
        strokeWidth={2.5}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
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
/*  Placeholder for missing shots                                              */
/* -------------------------------------------------------------------------- */

function NoShot(): React.ReactElement {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center rounded-lg surface-inset">
      <span className="text-[11.5px] text-gray-500">No preview captured for this step</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Shot pane with optional annotation overlay                                */
/* -------------------------------------------------------------------------- */

interface ShotPaneProps {
  src: string | undefined;
  annotations?: Annotation[];
  label: string;
}

function ShotPane({ src, annotations, label }: ShotPaneProps): React.ReactElement {
  const imgRef = useRef<HTMLImageElement>(null);
  const [imgSize, setImgSize] = useState<{ w: number; h: number } | null>(null);

  const onLoad = useCallback(() => {
    const img = imgRef.current;
    if (img) {
      setImgSize({ w: img.naturalWidth, h: img.naturalHeight });
    }
  }, []);

  if (!src) return <NoShot />;

  // The SVG viewBox matches the image's natural pixel dimensions so annotation
  // coordinates (recorded at capture time) align without any scaling arithmetic
  // on our part — the browser scales both the <img> and the <svg> together.
  return (
    <div className="relative overflow-hidden rounded-lg surface-inset" aria-label={label}>
      <img
        ref={imgRef}
        src={src}
        alt={label}
        className="block w-full"
        draggable={false}
        onLoad={onLoad}
      />
      {annotations && annotations.length > 0 && imgSize && (
        <svg
          className="pointer-events-none absolute inset-0 w-full h-full"
          viewBox={`0 0 ${imgSize.w} ${imgSize.h}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden
        >
          {annotations.map((a) => (
            <AnnotationShape key={a.id} a={a} />
          ))}
        </svg>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Step frame view                                                            */
/* -------------------------------------------------------------------------- */

interface FrameViewProps {
  step: ReplayStep;
  shots: ShotEntry | null;
  shotsLoading: boolean;
  onReplay(): void;
  replayBusy: boolean;
}

function FrameView({ step, shots, shotsLoading, onReplay, replayBusy }: FrameViewProps): React.ReactElement {
  const { userMessage, assistantMessage, checkpoint } = step;
  const annotations = userMessage?.annotations;
  const diffs = assistantMessage?.diffs;

  return (
    <div className="flex flex-col gap-4">
      {/* Two-column frame layout */}
      <div className="grid grid-cols-2 gap-4">
        {/* LEFT: Gesture pane */}
        <div className="flex flex-col gap-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-gray-500">
            Gesture
          </span>
          {shotsLoading ? (
            <div className="flex h-[120px] items-center justify-center rounded-lg surface-inset">
              <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
            </div>
          ) : (
            <ShotPane src={shots?.before} annotations={annotations} label="Before" />
          )}
          {userMessage ? (
            <p className="text-[12px] leading-relaxed text-gray-300">{userMessage.content}</p>
          ) : (
            <p className="text-[11.5px] italic text-gray-600">No user instruction recorded</p>
          )}
        </div>

        {/* RIGHT: Edit pane */}
        <div className="flex flex-col gap-2">
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-gray-500">
            Edit
          </span>
          {shotsLoading ? (
            <div className="flex h-[120px] items-center justify-center rounded-lg surface-inset">
              <Loader2 className="h-4 w-4 animate-spin text-gray-500" />
            </div>
          ) : (
            <ShotPane src={shots?.after} label="After" />
          )}
          {assistantMessage ? (
            <p className="text-[12px] leading-relaxed text-gray-300">{assistantMessage.content}</p>
          ) : (
            <p className="text-[11.5px] italic text-gray-600">No assistant summary recorded</p>
          )}
        </div>
      </div>

      {/* Diff viewer (read-only — imported checkpoints aren't on the live timeline) */}
      {diffs && diffs.length > 0 && (
        <div className="mt-2">
          <DiffViewer diffs={diffs} readOnly />
        </div>
      )}

      {/* Per-step action */}
      <div className="flex items-center gap-3 pt-1">
        <Tooltip
          label={
            replayBusy
              ? 'Applying step…'
              : "Re-apply this step's recorded changes to the current working tree"
          }
          side="top"
        >
          <button
            onClick={onReplay}
            disabled={replayBusy}
            aria-label={replayBusy ? 'Applying…' : 'Re-run this step'}
            className="flex items-center gap-2 rounded-lg bg-brand-700 px-3 py-2 text-[12.5px] font-medium text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.15)] transition-all duration-150 ease-spring hover:bg-brand-600 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {replayBusy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Applying…
              </>
            ) : (
              <>
                <RotateCcw className="h-3.5 w-3.5" />
                Re-run this step
              </>
            )}
          </button>
        </Tooltip>
        <span className="text-[11px] text-gray-600">
          Checkpoint: <span className="font-mono">{checkpoint.id.slice(0, 8)}</span>
        </span>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  ScrubberDialog                                                             */
/* -------------------------------------------------------------------------- */

export function ScrubberDialog(): React.ReactElement | null {
  const scrubberOpen = useEaselStore((s) => s.scrubberOpen);
  const replaySession = useEaselStore((s) => s.replaySession);
  const scrubIndex = useEaselStore((s) => s.scrubIndex);
  const replayBusy = useEaselStore((s) => s.replayBusy);
  const setScrubberOpen = useEaselStore((s) => s.setScrubberOpen);
  const setScrubIndex = useEaselStore((s) => s.setScrubIndex);
  const doReplayStep = useEaselStore((s) => s.replayStep);

  // Per-session shot cache: Map<checkpointId, ShotEntry>
  const shotCache = useRef<Map<string, ShotEntry>>(new Map());
  const [currentShots, setCurrentShots] = useState<ShotEntry | null>(null);
  const [shotsLoading, setShotsLoading] = useState(false);

  // Derive steps from the manifest each render (cheap pure computation).
  const steps: ReplayStep[] = replaySession ? buildReplaySteps(replaySession.manifest) : [];
  const total = steps.length;
  const clampedIndex = total > 0 ? Math.min(scrubIndex, total - 1) : 0;
  const currentStep: ReplayStep | undefined = steps[clampedIndex];

  // Fetch shots for the current step, using cache to avoid re-fetching.
  useEffect(() => {
    if (!currentStep) return;
    const cid = currentStep.checkpoint.id;

    if (shotCache.current.has(cid)) {
      setCurrentShots(shotCache.current.get(cid) ?? null);
      return;
    }

    let active = true;
    setShotsLoading(true);
    void easel.checkpoint.getShots({ checkpointId: cid }).then((result) => {
      if (!active) return;
      const entry: ShotEntry = result.ok ? result.value : {};
      shotCache.current.set(cid, entry);
      setCurrentShots(entry);
      setShotsLoading(false);
    });
    return () => {
      active = false;
    };
  }, [currentStep]);

  // Reset shot cache when a new session is loaded.
  const prevSessionId = useRef<string | null>(null);
  useEffect(() => {
    if (!replaySession) return;
    if (replaySession.sessionId !== prevSessionId.current) {
      shotCache.current = new Map();
      prevSessionId.current = replaySession.sessionId;
      setCurrentShots(null);
    }
  }, [replaySession]);

  const handleClose = useCallback(() => {
    setScrubberOpen(false);
  }, [setScrubberOpen]);

  // Keyboard ArrowLeft/ArrowRight to step through frames.
  useEffect(() => {
    if (!scrubberOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowLeft') {
        setScrubIndex(Math.max(0, clampedIndex - 1));
      } else if (e.key === 'ArrowRight') {
        setScrubIndex(Math.min(total - 1, clampedIndex + 1));
      } else if (e.key === 'Escape') {
        handleClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scrubberOpen, clampedIndex, total, setScrubIndex, handleClose]);

  if (!scrubberOpen || !replaySession) return null;

  const projectName = replaySession.manifest.session.projectName;

  function handleReplay(): void {
    if (!currentStep || replayBusy) return;
    void doReplayStep(currentStep.checkpoint.id);
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40 animate-fade-in"
        onClick={handleClose}
        aria-hidden
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-label={`Session replay — ${projectName}`}
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="glass-raised animate-scale-in w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 hairline-b flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <h2 className="text-base font-semibold text-gray-100 truncate">
                Session replay — {projectName}
              </h2>
              {total > 0 && (
                <span className="flex-shrink-0 rounded-full bg-brand-500/15 px-2 py-0.5 text-[11px] font-medium text-brand-300">
                  Step {clampedIndex + 1} / {total}
                </span>
              )}
            </div>
            <Tooltip label="Close" shortcut="Esc" side="left">
              <button
                aria-label="Close session replay"
                onClick={handleClose}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-200 transition-all duration-150 ease-spring active:scale-90"
              >
                <X className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>

          {/* Timeline scrubber */}
          {total > 0 ? (
            <div className="flex-shrink-0 flex items-center gap-3 px-5 py-3 hairline-b">
              <Tooltip label="Previous step (←)" side="bottom">
                <button
                  onClick={() => setScrubIndex(Math.max(0, clampedIndex - 1))}
                  disabled={clampedIndex === 0}
                  aria-label="Previous step"
                  className="flex-shrink-0 grid place-items-center w-7 h-7 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-200 disabled:opacity-30 transition-all duration-150 ease-spring active:scale-90"
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
              </Tooltip>

              <input
                type="range"
                min={0}
                max={Math.max(0, total - 1)}
                value={clampedIndex}
                onChange={(e) => setScrubIndex(Number(e.target.value))}
                className="flex-1 h-1.5 cursor-pointer accent-brand-400"
                aria-label="Step timeline"
              />

              <Tooltip label="Next step (→)" side="bottom">
                <button
                  onClick={() => setScrubIndex(Math.min(total - 1, clampedIndex + 1))}
                  disabled={clampedIndex === total - 1}
                  aria-label="Next step"
                  className="flex-shrink-0 grid place-items-center w-7 h-7 rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-200 disabled:opacity-30 transition-all duration-150 ease-spring active:scale-90"
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
              </Tooltip>

              {currentStep && (
                <span className="flex-shrink-0 text-[11px] text-gray-500 truncate max-w-[200px]" title={currentStep.checkpoint.message}>
                  {currentStep.checkpoint.message}
                </span>
              )}
            </div>
          ) : null}

          {/* Body (scrollable) */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {total === 0 ? (
              <div className="flex h-40 items-center justify-center">
                <p className="text-[13px] text-gray-500">
                  This session bundle contains no replay steps.
                </p>
              </div>
            ) : currentStep ? (
              <FrameView
                step={currentStep}
                shots={currentShots}
                shotsLoading={shotsLoading}
                onReplay={handleReplay}
                replayBusy={replayBusy}
              />
            ) : null}
          </div>

          {/* Footer */}
          <div className="flex-shrink-0 hairline-t px-5 py-4 flex items-center justify-end">
            <button
              onClick={handleClose}
              className="btn-secondary text-sm px-4 py-2"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
