/**
 * Easel — dev-server manager.
 *
 * Easel previews a *running* dev server; it doesn't, by itself, start one. This
 * module closes that gap: when a project is opened whose dev server isn't
 * already reachable, Easel runs the project's detected dev command
 * (e.g. `npm run dev`) as a child process, streams its output to the renderer,
 * and the reachability poll loads the preview as soon as it's serving.
 *
 * Only ONE managed server runs at a time. We track whether *we* started it so
 * we can stop exactly what we own on project close / app quit. A dev server the
 * user already had running is never touched (we detect reachability first).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { ProjectConfig } from '@shared/types';
import type { DevServerState, DevServerStatePayload } from '@shared/ipc';
import { IpcChannels } from '@shared/ipc';
import { getMainWindow } from '@main/window';
import { probe } from '@main/project';
import { createLogger } from '@main/logger';

const log = createLogger('devserver');

/* -------------------------------------------------------------------------- */
/*  State                                                                      */
/* -------------------------------------------------------------------------- */

interface ManagedServer {
  proc: ChildProcess;
  command: string;
  cwd: string;
  url: string;
}

let _server: ManagedServer | null = null;
let _state: DevServerState = 'idle';
const _logBuffer: string[] = [];

const MAX_LOG_LINES = 200;
const LOG_TAIL = 40;
/**
 * ANSI CSI color sequences: ESC '[' … 'm'. Built via fromCharCode so there is
 * no literal control character in the source (keeps `no-control-regex` happy).
 */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/* -------------------------------------------------------------------------- */
/*  Emit / logging                                                             */
/* -------------------------------------------------------------------------- */

function snapshot(): DevServerStatePayload {
  return {
    state: _state,
    command: _server?.command,
    cwd: _server?.cwd,
    url: _server?.url,
    logTail: _logBuffer.slice(-LOG_TAIL),
  };
}

/** Current dev-server state (for the `devServer.get` IPC handler). */
export function getDevServerState(): DevServerStatePayload {
  return snapshot();
}

function emit(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(IpcChannels.devServerEvent, snapshot());
}

function setState(state: DevServerState): void {
  _state = state;
  emit();
}

function pushLog(chunk: string): void {
  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.replace(ANSI, '').trimEnd();
    if (line.trim().length > 0) _logBuffer.push(line);
  }
  while (_logBuffer.length > MAX_LOG_LINES) _logBuffer.shift();
  emit();
}

/* -------------------------------------------------------------------------- */
/*  Start / stop                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Start `command` in `cwd`, waiting for the server to come up at `url`.
 * No-op if a managed server is already running.
 */
export function startDevServer(opts: { command: string; cwd: string; url: string }): void {
  if (_server) {
    log.info('Dev server already running; ignoring start', { command: opts.command });
    return;
  }

  _logBuffer.length = 0;
  log.info('Starting dev server', { command: opts.command, cwd: opts.cwd });

  // shell:true so `npm run dev` resolves via the user's PATH. detached on POSIX
  // creates a process group we can signal as a whole (npm spawns vite as a
  // child — killing only npm would orphan the server).
  const proc = spawn(opts.command, {
    cwd: opts.cwd,
    shell: true,
    detached: process.platform !== 'win32',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', BROWSER: 'none' },
  });

  _server = { proc, command: opts.command, cwd: opts.cwd, url: opts.url };
  setState('starting');

  proc.stdout?.on('data', (d: Buffer) => pushLog(d.toString()));
  proc.stderr?.on('data', (d: Buffer) => pushLog(d.toString()));

  proc.on('spawn', () => {
    // Process launched; the reachability poll confirms when it's actually serving.
    if (_server?.proc === proc) setState('running');
  });

  proc.on('error', (err: Error) => {
    log.error('Dev server failed to spawn', { err: err.message });
    pushLog(`✗ Failed to start: ${err.message}`);
    if (_server?.proc === proc) {
      _server = null;
      setState('error');
    }
  });

  proc.on('exit', (code, signal) => {
    log.info('Dev server exited', { code, signal });
    // Only react if this is still the current server (not superseded by a restart).
    if (_server?.proc !== proc) return;
    const clean = code === 0 || signal === 'SIGTERM' || signal === 'SIGKILL';
    pushLog(`— dev server exited (code ${code ?? 'null'}${signal ? `, ${signal}` : ''})`);
    _server = null;
    setState(clean ? 'stopped' : 'error');
  });
}

/** Stop the managed dev server (and its child process group). */
export function stopDevServer(): void {
  const server = _server;
  if (!server) return;
  log.info('Stopping dev server');
  _server = null;
  try {
    if (process.platform === 'win32' || server.proc.pid === undefined) {
      server.proc.kill();
    } else {
      // Negative pid → signal the whole process group created by `detached`.
      process.kill(-server.proc.pid, 'SIGTERM');
    }
  } catch (err) {
    log.warn('Error stopping dev server', { err: String(err) });
  }
  setState('stopped');
}

/* -------------------------------------------------------------------------- */
/*  Auto-start                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * If the project has a known dev command and its server isn't already
 * reachable, start it. Called when a project is opened.
 */
export async function maybeAutoStartDevServer(project: ProjectConfig): Promise<void> {
  if (!project.devCommand) {
    log.info('No dev command detected; skipping auto-start', { name: project.name });
    return;
  }

  const { reachable } = await probe(project.devServerUrl);
  if (reachable) {
    log.info('Dev server already reachable; not auto-starting', { url: project.devServerUrl });
    return;
  }

  startDevServer({
    command: project.devCommand,
    cwd: project.root,
    url: project.devServerUrl,
  });
}
