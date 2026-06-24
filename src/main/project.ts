/**
 * Easel — project management (open folder, framework detection, dev-server polling).
 *
 * Responsibilities:
 *  - Show an OS open-folder dialog and resolve a {@link ProjectConfig}.
 *  - Detect the framework (vite-react / next / vite-vue / vite-svelte / unknown)
 *    from `package.json` + config files.
 *  - Infer `devServerUrl` and `devCommand` from the detected framework.
 *  - Detect whether `@easel/vite-plugin-inspector` is present in deps or vite config.
 *  - Persist per-project config to `userData/projects/<hash>.json`.
 *  - Run a periodic dev-server reachability poll and push `preview.status` events
 *    to the renderer via the main window's webContents.
 *
 * All file I/O is synchronous at open-time (small JSON reads); the poll is async.
 */

import { app, dialog } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import type { ProjectConfig, ProjectFramework } from '@shared/types';
import type { PreviewStatusPayload } from '@shared/ipc';
import { IpcChannels } from '@shared/ipc';
import { getMainWindow } from '@main/window';
import { createLogger } from '@main/logger';

const log = createLogger('project');

/* -------------------------------------------------------------------------- */
/*  In-memory state                                                            */
/* -------------------------------------------------------------------------- */

let _currentProject: ProjectConfig | null = null;
let _pollTimer: ReturnType<typeof setInterval> | null = null;

/* -------------------------------------------------------------------------- */
/*  Persistence                                                                */
/* -------------------------------------------------------------------------- */

function projectCachePath(root: string): string {
  const hash = crypto.createHash('sha256').update(root).digest('hex').slice(0, 16);
  return path.join(app.getPath('userData'), 'projects', `${hash}.json`);
}

function loadCachedProject(root: string): Partial<ProjectConfig> {
  try {
    const raw = fs.readFileSync(projectCachePath(root), 'utf8');
    return JSON.parse(raw) as Partial<ProjectConfig>;
  } catch {
    return {};
  }
}

function saveProjectCache(config: ProjectConfig): void {
  const p = projectCachePath(config.root);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(config, null, 2), 'utf8');
  } catch (err) {
    log.warn('Failed to save project cache', { err: String(err) });
  }
}

/* -------------------------------------------------------------------------- */
/*  Framework detection                                                        */
/* -------------------------------------------------------------------------- */

interface PackageJson {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readPackageJson(root: string): PackageJson | null {
  try {
    const raw = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
    return JSON.parse(raw) as PackageJson;
  } catch {
    return null;
  }
}

function fileExists(root: string, ...segments: string[]): boolean {
  return fs.existsSync(path.join(root, ...segments));
}

function readFileText(root: string, ...segments: string[]): string {
  try {
    return fs.readFileSync(path.join(root, ...segments), 'utf8');
  } catch {
    return '';
  }
}

function hasDep(pkg: PackageJson | null, ...names: string[]): boolean {
  if (!pkg) return false;
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  return names.some((n) => n in all);
}

/**
 * Detect the framework used by the project. Checked in priority order:
 *  1. Next.js  — has `next` dep or `next.config.*` file.
 *  2. Vite+React — has `@vitejs/plugin-react` + vite config.
 *  3. Vite+Vue  — has `@vitejs/plugin-vue` + vite config.
 *  4. Vite+Svelte — has `@sveltejs/vite-plugin-svelte` + vite config.
 *  5. Unknown.
 */
function detectFramework(root: string, pkg: PackageJson | null): ProjectFramework {
  if (
    hasDep(pkg, 'next') ||
    fileExists(root, 'next.config.js') ||
    fileExists(root, 'next.config.ts') ||
    fileExists(root, 'next.config.mjs')
  ) {
    return 'next';
  }

  const hasViteConfig =
    fileExists(root, 'vite.config.ts') ||
    fileExists(root, 'vite.config.js') ||
    fileExists(root, 'vite.config.mts');

  if (hasViteConfig) {
    if (hasDep(pkg, '@vitejs/plugin-react', '@vitejs/plugin-react-swc')) return 'vite-react';
    if (hasDep(pkg, '@vitejs/plugin-vue', 'vue')) return 'vite-vue';
    if (hasDep(pkg, '@sveltejs/vite-plugin-svelte', 'svelte')) return 'vite-svelte';
  }

  // Fallback: infer from source file patterns.
  if (
    fileExists(root, 'src', 'App.tsx') ||
    fileExists(root, 'src', 'App.jsx') ||
    fileExists(root, 'src', 'main.tsx')
  ) {
    return 'vite-react';
  }

  return 'unknown';
}

/**
 * Infer the default dev-server URL for the detected framework.
 * Users can override this in Settings.
 */
function inferDevServerUrl(framework: ProjectFramework, pkg: PackageJson | null): string {
  // Check package.json scripts for explicit port hints.
  const devScript = pkg?.scripts?.['dev'] ?? pkg?.scripts?.['start'] ?? '';
  const portMatch = devScript.match(/--port[= ](\d+)|-p\s+(\d+)/);
  if (portMatch) {
    const port = portMatch[1] ?? portMatch[2];
    return `http://localhost:${port}`;
  }

  switch (framework) {
    case 'next':
      return 'http://localhost:3000';
    case 'vite-react':
    case 'vite-vue':
    case 'vite-svelte':
      return 'http://localhost:5173';
    default:
      return 'http://localhost:3000';
  }
}

/** Return the conventional `npm run dev` command for the framework. */
function inferDevCommand(framework: ProjectFramework, pkg: PackageJson | null): string | undefined {
  const scripts = pkg?.scripts ?? {};
  if ('dev' in scripts) return 'npm run dev';
  if ('start' in scripts) return 'npm run start';
  if (framework === 'next') return 'npx next dev';
  return undefined;
}

/**
 * Detect whether `@easel/vite-plugin-inspector` is present.
 * Checks deps + reads the vite config text for an import reference.
 */
function detectInspectorPlugin(root: string, pkg: PackageJson | null): boolean {
  if (hasDep(pkg, '@easel/vite-plugin-inspector')) return true;

  // Also scan vite config text as a loose text check (plugin may be inline).
  for (const name of ['vite.config.ts', 'vite.config.js', 'vite.config.mts']) {
    const text = readFileText(root, name);
    if (text.includes('easel') || text.includes('easelInspector')) return true;
  }

  return false;
}

/* -------------------------------------------------------------------------- */
/*  Open dialog                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Show an OS open-folder dialog. Returns the resolved {@link ProjectConfig}
 * or `null` if the user cancelled.
 */
export async function openProjectFolder(): Promise<ProjectConfig | null> {
  const win = getMainWindow();
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    title: 'Open Project',
    message: 'Select the root folder of your web project',
    properties: ['openDirectory', 'createDirectory'],
  });

  if (result.canceled || result.filePaths.length === 0) {
    log.info('Project open dialog cancelled');
    return null;
  }

  const root = result.filePaths[0];
  return loadProject(root);
}

/**
 * Load (or reload) a project from the given root directory, merging with any
 * previously-persisted per-project config (e.g. user-overridden devServerUrl).
 */
export function loadProject(root: string): ProjectConfig {
  const pkg = readPackageJson(root);
  const framework = detectFramework(root, pkg);
  const cached = loadCachedProject(root);
  const inspectorPluginPresent = detectInspectorPlugin(root, pkg);

  const config: ProjectConfig = {
    root,
    name: cached.name ?? path.basename(root),
    framework: cached.framework ?? framework,
    devServerUrl: cached.devServerUrl ?? inferDevServerUrl(framework, pkg),
    inspectorPluginPresent: cached.inspectorPluginPresent ?? inspectorPluginPresent,
    devCommand: cached.devCommand ?? inferDevCommand(framework, pkg),
  };

  log.info('Project loaded', {
    name: config.name,
    framework: config.framework,
    devServerUrl: config.devServerUrl,
    inspectorPluginPresent: config.inspectorPluginPresent,
  });

  saveProjectCache(config);
  setCurrentProject(config);
  return config;
}

/** Persist user-supplied overrides to the project config. */
export function updateProject(patch: Partial<ProjectConfig>): ProjectConfig | null {
  if (!_currentProject) return null;
  const updated: ProjectConfig = { ..._currentProject, ...patch };
  _currentProject = updated;
  saveProjectCache(updated);
  return updated;
}

/** Close the current project and stop polling. */
export function closeProject(): void {
  _currentProject = null;
  stopDevServerPoll();
  log.info('Project closed');
}

/** Return the currently open project, or null. */
export function getCurrentProject(): ProjectConfig | null {
  return _currentProject;
}

/* -------------------------------------------------------------------------- */
/*  Dev-server reachability poll                                               */
/* -------------------------------------------------------------------------- */

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 2500;

/** Make a simple HEAD request and return whether it succeeded. */
async function probe(url: string): Promise<{ reachable: boolean; detail?: string }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({ reachable: false, detail: 'timeout' });
    }, POLL_TIMEOUT_MS);

    const lib = url.startsWith('https://') ? https : http;
    const req = lib.request(url, { method: 'HEAD' }, (res) => {
      clearTimeout(timer);
      // Any HTTP response (even 404) means the server is up.
      resolve({ reachable: true, detail: String(res.statusCode) });
    });

    req.on('error', (err) => {
      clearTimeout(timer);
      resolve({ reachable: false, detail: err.message });
    });

    req.end();
  });
}

function stopDevServerPoll(): void {
  if (_pollTimer !== null) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
}

function startDevServerPoll(url: string): void {
  stopDevServerPoll();

  const tick = async (): Promise<void> => {
    const { reachable, detail } = await probe(url);
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;

    const payload: PreviewStatusPayload = { url, reachable, detail };
    win.webContents.send(IpcChannels.previewStatus, payload);
  };

  // Fire immediately then on interval.
  void tick();
  _pollTimer = setInterval(() => void tick(), POLL_INTERVAL_MS);
}

/** Internal: update _currentProject and (re)start the dev-server poll. */
function setCurrentProject(config: ProjectConfig): void {
  _currentProject = config;
  startDevServerPoll(config.devServerUrl);
}
