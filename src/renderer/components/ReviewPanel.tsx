/**
 * Easel — ReviewPanel (issue #19: propose-don't-write).
 *
 * Rendered while a {@link ReviewSession} is active. The agent's edits were
 * STAGED in a shadow worktree rather than written to the live project, so this
 * panel lets the user review each staged change in isolation:
 *   - per-change Approve / Reject (reflecting its {@link ReviewDecision})
 *   - hovering/focusing a change highlights the affected on-page element (the
 *     live page is still pre-edit, so the highlight anchors to the diff's OLD
 *     source line via the store's `focusReviewChange`)
 *   - footer: "Apply approved (N)" copies the approved subset into the live
 *     project + creates a checkpoint; "Discard" tears the whole session down.
 *
 * Styling mirrors DiffViewer / the App slide-up panel pattern (Tailwind, ink
 * palette). The diff body reuses {@link SingleFileDiff} from DiffViewer.
 */

import React from 'react';
import { Check, X, RotateCcw, ShieldCheck } from 'lucide-react';
import { useEaselStore } from '../store';
import { reviewCounts } from '../lib/reviewSession';
import { SingleFileDiff } from './DiffViewer';
import { Tooltip } from './Tooltip';

/* -------------------------------------------------------------------------- */
/*  Per-change row                                                            */
/* -------------------------------------------------------------------------- */

function decisionRing(decision: 'pending' | 'approved' | 'rejected'): string {
  switch (decision) {
    case 'approved':
      return 'border-emerald-500/40 bg-emerald-950/10';
    case 'rejected':
      return 'border-red-500/30 bg-red-950/10 opacity-60';
    default:
      return 'border-white/[0.06]';
  }
}

/* -------------------------------------------------------------------------- */
/*  ReviewPanel                                                               */
/* -------------------------------------------------------------------------- */

export function ReviewPanel(): React.ReactElement | null {
  const reviewSession = useEaselStore((s) => s.reviewSession);
  const streaming = useEaselStore((s) => s.streaming);
  const setReviewDecision = useEaselStore((s) => s.setReviewDecision);
  const focusReviewChange = useEaselStore((s) => s.focusReviewChange);
  const applyReview = useEaselStore((s) => s.applyReview);
  const discardReview = useEaselStore((s) => s.discardReview);

  if (!reviewSession) return null;

  const { changes } = reviewSession;
  const counts = reviewCounts(changes);

  return (
    <div className="flex flex-col gap-2">
      {/* Header */}
      <div className="mb-1 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-brand-300">
          <ShieldCheck className="h-3.5 w-3.5" />
          Review {counts.total} {counts.total === 1 ? 'change' : 'changes'}
          {streaming && <span className="ml-1 font-normal text-gray-500">staging…</span>}
        </span>
        <span className="flex items-center gap-2 text-[11px] text-gray-500">
          <span className="text-emerald-400">{counts.approved} approved</span>
          <span className="text-red-400">{counts.rejected} rejected</span>
          <span>{counts.pending} pending</span>
        </span>
      </div>

      {/* Changes list */}
      <div className="flex max-h-80 flex-col gap-2 overflow-y-auto">
        {changes.length === 0 ? (
          <p className="px-1 py-3 text-[11.5px] text-gray-500">
            {streaming ? 'Waiting for staged changes…' : 'No changes were staged.'}
          </p>
        ) : (
          changes.map((change) => {
            const { filePath } = change.diff;
            return (
              <div
                key={filePath}
                onMouseEnter={() => focusReviewChange(filePath)}
                onMouseLeave={() => focusReviewChange(null)}
                onFocus={() => focusReviewChange(filePath)}
                onBlur={() => focusReviewChange(null)}
                className={`flex flex-col gap-2 rounded-lg border p-2 transition-colors ${decisionRing(change.decision)}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] text-gray-500">
                    {!change.source && (
                      <Tooltip label="No on-page element to highlight (created file or unmapped)" side="top">
                        <span className="text-amber-400/80">no preview anchor</span>
                      </Tooltip>
                    )}
                  </span>
                  <div className="flex gap-1.5">
                    <Tooltip label="Approve this change" side="top">
                      <button
                        type="button"
                        aria-label={`Approve ${filePath}`}
                        aria-pressed={change.decision === 'approved'}
                        onClick={() => setReviewDecision(filePath, 'approved')}
                        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-spring active:scale-[0.97] ${
                          change.decision === 'approved'
                            ? 'bg-emerald-700 text-white'
                            : 'bg-emerald-900/40 text-emerald-300 hover:bg-emerald-800/60'
                        }`}
                      >
                        <Check className="h-3 w-3" />
                        Approve
                      </button>
                    </Tooltip>
                    <Tooltip label="Reject this change" side="top">
                      <button
                        type="button"
                        aria-label={`Reject ${filePath}`}
                        aria-pressed={change.decision === 'rejected'}
                        onClick={() => setReviewDecision(filePath, 'rejected')}
                        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all duration-150 ease-spring active:scale-[0.97] ${
                          change.decision === 'rejected'
                            ? 'bg-red-800 text-white'
                            : 'bg-red-950/40 text-red-400 hover:bg-red-900/60'
                        }`}
                      >
                        <X className="h-3 w-3" />
                        Reject
                      </button>
                    </Tooltip>
                  </div>
                </div>
                <SingleFileDiff diff={change.diff} />
              </div>
            );
          })
        )}
      </div>

      {/* Footer actions */}
      <div className="mt-1 flex items-center justify-end gap-2">
        <Tooltip label="Discard the whole review session — nothing is written" side="top">
          <button
            type="button"
            aria-label="Discard review session"
            onClick={() => void discardReview()}
            className="flex items-center gap-1.5 rounded-md bg-ink-800/80 px-2.5 py-1.5 text-xs font-medium text-gray-300 transition-all duration-150 ease-spring hover:bg-ink-700/80 active:scale-[0.97]"
          >
            <RotateCcw className="h-3 w-3" />
            Discard
          </button>
        </Tooltip>
        <Tooltip
          label={
            counts.approved > 0
              ? 'Write the approved changes to the project and create a checkpoint'
              : 'Approve at least one change to apply'
          }
          side="top"
        >
          <button
            type="button"
            aria-label="Apply approved changes"
            onClick={() => void applyReview()}
            disabled={streaming || counts.approved === 0}
            className="flex items-center gap-1.5 rounded-md bg-brand-700 px-3 py-1.5 text-xs font-semibold text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.15)] transition-all duration-150 ease-spring hover:bg-brand-600 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-3 w-3" />
            Apply approved ({counts.approved})
          </button>
        </Tooltip>
      </div>
    </div>
  );
}
