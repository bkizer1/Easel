/**
 * Easel — DevServerOverlay.
 *
 * Shown over the preview surface when the dev server for the current URL isn't
 * serving yet. Easel auto-starts the project's dev command on open, so most of
 * the time this is a transient "starting…" state that resolves itself once the
 * server responds (the reachability poll flips the surface back to the webview).
 *
 * Phases:
 *   connecting — just opened; we don't know the status yet.
 *   starting   — Easel is running the dev command; waiting for it to serve.
 *   down       — nothing is serving and nothing is starting.
 *   error      — the process we started exited / failed.
 */

import React from 'react';
import { Loader2, PlugZap, Square, Play } from 'lucide-react';
import type { DevServerState } from '@shared/ipc';

interface DevServerOverlayProps {
  url: string;
  state: DevServerState;
  reachable: boolean | null;
  command?: string;
  logTail: string[];
  /** True when we know a command to run (the open project has a detected dev command). */
  canStart: boolean;
  onStart: () => void;
  onStop: () => void;
}

type Phase = 'connecting' | 'starting' | 'down' | 'error';

function phaseOf(state: DevServerState, reachable: boolean | null): Phase {
  if (state === 'starting' || state === 'running') return 'starting';
  if (state === 'error') return 'error';
  if (reachable === null) return 'connecting';
  return 'down';
}

function LogTail({ lines }: { lines: string[] }): React.ReactElement | null {
  if (lines.length === 0) return null;
  return (
    <pre className="mt-4 max-h-40 w-full max-w-xl overflow-auto rounded-lg border border-white/10 bg-black/40 p-3 text-left text-[11px] font-mono leading-relaxed text-gray-400">
      {lines.join('\n')}
    </pre>
  );
}

export function DevServerOverlay(props: DevServerOverlayProps): React.ReactElement {
  const { url, state, reachable, command, logTail, canStart, onStart, onStop } = props;
  const phase = phaseOf(state, reachable);
  const spinning = phase === 'connecting' || phase === 'starting';

  return (
    <div className="absolute inset-0 grid place-items-center bg-gray-950 px-6 text-center select-none">
      <div className="flex max-w-xl flex-col items-center">
        {spinning ? (
          <Loader2 className="h-10 w-10 animate-spin text-brand-400" />
        ) : (
          <PlugZap className={`h-10 w-10 ${phase === 'error' ? 'text-rose-400' : 'text-gray-600'}`} />
        )}

        <h2 className="mt-4 text-sm font-semibold text-gray-200">
          {phase === 'connecting' && 'Connecting to your dev server…'}
          {phase === 'starting' && 'Starting your dev server…'}
          {phase === 'down' && 'No dev server running'}
          {phase === 'error' && 'Dev server stopped'}
        </h2>

        <p className="mt-1.5 max-w-sm text-xs leading-relaxed text-gray-500">
          {phase === 'connecting' && (
            <>
              Checking <span className="font-mono text-gray-400">{url}</span>…
            </>
          )}
          {phase === 'starting' && (
            <>
              Running <span className="font-mono text-gray-400">{command}</span>. The preview loads
              automatically once it responds.
            </>
          )}
          {phase === 'down' &&
            (canStart ? (
              <>
                Nothing is serving at <span className="font-mono text-gray-400">{url}</span>. Start it
                and the preview loads automatically.
              </>
            ) : (
              <>
                Nothing is serving at <span className="font-mono text-gray-400">{url}</span>. Start your
                dev server in a terminal — Easel checks every few seconds and loads it automatically.
              </>
            ))}
          {phase === 'error' && (
            <>
              The process at <span className="font-mono text-gray-400">{url}</span> exited. See its
              output below.
            </>
          )}
        </p>

        <LogTail lines={logTail} />

        <div className="mt-5 flex items-center gap-2">
          {phase === 'starting' ? (
            <button
              onClick={onStop}
              className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.06] px-3.5 py-2 text-xs font-medium text-gray-200 transition-colors hover:bg-white/[0.1]"
            >
              <Square className="h-3.5 w-3.5" /> Stop
            </button>
          ) : (
            canStart && (
              <button
                onClick={onStart}
                className="flex items-center gap-2 rounded-lg bg-brand-700 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-brand-600"
              >
                <Play className="h-3.5 w-3.5" />
                {phase === 'error' ? 'Restart dev server' : 'Start dev server'}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}
