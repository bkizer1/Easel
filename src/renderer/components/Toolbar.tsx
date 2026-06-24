/**
 * Easel — Toolbar (title bar).
 *
 * The top strip doubles as the macOS draggable title bar (the window uses a
 * hiddenInset title bar), so the whole header is a drag region and every
 * interactive control opts out with `no-drag`. On macOS we reserve space on the
 * left for the traffic-light buttons.
 */

import React from 'react';
import {
  FolderOpen,
  X,
  MousePointer2,
  PenLine,
  Undo2,
  Redo2,
  RefreshCw,
  Settings,
  Sparkles,
} from 'lucide-react';
import { useEaselStore } from '../store';
import { easel } from '../lib/api';

/** macOS reserves the top-left for window controls; pad the toolbar past them. */
const IS_MAC =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh');

/* -------------------------------------------------------------------------- */
/*  Wordmark                                                                  */
/* -------------------------------------------------------------------------- */

function Wordmark(): React.ReactElement {
  return (
    <div className="flex items-center gap-2 pr-1">
      <span className="grid place-items-center w-[19px] h-[19px] rounded-[6px] bg-gradient-to-br from-brand-300 via-brand-400 to-brand-600 shadow-[0_0_14px_-3px_rgba(45,212,191,0.7)]">
        <span className="w-[7px] h-[7px] rounded-[2px] bg-ink-950/85" />
      </span>
      <span className="font-display text-[15px] font-semibold tracking-tight text-gray-100 leading-none">
        Easel
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Status dot                                                                */
/* -------------------------------------------------------------------------- */

function StatusDot(): React.ReactElement {
  const previewStatus = useEaselStore((s) => s.previewStatus);
  const previewUrl = useEaselStore((s) => s.previewUrl);

  const matches = previewStatus && previewStatus.url === previewUrl;
  const reachable = matches ? previewStatus!.reachable : null;

  const color =
    reachable === null ? 'bg-gray-600' : reachable ? 'bg-brand-400' : 'bg-rose-500';
  const title =
    reachable === null
      ? 'No live preview'
      : reachable
        ? `Live · ${previewStatus!.url}`
        : `Unreachable · ${previewStatus!.detail ?? previewStatus!.url}`;

  return (
    <span className="relative flex items-center justify-center w-4 h-4" title={title}>
      {reachable && (
        <span className="absolute w-2.5 h-2.5 rounded-full bg-brand-400/40 animate-ping" />
      )}
      <span className={`relative w-2 h-2 rounded-full ${color}`} />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/*  Backend indicator                                                         */
/* -------------------------------------------------------------------------- */

function BackendIndicator(): React.ReactElement | null {
  const settings = useEaselStore((s) => s.settings);
  const setSettingsOpen = useEaselStore((s) => s.setSettingsOpen);
  if (!settings) return null;

  const { agentBackend, model } = settings;
  const backendLabel: Record<string, string> = {
    'claude-agent-sdk': 'Subscription',
    'anthropic-api': 'API',
    'local-openai': 'Local',
  };
  const shortModel = model.replace(/^claude-/, '').replace(/-\d{6,}$/, '');

  return (
    <button
      type="button"
      onClick={() => setSettingsOpen(true)}
      className="no-drag group flex items-center gap-1.5 pl-2 pr-2.5 h-7 rounded-lg bg-ink-800/70 hover:bg-ink-700/80 border border-white/5 hover:border-brand-500/30 transition-colors"
      title={`Backend: ${agentBackend} · Model: ${model} — click to change`}
    >
      <Sparkles className="w-3 h-3 text-brand-400" />
      <span className="text-[11px] font-medium text-gray-300">{backendLabel[agentBackend] ?? agentBackend}</span>
      <span className="w-px h-3 bg-white/10" />
      <span className="text-[11px] font-mono text-gray-500 group-hover:text-gray-400">{shortModel}</span>
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/*  Icon button                                                               */
/* -------------------------------------------------------------------------- */

interface IconButtonProps {
  onClick: () => void;
  title: string;
  disabled?: boolean;
  active?: boolean;
  variant?: 'default' | 'danger';
  children: React.ReactNode;
}

function IconButton({
  onClick,
  title,
  disabled = false,
  active = false,
  variant = 'default',
  children,
}: IconButtonProps): React.ReactElement {
  const base =
    'no-drag flex items-center justify-center w-[30px] h-[30px] rounded-lg transition-all duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 disabled:opacity-30 disabled:cursor-not-allowed';
  const color = active
    ? 'bg-brand-500/15 text-brand-300 ring-1 ring-brand-500/40 shadow-[0_0_12px_-4px_rgba(45,212,191,0.8)]'
    : variant === 'danger'
      ? 'text-gray-500 hover:bg-rose-500/15 hover:text-rose-400'
      : 'text-gray-400 hover:bg-white/[0.07] hover:text-gray-100';

  return (
    <button className={`${base} ${color}`} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

function Sep(): React.ReactElement {
  return <span className="mx-1 w-px h-5 bg-white/[0.07]" />;
}

/* -------------------------------------------------------------------------- */
/*  Toolbar                                                                   */
/* -------------------------------------------------------------------------- */

export function Toolbar(): React.ReactElement {
  const project = useEaselStore((s) => s.project);
  const mode = useEaselStore((s) => s.mode);
  const checkpoints = useEaselStore((s) => s.checkpoints);
  const currentCheckpointId = useEaselStore((s) => s.currentCheckpointId);
  const streaming = useEaselStore((s) => s.streaming);

  const openProject = useEaselStore((s) => s.openProject);
  const closeProject = useEaselStore((s) => s.closeProject);
  const setMode = useEaselStore((s) => s.setMode);
  const setSettingsOpen = useEaselStore((s) => s.setSettingsOpen);
  const undo = useEaselStore((s) => s.undo);
  const redo = useEaselStore((s) => s.redo);

  const currentIdx = checkpoints.findIndex((c) => c.id === currentCheckpointId);
  const canUndo = checkpoints.length > 0 && (currentIdx < checkpoints.length - 1 || currentIdx === -1);
  const canRedo = currentIdx > 0;

  return (
    <header
      className="drag-region relative z-10 flex items-center gap-1 h-12 px-3 bg-ink-900/80 backdrop-blur-xl hairline-b select-none"
      style={{ paddingLeft: IS_MAC ? 80 : 12 }}
    >
      <Wordmark />
      <Sep />

      {/* Project */}
      {!project ? (
        <button
          type="button"
          onClick={() => void openProject()}
          className="no-drag flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-lg text-[12px] text-gray-400 hover:text-gray-100 hover:bg-white/[0.07] transition-colors"
          title="Open a project folder so Claude can edit its source"
        >
          <FolderOpen className="w-3.5 h-3.5" />
          Open project
        </button>
      ) : (
        <div className="no-drag flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-lg bg-ink-800/60 border border-white/5">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-400" />
          <span className="text-[12px] font-medium text-gray-200 max-w-[160px] truncate" title={project.root}>
            {project.name}
          </span>
          <button
            onClick={() => void closeProject()}
            title="Close project"
            className="ml-0.5 grid place-items-center w-5 h-5 rounded-md text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}

      <Sep />

      {/* Interaction modes */}
      <IconButton
        onClick={() => setMode(mode === 'element-select' ? 'idle' : 'element-select')}
        title="Select mode — click an element to target it"
        active={mode === 'element-select'}
        disabled={!project || streaming}
      >
        <MousePointer2 className="w-[17px] h-[17px]" />
      </IconButton>
      <IconButton
        onClick={() => setMode(mode === 'freeform' ? 'idle' : 'freeform')}
        title="Markup mode — draw on the page"
        active={mode === 'freeform'}
        disabled={!project || streaming}
      >
        <PenLine className="w-[17px] h-[17px]" />
      </IconButton>

      <Sep />

      {/* History */}
      <IconButton onClick={() => void undo()} title="Undo last edit" disabled={!canUndo || streaming}>
        <Undo2 className="w-[17px] h-[17px]" />
      </IconButton>
      <IconButton onClick={() => void redo()} title="Redo" disabled={!canRedo || streaming}>
        <Redo2 className="w-[17px] h-[17px]" />
      </IconButton>
      <IconButton
        onClick={() => void easel.preview.reload({ hard: false })}
        title="Reload preview"
        disabled={!project}
      >
        <RefreshCw className="w-[17px] h-[17px]" />
      </IconButton>

      <div className="flex-1" />

      {/* Right cluster */}
      <BackendIndicator />
      <div className="no-drag flex items-center px-1.5">
        <StatusDot />
      </div>
      <IconButton onClick={() => setSettingsOpen(true)} title="Settings">
        <Settings className="w-[17px] h-[17px]" />
      </IconButton>
    </header>
  );
}
