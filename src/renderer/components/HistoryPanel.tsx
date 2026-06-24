/**
 * Easel — HistoryPanel.
 *
 * A dropdown timeline of git-backed checkpoints. Each entry is a state you can
 * jump back to; clicking one restores the working tree to that checkpoint and
 * reloads the preview. The entry the working tree currently matches is marked.
 */

import React from 'react';
import { History, Check, RotateCcw, Clock } from 'lucide-react';
import { useEaselStore } from '../store';

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function HistoryPanel(): React.ReactElement {
  const checkpoints = useEaselStore((s) => s.checkpoints);
  const currentId = useEaselStore((s) => s.currentCheckpointId);
  const restoreCheckpoint = useEaselStore((s) => s.restoreCheckpoint);

  // Newest first.
  const items = [...checkpoints].reverse();

  return (
    <div className="absolute left-0 top-full mt-1.5 z-30 w-80 overflow-hidden rounded-xl border border-white/10 bg-ink-900/95 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)] backdrop-blur-xl">
      <div className="flex items-center justify-between px-3.5 py-2.5 hairline-b">
        <span className="flex items-center gap-2 text-[12px] font-semibold text-gray-200">
          <History className="h-3.5 w-3.5 text-brand-400" /> History
        </span>
        <span className="text-[11px] text-gray-500">
          {checkpoints.length} checkpoint{checkpoints.length === 1 ? '' : 's'}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
          No edits yet. Changes Easel makes will appear here, so you can revert any of them.
        </div>
      ) : (
        <ul className="max-h-80 overflow-y-auto py-1">
          {items.map((c) => {
            const isCurrent = c.id === currentId;
            return (
              <li key={c.id}>
                <button
                  onClick={() => void restoreCheckpoint(c.id)}
                  disabled={isCurrent}
                  title={isCurrent ? 'Current state' : `Revert to: ${c.message}`}
                  className={`group flex w-full items-start gap-2.5 px-3.5 py-2 text-left transition-colors ${
                    isCurrent ? 'bg-brand-500/10' : 'hover:bg-white/[0.05]'
                  }`}
                >
                  <span
                    className={`mt-0.5 grid h-4 w-4 flex-shrink-0 place-items-center rounded-full ${
                      isCurrent ? 'bg-brand-500/20 text-brand-300' : 'text-gray-600 group-hover:text-gray-300'
                    }`}
                  >
                    {isCurrent ? <Check className="h-3 w-3" /> : <RotateCcw className="h-3 w-3" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12.5px] text-gray-200">{c.message}</span>
                    <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-gray-500">
                      <Clock className="h-2.5 w-2.5" /> {relTime(c.createdAt)}
                      {c.changedFiles.length > 0 && (
                        <span>· {c.changedFiles.length} file{c.changedFiles.length === 1 ? '' : 's'}</span>
                      )}
                    </span>
                  </span>
                  {!isCurrent && (
                    <span className="self-center text-[10.5px] font-medium text-gray-600 opacity-0 transition group-hover:text-brand-300 group-hover:opacity-100">
                      Revert
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
