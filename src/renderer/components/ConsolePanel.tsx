/**
 * Easel — ConsolePanel.
 *
 * A dropdown showing warnings/errors captured from the previewed page's own
 * console. This is the answer to "the page is blank and I don't know why" — an
 * uncaught error like `ReferenceError: features is not defined` shows up here.
 */

import React from 'react';
import {
  Terminal,
  AlertTriangle,
  AlertCircle,
  Trash2,
  Wrench,
  Loader2,
  CheckCircle2,
} from 'lucide-react';
import { useEaselStore } from '../store';
import type { PageLog } from '../store';
import { Tooltip } from './Tooltip';

/**
 * Compact resolution badge shown after a "Fix this" edit finishes: a green
 * check when no equivalent error re-fired, or an amber note when it did.
 */
function FixStatus({ state }: { state: NonNullable<PageLog['error']>['fixState'] }): React.ReactElement | null {
  if (state === 'resolved') {
    return (
      <span className="flex items-center gap-1 text-[10.5px] font-medium text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> Resolved
      </span>
    );
  }
  if (state === 'still-erroring') {
    return (
      <span className="flex items-center gap-1 text-[10.5px] font-medium text-amber-400">
        <AlertTriangle className="h-3 w-3" /> Still erroring
      </span>
    );
  }
  return null;
}

export function ConsolePanel(): React.ReactElement {
  const pageLogs = useEaselStore((s) => s.pageLogs);
  const clearPageLogs = useEaselStore((s) => s.clearPageLogs);
  const fixPageError = useEaselStore((s) => s.fixPageError);
  const streaming = useEaselStore((s) => s.streaming);
  const hasProject = useEaselStore((s) => s.project !== null);

  // Newest first.
  const items = [...pageLogs].reverse();

  return (
    <div className="glass-panel animate-panel-in absolute right-0 top-full mt-2 z-30 w-[26rem] overflow-hidden origin-top-right">
      <div className="flex items-center justify-between px-3.5 py-2.5 hairline-b">
        <span className="flex items-center gap-2 text-[12px] font-semibold text-gray-200">
          <Terminal className="h-3.5 w-3.5 text-brand-400" /> Page console
        </span>
        {items.length > 0 && (
          <Tooltip label="Clear console" side="left">
            <button
              aria-label="Clear console"
              onClick={() => clearPageLogs()}
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-gray-500 transition-all duration-150 ease-spring hover:bg-white/[0.06] hover:text-gray-300 active:scale-[0.97]"
            >
              <Trash2 className="h-3 w-3" /> Clear
            </button>
          </Tooltip>
        )}
      </div>

      {items.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
          No warnings or errors from the page. If the preview is blank, errors will surface here.
        </div>
      ) : (
        <ul className="surface-inset mx-2 my-2 max-h-80 overflow-y-auto py-1">
          {items.map((l) => (
            <li
              key={l.id}
              className="flex items-start gap-2.5 px-3.5 py-2 hairline-b last:border-0"
            >
              <span className={`mt-0.5 flex-shrink-0 ${l.level === 'error' ? 'text-rose-400' : 'text-amber-400'}`}>
                {l.level === 'error' ? <AlertCircle className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-gray-300">
                  {l.message}
                </span>
                {l.source && <span className="mt-0.5 block truncate text-[10.5px] text-gray-600">{l.source}</span>}

                {/* Uncaught runtime errors carry structured source info → offer a
                    one-click AI fix targeting the throwing file. */}
                {l.error && (
                  <span className="mt-1.5 flex items-center gap-2">
                    {l.error.fixState === 'fixing' ? (
                      <span className="flex items-center gap-1 text-[10.5px] font-medium text-brand-400">
                        <Loader2 className="h-3 w-3 animate-spin" /> Fixing…
                      </span>
                    ) : l.error.fixState === 'resolved' || l.error.fixState === 'still-erroring' ? (
                      <FixStatus state={l.error.fixState} />
                    ) : (
                      <Tooltip
                        label={
                          !hasProject
                            ? 'Open a project folder so Claude can edit its source'
                            : streaming
                              ? 'An edit is already running'
                              : 'Let Claude fix this error'
                        }
                        side="top"
                      >
                        <button
                          aria-label="Fix this error"
                          onClick={() => void fixPageError(l.id)}
                          disabled={streaming || !hasProject}
                          className="flex items-center gap-1 rounded-md border border-brand-500/40 bg-brand-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-brand-300 transition-all duration-150 ease-spring hover:bg-brand-500/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <Wrench className="h-3 w-3" /> Fix
                        </button>
                      </Tooltip>
                    )}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
