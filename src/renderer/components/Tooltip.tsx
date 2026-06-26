/**
 * Easel — Tooltip.
 *
 * A lightweight, dependency-free tooltip that replaces the native `title`
 * attribute everywhere in the app. Native titles are slow (~1.5s OS delay),
 * unstyleable, and inconsistent across platforms; this gives us a fast, branded,
 * dark-glass hover label with optional keyboard-shortcut chips.
 *
 * Design goals:
 *   - Zero wrapper DOM: the trigger handlers/ref are merged onto the child via
 *     `cloneElement`, so the tooltip never disturbs flex/grid layouts.
 *   - Portal-rendered to <body>, positioned with viewport-aware flip + clamp so
 *     it never clips at a screen edge.
 *   - Pointer AND keyboard triggers (focus shows it too — good for a11y).
 *   - Honours `prefers-reduced-motion` via the global CSS guard.
 *
 * Usage:
 *   <Tooltip label="Reload preview" shortcut="⌘R">
 *     <button …><RefreshCw /></button>
 *   </Tooltip>
 */

import React, {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

type Side = 'top' | 'bottom' | 'left' | 'right';
type Align = 'center' | 'start' | 'end';

export interface TooltipProps {
  /** The hover label. If falsy, the child renders untouched (no tooltip). */
  label?: React.ReactNode;
  /** Optional shortcut hint, e.g. "⌘R" or ['⌘', '⇧', 'Z']. Rendered as kbd chips. */
  shortcut?: string | string[];
  /** Preferred side; flips automatically when there isn't room. */
  side?: Side;
  /** Alignment along the trigger edge (top/bottom sides only). */
  align?: Align;
  /** Show delay in ms. */
  delay?: number;
  /** Force-disable the tooltip while still rendering the child. */
  disabled?: boolean;
  /** Exactly one focusable/hoverable element. */
  children: React.ReactElement;
}

const GAP = 8; // distance between trigger and tooltip
const MARGIN = 8; // min distance from the viewport edge
const ARROW = 6; // half-size of the arrow square

interface Coords {
  x: number;
  y: number;
  side: Side;
  arrow: number; // px offset of the arrow along the facing edge
}

function mergeRef<T>(childRef: unknown, node: T): void {
  if (typeof childRef === 'function') (childRef as (n: T) => void)(node);
  else if (childRef && typeof childRef === 'object')
    (childRef as React.MutableRefObject<T>).current = node;
}

export function compute(
  trigger: DOMRect,
  tip: DOMRect,
  side: Side,
  align: Align,
  vw: number,
  vh: number,
): Coords {
  // Flip to the opposite side if the preferred one doesn't fit.
  let resolved = side;
  if (side === 'top' && trigger.top - tip.height - GAP < MARGIN) resolved = 'bottom';
  else if (side === 'bottom' && trigger.bottom + tip.height + GAP > vh - MARGIN) resolved = 'top';
  else if (side === 'left' && trigger.left - tip.width - GAP < MARGIN) resolved = 'right';
  else if (side === 'right' && trigger.right + tip.width + GAP > vw - MARGIN) resolved = 'left';

  let x = 0;
  let y = 0;
  const tcx = trigger.left + trigger.width / 2;
  const tcy = trigger.top + trigger.height / 2;

  if (resolved === 'top' || resolved === 'bottom') {
    y = resolved === 'top' ? trigger.top - tip.height - GAP : trigger.bottom + GAP;
    if (align === 'start') x = trigger.left;
    else if (align === 'end') x = trigger.right - tip.width;
    else x = tcx - tip.width / 2;
  } else {
    x = resolved === 'left' ? trigger.left - tip.width - GAP : trigger.right + GAP;
    y = tcy - tip.height / 2;
  }

  // Clamp into the viewport. Apply the lower bound LAST so a tooltip wider/taller
  // than the viewport pins to the top-left margin instead of going off-screen.
  x = Math.max(MARGIN, Math.min(x, vw - tip.width - MARGIN));
  y = Math.max(MARGIN, Math.min(y, vh - tip.height - MARGIN));

  // Arrow tracks the trigger centre, clamped within the tooltip body.
  const arrow =
    resolved === 'top' || resolved === 'bottom'
      ? Math.min(Math.max(tcx - x, ARROW + 6), tip.width - ARROW - 6)
      : Math.min(Math.max(tcy - y, ARROW + 6), tip.height - ARROW - 6);

  return { x, y, side: resolved, arrow };
}

function Chips({ shortcut }: { shortcut: string | string[] }): React.ReactElement {
  const keys = Array.isArray(shortcut) ? shortcut : shortcut.split(/(?=[⌘⌥⇧⌃])|\+/).filter(Boolean);
  return (
    <span className="ml-1.5 flex items-center gap-0.5">
      {keys.map((k, i) => (
        <kbd key={`${k}-${i}`} className="kbd">
          {k.trim()}
        </kbd>
      ))}
    </span>
  );
}

export function Tooltip({
  label,
  shortcut,
  side = 'bottom',
  align = 'center',
  delay = 320,
  disabled = false,
  children,
}: TooltipProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<Coords | null>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const tipRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  const inert = disabled || label == null || label === '';

  const clearTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    if (inert) return;
    clearTimer();
    timer.current = setTimeout(() => setOpen(true), delay);
  }, [inert, delay, clearTimer]);

  const hide = useCallback(() => {
    clearTimer();
    setOpen(false);
    // Reset coords so the next open re-measures from scratch (no stale-position
    // flash) and the visibility gate works on every open, not just the first.
    setCoords(null);
  }, [clearTimer]);

  // Position once visible, and keep it pinned on scroll/resize.
  useLayoutEffect(() => {
    if (!open) return;
    const place = (): void => {
      const t = triggerRef.current;
      const tip = tipRef.current;
      if (!t || !tip) return;
      // The trigger was removed from the DOM while open (e.g. a button that swaps
      // to another on click) — dismiss instead of pinning to a detached rect.
      if (!t.isConnected) {
        hide();
        return;
      }
      setCoords(
        compute(
          t.getBoundingClientRect(),
          tip.getBoundingClientRect(),
          side,
          align,
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, side, align, label, shortcut, hide]);

  // Escape always dismisses; also clean the timer on unmount.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hide]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  if (!isValidElement(children)) return children;
  if (inert) return children;

  const child = children as React.ReactElement & {
    ref?: unknown;
    props: Record<string, unknown>;
  };

  const handlers = {
    ref: (node: HTMLElement | null) => {
      triggerRef.current = node;
      mergeRef(child.ref, node);
      // If the trigger leaves the DOM while a tooltip is open, dismiss it so it
      // can't get stuck (e.g. a control that conditionally swaps to another).
      if (!node) hide();
    },
    onPointerEnter: (e: React.PointerEvent) => {
      (child.props.onPointerEnter as ((e: React.PointerEvent) => void) | undefined)?.(e);
      if (e.pointerType !== 'touch') show();
    },
    onPointerLeave: (e: React.PointerEvent) => {
      (child.props.onPointerLeave as ((e: React.PointerEvent) => void) | undefined)?.(e);
      hide();
    },
    onPointerDown: (e: React.PointerEvent) => {
      (child.props.onPointerDown as ((e: React.PointerEvent) => void) | undefined)?.(e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      (child.props.onFocus as ((e: React.FocusEvent) => void) | undefined)?.(e);
      show();
    },
    onBlur: (e: React.FocusEvent) => {
      (child.props.onBlur as ((e: React.FocusEvent) => void) | undefined)?.(e);
      hide();
    },
    'aria-describedby': open ? id : undefined,
  };

  const arrowStyle: React.CSSProperties =
    coords?.side === 'top'
      ? { left: coords.arrow, bottom: -ARROW, marginLeft: -ARROW }
      : coords?.side === 'bottom'
        ? { left: coords.arrow, top: -ARROW, marginLeft: -ARROW }
        : coords?.side === 'left'
          ? { top: coords.arrow, right: -ARROW, marginTop: -ARROW }
          : { top: coords?.arrow, left: -ARROW, marginTop: -ARROW };

  return (
    <>
      {cloneElement(child, handlers)}
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="pointer-events-none fixed z-[1000] flex max-w-[min(360px,90vw)] items-center rounded-lg border border-white/10 bg-ink-800/95 px-2.5 py-1.5 text-[11.5px] font-medium leading-snug text-gray-100 shadow-glass-lg backdrop-blur-xl animate-tooltip-in"
            style={{
              left: coords?.x ?? -9999,
              top: coords?.y ?? -9999,
              visibility: coords ? 'visible' : 'hidden',
            }}
          >
            <span className="min-w-0 break-words">{label}</span>
            {shortcut && <Chips shortcut={shortcut} />}
            <span
              aria-hidden
              className="absolute h-[12px] w-[12px] rotate-45 rounded-[2px] border-b border-r border-white/10 bg-ink-800/95"
              style={arrowStyle}
            />
          </div>,
          document.body,
        )}
    </>
  );
}
