/**
 * Easel — StateDiffList.
 *
 * Shared rendering for a time-travel state deep-diff (a list of
 * {@link StateDiffEntry}). Used by BOTH the cockpit's Time-travel tab
 * (`StateXRayPanel`) and the History panel's per-checkpoint state-diff expander
 * so the two stay visually identical. Pure presentation — the caller computes
 * the diff (via the store's `compareSnapshots`) and passes the result in.
 */

import React from 'react';
import type { StateDiffEntry } from '@shared/xray';

/** Per-kind badge styling, shared so both diff surfaces match exactly. */
export const DIFF_KIND_STYLE: Record<StateDiffEntry['kind'], string> = {
  added: 'bg-emerald-500/15 text-emerald-400',
  removed: 'bg-rose-500/15 text-rose-400',
  changed: 'bg-amber-500/15 text-amber-400',
};

/**
 * Render a state deep-diff. `diff` semantics:
 *   - `null`     → nothing compared yet (caller-defined empty prompt shown).
 *   - `'none'`   → compared, but a snapshot was missing for one side.
 *   - `[]`       → compared, no state changes between the two points.
 *   - `[...]`    → the ordered list of leaf changes.
 *
 * The three "empty" branches render caller-supplied copy so each host can phrase
 * them in context, while the populated branch is identical everywhere.
 */
export function StateDiffList({
  diff,
  emptyPrompt,
  missingPrompt,
  noChangesPrompt,
}: {
  diff: StateDiffEntry[] | null | 'none';
  emptyPrompt: React.ReactNode;
  missingPrompt: React.ReactNode;
  noChangesPrompt: React.ReactNode;
}): React.ReactElement {
  if (diff === null) {
    return (
      <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
        {emptyPrompt}
      </div>
    );
  }
  if (diff === 'none') {
    return (
      <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
        {missingPrompt}
      </div>
    );
  }
  if (diff.length === 0) {
    return (
      <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
        {noChangesPrompt}
      </div>
    );
  }

  return (
    <ul>
      {diff.map((d, i) => (
        <li
          key={`${d.path}-${i}`}
          className="flex items-start gap-2 px-3.5 py-1.5 hairline-b last:border-0"
        >
          <span
            className={`mt-0.5 flex-shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${DIFF_KIND_STYLE[d.kind]}`}
          >
            {d.kind}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-[11.5px] text-gray-300" title={d.path}>
              {d.path}
            </span>
            <span className="mt-0.5 block font-mono text-[11px] text-gray-500">
              {d.kind !== 'added' && <span className="text-rose-400/80">{d.before}</span>}
              {d.kind === 'changed' && <span className="text-gray-600"> → </span>}
              {d.kind !== 'removed' && <span className="text-emerald-400/80">{d.after}</span>}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}
