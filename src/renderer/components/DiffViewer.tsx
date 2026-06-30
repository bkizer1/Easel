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
import { resolveRollbackTarget } from '../lib/rollback';
import { Tooltip } from './Tooltip';

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
    <div className="overflow-hidden rounded-lg border border-white/[0.06]">
      {/* File header */}
      <button
        className="flex w-full items-center gap-2 bg-ink-850/80 px-3 py-2 text-left transition-all duration-150 ease-spring hover:bg-ink-800/80 active:scale-[0.99]"
        onClick={() => setExpanded((e) => !e)}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
        )}
        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-gray-500" />
        <span className="flex-1 truncate font-mono text-xs text-gray-300">{diff.filePath}</span>
        <span className={`flex-shrink-0 text-xs font-medium ${changeColor[diff.changeType]}`}>
          {diff.changeType}
        </span>
        <span className="flex-shrink-0 text-xs text-emerald-500">+{diff.additions}</span>
        <span className="ml-1 flex-shrink-0 text-xs text-red-400">-{diff.deletions}</span>
      </button>

      {/* Diff lines */}
      {expanded && (
        <div className="surface-inset overflow-x-auto rounded-none border-0">
          <table className="w-full border-collapse font-mono text-xs">
            <tbody>
              {lines.map((line, i) => {
                if (line.kind === 'meta') return null;
                if (line.kind === 'hunk') {
                  return (
                    <tr key={i} className="bg-ink-950/60">
                      <td className="w-10 select-none px-2 py-0.5 text-gray-600" />
                      <td className="px-3 py-0.5 italic text-gray-600">{line.text}</td>
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
                    <td className="w-10 select-none border-r border-white/[0.06] px-2 py-px text-right text-gray-600">
                      {line.lineNo ?? ''}
                    </td>
                    <td className={`whitespace-pre px-3 py-px ${textClass}`}>
                      <span className="mr-1 select-none opacity-60">{prefix}</span>
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
    // Restore the checkpoint immediately before this edit (the "previous"
    // state) — see resolveRollbackTarget, shared with the verify-fail rollback.
    const previousId = resolveRollbackTarget(checkpoints, checkpointId);
    if (previousId) {
      await restoreCheckpoint(previousId);
    }
    onDismiss();
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wider text-gray-400">
          {diffs.length} {diffs.length === 1 ? 'file' : 'files'} changed
        </span>
        <div className="flex gap-2">
          <Tooltip label="Accept changes (keep)" side="bottom">
            <button
              aria-label="Accept changes"
              onClick={onDismiss}
              className="flex items-center gap-1.5 rounded-md bg-emerald-900/40 px-2.5 py-1 text-xs font-medium text-emerald-300 transition-all duration-150 ease-spring hover:bg-emerald-800/60 active:scale-[0.97]"
            >
              <Check className="h-3 w-3" />
              Accept
            </button>
          </Tooltip>
          <Tooltip label="Reject changes (restore previous checkpoint)" side="bottom">
            <button
              aria-label="Reject changes"
              onClick={() => void handleReject()}
              className="flex items-center gap-1.5 rounded-md bg-red-950/40 px-2.5 py-1 text-xs font-medium text-red-400 transition-all duration-150 ease-spring hover:bg-red-900/60 active:scale-[0.97]"
            >
              <RotateCcw className="h-3 w-3" />
              Reject
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
        {diffs.map((d) => (
          <SingleFileDiff key={d.filePath} diff={d} />
        ))}
      </div>
    </div>
  );
}
