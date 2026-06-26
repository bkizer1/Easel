/**
 * Easel — TweakPanel (Live DOM/CSS tweak, #6).
 *
 * After picking an element, nudge common CSS properties (size, padding, margin,
 * color, font-size, radius) like DevTools — applied instantly as ephemeral
 * inline styles via the guest inspector. The accumulated `{property, old, new}`
 * delta is shown; "Apply to source" ships that exact delta to the agent so the
 * change becomes durable (Tailwind class / CSS rule / styled-component);
 * "Discard" clears the inline styles.
 */

import React, { useState } from 'react';
import { SlidersHorizontal, Check, Undo2 } from 'lucide-react';
import { useEaselStore } from '../store';
import { formatStyleEdit } from '../lib/styleEdit';
import { Tooltip } from './Tooltip';

/** Numeric (px) tweakable properties surfaced as steppers. */
const NUMERIC_PROPS: Array<{ property: string; label: string; min: number; max: number; step: number }> = [
  { property: 'padding', label: 'Padding', min: 0, max: 200, step: 1 },
  { property: 'margin', label: 'Margin', min: 0, max: 200, step: 1 },
  { property: 'font-size', label: 'Font size', min: 6, max: 120, step: 1 },
  { property: 'border-radius', label: 'Radius', min: 0, max: 100, step: 1 },
  { property: 'width', label: 'Width', min: 0, max: 2000, step: 1 },
];

export function TweakPanel(): React.ReactElement | null {
  const targets = useEaselStore((s) => s.targets);
  const styleTweak = useEaselStore((s) => s.styleTweak);
  const tweakStyle = useEaselStore((s) => s.tweakStyle);
  const applyStyleToSource = useEaselStore((s) => s.applyStyleToSource);
  const discardStyleTweak = useEaselStore((s) => s.discardStyleTweak);
  const streaming = useEaselStore((s) => s.streaming);

  const target = targets.length > 0 ? targets[targets.length - 1] : null;
  const selector = target?.selector ?? null;

  // Local numeric values per property (px). Reset when the target changes.
  const [values, setValues] = useState<Record<string, number>>({});
  const [color, setColor] = useState('#000000');
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (selector !== seededKey) {
    // New element picked (or deselected) — clear the local stepper state.
    setSeededKey(selector);
    setValues({});
  }

  if (!selector) return null;

  const setNumeric = (property: string, raw: number, min: number, max: number): void => {
    const clamped = Math.max(min, Math.min(max, raw));
    setValues((v) => ({ ...v, [property]: clamped }));
    tweakStyle(selector, property, `${clamped}px`);
  };

  const deltas = styleTweak && styleTweak.selector === selector ? styleTweak.deltas : [];

  return (
    <div className="glass-panel animate-slide-up absolute bottom-4 right-4 z-30 w-72 overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2.5 hairline-b">
        <SlidersHorizontal className="h-3.5 w-3.5 text-brand-400" />
        <span className="text-[12px] font-semibold text-gray-200">Tweak styles</span>
        <span className="ml-auto font-mono text-[10.5px] text-gray-500 truncate max-w-[45%]" title={selector}>
          {target?.tagName || selector}
        </span>
      </div>

      <div className="px-3.5 py-2 space-y-2">
        {NUMERIC_PROPS.map((p) => {
          const cur = values[p.property] ?? 0;
          return (
            <div key={p.property} className="flex items-center gap-2">
              <label className="w-20 text-[11.5px] text-gray-400">{p.label}</label>
              <Tooltip label={`Decrease ${p.label.toLowerCase()}`} side="top">
                <button
                  onClick={() => setNumeric(p.property, cur - p.step, p.min, p.max)}
                  aria-label={`Decrease ${p.label.toLowerCase()}`}
                  className="grid h-6 w-6 place-items-center rounded-md bg-ink-800 text-gray-300 hover:bg-ink-700 transition-all duration-150 ease-spring active:scale-90"
                >
                  −
                </button>
              </Tooltip>
              <input
                type="number"
                value={cur}
                min={p.min}
                max={p.max}
                onChange={(e) => setNumeric(p.property, Number(e.target.value), p.min, p.max)}
                className="w-14 surface-inset rounded-md border border-white/10 bg-ink-800 px-1.5 py-0.5 text-center text-[11.5px] text-gray-200 focus:border-brand-500/50 focus:outline-none"
              />
              <Tooltip label={`Increase ${p.label.toLowerCase()}`} side="top">
                <button
                  onClick={() => setNumeric(p.property, cur + p.step, p.min, p.max)}
                  aria-label={`Increase ${p.label.toLowerCase()}`}
                  className="grid h-6 w-6 place-items-center rounded-md bg-ink-800 text-gray-300 hover:bg-ink-700 transition-all duration-150 ease-spring active:scale-90"
                >
                  +
                </button>
              </Tooltip>
            </div>
          );
        })}

        <div className="flex items-center gap-2">
          <label className="w-20 text-[11.5px] text-gray-400">Color</label>
          <input
            type="color"
            value={color}
            onChange={(e) => {
              setColor(e.target.value);
              tweakStyle(selector, 'color', e.target.value);
            }}
            className="h-6 w-10 cursor-pointer rounded-md border border-white/10 bg-ink-800"
          />
          <span className="font-mono text-[11px] text-gray-500">{color}</span>
        </div>
      </div>

      {deltas.length > 0 && (
        <div className="hairline-t px-3.5 py-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
            Pending changes
          </div>
          <ul className="space-y-0.5">
            {deltas.map((d) => (
              <li key={d.property} className="font-mono text-[10.5px] text-gray-400 truncate">
                {formatStyleEdit(d)}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex items-center gap-2 hairline-t px-3.5 py-2.5">
        <Tooltip label="Apply pending style changes to source" side="top">
          <button
            onClick={() => void applyStyleToSource()}
            disabled={deltas.length === 0 || streaming}
            aria-label="Apply to source"
            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-600 px-2 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500 disabled:opacity-30 transition-all duration-150 ease-spring active:scale-[0.97]"
          >
            <Check className="h-3.5 w-3.5" /> Apply to source
          </button>
        </Tooltip>
        <Tooltip label="Discard inline tweaks" side="top">
          <button
            onClick={() => discardStyleTweak()}
            disabled={deltas.length === 0}
            aria-label="Discard inline tweaks"
            className="flex items-center gap-1.5 rounded-lg bg-ink-800 px-2 py-1.5 text-[12px] text-gray-300 hover:bg-ink-700 disabled:opacity-30 transition-all duration-150 ease-spring active:scale-[0.97]"
          >
            <Undo2 className="h-3.5 w-3.5" /> Discard
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
