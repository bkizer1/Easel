/**
 * Easel — ConsolePanel.
 *
 * A dropdown showing warnings/errors captured from the previewed page's own
 * console. This is the answer to "the page is blank and I don't know why" — an
 * uncaught error like `ReferenceError: features is not defined` shows up here.
 */

import React from 'react';
import { Terminal, AlertTriangle, AlertCircle, Trash2 } from 'lucide-react';
import { useEaselStore } from '../store';

export function ConsolePanel(): React.ReactElement {
  const pageLogs = useEaselStore((s) => s.pageLogs);
  const clearPageLogs = useEaselStore((s) => s.clearPageLogs);

  // Newest first.
  const items = [...pageLogs].reverse();

  return (
    <div className="absolute left-0 top-full mt-1.5 z-30 w-[26rem] overflow-hidden rounded-xl border border-white/10 bg-ink-900/95 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)] backdrop-blur-xl">
      <div className="flex items-center justify-between px-3.5 py-2.5 hairline-b">
        <span className="flex items-center gap-2 text-[12px] font-semibold text-gray-200">
          <Terminal className="h-3.5 w-3.5 text-brand-400" /> Page console
        </span>
        {items.length > 0 && (
          <button
            onClick={() => clearPageLogs()}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-gray-500 transition-colors hover:bg-white/[0.06] hover:text-gray-300"
          >
            <Trash2 className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      {items.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
          No warnings or errors from the page. If the preview is blank, errors will surface here.
        </div>
      ) : (
        <ul className="max-h-80 overflow-y-auto py-1">
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
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
