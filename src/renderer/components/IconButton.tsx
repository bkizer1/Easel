/**
 * Easel — IconButton.
 *
 * The single icon-button primitive used across the toolbar, address bar, and
 * panels. Wraps {@link Tooltip} so every icon control gets a fast, branded hover
 * label "for free", and standardises the motion language (spring press, jade
 * active-glow, hover wash).
 *
 * Accessibility note: disabled buttons are rendered with `aria-disabled` (not
 * the native `disabled` attribute) so the tooltip still appears on hover — a
 * greyed-out control should still be able to explain itself. Clicks and keyboard
 * focus are suppressed while disabled.
 */

import React from 'react';
import { Tooltip } from './Tooltip';

type Variant = 'default' | 'danger' | 'primary';
type Size = 'sm' | 'md';
type Side = 'top' | 'bottom' | 'left' | 'right';

export interface IconButtonProps {
  tooltip?: React.ReactNode;
  shortcut?: string | string[];
  tooltipSide?: Side;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  variant?: Variant;
  size?: Size;
  className?: string;
  'aria-label'?: string;
  children: React.ReactNode;
}

const SIZE: Record<Size, string> = {
  sm: 'w-7 h-7',
  md: 'w-[30px] h-[30px]',
};

export function IconButton({
  tooltip,
  shortcut,
  tooltipSide = 'bottom',
  onClick,
  disabled = false,
  active = false,
  variant = 'default',
  size = 'md',
  className = '',
  children,
  ...rest
}: IconButtonProps): React.ReactElement {
  const base =
    'no-drag relative inline-flex items-center justify-center rounded-lg transition-all duration-150 ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60';

  let color: string;
  if (disabled) {
    color = 'text-gray-600 opacity-40 cursor-not-allowed';
  } else if (active) {
    color =
      variant === 'danger'
        ? 'bg-rose-500/15 text-rose-300 ring-1 ring-rose-500/40 shadow-glow-rose'
        : 'bg-brand-500/15 text-brand-200 ring-1 ring-brand-500/40 shadow-glow-brand';
  } else if (variant === 'primary') {
    color =
      'bg-brand-600 text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)] hover:bg-brand-500 active:scale-[0.92]';
  } else if (variant === 'danger') {
    color = 'text-gray-400 hover:bg-rose-500/15 hover:text-rose-300 active:scale-[0.92]';
  } else {
    color = 'text-gray-400 hover:bg-white/[0.07] hover:text-gray-100 active:scale-[0.92]';
  }

  // Icon-only buttons have no text node, so without an explicit aria-label their
  // accessible name would be empty. Fall back to the tooltip text when it's a
  // plain string (a tooltip is a description, not a name, for screen readers).
  const ariaLabel =
    (rest as { 'aria-label'?: string })['aria-label'] ??
    (typeof tooltip === 'string' ? tooltip : undefined);

  const button = (
    <button
      type="button"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      tabIndex={disabled ? -1 : undefined}
      onClick={(e) => {
        if (disabled) {
          e.preventDefault();
          return;
        }
        onClick?.(e);
      }}
      className={`${base} ${SIZE[size]} ${color} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );

  return (
    <Tooltip label={tooltip} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  );
}
