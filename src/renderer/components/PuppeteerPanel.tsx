/**
 * Easel — PuppeteerPanel (issue #17).
 *
 * The "Live State Puppeteer" cockpit panel, docked at the bottom of the shell.
 * Surfaces the opt-in enable toggle, the list of active fetch/XHR mocks (each
 * removable), and the ephemeral state overrides applied this session.
 *
 * Design pattern mirrors StateXRayPanel exactly: the same header chrome,
 * Tailwind token set, `hairline-b` dividers, and Tooltip wrappers. State reads
 * come from the Zustand store (the `puppeteer` slice), mutations go through the
 * four store actions below — this component never calls `window.easel` directly.
 *
 * Store actions used:
 *   - `setPuppeteerEnabled(enabled: boolean)`  — opt-in toggle
 *   - `removePuppeteerMock(id: string)`        — per-row remove button
 *   - `clearPuppeteer()`                       — Clear all button
 *   - `setPuppeteerOpen(open: boolean)`        — close button
 */

import React from 'react';
import {
  FlaskConical,
  X,
  Trash2,
  Radio,
  ShieldOff,
  Info,
} from 'lucide-react';
import { useEaselStore } from '../store';
import { describeMock, describeOverride } from '../lib/puppeteerLabel';
import type { FetchMockSpec, StateOverride } from '@shared/puppeteer';
import { Tooltip } from './Tooltip';

/* -------------------------------------------------------------------------- */
/*  Mock row                                                                   */
/* -------------------------------------------------------------------------- */

interface MockRowProps {
  spec: FetchMockSpec;
  onRemove: (id: string) => void;
}

/**
 * A single active fetch-mock row. Shows the one-line summary produced by
 * {@link describeMock} and a per-row remove button that calls the store's
 * `removePuppeteerMock` action.
 */
function MockRow({ spec, onRemove }: MockRowProps): React.ReactElement {
  const label = describeMock(spec);

  return (
    <li className="flex items-center gap-2 px-3.5 py-1.5 hairline-b last:border-0">
      {spec.once && (
        <Tooltip label="One-shot — fires once then auto-removes" side="top">
          <span className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-amber-500/15 text-amber-300">
            1×
          </span>
        </Tooltip>
      )}
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gray-300"
        title={label}
      >
        {label}
      </span>
      <Tooltip label="Remove this mock" side="top">
        <button
          onClick={() => onRemove(spec.id)}
          aria-label={`Remove mock: ${label}`}
          className="flex-shrink-0 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10.5px] text-gray-500 transition-all duration-150 ease-spring hover:bg-rose-500/15 hover:text-rose-400 active:scale-[0.97]"
        >
          <X className="h-3 w-3" />
        </button>
      </Tooltip>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Override row                                                               */
/* -------------------------------------------------------------------------- */

interface OverrideRowProps {
  override: StateOverride;
}

/**
 * A single recorded state-override row. Overrides are ephemeral (one-shot
 * writes); the row is informational only — no remove button, since a reload
 * restores the app's real state automatically.
 */
function OverrideRow({ override }: OverrideRowProps): React.ReactElement {
  const label = describeOverride(override);

  return (
    <li className="flex items-center gap-2 px-3.5 py-1.5 hairline-b last:border-0">
      <span className="flex-shrink-0 rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide bg-iris-500/15 text-iris-300">
        1×
      </span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gray-400"
        title={label}
      >
        {label}
      </span>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Section header                                                             */
/* -------------------------------------------------------------------------- */

interface SectionHeaderProps {
  label: string;
  count: number;
}

function SectionHeader({ label, count }: SectionHeaderProps): React.ReactElement {
  return (
    <div className="flex items-center gap-2 px-3.5 py-1.5 hairline-b bg-ink-900/40">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        {label}
      </span>
      <span className="ml-auto rounded-full bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-medium text-gray-500">
        {count}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Panel shell                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The full Puppeteer cockpit panel.
 *
 * Layout:
 *   - Header: icon + title + enable toggle + optional Clear-all button + close X.
 *   - Body: policy-blocked banner (when applicable), mock list, overrides list,
 *     or an empty/help state when puppeteer is off or nothing is active.
 */
export function PuppeteerPanel(): React.ReactElement {
  const puppeteer = useEaselStore((s) => s.puppeteer);
  const setPuppeteerOpen = useEaselStore((s) => s.setPuppeteerOpen);
  const setPuppeteerEnabled = useEaselStore((s) => s.setPuppeteerEnabled);
  const removePuppeteerMock = useEaselStore((s) => s.removePuppeteerMock);
  const clearPuppeteer = useEaselStore((s) => s.clearPuppeteer);

  const { enabled, mocks, overrides, policyBlockedReason } = puppeteer;
  const hasActivity = mocks.length > 0 || overrides.length > 0;
  const isBlocked = Boolean(policyBlockedReason);

  return (
    <div className="flex h-full flex-col">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 px-3.5 py-2 hairline-b">
        <span className="flex items-center gap-2 text-[12px] font-semibold text-gray-200">
          <FlaskConical className="h-3.5 w-3.5 text-brand-400" />
          Live State Puppeteer
        </span>

        {/* Enable toggle — mirrors the NetworkTab "Capture" button exactly */}
        <Tooltip
          label={
            isBlocked
              ? `Blocked by policy: ${policyBlockedReason ?? 'disabled'}`
              : enabled
                ? 'Disable fetch/XHR interception'
                : 'Enable fetch/XHR interception (opt-in)'
          }
          side="bottom"
        >
          <button
            onClick={() => !isBlocked && void setPuppeteerEnabled(!enabled)}
            aria-label={enabled ? 'Disable puppeteer' : 'Enable puppeteer'}
            aria-pressed={enabled}
            disabled={isBlocked}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150 ease-spring active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 ${
              enabled
                ? 'bg-brand-500/15 text-brand-300'
                : 'text-gray-400 hover:bg-white/[0.06] hover:text-gray-200'
            }`}
          >
            <Radio className={`h-3 w-3 ${enabled ? 'animate-pulse' : ''}`} />
            {enabled ? 'Active' : 'Enable'}
          </button>
        </Tooltip>

        {/* Clear-all — only shown when there is something to clear */}
        {hasActivity && (
          <Tooltip label="Remove all active mocks and clear override history" side="bottom">
            <button
              onClick={() => void clearPuppeteer()}
              aria-label="Clear all mocks and overrides"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-gray-500 transition-all duration-150 ease-spring hover:bg-white/[0.06] hover:text-gray-300 active:scale-[0.97]"
            >
              <Trash2 className="h-3 w-3" /> Clear all
            </button>
          </Tooltip>
        )}

        {/* Summary counts badge when active */}
        {hasActivity && (
          <span className="ml-auto text-[11px] text-gray-500">
            {mocks.length} mock{mocks.length === 1 ? '' : 's'}
            {overrides.length > 0 && ` · ${overrides.length} override${overrides.length === 1 ? '' : 's'}`}
          </span>
        )}

        <Tooltip label="Close Puppeteer panel" side="top">
          <button
            onClick={() => setPuppeteerOpen(false)}
            aria-label="Close Puppeteer panel"
            className={`${hasActivity ? '' : 'ml-auto'} flex-shrink-0 rounded-md p-1 text-gray-500 transition-all duration-150 ease-spring hover:bg-white/[0.06] hover:text-gray-300 active:scale-90`}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      {/* ── Body ────────────────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto">
        {/* Policy-blocked banner */}
        {isBlocked && (
          <div className="flex items-start gap-2.5 px-3.5 py-3 hairline-b bg-amber-500/[0.06]">
            <ShieldOff className="mt-0.5 h-3.5 w-3.5 flex-shrink-0 text-amber-400" />
            <p className="text-[11.5px] leading-relaxed text-amber-300/90">
              <span className="font-semibold">Blocked by policy.</span>{' '}
              {policyBlockedReason} To enable puppeteer, update{' '}
              <span className="font-mono">.easel/policy.json</span> and set{' '}
              <span className="font-mono">allowStatePuppeteer: true</span>.
            </p>
          </div>
        )}

        {/* Empty / off state */}
        {!hasActivity && (
          <div className="flex flex-col items-center gap-3 px-3.5 py-7 text-center animate-fade-in">
            <span className="grid place-items-center h-10 w-10 rounded-xl border border-brand-500/20 bg-brand-500/10 text-brand-300">
              <FlaskConical className="h-4 w-4" />
            </span>
            <p className="max-w-[280px] text-[12px] leading-relaxed text-gray-400">
              {enabled
                ? 'No active mocks or overrides. Ask the agent to intercept a fetch request or override a component state value.'
                : 'Enable puppeteer to intercept fetch/XHR requests or override component state without editing source.'}
            </p>
            {!isBlocked && !enabled && (
              <button
                onClick={() => void setPuppeteerEnabled(true)}
                className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)] transition-all duration-150 ease-spring hover:bg-brand-500 active:scale-[0.97]"
              >
                <Radio className="h-3.5 w-3.5" /> Enable puppeteer
              </button>
            )}
          </div>
        )}

        {/* Active mocks */}
        {mocks.length > 0 && (
          <section aria-label="Active fetch mocks">
            <SectionHeader label="Fetch mocks" count={mocks.length} />
            <ul>
              {mocks.map((spec) => (
                <MockRow
                  key={spec.id}
                  spec={spec}
                  onRemove={(id) => void removePuppeteerMock(id)}
                />
              ))}
            </ul>
          </section>
        )}

        {/* State overrides */}
        {overrides.length > 0 && (
          <section aria-label="Applied state overrides">
            <SectionHeader label="State overrides" count={overrides.length} />
            <div className="flex items-start gap-2 px-3.5 py-2 hairline-b bg-ink-900/20">
              <Info className="mt-0.5 h-3 w-3 flex-shrink-0 text-gray-500" />
              <p className="text-[11px] leading-relaxed text-gray-500">
                One-shot writes — revert by reloading the preview.
              </p>
            </div>
            <ul>
              {overrides.map((override) => (
                <OverrideRow key={override.id} override={override} />
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
