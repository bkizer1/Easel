/**
 * Easel — DiffViewer component.
 *
 * Renders an array of FileDiff objects (unified-diff format) as a visual
 * add/del table, with Accept and Reject actions.
 *
 * Accept = keep the current checkpoint (no-op; just dismiss the diff panel).
 * Reject = call store.restoreCheckpoint to the checkpoint immediately before
 *          this edit, reverting source files and triggering HMR back to the
 *          pre-edit state.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Check, RotateCcw, FileText } from 'lucide-react';
import type { FileDiff } from '@shared/types';
import { useEaselStore } from '../store';

/* -------------------------------------------------------------------------- */
/*  Diff line parser                                                          */
/* -------------------------------------------------------------------------- */

type DiffLineKind = 'add' | 'del' | 'ctx' | 'hunk' | 'meta';

interface DiffLine {
  kind: DiffLineKind;
  text: string;
  lineNo?: number;
}

function parseDiff(unifiedDiff: string): DiffLine[] {
  const lines = unifiedDiff.split('\n');
  const result: DiffLine[] = [];
  let addNo = 0;
  let delNo = 0;

  for (const raw of lines) {
    if (raw.startsWith('@@')) {
      // Parse hunk header: @@ -l,s +l,s @@
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (match) {
        delNo = parseInt(match[1], 10);
        addNo = parseInt(match[2], 10);
      }
      result.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ') || raw.startsWith('index ')) {
      result.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      result.push({ kind: 'add', text: raw.slice(1), lineNo: addNo++ });
      continue;
    }
    if (raw.startsWith('-')) {
      result.push({ kind: 'del', text: raw.slice(1), lineNo: delNo++ });
      continue;
    }
    if (raw.startsWith(' ') || raw === '') {
      result.push({ kind: 'ctx', text: raw.slice(1) ?? '', lineNo: addNo });
      addNo++;
      delNo++;
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*  SingleFileDiff                                                            */
/* -------------------------------------------------------------------------- */

function SingleFileDiff({ diff }: { diff: FileDiff }): React.ReactElement {
  const [expanded, setExpanded] = useState(true);

  const changeColor: Record<FileDiff['changeType'], string> = {
    modified: 'text-blue-400',
    created: 'text-emerald-400',
    deleted: 'text-red-400',
    renamed: 'text-amber-400',
  };

  const lines = parseDiff(diff.unifiedDiff);

  return (
    <div className="border border-gray-800 rounded-lg overflow-hidden">
      {/* File header */}
      <button
        className="w-full flex items-center gap-2 px-3 py-2 bg-gray-900 hover:bg-gray-850 transition-colors text-left"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
        )}
        <FileText className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
        <span className="text-xs font-mono text-gray-300 truncate flex-1">{diff.filePath}</span>
        <span className={`text-xs font-medium flex-shrink-0 ${changeColor[diff.changeType]}`}>
          {diff.changeType}
        </span>
        <span className="text-xs text-emerald-500 flex-shrink-0">+{diff.additions}</span>
        <span className="text-xs text-red-400 flex-shrink-0 ml-1">-{diff.deletions}</span>
      </button>

      {/* Diff lines */}
      {expanded && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs font-mono border-collapse">
            <tbody>
              {lines.map((line, i) => {
                if (line.kind === 'meta') return null;
                if (line.kind === 'hunk') {
                  return (
                    <tr key={i} className="bg-gray-950">
                      <td className="px-2 py-0.5 text-gray-600 select-none w-10" />
                      <td className="px-3 py-0.5 text-gray-600 italic">{line.text}</td>
                    </tr>
                  );
                }
                const bgClass =
                  line.kind === 'add'
                    ? 'bg-emerald-950/60'
                    : line.kind === 'del'
                      ? 'bg-red-950/60'
                      : '';
                const textClass =
                  line.kind === 'add'
                    ? 'text-emerald-300'
                    : line.kind === 'del'
                      ? 'text-red-300'
                      : 'text-gray-400';
                const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';

                return (
                  <tr key={i} className={bgClass}>
                    <td className="px-2 py-px text-gray-600 select-none text-right w-10 border-r border-gray-800">
                      {line.lineNo ?? ''}
                    </td>
                    <td className={`px-3 py-px whitespace-pre ${textClass}`}>
                      <span className="select-none mr-1 opacity-60">{prefix}</span>
                      {line.text}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  DiffViewer                                                                */
/* -------------------------------------------------------------------------- */

interface Props {
  diffs: FileDiff[];
  /** Id of the checkpoint that should be reverted on Reject. */
  checkpointId?: string;
  /** Called when the user accepts or rejects so the parent can dismiss. */
  onDismiss(): void;
}

export function DiffViewer({ diffs, checkpointId, onDismiss }: Props): React.ReactElement | null {
  const checkpoints = useEaselStore((s) => s.checkpoints);
  const restoreCheckpoint = useEaselStore((s) => s.restoreCheckpoint);

  if (diffs.length === 0) return null;

  async function handleReject(): Promise<void> {
    if (!checkpointId) {
      onDismiss();
      return;
    }
    // Find the checkpoint immediately before this one (the "previous" state).
    const idx = checkpoints.findIndex((c) => c.id === checkpointId);
    const previous = idx >= 0 ? checkpoints[idx + 1] : undefined;
    if (previous) {
      await restoreCheckpoint(previous.id);
    }
    onDismiss();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
          {diffs.length} {diffs.length === 1 ? 'file' : 'files'} changed
        </span>
        <div className="flex gap-2">
          <button
            onClick={onDismiss}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-emerald-900/40 hover:bg-emerald-800/60 text-emerald-300 transition-colors"
            title="Accept changes (keep)"
          >
            <Check className="w-3 h-3" />
            Accept
          </button>
          <button
            onClick={() => void handleReject()}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md bg-red-950/40 hover:bg-red-900/60 text-red-400 transition-colors"
            title="Reject changes (restore previous checkpoint)"
          >
            <RotateCcw className="w-3 h-3" />
            Reject
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2 max-h-96 overflow-y-auto">
        {diffs.map((d) => (
          <SingleFileDiff key={d.filePath} diff={d} />
        ))}
      </div>
    </div>
  );
}
