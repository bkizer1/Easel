/**
 * Easel Renderer — guardrail allow-once prompt.
 *
 * When the agent tries to write a path the project's `.easel/policy.json` marks
 * `requireConfirm`, the edit pauses and a `policy-confirm` warning queues an
 * entry in `pendingPolicyConfirms`. This component surfaces the oldest pending
 * write as a docked prompt with Allow-once / Deny actions; answering resolves
 * the paused write in the main process via `respondPolicyConfirm`.
 *
 * Renders nothing when there is nothing to confirm.
 */

import { ShieldAlert } from 'lucide-react';
import { useEaselStore } from '../store';

export function PolicyPrompt(): JSX.Element | null {
  const pending = useEaselStore((s) => s.pendingPolicyConfirms);
  const respond = useEaselStore((s) => s.respondPolicyConfirm);

  // Surface one at a time (FIFO) to keep the decision unambiguous.
  const current = pending[0];
  if (!current) return null;

  const { requestId, path, reason } = current;

  return (
    <div
      role="alertdialog"
      aria-live="assertive"
      aria-label="Guardrail confirmation"
      className={[
        'fixed bottom-5 left-1/2 -translate-x-1/2 z-50',
        'flex items-start gap-3',
        'px-4 py-3 rounded-xl',
        'bg-amber-950/85 backdrop-blur-xl border border-amber-500/30 text-amber-50 text-sm',
        'shadow-[0_8px_40px_-8px_rgba(0,0,0,0.6)] max-w-md w-[calc(100%-2rem)]',
      ].join(' ')}
    >
      <span className="grid place-items-center w-6 h-6 rounded-lg bg-amber-500/15 text-amber-300 flex-shrink-0 mt-0.5">
        <ShieldAlert className="w-3.5 h-3.5" />
      </span>
      <div className="flex-1 min-w-0">
        <p className="leading-snug">
          The agent wants to edit{' '}
          <span className="font-mono text-amber-100 break-all">{path}</span>.
        </p>
        <p className="mt-0.5 text-[12px] text-amber-200/70 leading-snug">{reason}</p>
        <div className="mt-2.5 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void respond(requestId, path, true)}
            className="px-3 py-1.5 rounded-lg bg-amber-400 text-ink-950 text-xs font-semibold hover:brightness-110 transition"
          >
            Allow once
          </button>
          <button
            type="button"
            onClick={() => void respond(requestId, path, false)}
            className="px-3 py-1.5 rounded-lg bg-amber-500/10 text-amber-100 text-xs font-semibold hover:bg-amber-500/20 transition"
          >
            Deny
          </button>
          {pending.length > 1 && (
            <span className="ml-auto text-[11px] text-amber-200/60">
              +{pending.length - 1} more
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
