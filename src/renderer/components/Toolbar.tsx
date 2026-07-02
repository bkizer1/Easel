/**
 * Easel — Toolbar (title bar).
 *
 * The top strip doubles as the macOS draggable title bar (the window uses a
 * hiddenInset title bar), so the whole header is a drag region and every
 * interactive control opts out with `no-drag`. On macOS we reserve space on the
 * left for the traffic-light buttons.
 *
 * Controls are organised into segmented clusters (`.seg`) — mode, edit, view —
 * which reads as mature browser chrome rather than a loose row of icons.
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
  Grid3x3,
  ScanLine,
  Wand2,
  ScanEye,
  FlaskConical,
} from 'lucide-react';
import { useEaselStore, VIEWPORT_PRESETS } from '../store';
import { easel } from '../lib/api';
import { HistoryPanel } from './HistoryPanel';
import { ConsolePanel } from './ConsolePanel';
import { IconButton } from './IconButton';
import { Tooltip } from './Tooltip';

/** macOS reserves the top-left for window controls; pad the toolbar past them. */
const IS_MAC =
  typeof navigator !== 'undefined' && navigator.userAgent.includes('Macintosh');
const MOD = IS_MAC ? '⌘' : 'Ctrl';

/* -------------------------------------------------------------------------- */
/*  Wordmark                                                                  */
/* -------------------------------------------------------------------------- */

function Wordmark(): React.ReactElement {
  return (
    <div className="flex items-center gap-2 pr-1 select-none">
      <span className="grid place-items-center w-[22px] h-[22px] rounded-[7px] bg-gradient-to-br from-brand-300 via-brand-400 to-brand-600 shadow-[0_0_16px_-3px_rgba(52,211,176,0.8)] ring-1 ring-white/20">
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
  const label =
    reachable === null
      ? 'No live preview'
      : reachable
        ? `Live · ${previewStatus!.url}`
        : `Unreachable · ${previewStatus!.detail ?? previewStatus!.url}`;

  return (
    <Tooltip label={label} side="bottom">
      <span className="no-drag relative flex items-center justify-center w-5 h-5">
        {reachable && (
          <span className="absolute w-2.5 h-2.5 rounded-full bg-brand-400/40 animate-ping" />
        )}
        <span className={`relative w-2 h-2 rounded-full ${color}`} />
      </span>
    </Tooltip>
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
    <Tooltip label={`Backend: ${agentBackend} · ${model} — click to change`} side="bottom">
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="no-drag group flex items-center gap-1.5 pl-2 pr-2.5 h-7 rounded-lg bg-ink-800/70 hover:bg-ink-700/80 border border-white/5 hover:border-brand-500/30 transition-all duration-150 ease-spring active:scale-[0.98]"
      >
        <Sparkles className="w-3 h-3 text-brand-400" />
        <span className="text-[11px] font-medium text-gray-300">{backendLabel[agentBackend] ?? agentBackend}</span>
        <span className="w-px h-3 bg-white/10" />
        <span className="text-[11px] font-mono text-gray-500 group-hover:text-gray-400">{shortModel}</span>
      </button>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------------- */
/*  Segmented cluster                                                          */
/* -------------------------------------------------------------------------- */

function Seg({ children }: { children: React.ReactNode }): React.ReactElement {
  return <div className="seg no-drag">{children}</div>;
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
    <div className="glass-panel animate-panel-in absolute left-0 top-full mt-2 z-30 w-48 overflow-hidden py-1.5 origin-top">
      <div className="px-3.5 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
        Viewport
      </div>
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
            <span className="flex items-center gap-2">
              {active && <span className="w-1 h-1 rounded-full bg-brand-400" />}
              <span className={active ? '' : 'pl-3'}>{p.label}</span>
            </span>
            <span className="font-mono text-[11px] text-gray-500">{p.width ? `${p.width}px` : 'auto'}</span>
          </button>
        );
      })}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Alignment-grid panel (issue #5)                                           */
/* -------------------------------------------------------------------------- */

function GridPanel(): React.ReactElement {
  const offGridElements = useEaselStore((s) => s.offGridElements);
  const scanningOffGrid = useEaselStore((s) => s.scanningOffGrid);
  const streaming = useEaselStore((s) => s.streaming);
  const gridConfig = useEaselStore((s) => s.gridConfig);
  const scanOffGrid = useEaselStore((s) => s.scanOffGrid);
  const snapToGrid = useEaselStore((s) => s.snapToGrid);
  const setHover = useEaselStore((s) => s.setHover);

  return (
    <div className="glass-panel animate-panel-in absolute right-0 top-full mt-2 z-30 w-80 overflow-hidden origin-top-right">
      <div className="flex items-center justify-between gap-2 px-3.5 py-2.5 hairline-b">
        <div className="flex flex-col">
          <span className="text-[12.5px] font-medium text-gray-200">Alignment grid</span>
          <span className="font-mono text-[10.5px] text-gray-500">
            {gridConfig.columns} cols · {gridConfig.gutter}px gutter · {gridConfig.baseline}px baseline
          </span>
        </div>
        <Tooltip label="Scan the page for elements whose edges miss the grid" side="bottom">
          <button
            onClick={() => scanOffGrid()}
            disabled={scanningOffGrid || streaming}
            className="flex items-center gap-1.5 rounded-lg bg-ink-800/80 px-2.5 py-1.5 text-[11.5px] font-medium text-gray-200 hover:bg-ink-700/80 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150 ease-spring active:scale-[0.97]"
          >
            <ScanLine className="w-3.5 h-3.5" />
            {scanningOffGrid ? 'Scanning…' : 'Scan'}
          </button>
        </Tooltip>
      </div>

      <div className="max-h-64 overflow-y-auto py-1">
        {offGridElements.length === 0 ? (
          <p className="px-3.5 py-3 text-[11.5px] text-gray-500">
            {scanningOffGrid
              ? 'Scanning the preview…'
              : 'No off-grid elements found yet. Click Scan to check alignment.'}
          </p>
        ) : (
          offGridElements.map((o) => {
            const label = o.dataEaselSource
              ? `${o.dataEaselSource.filePath}:${o.dataEaselSource.line}`
              : o.selector;
            return (
              <div
                key={o.id}
                onMouseEnter={() => setHover(o.selector)}
                onMouseLeave={() => setHover(null)}
                className="flex items-center justify-between gap-2 px-3.5 py-1.5 hover:bg-white/[0.05]"
              >
                <div className="min-w-0 flex flex-col">
                  <span className="truncate text-[11.5px] text-gray-300" title={label}>
                    {`<${o.tagName}>`} {label}
                  </span>
                  {!o.dataEaselSource && (
                    <span className="text-[10px] text-amber-400/80">no source map — grep fallback</span>
                  )}
                </div>
                <span className="shrink-0 font-mono text-[10.5px] text-rose-300/90" title="Worst edge offset">
                  {o.worstOffsetPx}px
                </span>
              </div>
            );
          })
        )}
      </div>

      {offGridElements.length > 0 && (
        <div className="hairline-t px-3.5 py-2.5">
          <Tooltip label="Ask the agent to align all listed elements in one edit (one checkpoint)" side="top">
            <button
              onClick={() => void snapToGrid(offGridElements.map((o) => o.id))}
              disabled={streaming}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand-700 px-3 py-2 text-[12px] font-medium text-white shadow-[inset_0_1px_0_0_rgba(255,255,255,0.15)] hover:bg-brand-600 disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-150 ease-spring active:scale-[0.98]"
            >
              <Wand2 className="w-3.5 h-3.5" />
              Snap {offGridElements.length} to grid
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Count badge (errors / off-grid)                                            */
/* -------------------------------------------------------------------------- */

function CountBadge({ count, tone }: { count: number; tone: 'rose' | 'amber' }): React.ReactElement {
  const cls = tone === 'rose' ? 'bg-rose-500' : 'bg-amber-500';
  return (
    <span
      className={`pointer-events-none absolute -right-0.5 -top-0.5 z-10 grid h-[15px] min-w-[15px] place-items-center rounded-full ${cls} px-1 text-[9px] font-bold text-white ring-2 ring-ink-900`}
    >
      {count > 9 ? '9+' : count}
    </span>
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

  const gridVisible = useEaselStore((s) => s.gridVisible);
  const offGridElements = useEaselStore((s) => s.offGridElements);
  const setGridVisible = useEaselStore((s) => s.setGridVisible);

  const xrayOpen = useEaselStore((s) => s.xrayOpen);
  const setXrayOpen = useEaselStore((s) => s.setXrayOpen);
  const puppeteerOpen = useEaselStore((s) => s.puppeteerOpen);
  const setPuppeteerOpen = useEaselStore((s) => s.setPuppeteerOpen);
  const puppeteer = useEaselStore((s) => s.puppeteer);

  const [menu, setMenu] = useState<'viewport' | 'console' | 'grid' | null>(null);

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
  const toggleMenu = (m: 'viewport' | 'console' | 'grid'): void => {
    setHistoryOpen(false);
    setMenu((cur) => (cur === m ? null : m));
  };
  const toggleHistory = (): void => {
    setMenu(null);
    setHistoryOpen(!historyOpen);
  };

  return (
    <header
      className="drag-region relative z-10 flex items-center gap-2 h-12 px-3 bg-ink-900/80 backdrop-blur-xl hairline-b select-none"
      style={{ paddingLeft: IS_MAC ? 80 : 12 }}
    >
      <Wordmark />

      {/* Project */}
      {!project ? (
        <Tooltip label="Open a project folder so the AI can edit its source" side="bottom">
          <button
            type="button"
            onClick={() => void openProject()}
            className="no-drag flex items-center gap-1.5 h-7 pl-2 pr-2.5 rounded-lg text-[12px] text-gray-400 hover:text-gray-100 hover:bg-white/[0.07] transition-all duration-150 ease-spring active:scale-[0.98]"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Open project
          </button>
        </Tooltip>
      ) : (
        <div className="no-drag flex items-center gap-1 h-7 pl-2.5 pr-1 rounded-lg bg-ink-800/60 border border-white/5">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-400 shadow-[0_0_8px_rgba(52,211,176,0.8)]" />
          <Tooltip label={project.root} side="bottom">
            <span className="text-[12px] font-medium text-gray-200 max-w-[160px] truncate">
              {project.name}
            </span>
          </Tooltip>
          <Tooltip label="Close project" side="bottom">
            <button
              onClick={() => void closeProject()}
              className="ml-0.5 grid place-items-center w-5 h-5 rounded-md text-gray-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          </Tooltip>
        </div>
      )}

      {/* Mode cluster */}
      <Seg>
        <IconButton
          onClick={() => setMode(mode === 'element-select' ? 'idle' : 'element-select')}
          tooltip="Select an element to target"
          active={mode === 'element-select'}
          disabled={!project || streaming}
          aria-label="Select mode"
        >
          <MousePointer2 className="w-[17px] h-[17px]" />
        </IconButton>
        <IconButton
          onClick={() => setMode(mode === 'freeform' ? 'idle' : 'freeform')}
          tooltip="Markup mode — draw on the page"
          active={mode === 'freeform'}
          disabled={!project || streaming}
          aria-label="Markup mode"
        >
          <PenLine className="w-[17px] h-[17px]" />
        </IconButton>
      </Seg>

      {/* Edit-history cluster */}
      <Seg>
        <IconButton
          onClick={() => void undo()}
          tooltip="Undo last change"
          shortcut={`${MOD}Z`}
          disabled={!canUndo || streaming}
          aria-label="Undo"
        >
          <Undo2 className="w-[17px] h-[17px]" />
        </IconButton>
        <IconButton
          onClick={() => void redo()}
          tooltip="Redo"
          shortcut={`${MOD}⇧Z`}
          disabled={!canRedo || streaming}
          aria-label="Redo"
        >
          <Redo2 className="w-[17px] h-[17px]" />
        </IconButton>
        <div className="relative no-drag">
          <IconButton
            onClick={toggleHistory}
            tooltip="History — revert any change"
            active={historyOpen}
            disabled={!project || checkpoints.length === 0}
            aria-label="History"
          >
            <History className="w-[17px] h-[17px]" />
          </IconButton>
          {historyOpen && <HistoryPanel />}
        </div>
      </Seg>

      {/* View-tools cluster */}
      <Seg>
        <IconButton
          onClick={() => reloadPreview()}
          tooltip="Reload preview"
          disabled={!previewUrl}
          aria-label="Reload preview"
        >
          <RefreshCw className="w-[17px] h-[17px]" />
        </IconButton>
        <div className="relative no-drag">
          <IconButton
            onClick={() => toggleMenu('viewport')}
            tooltip="Responsive viewport"
            active={menu === 'viewport' || viewportWidth !== null}
            disabled={!previewUrl}
            aria-label="Responsive viewport"
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
        <IconButton
          onClick={() => toggleDevTools()}
          tooltip="Toggle DevTools for the preview"
          disabled={!previewUrl}
          aria-label="Toggle DevTools"
        >
          <Code2 className="w-[17px] h-[17px]" />
        </IconButton>
        <div className="relative no-drag">
          <IconButton
            onClick={() => {
              // Toggling the button shows/hides the grid AND opens/closes its panel.
              const opening = menu !== 'grid';
              setGridVisible(opening);
              toggleMenu('grid');
            }}
            tooltip="Alignment grid — overlay a column/baseline grid and flag off-grid elements"
            active={menu === 'grid' || gridVisible}
            disabled={!previewUrl}
            aria-label="Alignment grid"
          >
            <Grid3x3 className="w-[17px] h-[17px]" />
          </IconButton>
          {offGridElements.length > 0 && menu !== 'grid' && (
            <CountBadge count={offGridElements.length} tone="amber" />
          )}
          {menu === 'grid' && <GridPanel />}
        </div>
        <div className="relative no-drag">
          <IconButton
            onClick={() => toggleMenu('console')}
            tooltip="Page console — warnings & errors from the previewed page"
            active={menu === 'console'}
            variant={errorCount > 0 ? 'danger' : 'default'}
            disabled={!previewUrl}
            aria-label="Page console"
          >
            <Terminal className="w-[17px] h-[17px]" />
          </IconButton>
          {errorCount > 0 && <CountBadge count={errorCount} tone="rose" />}
          {menu === 'console' && <ConsolePanel />}
        </div>
        <IconButton
          onClick={() => setXrayOpen(!xrayOpen)}
          tooltip="State X-Ray — live state, network & time-travel"
          active={xrayOpen}
          disabled={!previewUrl}
          aria-label="State X-Ray"
        >
          <ScanEye className="w-[17px] h-[17px]" />
        </IconButton>
        <div className="relative no-drag">
          <IconButton
            onClick={() => setPuppeteerOpen(!puppeteerOpen)}
            tooltip="Live State Puppeteer — intercept fetches & override component state"
            active={puppeteerOpen || puppeteer.enabled}
            disabled={!previewUrl}
            aria-label="Live State Puppeteer"
          >
            <FlaskConical className="w-[17px] h-[17px]" />
          </IconButton>
          {puppeteer.enabled && (puppeteer.mocks.length > 0 || puppeteer.overrides.length > 0) && (
            <CountBadge count={puppeteer.mocks.length + puppeteer.overrides.length} tone="amber" />
          )}
        </div>
        <IconButton
          onClick={() => {
            if (previewUrl) void easel.preview.openExternal({ url: previewUrl });
          }}
          tooltip="Open in your browser"
          disabled={!previewUrl}
          aria-label="Open in browser"
        >
          <ExternalLink className="w-[17px] h-[17px]" />
        </IconButton>
      </Seg>

      <div className="flex-1" />

      {/* Right cluster */}
      <BackendIndicator />
      <div className="no-drag flex items-center px-1">
        <StatusDot />
      </div>
      <IconButton onClick={() => setSettingsOpen(true)} tooltip="Settings" aria-label="Settings">
        <Settings className="w-[17px] h-[17px]" />
      </IconButton>

      {/* Click-away backdrop closes any open menu */}
      {anyMenuOpen && <div className="fixed inset-0 z-20" onClick={closeAllMenus} />}
    </header>
  );
}
