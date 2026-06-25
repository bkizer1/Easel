/**
 * Easel — ChatPanel.
 *
 * Right-docked conversation panel: transcript, streamed agent output, per-turn
 * diff previews, and the instruction composer with voice + submit/cancel.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Send, X, Loader2, AlertTriangle, Info, Wand2, Zap, Plus, Trash2 } from 'lucide-react';
import type { ChatMessage, FileDiff, InstructionMacro } from '@shared/types';
import { useEaselStore } from '../store';
import { DiffViewer } from './DiffViewer';
import { VoiceButton } from './VoiceButton';
import { hotkeyMatches, normalizeHotkey } from '../lib/hotkeys';

/**
 * Stable empty-array reference for the macros selector. Returning a fresh `[]`
 * from the Zustand selector on every render would defeat referential-equality
 * bail-out and cause needless re-renders.
 */
const EMPTY_MACROS: InstructionMacro[] = [];

/* -------------------------------------------------------------------------- */
/*  System badges (confidence / warning / error / note)                       */
/* -------------------------------------------------------------------------- */

function SystemBadge({ content }: { content: string }): React.ReactElement {
  const isWarning = content.startsWith('Warning:');
  const isConfidence = content.startsWith('[confidence:');
  const isError = content.startsWith('Error:');

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

  if (message.role === 'system') return <SystemBadge content={message.content} />;

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
      {message.content && (
        <div className="text-[13px] text-gray-300 leading-relaxed whitespace-pre-wrap">
          {message.content}
          {isStreaming && (
            <span className="inline-block w-[3px] h-[14px] ml-0.5 bg-brand-400 rounded-full animate-pulse align-middle" />
          )}
        </div>
      )}
      {!diffsDismissed && diffs.length > 0 && (
        <DiffViewer diffs={diffs} checkpointId={message.checkpointId} onDismiss={() => setDiffsDismissed(true)} />
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
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRun(macro.id)}
            title={
              macro.hotkey
                ? `${macro.instructionTemplate} (${macro.hotkey})`
                : macro.instructionTemplate
            }
            className="px-2.5 py-1 hover:bg-white/[0.06] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {macro.name}
            {macro.hotkey && (
              <kbd className="ml-1.5 font-mono text-[10px] text-gray-500">{macro.hotkey}</kbd>
            )}
          </button>
          <button
            type="button"
            onClick={() => onDelete(macro.id)}
            title="Delete macro"
            className="grid place-items-center w-5 self-stretch text-gray-600 hover:text-rose-300 hover:bg-rose-500/10 transition-colors"
          >
            <Trash2 className="w-3 h-3" />
          </button>
        </span>
      ))}
      <button
        type="button"
        onClick={onAdd}
        title="Save a new macro"
        className="grid place-items-center w-6 h-6 rounded-lg bg-ink-800/80 border border-white/10 text-gray-400 hover:text-brand-300 hover:border-brand-500/40 transition-colors flex-shrink-0"
      >
        <Plus className="w-3.5 h-3.5" />
      </button>
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
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(420px,90vw)] rounded-2xl bg-ink-900 border border-white/10 shadow-2xl p-5 space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="font-display text-sm font-semibold text-gray-100">Save instruction macro</h2>
          <button type="button" onClick={onClose} className="text-gray-500 hover:text-gray-300">
            <X className="w-4 h-4" />
          </button>
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
          chat.map((msg) => (
            <MessageBubble
              key={msg.id}
              message={msg}
              isStreaming={msg.role === 'assistant' && msg.requestId === activeRequestId && streaming}
              onSaveAsMacro={msg.role === 'user' ? openSaveMacro : undefined}
            />
          ))
        )}
      </div>

      {/* Composer */}
      <div className="flex-shrink-0 p-3 hairline-t">
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
              <button
                type="button"
                onClick={() => void cancelEdit()}
                title="Stop"
                className="grid place-items-center w-8 h-8 rounded-xl bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void handleSubmit()}
                disabled={!canSubmit}
                title="Send (Enter)"
                className="grid place-items-center w-8 h-8 rounded-xl bg-gradient-to-br from-brand-400 to-brand-600 text-ink-950 shadow-[0_0_16px_-4px_rgba(45,212,191,0.8)] transition-all hover:brightness-110 disabled:from-ink-700 disabled:to-ink-700 disabled:text-gray-600 disabled:shadow-none"
              >
                <Send className="w-3.5 h-3.5" />
              </button>
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
