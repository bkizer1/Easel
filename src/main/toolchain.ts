/**
 * Easel — shared build toolchain.
 *
 * Instead of running a per-project `npm install` for every site created from
 * scratch, Easel maintains ONE toolchain (Vite + React + the JSX transform) in
 * `userData/toolchain`. New projects are created as plain source and their
 * `node_modules` is symlinked to this shared install (see `scaffold.ts`), so
 * project creation is ~instant and costs no extra disk per project.
 *
 * The toolchain is installed lazily on first need and reused forever after. It's
 * also pre-warmed when the new-site wizard opens, so the one-time install
 * overlaps the time the user spends answering the brief.
 */

import { app } from 'electron';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { TOOLCHAIN_DEPENDENCIES } from '@shared/toolchainDeps';
import { createLogger } from '@main/logger';

const log = createLogger('toolchain');

export function toolchainDir(): string {
  return path.join(app.getPath('userData'), 'toolchain');
}

/** Absolute path to the shared `node_modules` projects symlink against. */
export function toolchainModulesPath(): string {
  return path.join(toolchainDir(), 'node_modules');
}

/** Written only after a fully successful install, so partial installs aren't trusted. */
function readyMarker(): string {
  return path.join(toolchainDir(), '.easel-ready');
}

/** True when the shared toolchain is installed and usable. */
export function isToolchainReady(): boolean {
  return existsSync(readyMarker()) && existsSync(path.join(toolchainModulesPath(), 'vite'));
}

/* -------------------------------------------------------------------------- */
/*  Install (idempotent, single-flight, with progress fan-out)                 */
/* -------------------------------------------------------------------------- */

let warmPromise: Promise<string> | null = null;
const logListeners = new Set<(line: string) => void>();

function broadcast(line: string): void {
  for (const listener of logListeners) listener(line);
}

/**
 * Ensure the shared toolchain is installed, returning the path to its
 * `node_modules`. Idempotent and single-flight: concurrent callers (e.g. the
 * wizard's pre-warm and the actual create) share one install. `onLog` receives
 * `npm install` output for the duration of the install.
 */
export function ensureToolchain(onLog?: (line: string) => void): Promise<string> {
  if (isToolchainReady()) return Promise.resolve(toolchainModulesPath());
  if (onLog) logListeners.add(onLog);
  if (!warmPromise) {
    warmPromise = installToolchain().finally(() => {
      warmPromise = null;
    });
  }
  const pending = warmPromise;
  if (onLog) void pending.finally(() => logListeners.delete(onLog));
  return pending;
}

/** Fire-and-forget warm-up; errors are swallowed (they resurface at create time). */
export function prewarmToolchain(): void {
  if (isToolchainReady()) return;
  void ensureToolchain().catch((err) => log.warn('Toolchain pre-warm failed', { err: String(err) }));
}

async function installToolchain(): Promise<string> {
  const dir = toolchainDir();
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(
      { name: 'easel-toolchain', private: true, version: '0.0.0', type: 'module', dependencies: TOOLCHAIN_DEPENDENCIES },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  log.info('Warming shared toolchain', { dir });
  broadcast("Setting up Easel's build toolchain (one-time)…");
  await npmInstall(dir);
  await writeFile(readyMarker(), 'ok', 'utf8');
  log.info('Shared toolchain ready', { dir });
  return toolchainModulesPath();
}

function npmInstall(dir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: dir,
      shell: true,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    });
    const onData = (d: Buffer): void => {
      const last = d.toString().split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
      if (last) broadcast(last);
    };
    proc.stdout?.on('data', onData);
    proc.stderr?.on('data', onData);
    proc.on('error', (err) =>
      reject(new Error(`Couldn't run npm install: ${err.message}. Is Node.js / npm on your PATH?`)),
    );
    proc.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Toolchain install exited with code ${code ?? 'null'}.`)),
    );
  });
}
