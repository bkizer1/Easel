/**
 * Easel — ExtractComponentCta.
 *
 * Issue #15: Lasso refactor — extract a reusable component.
 *
 * Presentational CTA rendered above the composer when the current selection
 * contains extractable similarity clusters (>= 2 structurally-similar elements
 * spanning >= 2 source files). Shows the top cluster and lets the user rename
 * the suggested component name before kicking off the refactor.
 */

import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useEaselStore } from '../store';
import { extractableClusters } from '../lib/refactorClusters';

export function ExtractComponentCta(): React.ReactElement | null {
  const targets = useEaselStore((s) => s.targets);
  const submitRefactor = useEaselStore((s) => s.submitRefactor);
  const streaming = useEaselStore((s) => s.streaming);

  const clusters = React.useMemo(() => extractableClusters(targets), [targets]);

  const cluster = clusters[0];

  // Keep a local copy of the suggested name so the user can rename before extracting.
  // Reset when the cluster changes (different selection).
  const [name, setName] = useState<string>(() => cluster?.suggestedName ?? '');

  // Sync the input when the top cluster changes identity.
  const clusterId = cluster?.id;
  React.useEffect(() => {
    if (cluster) setName(cluster.suggestedName);
  }, [clusterId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!cluster) return null;

  const firstTag = cluster.members[0]?.tagName ?? 'element';

  function handleExtract(): void {
    if (!cluster || streaming) return;
    void submitRefactor(cluster.id, name.trim() || cluster.suggestedName);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleExtract();
    }
  }

  return (
    <div className="mb-2 flex items-start gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.08] px-2.5 py-2 animate-slide-up">
      {/* Icon */}
      <span className="mt-0.5 grid place-items-center w-5 h-5 flex-shrink-0 rounded-md bg-emerald-500/15 text-emerald-300">
        <Sparkles className="w-3 h-3" />
      </span>

      {/* Body */}
      <div className="flex-1 min-w-0 space-y-1.5">
        <p className="text-[11.5px] font-semibold text-emerald-100/90 leading-tight">
          Extract a reusable component
        </p>
        <p className="text-[11px] text-emerald-200/60 leading-tight">
          {cluster.members.length} similar &lt;{firstTag}&gt; across {cluster.files.length} files
        </p>

        {/* Inline name input + Extract button */}
        <div className="flex items-center gap-1.5 pt-0.5">
          <input
            type="text"
            aria-label="Component name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={streaming}
            className="flex-1 min-w-0 rounded-md bg-ink-800/80 border border-white/10 px-2 py-1 text-[11px] font-mono text-gray-100 placeholder-gray-600 outline-none focus:border-emerald-500/50 disabled:opacity-50 disabled:cursor-not-allowed"
            placeholder="ComponentName"
          />
          <button
            type="button"
            aria-label="Extract component"
            onClick={handleExtract}
            disabled={streaming}
            className="flex-shrink-0 flex items-center gap-1 rounded-md bg-emerald-600/30 border border-emerald-500/25 px-2 py-1 text-[11px] font-medium text-emerald-200 transition-all duration-150 ease-spring hover:bg-emerald-600/45 active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100"
          >
            <Sparkles className="w-3 h-3" />
            Extract
          </button>
        </div>
      </div>
    </div>
  );
}
