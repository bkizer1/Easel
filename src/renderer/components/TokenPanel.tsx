/**
 * Easel — TokenPanel (Live token inspector, #8).
 *
 * For the picked element, lists its computed color/spacing/typography values
 * and whether each maps to a project design token (CSS custom property or
 * Tailwind token). "Use token" swaps the hardcoded value for the token in
 * source; values with no match are flagged "off-system".
 */

import React, { useEffect } from 'react';
import { Palette, X, ArrowRight } from 'lucide-react';
import { useEaselStore } from '../store';
import { Tooltip } from './Tooltip';

export function TokenPanel(): React.ReactElement | null {
  const targets = useEaselStore((s) => s.targets);
  const tokenMatches = useEaselStore((s) => s.tokenMatches);
  const tokenLoading = useEaselStore((s) => s.tokenLoading);
  const fetchTokenMatches = useEaselStore((s) => s.fetchTokenMatches);
  const clearTokenMatches = useEaselStore((s) => s.clearTokenMatches);
  const tokenizeValue = useEaselStore((s) => s.tokenizeValue);
  const streaming = useEaselStore((s) => s.streaming);

  const target = targets.length > 0 ? targets[targets.length - 1] : null;
  const selector = target?.selector ?? null;
  const computed = target?.computedStyles;

  // Resolve token matches whenever a new element (with computed styles) is picked.
  useEffect(() => {
    if (selector && computed && Object.keys(computed).length > 0) {
      void fetchTokenMatches(computed);
    }
    // Re-run only when the picked element changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selector]);

  if (!selector || tokenMatches === null) return null;

  return (
    <div className="glass-panel animate-slide-up absolute top-16 left-4 z-30 w-72 overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2.5 hairline-b">
        <Palette className="h-3.5 w-3.5 text-brand-400" />
        <span className="text-[12px] font-semibold text-gray-200">Design tokens</span>
        {tokenLoading && <span className="text-[10.5px] text-gray-500">resolving…</span>}
        <Tooltip label="Close token inspector" side="top">
          <button
            onClick={() => clearTokenMatches()}
            aria-label="Close token inspector"
            className="ml-auto grid h-6 w-6 place-items-center rounded-md text-gray-500 hover:bg-white/10 hover:text-gray-200 transition-all duration-150 ease-spring active:scale-90"
          >
            <X className="h-3 w-3" />
          </button>
        </Tooltip>
      </div>

      <ul className="max-h-72 overflow-y-auto py-1">
        {tokenMatches.map((m) => (
          <li key={m.property} className="px-3 py-1.5">
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-gray-500 truncate max-w-[40%]" title={m.property}>
                {m.property}
              </span>
              <span className="font-mono text-[11px] text-gray-300 truncate flex-1" title={m.value}>
                {m.value}
              </span>
            </div>
            {m.token ? (
              <div className="mt-1 flex items-center gap-1.5">
                <ArrowRight className="h-3 w-3 text-brand-400" />
                <span className="font-mono text-[11px] text-brand-300 truncate flex-1" title={m.token.replacement}>
                  {m.token.name}
                </span>
                <Tooltip label={`Replace hardcoded value with ${m.token.name}`} side="top">
                  <button
                    onClick={() => void tokenizeValue(m)}
                    disabled={streaming}
                    aria-label={`Use token ${m.token.name}`}
                    className="rounded-md bg-brand-600 px-2 py-0.5 text-[10.5px] font-medium text-white hover:bg-brand-500 disabled:opacity-30 transition-all duration-150 ease-spring active:scale-[0.97]"
                  >
                    Use token
                  </button>
                </Tooltip>
              </div>
            ) : (
              <div className="mt-1 text-[10.5px] text-amber-400/80">off-system (no token match)</div>
            )}
          </li>
        ))}
        {tokenMatches.length === 0 && !tokenLoading && (
          <li className="px-3.5 py-3 text-[11.5px] text-gray-500">No inspectable values.</li>
        )}
      </ul>
    </div>
  );
}
