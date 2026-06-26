/**
 * Easel — StateXRayPanel.
 *
 * The "State X-Ray" inspection cockpit, mounted in the bottom dock. Three tabs:
 *  - State:       live state/props/hooks/computed-style of the picked element,
 *                 each row source-anchored with a one-click "Change this" edit.
 *  - Network:     the page's network requests (via the CDP tap), each failing
 *                 row offering "Add states" to bridge into a source edit.
 *  - Time-travel: deep-diff of two checkpoints' persisted state snapshots.
 *
 * Every observed fact bridges into the existing EditRequest pipeline through the
 * store actions; this component never touches the guest DOM or `window.easel`.
 */

import React from 'react';
import {
  ScanEye,
  X,
  RefreshCw,
  Wand2,
  Radio,
  Trash2,
  GitCompare,
  Loader2,
  MousePointer2,
} from 'lucide-react';
import { useEaselStore } from '../store';
import { formatSerializedValue } from '@shared/xray';
import type {
  ElementStateSnapshot,
  NetworkEntry,
  StateDiffEntry,
  StateEntry,
  StateGroup,
} from '@shared/xray';
import type { SourceLocation } from '@shared/types';
import { Tooltip } from './Tooltip';

/* -------------------------------------------------------------------------- */
/*  Small shared bits                                                          */
/* -------------------------------------------------------------------------- */

/** A source-anchored `file:line:col` chip, styled like an inspector target chip. */
function SourceChip({ src }: { src: SourceLocation }): React.ReactElement {
  const label = `${src.filePath}:${src.line}:${src.column}`;
  return (
    <span
      className="inline-flex max-w-[240px] items-center truncate rounded border border-white/10 bg-gray-800/90 px-1.5 py-0.5 font-mono text-[10.5px] text-gray-300"
      title={label}
    >
      {label}
    </span>
  );
}

const TAB_LABELS: Record<'state' | 'network' | 'time-travel', string> = {
  state: 'State',
  network: 'Network',
  'time-travel': 'Time-travel',
};

function shortId(id: string): string {
  return id.length > 7 ? id.slice(0, 7) : id;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* -------------------------------------------------------------------------- */
/*  State tab                                                                  */
/* -------------------------------------------------------------------------- */

const GROUP_ORDER: StateGroup[] = ['props', 'state', 'hooks', 'context', 'computed-style'];

const GROUP_LABELS: Record<StateGroup, string> = {
  props: 'Props',
  state: 'State',
  hooks: 'Hooks',
  context: 'Context',
  'computed-style': 'Computed style',
};

function ScrubControl({ entry }: { entry: StateEntry }): React.ReactElement | null {
  const scrubValue = useEaselStore((s) => s.scrubValue);
  const v = entry.value;

  if (v.kind === 'boolean') {
    return (
      <button
        onClick={() => scrubValue(entry.path, !v.value)}
        className={`rounded px-1.5 py-0.5 text-[10.5px] font-medium transition-all duration-150 ease-spring active:scale-[0.97] ${
          v.value
            ? 'bg-brand-500/15 text-brand-300'
            : 'bg-white/[0.06] text-gray-400 hover:text-gray-200'
        }`}
      >
        {String(v.value)}
      </button>
    );
  }

  if (v.kind === 'number' || v.kind === 'string') {
    return (
      <input
        type={v.kind === 'number' ? 'number' : 'text'}
        defaultValue={String(v.value)}
        onChange={(e) =>
          scrubValue(
            entry.path,
            v.kind === 'number' ? Number(e.target.value) : e.target.value,
          )
        }
        className="w-24 rounded border border-white/10 bg-ink-900/60 px-1.5 py-0.5 font-mono text-[11px] text-gray-200 focus:border-brand-500/50 focus:outline-none surface-inset"
      />
    );
  }

  return null;
}

function StateRow({ entry }: { entry: StateEntry }): React.ReactElement {
  const bridge = useEaselStore((s) => s.bridgeElementStateToEdit);
  const streaming = useEaselStore((s) => s.streaming);

  return (
    <li className="flex items-start gap-2 px-3.5 py-1.5 hairline-b last:border-0">
      <span className="mt-0.5 w-32 flex-shrink-0 truncate font-mono text-[11.5px] text-gray-400" title={entry.label}>
        {entry.label}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-gray-200" title={formatSerializedValue(entry.value)}>
        {formatSerializedValue(entry.value)}
      </span>
      {entry.writable && <ScrubControl entry={entry} />}
      <Tooltip label={streaming ? 'An edit is already running' : 'Bridge this value into a source edit'} side="top">
        <button
          onClick={() => void bridge(entry)}
          disabled={streaming}
          aria-label="Bridge this value into a source edit"
          className="flex flex-shrink-0 items-center gap-1 rounded-md border border-iris-500/40 bg-iris-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-iris-300 transition-all duration-150 ease-spring hover:bg-iris-500/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Wand2 className="h-3 w-3" /> Change this
        </button>
      </Tooltip>
    </li>
  );
}

function StateTab(): React.ReactElement {
  const snapshot = useEaselStore((s) => s.currentElementState);
  const refresh = useEaselStore((s) => s.refreshElementState);
  const mode = useEaselStore((s) => s.mode);
  const setMode = useEaselStore((s) => s.setMode);

  if (!snapshot) {
    const selecting = mode === 'element-select';
    return (
      <div className="flex flex-col items-center gap-3 px-3.5 py-7 text-center animate-fade-in">
        <span className="grid place-items-center h-10 w-10 rounded-xl border border-brand-500/20 bg-brand-500/10 text-brand-300">
          <MousePointer2 className="h-4 w-4" />
        </span>
        <p className="max-w-[280px] text-[12px] leading-relaxed text-gray-400">
          {selecting
            ? 'Select mode is on — click any element in the preview to inspect its live state, props, hooks and computed style.'
            : 'Pick an element to inspect its live state, props, hooks and computed style.'}
        </p>
        {selecting ? (
          <span className="flex items-center gap-1.5 text-[11px] text-brand-300/90">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-400" />
            Select mode active
          </span>
        ) : (
          <button
            onClick={() => setMode('element-select')}
            className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-[12px] font-medium text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.18)] transition-all duration-150 ease-spring hover:bg-brand-500 active:scale-[0.97]"
          >
            <MousePointer2 className="h-3.5 w-3.5" /> Enable Select mode
          </button>
        )}
      </div>
    );
  }

  return <StateBody snapshot={snapshot} onRefresh={refresh} />;
}

function StateBody({
  snapshot,
  onRefresh,
}: {
  snapshot: ElementStateSnapshot;
  onRefresh: () => void;
}): React.ReactElement {
  const changedKeys = snapshot.renderCause?.changedKeys ?? [];
  const computedStyleEntries = Object.entries(snapshot.computedStyle);

  // Group entries (preserving GROUP_ORDER) but skip computed-style here — it has
  // its own dedicated section rendered from snapshot.computedStyle.
  const grouped = GROUP_ORDER.filter((g) => g !== 'computed-style').map((group) => ({
    group,
    entries: snapshot.entries.filter((e) => e.group === group),
  }));

  return (
    <div>
      {/* Sub-header: framework + name + source anchor + refresh */}
      <div className="flex items-center gap-2 px-3.5 py-2 hairline-b">
        <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-gray-400">
          {snapshot.framework}
        </span>
        <span className="truncate font-mono text-[12px] text-gray-200" title={snapshot.selector}>
          {snapshot.componentName ?? snapshot.selector}
        </span>
        {snapshot.dataEaselSource && <SourceChip src={snapshot.dataEaselSource} />}
        <Tooltip label="Re-read the element's live state" side="top">
          <button
            onClick={onRefresh}
            aria-label="Refresh element state"
            className="ml-auto flex flex-shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-gray-500 transition-all duration-150 ease-spring hover:bg-white/[0.06] hover:text-gray-300 active:scale-[0.97]"
          >
            <RefreshCw className="h-3 w-3" /> Refresh
          </button>
        </Tooltip>
      </div>

      {snapshot.error && (
        <div className="px-3.5 py-2 text-[11.5px] text-amber-400">{snapshot.error}</div>
      )}

      {changedKeys.length > 0 && (
        <div className="px-3.5 py-1.5 text-[11px] text-gray-500">
          Changed since last render:{' '}
          <span className="font-mono text-gray-400">{changedKeys.join(', ')}</span>
        </div>
      )}

      {grouped.map(({ group, entries }) =>
        entries.length === 0 ? null : (
          <div key={group}>
            <div className="px-3.5 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
              {GROUP_LABELS[group]}
            </div>
            <ul>
              {entries.map((entry) => (
                <StateRow key={entry.path.join('.') || entry.label} entry={entry} />
              ))}
            </ul>
          </div>
        ),
      )}

      {computedStyleEntries.length > 0 && (
        <div>
          <div className="px-3.5 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-gray-500">
            Computed style
          </div>
          <ul className="px-3.5 pb-2">
            {computedStyleEntries.map(([prop, val]) => (
              <li key={prop} className="flex items-baseline gap-2 py-0.5 font-mono text-[11px]">
                <span className="w-32 flex-shrink-0 truncate text-gray-500" title={prop}>
                  {prop}
                </span>
                <span className="min-w-0 flex-1 truncate text-gray-300" title={val}>
                  {val}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Network tab                                                                */
/* -------------------------------------------------------------------------- */

function statusColor(entry: NetworkEntry): string {
  if (entry.failed) return 'text-rose-400';
  const s = entry.status;
  if (s === undefined) return 'text-gray-500';
  if (s >= 500) return 'text-rose-400';
  if (s >= 400) return 'text-amber-400';
  if (s >= 300) return 'text-gray-400';
  return 'text-emerald-400';
}

function NetworkRow({ entry }: { entry: NetworkEntry }): React.ReactElement {
  const bridge = useEaselStore((s) => s.bridgeNetworkToEdit);
  const streaming = useEaselStore((s) => s.streaming);
  const isFailing = entry.failed || (entry.status !== undefined && entry.status >= 400);

  return (
    <li
      className={`flex items-center gap-2 px-3.5 py-1.5 hairline-b last:border-0 ${
        isFailing ? 'bg-rose-500/[0.06]' : ''
      }`}
    >
      <span className="w-12 flex-shrink-0 font-mono text-[11px] uppercase text-gray-400">
        {entry.method}
      </span>
      <span className={`w-10 flex-shrink-0 font-mono text-[11px] ${statusColor(entry)}`}>
        {entry.failed ? 'ERR' : (entry.status ?? '—')}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-gray-300" title={entry.url}>
        {entry.url}
      </span>
      {entry.durationMs !== undefined && (
        <span className="flex-shrink-0 text-[10.5px] text-gray-500">{Math.round(entry.durationMs)}ms</span>
      )}
      {entry.initiator && <SourceChip src={entry.initiator} />}
      <Tooltip label={streaming ? 'An edit is already running' : 'Add loading/error states for this request'} side="top">
        <button
          onClick={() => void bridge(entry.id)}
          disabled={streaming}
          aria-label="Add loading/error states for this request"
          className="flex flex-shrink-0 items-center gap-1 rounded-md border border-iris-500/40 bg-iris-500/10 px-1.5 py-0.5 text-[10.5px] font-medium text-iris-300 transition-all duration-150 ease-spring hover:bg-iris-500/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Wand2 className="h-3 w-3" /> Add states
        </button>
      </Tooltip>
    </li>
  );
}

function NetworkTab(): React.ReactElement {
  const entries = useEaselStore((s) => s.networkEntries);
  const capturing = useEaselStore((s) => s.networkCapturing);
  const setCapture = useEaselStore((s) => s.setNetworkCapture);
  const clearLog = useEaselStore((s) => s.clearNetworkLog);

  // Newest first.
  const items = [...entries].reverse();

  return (
    <div>
      <div className="flex items-center gap-2 px-3.5 py-2 hairline-b">
        <Tooltip label={capturing ? 'Stop capturing network requests' : 'Start capturing network requests'} side="bottom">
          <button
            onClick={() => void setCapture(!capturing)}
            aria-label={capturing ? 'Stop capturing' : 'Start capturing'}
            className={`flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition-all duration-150 ease-spring active:scale-[0.97] ${
              capturing
                ? 'bg-brand-500/15 text-brand-300'
                : 'text-gray-400 hover:bg-white/[0.06] hover:text-gray-200'
            }`}
          >
            <Radio className={`h-3 w-3 ${capturing ? 'animate-pulse' : ''}`} />
            {capturing ? 'Capturing' : 'Capture'}
          </button>
        </Tooltip>
        {items.length > 0 && (
          <Tooltip label="Clear network log" side="bottom">
            <button
              onClick={() => void clearLog()}
              aria-label="Clear network log"
              className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-gray-500 transition-all duration-150 ease-spring hover:bg-white/[0.06] hover:text-gray-300 active:scale-[0.97]"
            >
              <Trash2 className="h-3 w-3" /> Clear
            </button>
          </Tooltip>
        )}
        <span className="ml-auto text-[11px] text-gray-500">
          {items.length} request{items.length === 1 ? '' : 's'}
        </span>
      </div>

      {items.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
          {capturing
            ? 'No requests captured yet. Interact with the page to log its network requests.'
            : "Turn on Capture to log the page's network requests."}
        </div>
      ) : (
        <ul>
          {items.map((entry) => (
            <NetworkRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Time-travel tab                                                            */
/* -------------------------------------------------------------------------- */

const DIFF_KIND_STYLE: Record<StateDiffEntry['kind'], string> = {
  added: 'bg-emerald-500/15 text-emerald-400',
  removed: 'bg-rose-500/15 text-rose-400',
  changed: 'bg-amber-500/15 text-amber-400',
};

function TimeTravelTab(): React.ReactElement {
  const checkpoints = useEaselStore((s) => s.checkpoints);
  const compareSnapshots = useEaselStore((s) => s.compareSnapshots);

  // `'none'` is the sentinel for "compared, but a snapshot was missing".
  const [diff, setDiff] = React.useState<StateDiffEntry[] | null | 'none'>(null);
  const [comparing, setComparing] = React.useState(false);

  // Default From = second-newest, To = newest. checkpoints are newest-first.
  const [fromId, setFromId] = React.useState<string>(() => checkpoints[1]?.id ?? '');
  const [toId, setToId] = React.useState<string>(() => checkpoints[0]?.id ?? '');

  async function runCompare(): Promise<void> {
    if (!fromId || !toId) return;
    setComparing(true);
    try {
      const result = await compareSnapshots(fromId, toId);
      setDiff(result === null ? 'none' : result);
    } finally {
      setComparing(false);
    }
  }

  if (checkpoints.length === 0) {
    return (
      <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
        No checkpoints yet. State snapshots are captured per checkpoint when an element is being
        inspected.
      </div>
    );
  }

  const selectClass =
    'min-w-0 flex-1 rounded-md border border-white/10 bg-ink-900/60 px-2 py-1 text-[11.5px] text-gray-200 focus:border-brand-500/50 focus:outline-none surface-inset';

  return (
    <div>
      <div className="flex items-center gap-2 px-3.5 py-2 hairline-b">
        <span className="flex-shrink-0 text-[11px] text-gray-500">From</span>
        <select value={fromId} onChange={(e) => setFromId(e.target.value)} className={selectClass}>
          {checkpoints.map((c) => (
            <option key={c.id} value={c.id}>
              {truncate(c.message, 40)} ({shortId(c.id)})
            </option>
          ))}
        </select>
        <span className="flex-shrink-0 text-[11px] text-gray-500">To</span>
        <select value={toId} onChange={(e) => setToId(e.target.value)} className={selectClass}>
          {checkpoints.map((c) => (
            <option key={c.id} value={c.id}>
              {truncate(c.message, 40)} ({shortId(c.id)})
            </option>
          ))}
        </select>
        <Tooltip label="Compare snapshots" side="top">
          <button
            onClick={() => void runCompare()}
            disabled={comparing || !fromId || !toId}
            aria-label="Compare snapshots"
            className="flex flex-shrink-0 items-center gap-1 rounded-md border border-iris-500/40 bg-iris-500/10 px-2 py-1 text-[11px] font-medium text-iris-300 transition-all duration-150 ease-spring hover:bg-iris-500/20 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {comparing ? <Loader2 className="h-3 w-3 animate-spin" /> : <GitCompare className="h-3 w-3" />}
            Compare
          </button>
        </Tooltip>
      </div>

      {diff === null ? (
        <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
          Pick two checkpoints and Compare to see how the inspected state changed between them.
        </div>
      ) : diff === 'none' ? (
        <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
          No state snapshot stored for one of these checkpoints (snapshots are captured when an
          element is being inspected at checkpoint time).
        </div>
      ) : diff.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] leading-relaxed text-gray-500">
          No state changes between these checkpoints.
        </div>
      ) : (
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
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Panel shell                                                                */
/* -------------------------------------------------------------------------- */

export function StateXRayPanel(): React.ReactElement {
  const xrayTab = useEaselStore((s) => s.xrayTab);
  const setXrayTab = useEaselStore((s) => s.setXrayTab);
  const setXrayOpen = useEaselStore((s) => s.setXrayOpen);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-3.5 py-2 hairline-b">
        <span className="flex items-center gap-2 text-[12px] font-semibold text-gray-200">
          <ScanEye className="h-3.5 w-3.5 text-brand-400" /> State X-Ray
        </span>

        <div className="flex items-center gap-1">
          {(['state', 'network', 'time-travel'] as const).map((tab) => (
            <button
              key={tab}
              onClick={() => setXrayTab(tab)}
              className={`rounded-md px-2 py-1 text-[11.5px] font-medium transition-all duration-150 ease-spring active:scale-[0.97] ${
                xrayTab === tab
                  ? 'bg-brand-500/15 text-brand-300'
                  : 'text-gray-400 hover:bg-white/[0.06] hover:text-gray-200'
              }`}
            >
              {TAB_LABELS[tab]}
            </button>
          ))}
        </div>

        <Tooltip label="Close State X-Ray" side="top">
          <button
            onClick={() => setXrayOpen(false)}
            aria-label="Close State X-Ray"
            className="ml-auto flex-shrink-0 rounded-md p-1 text-gray-500 transition-all duration-150 ease-spring hover:bg-white/[0.06] hover:text-gray-300 active:scale-90"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </Tooltip>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto">
        {xrayTab === 'state' && <StateTab />}
        {xrayTab === 'network' && <NetworkTab />}
        {xrayTab === 'time-travel' && <TimeTravelTab />}
      </div>
    </div>
  );
}
