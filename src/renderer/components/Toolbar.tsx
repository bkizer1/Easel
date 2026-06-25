/**
 * Easel — Toolbar (title bar).
 *
 * The top strip doubles as the macOS draggable title bar (the window uses a
 * hiddenInset title bar), so the whole header is a drag region and every
 * interactive control opts out with `no-drag`. On macOS we reserve space on the
 * left for the traffic-light buttons.
 */

import React, { useState } from 'react';
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
  History,
  Monitor,
  Code2,
  Terminal,
  ExternalLink,
} from 'lucide-react';
import { useEaselStore, VIEWPORT_PRESETS } from '../store';
import { easel } from '../lib/api';
import { HistoryPanel } from './HistoryPanel';
import { ConsolePanel } from './ConsolePanel';

/** macOS reserves the top-left for window controls; pad the toolbar past them. */
const IS_MAC =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh');

/* -------------------------------------------------------------------------- */
/*  Wordmark                                                                  */
/* -------------------------------------------------------------------------- */

function Wordmark(): React.ReactElement {
  return (
    <div className="flex items-center gap-2 pr-1">
      <span className="grid place-items-center w-[21px] h-[21px] rounded-[7px] bg-gradient-to-br from-brand-300 via-brand-400 to-brand-600 shadow-[0_0_14px_-3px_rgba(52,211,176,0.75)]">
        {/* Easel mark — matches the app icon */}
        <svg viewBox="0 0 24 24" className="w-[15px] h-[15px]" aria-hidden="true">
          <g stroke="#ffffff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M12 3.9 L6.7 20.2" />
            <path d="M12 3.9 L17.3 20.2" />
            <path d="M12 3.9 L13.3 20.4" />
            <path d="M7.8 13.7 L16.2 13.7" />
          </g>
          <rect x="8.1" y="6" width="7.8" height="7.9" rx="1.2" fill="#06352c" />
          <path d="M9.7 11.8 Q10.7 8.3 14.3 9.6" stroke="#9af0df" strokeWidth="1.4" strokeLinecap="round" fill="none" />
        </svg>
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
/*  Responsive viewport menu                                                  */
/* -------------------------------------------------------------------------- */

function ViewportMenu({
  current,
  onPick,
}: {
  current: number | null;
  onPick: (width: number | null) => void;
}): React.ReactElement {
  return (
    <div className="absolute left-0 top-full mt-1.5 z-30 w-44 overflow-hidden rounded-xl border border-white/10 bg-ink-900/95 py-1 shadow-[0_20px_60px_-15px_rgba(0,0,0,0.7)] backdrop-blur-xl">
      {VIEWPORT_PRESETS.map((p) => {
        const active = p.width === current;
        return (
          <button
            key={p.label}
            onClick={() => onPick(p.width)}
            className={`flex w-full items-center justify-between px-3.5 py-2 text-left text-[12.5px] transition-colors ${
              active ? 'bg-brand-500/10 text-brand-200' : 'text-gray-300 hover:bg-white/[0.05]'
            }`}
          >
            <span>{p.label}</span>
            <span className="font-mono text-[11px] text-gray-500">{p.width ? `${p.width}px` : 'auto'}</span>
          </button>
        );
      })}
    </div>
  );
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
  const previewUrl = useEaselStore((s) => s.previewUrl);
  const viewportWidth = useEaselStore((s) => s.viewportWidth);
  const pageLogs = useEaselStore((s) => s.pageLogs);
  const historyOpen = useEaselStore((s) => s.historyOpen);

  const openProject = useEaselStore((s) => s.openProject);
  const closeProject = useEaselStore((s) => s.closeProject);
  const setMode = useEaselStore((s) => s.setMode);
  const setSettingsOpen = useEaselStore((s) => s.setSettingsOpen);
  const undo = useEaselStore((s) => s.undo);
  const redo = useEaselStore((s) => s.redo);
  const reloadPreview = useEaselStore((s) => s.reloadPreview);
  const toggleDevTools = useEaselStore((s) => s.toggleDevTools);
  const setViewportWidth = useEaselStore((s) => s.setViewportWidth);
  const setHistoryOpen = useEaselStore((s) => s.setHistoryOpen);

  const [menu, setMenu] = useState<'viewport' | 'console' | null>(null);

  // Timeline is oldest-first; the cursor is the checkpoint the tree matches.
  const currentIdx = checkpoints.findIndex((c) => c.id === currentCheckpointId);
  const canUndo = currentIdx > 0; // an earlier checkpoint exists
  const canRedo = currentIdx >= 0 && currentIdx < checkpoints.length - 1; // a later one exists

  const errorCount = pageLogs.filter((l) => l.level === 'error').length;
  const anyMenuOpen = historyOpen || menu !== null;
  const closeAllMenus = (): void => {
    setMenu(null);
    setHistoryOpen(false);
  };
  const toggleMenu = (m: 'viewport' | 'console'): void => {
    setHistoryOpen(false);
    setMenu((cur) => (cur === m ? null : m));
  };
  const toggleHistory = (): void => {
    setMenu(null);
    setHistoryOpen(!historyOpen);
  };

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
          title="Open a project folder so the AI can edit its source"
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

      {/* Edit history: undo / redo / history timeline */}
      <IconButton onClick={() => void undo()} title="Undo last change" disabled={!canUndo || streaming}>
        <Undo2 className="w-[17px] h-[17px]" />
      </IconButton>
      <IconButton onClick={() => void redo()} title="Redo" disabled={!canRedo || streaming}>
        <Redo2 className="w-[17px] h-[17px]" />
      </IconButton>
      <div className="relative no-drag">
        <IconButton
          onClick={toggleHistory}
          title="History — revert any change"
          active={historyOpen}
          disabled={!project || checkpoints.length === 0}
        >
          <History className="w-[17px] h-[17px]" />
        </IconButton>
        {historyOpen && <HistoryPanel />}
      </div>

      <Sep />

      {/* View tools: reload / viewport / devtools / console / open-external */}
      <IconButton onClick={() => reloadPreview()} title="Reload preview" disabled={!previewUrl}>
        <RefreshCw className="w-[17px] h-[17px]" />
      </IconButton>
      <div className="relative no-drag">
        <IconButton
          onClick={() => toggleMenu('viewport')}
          title="Responsive viewport"
          active={menu === 'viewport' || viewportWidth !== null}
          disabled={!previewUrl}
        >
          <Monitor className="w-[17px] h-[17px]" />
        </IconButton>
        {menu === 'viewport' && (
          <ViewportMenu
            current={viewportWidth}
            onPick={(w) => {
              setViewportWidth(w);
              setMenu(null);
            }}
          />
        )}
      </div>
      <IconButton onClick={() => toggleDevTools()} title="Toggle DevTools for the preview" disabled={!previewUrl}>
        <Code2 className="w-[17px] h-[17px]" />
      </IconButton>
      <div className="relative no-drag">
        <IconButton
          onClick={() => toggleMenu('console')}
          title="Page console — warnings & errors from the previewed page"
          active={menu === 'console'}
          variant={errorCount > 0 ? 'danger' : 'default'}
          disabled={!previewUrl}
        >
          <Terminal className="w-[17px] h-[17px]" />
        </IconButton>
        {errorCount > 0 && (
          <span className="pointer-events-none absolute -right-0.5 -top-0.5 grid h-[15px] min-w-[15px] place-items-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white ring-2 ring-ink-900">
            {errorCount > 9 ? '9+' : errorCount}
          </span>
        )}
        {menu === 'console' && <ConsolePanel />}
      </div>
      <IconButton
        onClick={() => {
          if (previewUrl) void easel.preview.openExternal({ url: previewUrl });
        }}
        title="Open in your browser"
        disabled={!previewUrl}
      >
        <ExternalLink className="w-[17px] h-[17px]" />
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

      {/* Click-away backdrop closes any open menu */}
      {anyMenuOpen && <div className="fixed inset-0 z-20" onClick={closeAllMenus} />}
    </header>
  );
}
