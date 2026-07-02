/**
 * Easel — ChatPanel.
 *
 * Right-docked conversation panel: transcript, streamed agent output, per-turn
 * diff previews, and the instruction composer with voice + submit/cancel.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Send,
  X,
  Loader2,
  AlertTriangle,
  Info,
  Wand2,
  Zap,
  Plus,
  Trash2,
  Layers,
  CheckCircle2,
  RotateCcw,
} from 'lucide-react';
import type { ChatMessage, FileDiff, InstructionMacro } from '@shared/types';
import { useEaselStore } from '../store';
import { DiffViewer } from './DiffViewer';
import { ExtractComponentCta } from './ExtractComponentCta';
import { VoiceButton } from './VoiceButton';
import { Tooltip } from './Tooltip';
import { hotkeyMatches, normalizeHotkey } from '../lib/hotkeys';
import { parseVerifyBadge } from '../lib/verifyBadge';
import { earliestTurnCheckpointId, resolveRollbackTarget } from '../lib/rollback';
import { selfHealPhaseLabel } from '../lib/selfHealLabel';
import { thinkingVerb, THINKING_VERBS } from '../lib/thinkingVerbs';

/**
 * Stable empty-array reference for the macros selector. Returning a fresh `[]`
 * from the Zustand selector on every render would defeat referential-equality
 * bail-out and cause needless re-renders.
 */
const EMPTY_MACROS: InstructionMacro[] = [];

/* -------------------------------------------------------------------------- */
/*  System badges (confidence / warning / error / note)                       */
/* -------------------------------------------------------------------------- */

function SystemBadge({
  content,
  requestId,
}: {
  content: string;
  /** The requestId this badge belongs to — used to locate the turn's checkpoint
   * so a terminal verify:fail can offer a one-click rollback. */
  requestId?: string;
}): React.ReactElement {
  const isWarning = content.startsWith('Warning:');
  const isConfidence = content.startsWith('[confidence:');
  const isError = content.startsWith('Error:');

  // Issue #16: self-heal verdict badge — pass (jade) / fail (amber). Parsed by a
  // pure helper anchored to the leading token, so the rendered state depends
  // only on the verdict token, never on the rationale text.
  const verify = parseVerifyBadge(content);
  if (verify) {
    const cls = verify.pass
      ? 'text-brand-300 bg-brand-500/10 border-brand-500/25'
      : 'text-amber-300 bg-amber-500/10 border-amber-500/25';
    const Icon = verify.pass ? CheckCircle2 : AlertTriangle;
    return (
      <div className={`flex items-start gap-2 px-3 py-2 rounded-xl border text-xs ${cls}`}>
        <Icon className="w-3.5 h-3.5 mt-px flex-shrink-0" />
        <span className="flex-1">
          <span className="font-semibold">{verify.pass ? 'Verified' : 'Verify: needs another pass'}</span>
          {verify.confidencePct !== undefined ? (
            <span className="opacity-60"> ({verify.confidencePct}%)</span>
          ) : null}
          {verify.message ? <span className="opacity-80"> — {verify.message}</span> : ''}
        </span>
        {/* Issue #32, Deliverable 2: a terminal verify:fail (after the bounded
            retry) offers a one-click rollback to the pre-edit checkpoint. */}
        {!verify.pass && requestId ? <RollbackButton requestId={requestId} /> : null}
      </div>
    );
  }

  if (isConfidence) {
    const level = /\[confidence:\s*(\w+)\]/.exec(content)?.[1] ?? 'none';
    const colors: Record<string, string> = {
      high: 'text-brand-300 bg-brand-500/10 border-brand-500/25',
      medium: 'text-amber-300 bg-amber-500/10 border-amber-500/25',
      low: 'text-rose-300 bg-rose-500/10 border-rose-500/25',
      none: 'text-gray-400 bg-white/[0.03] border-white/10',
    };
    const msg = content.replace(/\[confidence:\s*\w+\]\s*/, '');
    return (
      <div className={`flex items-start gap-2 px-3 py-2 rounded-xl border text-xs ${colors[level] ?? colors['none']}`}>
        <Info className="w-3.5 h-3.5 mt-px flex-shrink-0" />
        <span>
          <span className="font-semibold capitalize">{level} confidence</span>
          {msg ? <span className="opacity-80"> — {msg}</span> : ''}
        </span>
      </div>
    );
  }

  if (isWarning || isError) {
    const cls = isError
      ? 'text-rose-300 bg-rose-500/10 border-rose-500/25'
      : 'text-amber-300 bg-amber-500/10 border-amber-500/25';
    return (
      <div className={`flex items-start gap-2 px-3 py-2 rounded-xl border text-xs ${cls}`}>
        <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
        <span>{content.replace(/^(Warning|Error):\s*/, '')}</span>
      </div>
    );
  }

  return <div className="px-1 text-xs text-gray-500 italic whitespace-pre-wrap">{content}</div>;
}

/* -------------------------------------------------------------------------- */
/*  Verify-fail rollback button (issue #32, Deliverable 2)                     */
/* -------------------------------------------------------------------------- */

/**
 * One-click rollback offered on a terminal `verify:fail` badge. Resolves the
 * failed turn's checkpoint (the assistant message sharing this `requestId`
 * carries it) and restores the checkpoint immediately before it — mirroring
 * DiffViewer's Reject exactly via the shared {@link resolveRollbackTarget}.
 * Hidden when there is no pre-edit checkpoint to roll back to.
 */
function RollbackButton({ requestId }: { requestId: string }): React.ReactElement | null {
  const checkpoints = useEaselStore((s) => s.checkpoints);
  const restoreCheckpoint = useEaselStore((s) => s.restoreCheckpoint);
  // Roll the WHOLE turn back to its pre-edit state. A self-heal turn can create
  // several checkpoints (attempt 1 → C1, the retry → C2); the pre-edit state is
  // the predecessor of the EARLIEST one (C1), so target that — not the latest,
  // which would only undo the retry. See earliestTurnCheckpointId.
  const checkpointId = useEaselStore((s) => earliestTurnCheckpointId(s.chat, requestId));

  const target = resolveRollbackTarget(checkpoints, checkpointId);
  if (!target) return null;

  return (
    <Tooltip label="Roll back this edit (restore previous checkpoint)" side="bottom">
      <button
        type="button"
        aria-label="Roll back this edit"
        onClick={() => void restoreCheckpoint(target)}
        className="flex flex-shrink-0 items-center gap-1 rounded-md bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200 transition-all duration-150 ease-spring hover:bg-amber-500/25 active:scale-[0.97]"
      >
        <RotateCcw className="h-3 w-3" />
        Roll back
      </button>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/*  Self-heal phase indicator (issue #32, Deliverable 1)                       */
/* -------------------------------------------------------------------------- */

/**
 * Transient inline indicator for the in-flight self-heal lifecycle, rendered
 * above the composer. Mirrors the header "Working…" spinner treatment. Shows
 * "Verifying edit…" while the judge runs and "Retrying (attempt N)… — <why>"
 * while a bounded retry is underway. Renders nothing when idle.
 */
function SelfHealIndicator(): React.ReactElement | null {
  const selfHealPhase = useEaselStore((s) => s.selfHealPhase);
  if (!selfHealPhase) return null;
  return (
    <div className="mb-2 flex items-center gap-1.5 px-1 text-[11px] font-medium text-brand-300 animate-slide-up">
      <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
      <span className="truncate">{selfHealPhaseLabel(selfHealPhase)}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  "Working" indicator (never let the panel look hung)                        */
/* -------------------------------------------------------------------------- */

/**
 * Live tool-activity line shown INSIDE the streaming assistant bubble (e.g.
 * "Reading App.tsx") while the model is mid-narration but paused on a tool.
 * Rendered only when the parent bubble `isStreaming`, so only the active turn
 * subscribes to {@link EaselState.activeToolActivity} — other bubbles don't
 * re-render when it changes. Returns nothing when no tool is running.
 */
function StreamingToolActivity(): React.ReactElement | null {
  const activeToolActivity = useEaselStore((s) => s.activeToolActivity);
  if (!activeToolActivity) return null;
  return (
    <div className="flex items-center gap-1.5 text-[11px] text-gray-500 animate-fade-in">
      <Loader2 className="w-3 h-3 animate-spin flex-shrink-0" />
      <span className="truncate">{activeToolActivity}</span>
    </div>
  );
}

/**
 * Transcript "working" indicator — the primary defense against the panel looking
 * hung. Shown while an edit is streaming but the active turn has produced no
 * visible assistant text yet: the pre-first-token gap (agent spin-up, tool use
 * before any narration) and the fresh gap a self-heal retry re-opens. Surfaces
 * the current tool activity when the store has one, otherwise cycles whimsical
 * spinner verbs, and counts elapsed seconds so even a slow turn visibly ticks.
 *
 * Once the assistant streams any text, the bubble's own pulsing cursor (plus
 * {@link StreamingToolActivity}) takes over and this hides — so the two never
 * show at once.
 */
function WorkingIndicator(): React.ReactElement | null {
  const streaming = useEaselStore((s) => s.streaming);
  const activeRequestId = useEaselStore((s) => s.activeRequestId);
  const activeToolActivity = useEaselStore((s) => s.activeToolActivity);
  // Has the in-flight turn produced any visible assistant text yet?
  const hasVisibleContent = useEaselStore((s) =>
    s.chat.some(
      (m) =>
        m.role === 'assistant' &&
        m.requestId === s.activeRequestId &&
        m.content.trim().length > 0,
    ),
  );

  const show = streaming && !hasVisibleContent;

  const [tick, setTick] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  // Start each turn on a different verb so it doesn't always open with the same
  // word; re-seeded whenever the active request changes (incl. a retry re-arm).
  const seedRef = useRef(0);

  useEffect(() => {
    seedRef.current = Math.floor(Math.random() * THINKING_VERBS.length);
    setTick(0);
    setElapsed(0);
  }, [activeRequestId]);

  useEffect(() => {
    if (!show) return;
    const verbTimer = setInterval(() => setTick((t) => t + 1), 2400);
    const secTimer = setInterval(() => setElapsed((n) => n + 1), 1000);
    return () => {
      clearInterval(verbTimer);
      clearInterval(secTimer);
    };
  }, [show]);

  if (!show) return null;

  const label = activeToolActivity ?? `${thinkingVerb(seedRef.current + tick)}…`;

  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 animate-slide-up">
      <span className="grid place-items-center w-6 h-6 rounded-lg bg-brand-500/10 border border-brand-500/20 text-brand-300 flex-shrink-0">
        <Loader2 className="w-3 h-3 animate-spin" />
      </span>
      <span className="text-[13px] leading-relaxed text-gray-400">
        <span className="animate-pulse-soft">{label}</span>
        {elapsed >= 3 && <span className="text-gray-600"> · {elapsed}s</span>}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Message bubble                                                            */
/* -------------------------------------------------------------------------- */

function MessageBubble({
  message,
  isStreaming,
  onSaveAsMacro,
}: {
  message: ChatMessage;
  isStreaming: boolean;
  /** Right-click handler for user messages: "Save as macro" from this instruction. */
  onSaveAsMacro?: (instruction: string) => void;
}): React.ReactElement {
  const [diffsDismissed, setDiffsDismissed] = useState(false);

  // The checkpoint a DiffViewer "Reject" rolls back to. For a self-heal RETRY
  // bubble (whose diffs are the whole turn's cumulative set), reject to the
  // turn's EARLIEST checkpoint so it undoes the entire turn — matching the
  // verify-fail "Roll back" button — instead of only the retry attempt.
  const diffCheckpointId = useEaselStore((s) =>
    message.retryAttempt !== undefined && message.requestId
      ? earliestTurnCheckpointId(s.chat, message.requestId)
      : message.checkpointId,
  );

  if (message.role === 'system')
    return <SystemBadge content={message.content} requestId={message.requestId} />;

  if (message.role === 'user') {
    return (
      <div className="flex justify-end">
        <div
          onContextMenu={
            onSaveAsMacro
              ? (e) => {
                  e.preventDefault();
                  onSaveAsMacro(message.content);
                }
              : undefined
          }
          title={onSaveAsMacro ? 'Right-click to save as a macro' : undefined}
          className="max-w-[88%] px-3.5 py-2.5 rounded-2xl rounded-br-md bg-gradient-to-br from-brand-500/25 to-brand-600/15 border border-brand-500/25 text-gray-100 text-[13px] leading-relaxed shadow-sm"
        >
          {message.content}
          {message.annotations && message.annotations.length > 0 && (
            <div className="mt-1.5 flex items-center gap-1 text-[11px] text-brand-300/80">
              <span className="w-1 h-1 rounded-full bg-brand-300" />
              {message.annotations.length} annotation{message.annotations.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>
      </div>
    );
  }

  const diffs: FileDiff[] = message.diffs ?? [];
  return (
    <div className="flex flex-col gap-2.5">
      {/* Issue #32, fix C: a self-heal retry attempt gets its own bubble; mark
          it with a subtle divider so its narration reads as a fresh attempt. */}
      {message.retryAttempt !== undefined && (
        <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wide text-amber-300/70">
          <RotateCcw className="w-3 h-3 flex-shrink-0" />
          <span>Retried</span>
          <span className="h-px flex-1 bg-amber-500/15" />
        </div>
      )}
      {message.content && (
        <div className="text-[13px] text-gray-300 leading-relaxed whitespace-pre-wrap">
          {message.content}
          {isStreaming && (
            <span className="inline-block w-[3px] h-[14px] ml-0.5 bg-brand-400 rounded-full animate-pulse align-middle" />
          )}
        </div>
      )}
      {/* Mid-stream tool activity ("Reading App.tsx"): only when this bubble is
          the active streaming turn AND has already narrated some text — the
          pre-text gap is covered by the transcript-level WorkingIndicator. */}
      {isStreaming && message.content && <StreamingToolActivity />}
      {!diffsDismissed && diffs.length > 0 && (
        <DiffViewer diffs={diffs} checkpointId={diffCheckpointId} refactor={message.refactor} onDismiss={() => setDiffsDismissed(true)} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Macro bar + save dialog                                                   */
/* -------------------------------------------------------------------------- */

function MacroBar({
  macros,
  disabled,
  onRun,
  onDelete,
  onAdd,
}: {
  macros: InstructionMacro[];
  disabled: boolean;
  onRun: (id: string) => void;
  onDelete: (id: string) => void;
  onAdd: () => void;
}): React.ReactElement {
  return (
    <div className="flex items-center gap-1.5 px-3 py-2 hairline-b overflow-x-auto flex-shrink-0">
      <span className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-gray-600 flex-shrink-0">
        <Zap className="w-3 h-3" />
        Macros
      </span>
      {macros.map((macro) => (
        <span
          key={macro.id}
          className="group inline-flex items-center rounded-lg bg-ink-800/80 border border-white/10 text-[12px] text-gray-200 flex-shrink-0 overflow-hidden"
        >
          <Tooltip label={macro.instructionTemplate} shortcut={macro.hotkey} side="top">
            <button
              type="button"
              disabled={disabled}
              onClick={() => onRun(macro.id)}
              className="px-2.5 py-1 hover:bg-white/[0.06] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {macro.name}
              {macro.hotkey && (
                <kbd className="ml-1.5 font-mono text-[10px] text-gray-500">{macro.hotkey}</kbd>
              )}
            </button>
          </Tooltip>
          <Tooltip label="Delete macro" side="top">
            <button
              type="button"
              onClick={() => onDelete(macro.id)}
              className="grid place-items-center w-5 self-stretch text-gray-600 hover:text-rose-300 hover:bg-rose-500/10 transition-colors"
              aria-label="Delete macro"
            >
              <Trash2 className="w-3 h-3" />
            </button>
          </Tooltip>
        </span>
      ))}
      <Tooltip label="Save a new macro" side="top">
        <button
          type="button"
          onClick={onAdd}
          className="grid place-items-center w-6 h-6 rounded-lg bg-ink-800/80 border border-white/10 text-gray-400 hover:text-brand-300 hover:border-brand-500/40 transition-all duration-150 ease-spring active:scale-90 flex-shrink-0"
          aria-label="Save a new macro"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

function SaveMacroDialog({
  prefill,
  onSave,
  onClose,
}: {
  prefill: string;
  onSave: (input: { name: string; instructionTemplate: string; hotkey?: string }) => void;
  onClose: () => void;
}): React.ReactElement {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState(prefill);
  const [hotkey, setHotkey] = useState('');
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const canSave = name.trim().length > 0 && template.trim().length > 0;

  function submit(): void {
    if (!canSave) return;
    const normalized = normalizeHotkey(hotkey);
    onSave({
      name: name.trim(),
      instructionTemplate: template.trim(),
      ...(normalized ? { hotkey: normalized } : {}),
    });
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="glass-raised w-[min(420px,90vw)] p-5 space-y-4 animate-scale-in"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-gray-100">Save instruction macro</h2>
          <Tooltip label="Close" side="left">
            <button
              type="button"
              onClick={onClose}
              className="grid place-items-center w-7 h-7 rounded-lg text-gray-500 hover:text-gray-200 hover:bg-white/[0.07] transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </Tooltip>
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-gray-400">Name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Match design tokens"
            className="w-full rounded-lg bg-ink-800 border border-white/10 px-2.5 py-1.5 text-[13px] text-gray-100 placeholder-gray-600 outline-none focus:border-brand-500/50"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-gray-400">
            Instruction — use <code className="text-brand-300">{'{element}'}</code> and{' '}
            <code className="text-brand-300">{'{text}'}</code> to reference the selected element
          </span>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            rows={3}
            placeholder="Restyle {element} to match our design tokens"
            className="w-full rounded-lg bg-ink-800 border border-white/10 px-2.5 py-1.5 text-[13px] text-gray-100 placeholder-gray-600 outline-none focus:border-brand-500/50 resize-none"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-gray-400">Hotkey (optional)</span>
          <input
            value={hotkey}
            onChange={(e) => setHotkey(e.target.value)}
            placeholder="e.g. mod+1"
            className="w-full rounded-lg bg-ink-800 border border-white/10 px-2.5 py-1.5 text-[13px] text-gray-100 placeholder-gray-600 outline-none focus:border-brand-500/50 font-mono"
          />
        </label>

        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-[12px] text-gray-400 hover:text-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSave}
            className="px-3 py-1.5 rounded-lg text-[12px] font-medium bg-gradient-to-br from-brand-400 to-brand-600 text-ink-950 disabled:from-ink-700 disabled:to-ink-700 disabled:text-gray-600 transition-all hover:brightness-110"
          >
            Save macro
          </button>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Selection context chip                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Surfaces the current draft selection (markup + element targets) directly above
 * the composer. Because selections now persist across sends, this makes it
 * obvious what's attached to the next message and gives a one-click "clear all".
 * Per-mark removal lives on the canvas; this is the bulk affordance.
 */
function SelectionChip(): React.ReactElement | null {
  const annotations = useEaselStore((s) => s.annotations);
  const targets = useEaselStore((s) => s.targets);
  const clearAnnotations = useEaselStore((s) => s.clearAnnotations);
  const clearTargets = useEaselStore((s) => s.clearTargets);

  // Element picks create a target AND a matching annotation that share an id;
  // freeform creates only an annotation; region-resolved creates only a target.
  // Count distinct ids so the total reflects the user's actual mark count.
  const count = new Set([...annotations.map((a) => a.id), ...targets.map((t) => t.id)]).size;
  if (count === 0) return null;

  const clearAll = (): void => {
    clearAnnotations();
    clearTargets();
  };

  return (
    <div className="mb-2 flex items-center gap-2 rounded-xl border border-iris-500/25 bg-iris-500/[0.08] px-2.5 py-1.5 animate-slide-up">
      <span className="grid place-items-center w-5 h-5 rounded-md bg-iris-500/15 text-iris-300">
        <Layers className="w-3 h-3" />
      </span>
      <span className="flex-1 text-[11.5px] text-iris-100/90 leading-tight">
        <span className="font-semibold">
          {count} selection{count !== 1 ? 's' : ''}
        </span>{' '}
        <span className="text-iris-200/60">attached to your next message</span>
      </span>
      <Tooltip label="Clear selection" side="top">
        <button
          type="button"
          onClick={clearAll}
          className="grid place-items-center w-5 h-5 rounded-md text-iris-200/70 hover:text-white hover:bg-iris-500/25 transition-colors"
          aria-label="Clear selection"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  ChatPanel                                                                 */
/* -------------------------------------------------------------------------- */

export function ChatPanel(): React.ReactElement {
  const chat = useEaselStore((s) => s.chat);
  const streaming = useEaselStore((s) => s.streaming);
  const activeRequestId = useEaselStore((s) => s.activeRequestId);
  const project = useEaselStore((s) => s.project);
  const previewUrl = useEaselStore((s) => s.previewUrl);
  const submitEdit = useEaselStore((s) => s.submitEdit);
  const cancelEdit = useEaselStore((s) => s.cancelEdit);
  const macros = useEaselStore((s) => s.settings?.macros ?? EMPTY_MACROS);
  const saveMacro = useEaselStore((s) => s.saveMacro);
  const deleteMacro = useEaselStore((s) => s.deleteMacro);
  const runMacro = useEaselStore((s) => s.runMacro);

  const [instruction, setInstruction] = useState('');
  const [showSaveMacro, setShowSaveMacro] = useState(false);
  const [savePrefill, setSavePrefill] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const canRunMacro = !!project && !streaming;

  // Global hotkey listener: invoke a macro whose chord matches the keypress.
  useEffect(() => {
    if (!canRunMacro) return;
    function onKeyDown(e: KeyboardEvent): void {
      // Ignore while typing into a field — let the composer handle keys.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
        return;
      }
      for (const macro of macros) {
        if (macro.hotkey && hotkeyMatches(macro.hotkey, e)) {
          e.preventDefault();
          void runMacro(macro.id);
          return;
        }
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [macros, canRunMacro, runMacro]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
  }, [instruction]);

  const canSubmit = instruction.trim().length > 0 && !!project && !streaming;

  const handleSubmit = useCallback(async () => {
    const text = instruction.trim();
    if (!text || streaming || !project) return;
    setInstruction('');
    await submitEdit(text);
  }, [instruction, streaming, project, submitEdit]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  }

  const handleTranscript = useCallback((text: string) => {
    setInstruction((prev) => (prev ? `${prev} ${text}` : text));
  }, []);

  const openSaveMacro = useCallback((prefill: string) => {
    setSavePrefill(prefill);
    setShowSaveMacro(true);
  }, []);

  const handleSaveMacro = useCallback(
    (input: { name: string; instructionTemplate: string; hotkey?: string }) => {
      void saveMacro(input);
      setShowSaveMacro(false);
      setSavePrefill('');
    },
    [saveMacro],
  );

  const composerDisabled = !project || streaming;

  return (
    <aside className="flex flex-col h-full w-full bg-ink-900/50 backdrop-blur-xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 h-12 hairline-b flex-shrink-0">
        <span className="font-display text-sm font-semibold tracking-tight text-gray-200">Chat</span>
        {streaming ? (
          <div className="flex items-center gap-1.5 text-[11px] font-medium text-brand-300">
            <Loader2 className="w-3 h-3 animate-spin" />
            <span>Working…</span>
          </div>
        ) : (
          <span className="text-[11px] text-gray-600">{chat.length > 0 ? `${chat.length} messages` : ''}</span>
        )}
      </div>

      {/* Macro bar */}
      {(macros.length > 0 || project) && (
        <MacroBar
          macros={macros}
          disabled={!canRunMacro}
          onRun={(id) => void runMacro(id)}
          onDelete={(id) => void deleteMacro(id)}
          onAdd={() => openSaveMacro('')}
        />
      )}

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 scroll-smooth">
        {chat.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-2 gap-4">
            <span className="grid place-items-center w-12 h-12 rounded-2xl bg-brand-500/10 border border-brand-500/20 text-brand-300">
              <Wand2 className="w-5 h-5" />
            </span>
            <div className="space-y-1">
              <p className="text-[13px] font-medium text-gray-300">
                {project ? 'Mark it up, then describe it' : previewUrl ? 'Open a project to edit' : 'Load a page to begin'}
              </p>
              <p className="text-xs text-gray-600 leading-relaxed max-w-[220px]">
                {project
                  ? 'Select an element or draw on the preview, then tell Claude what to change.'
                  : previewUrl
                    ? 'Browsing works now — open the project folder so Claude can edit its source.'
                    : 'Type a dev-server URL in the address bar to load your app.'}
              </p>
            </div>
          </div>
        ) : (
          <>
            {chat.map((msg) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                isStreaming={msg.role === 'assistant' && msg.requestId === activeRequestId && streaming}
                onSaveAsMacro={msg.role === 'user' ? openSaveMacro : undefined}
              />
            ))}
            {/* Reassure the user Easel is working during the silent pre-first-token
                gap; hides itself the moment the assistant starts streaming text. */}
            <WorkingIndicator />
          </>
        )}
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 p-3 hairline-t">
        <SelfHealIndicator />
        <SelectionChip />
        <ExtractComponentCta />
        <div
          className={`relative flex items-end gap-2 rounded-2xl bg-ink-800/80 border px-3 py-2.5 transition-all duration-200 ${
            composerDisabled
              ? 'border-white/5 opacity-70'
              : 'border-white/10 focus-within:border-brand-500/50 focus-within:shadow-[0_0_0_3px_rgba(45,212,191,0.10)]'
          }`}
        >
          <textarea
            ref={textareaRef}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={project ? 'Describe a change…' : 'Open a project first'}
            disabled={composerDisabled}
            rows={1}
            className="flex-1 bg-transparent text-[13px] text-gray-100 placeholder-gray-600 resize-none outline-none leading-relaxed max-h-[140px] disabled:cursor-not-allowed"
            style={{ minHeight: '22px' }}
          />
          <div className="flex items-center gap-1 flex-shrink-0">
            <VoiceButton onTranscript={handleTranscript} disabled={composerDisabled} />
            {streaming ? (
              <Tooltip label="Stop generating" shortcut="Esc" side="top">
                <button
                  type="button"
                  onClick={() => void cancelEdit()}
                  className="grid place-items-center w-8 h-8 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 transition-all duration-150 ease-spring active:scale-90"
                  aria-label="Stop generating"
                >
                  <X className="w-4 h-4" />
                </button>
              </Tooltip>
            ) : (
              <Tooltip label="Send message" shortcut="⏎" side="top">
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                  className="grid place-items-center w-8 h-8 rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-ink-950 shadow-[0_0_16px_-4px_rgba(45,212,191,0.8)] transition-all duration-150 ease-spring hover:brightness-110 active:scale-90 disabled:from-ink-700 disabled:to-ink-700 disabled:text-gray-600 disabled:shadow-none disabled:active:scale-100"
                  aria-label="Send message"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        <p className="mt-1.5 px-1 text-[10px] text-gray-600">
          <kbd className="font-mono">Enter</kbd> to send · <kbd className="font-mono">Shift+Enter</kbd> for a new line
        </p>
      </div>

      {showSaveMacro && (
        <SaveMacroDialog
          prefill={savePrefill}
          onSave={handleSaveMacro}
          onClose={() => {
            setShowSaveMacro(false);
            setSavePrefill('');
          }}
        />
      )}
    </aside>
  );
}
