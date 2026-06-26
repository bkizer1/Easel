/**
 * Easel — HistoryPanel.
 *
 * A dropdown timeline of git-backed checkpoints. Each entry is a state you can
 * jump back to; clicking one restores the working tree to that checkpoint and
 * reloads the preview. The entry the working tree currently matches is marked.
 *
 * Issue #7: each entry can be expanded to a before/after visual diff — an
 * onion-skin slider over the pre-edit and post-HMR preview screenshots — so the
 * visual change (including layout shifts the file diff hides) is visible.
 */

import React, { useState } from 'react';
import {
  History,
  Check,
  RotateCcw,
  Clock,
  Images,
  ChevronDown,
  ChevronRight,
  FlaskConical,
  Trash2,
  GitPullRequest,
  ExternalLink,
} from 'lucide-react';
import type { Checkpoint } from '@shared/types';
import { useEaselStore } from '../store';
import { easel } from '../lib/api';

function relTime(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Before/after onion-skin visual diff for one checkpoint. */
function VisualDiff({ checkpointId }: { checkpointId: string }): React.ReactElement {
  const getCheckpointShots = useEaselStore((s) => s.getCheckpointShots);
  const [shots, setShots] = useState<{ before?: string; after?: string } | null>(null);
  const [opacity, setOpacity] = useState(100);
  const [loaded, setLoaded] = useState(false);

  // Lazy-load on first render of the expanded view.
  React.useEffect(() => {
    let active = true;
    void getCheckpointShots(checkpointId).then((s) => {
      if (active) {
        setShots(s);
        setLoaded(true);
      }
    });
    return () => {
      active = false;
    };
  }, [checkpointId, getCheckpointShots]);

  if (!loaded) {
    return <div className="px-3.5 py-3 text-[11px] text-gray-500">Loading screenshots…</div>;
  }
  const hasAny = shots && (shots.before || shots.after);
  if (!hasAny) {
    return <div className="px-3.5 py-3 text-[11px] text-gray-500">No screenshots for this checkpoint.</div>;
  }

  return (
    <div className="px-3.5 pb-3 pt-1">
      {/* Onion-skin: before with after overlaid at the slider opacity. */}
      <div className="relative overflow-hidden rounded-md border border-white/10 bg-black/40">
        {shots!.before && (
          <img src={shots!.before} alt="before" className="block w-full" draggable={false} />
        )}
        {shots!.after && (
          <img
            src={shots!.after}
            alt="after"
            className="absolute inset-0 block w-full"
            style={{ opacity: opacity / 100 }}
            draggable={false}
          />
        )}
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <span className="text-[10px] text-gray-500">Before</span>
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          onChange={(e) => setOpacity(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer accent-brand-400"
          aria-label="Onion-skin opacity"
          disabled={!shots!.before || !shots!.after}
        />
        <span className="text-[10px] text-gray-500">After</span>
      </div>
      {(!shots!.before || !shots!.after) && (
        <div className="mt-1 text-[10px] text-amber-400/70">
          Only the {shots!.before ? 'before' : 'after'} frame was captured.
        </div>
      )}
    </div>
  );
}

function CheckpointEntry({ c, isCurrent }: { c: Checkpoint; isCurrent: boolean }): React.ReactElement {
  const restoreCheckpoint = useEaselStore((s) => s.restoreCheckpoint);
  const [expanded, setExpanded] = useState(false);

  return (
    <li>
      <div
        className={`group flex w-full items-start gap-2.5 px-3.5 py-2 ${
          isCurrent ? 'bg-brand-500/10' : 'hover:bg-white/[0.05]'
        }`}
      >
        <button
          onClick={() => void restoreCheckpoint(c.id)}
          disabled={isCurrent}
          title={isCurrent ? 'Current state' : `Revert to: ${c.message}`}
          className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
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
        </button>
        <button
          onClick={() => setExpanded((e) => !e)}
          title="Before / after screenshots"
          className="mt-0.5 flex shrink-0 items-center gap-0.5 rounded-md px-1 py-0.5 text-gray-500 hover:bg-white/10 hover:text-brand-300"
        >
          <Images className="h-3 w-3" />
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      </div>
      {expanded && <VisualDiff checkpointId={c.id} />}
    </li>
  );
}

/** Issue #11: start / keep / discard a scratch experiment. */
function ScratchControls(): React.ReactElement {
  const scratch = useEaselStore((s) => s.scratch);
  const project = useEaselStore((s) => s.project);
  const streaming = useEaselStore((s) => s.streaming);
  const startScratch = useEaselStore((s) => s.startScratch);
  const keepScratch = useEaselStore((s) => s.keepScratch);
  const discardScratch = useEaselStore((s) => s.discardScratch);
  const [opening, setOpening] = useState(false);
  const [name, setName] = useState('');

  if (scratch?.active) {
    return (
      <div className="flex items-center gap-2 bg-amber-500/[0.08] px-3.5 py-2 hairline-b">
        <FlaskConical className="h-3.5 w-3.5 shrink-0 text-amber-300" />
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-amber-200/90">
          Experiment{scratch.name ? `: ${scratch.name}` : ' in progress'}
        </span>
        <button
          onClick={() => void keepScratch()}
          disabled={streaming}
          title="Keep these edits on the main line"
          className="flex items-center gap-1 rounded-md bg-brand-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-500 disabled:opacity-30"
        >
          <Check className="h-3 w-3" /> Keep
        </button>
        <button
          onClick={() => void discardScratch()}
          disabled={streaming}
          title="Discard the experiment and restore the pre-scratch state"
          className="flex items-center gap-1 rounded-md bg-ink-800 px-2 py-1 text-[11px] text-gray-300 hover:bg-rose-500/15 hover:text-rose-300 disabled:opacity-30"
        >
          <Trash2 className="h-3 w-3" /> Discard
        </button>
      </div>
    );
  }

  if (opening) {
    const submit = (): void => {
      void startScratch(name.trim() || undefined);
      setOpening(false);
      setName('');
    };
    return (
      <div className="flex items-center gap-1.5 px-3.5 py-2 hairline-b">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setOpening(false);
          }}
          placeholder="Experiment name (optional)"
          className="flex-1 rounded-md border border-white/10 bg-ink-800 px-2 py-1 text-[11.5px] text-gray-200 placeholder-gray-600 focus:border-brand-500/50 focus:outline-none"
        />
        <button
          onClick={submit}
          className="rounded-md bg-brand-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-brand-500"
        >
          Start
        </button>
      </div>
    );
  }

  return (
    <div className="px-3.5 py-2 hairline-b">
      <button
        onClick={() => setOpening(true)}
        disabled={!project || streaming}
        title="Start a throwaway experiment you can keep or discard"
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-ink-800/70 px-2 py-1.5 text-[11.5px] text-gray-300 hover:bg-ink-700 disabled:opacity-30"
      >
        <FlaskConical className="h-3.5 w-3.5 text-brand-400" /> Start experiment
      </button>
    </div>
  );
}

/** Issue #10: branch & open a PR from this session's accepted checkpoints. */
function PublishFooter(): React.ReactElement | null {
  const checkpoints = useEaselStore((s) => s.checkpoints);
  const publishing = useEaselStore((s) => s.publishing);
  const lastPrUrl = useEaselStore((s) => s.lastPrUrl);
  const openPr = useEaselStore((s) => s.openPr);
  const scratch = useEaselStore((s) => s.scratch);

  // Only the agent edits (those with a requestId) are publishable.
  const editCount = checkpoints.filter((c) => c.requestId).length;
  if (editCount === 0) return null;

  return (
    <div className="hairline-t px-3.5 py-2.5">
      <button
        onClick={() => void openPr()}
        disabled={publishing || scratch?.active}
        title={
          scratch?.active
            ? 'Keep or discard the active experiment before opening a PR'
            : 'Squash these edits onto a fresh branch off HEAD and open a PR'
        }
        className="flex w-full items-center justify-center gap-1.5 rounded-md bg-brand-600 px-2 py-1.5 text-[12px] font-medium text-white hover:bg-brand-500 disabled:opacity-30"
      >
        <GitPullRequest className="h-3.5 w-3.5" />
        {publishing ? 'Opening PR…' : `Branch & open PR (${editCount} edit${editCount === 1 ? '' : 's'})`}
      </button>
      {lastPrUrl && (
        <button
          onClick={() => void easel.preview.openExternal({ url: lastPrUrl })}
          className="mt-1.5 flex w-full items-center justify-center gap-1.5 text-[11px] text-brand-300 hover:text-brand-200"
        >
          <ExternalLink className="h-3 w-3" /> View pull request
        </button>
      )}
    </div>
  );
}

export function HistoryPanel(): React.ReactElement {
  const checkpoints = useEaselStore((s) => s.checkpoints);
  const currentId = useEaselStore((s) => s.currentCheckpointId);

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

      {/* Issue #11: scratch experiment controls */}
      <ScratchControls />

      {items.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
          No edits yet. Changes Easel makes will appear here, so you can revert any of them.
        </div>
      ) : (
        <ul className="max-h-80 overflow-y-auto py-1">
          {items.map((c) => (
            <CheckpointEntry key={c.id} c={c} isCurrent={c.id === currentId} />
          ))}
        </ul>
      )}

      {/* Issue #10: branch & open a PR from accepted checkpoints */}
      <PublishFooter />
    </div>
  );
}
