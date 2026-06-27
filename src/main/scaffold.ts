/**
 * Easel — new-site scaffolding.
 *
 * When the user starts a site from scratch (see NewSiteWizard), this writes a
 * fresh Vite + React + TS project, installs its dependencies (streaming
 * progress), git-inits it (so checkpoints work), and loads it as the current
 * project. The agent then builds the actual site on top of the placeholder from
 * the user's brief (see `buildSitePrompt`).
 */

import { dialog } from 'electron';
import { execFile } from 'node:child_process';
import { mkdir, writeFile, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import type { ProjectConfig } from '@shared/types';
import type { NewSiteBrief } from '@shared/siteBrief';
import type { ScaffoldEventPayload } from '@shared/ipc';
import { IpcChannels } from '@shared/ipc';
import { TEMPLATE_DEPENDENCIES, TEMPLATE_DEV_DEPENDENCIES } from '@shared/toolchainDeps';
import { getMainWindow } from '@main/window';
import { loadProject } from '@main/project';
import { ensureToolchain, isToolchainReady, toolchainModulesPath } from '@main/toolchain';
import { createLogger } from '@main/logger';

const execFileAsync = promisify(execFile);
const log = createLogger('scaffold');

function emit(payload: ScaffoldEventPayload): void {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) win.webContents.send(IpcChannels.projectScaffoldEvent, payload);
}

function slugify(name: string): string {
  const s = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'easel-site';
}

/** Open a folder dialog to choose where to create the new site. */
export async function chooseNewSiteLocation(): Promise<string | null> {
  const win = getMainWindow();
  const result = await dialog.showOpenDialog(win ?? undefined!, {
    title: 'Where should your new site live?',
    message: 'Choose a folder to create your new site in',
    buttonLabel: 'Use this folder',
    defaultPath: os.homedir(),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

/* -------------------------------------------------------------------------- */
/*  Template                                                                    */
/* -------------------------------------------------------------------------- */

/** A fresh Vite + React + TS project — the AI replaces App.tsx/styles.css. */
function templateFiles(name: string, slug: string): Record<string, string> {
  const nameLit = JSON.stringify(name); // safe to inline into TSX/HTML
  return {
    'package.json':
      JSON.stringify(
        {
          name: slug,
          private: true,
          version: '0.0.0',
          type: 'module',
          scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
          dependencies: TEMPLATE_DEPENDENCIES,
          devDependencies: TEMPLATE_DEV_DEPENDENCIES,
        },
        null,
        2,
      ) + '\n',
    'vite.config.ts':
      "import { defineConfig } from 'vite';\n" +
      "import react from '@vitejs/plugin-react';\n\n" +
      "// cacheDir is project-local (not the default node_modules/.vite) because\n" +
      "// node_modules is a symlink to Easel's shared toolchain — keep prebundle\n" +
      '// caches separate per project.\n' +
      'export default defineConfig({\n' +
      '  plugins: [react()],\n' +
      "  cacheDir: '.vite',\n" +
      '  server: { port: 3000 },\n' +
      '});\n',
    'index.html':
      '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n' +
      '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />\n' +
      `    <title>${name.replace(/[<>&]/g, '')}</title>\n` +
      '  </head>\n  <body>\n    <div id="root"></div>\n' +
      '    <script type="module" src="/src/main.tsx"></script>\n  </body>\n</html>\n',
    'tsconfig.json':
      JSON.stringify(
        {
          compilerOptions: {
            target: 'ES2020',
            useDefineForClassFields: true,
            lib: ['ES2020', 'DOM', 'DOM.Iterable'],
            module: 'ESNext',
            skipLibCheck: true,
            moduleResolution: 'bundler',
            resolveJsonModule: true,
            isolatedModules: true,
            noEmit: true,
            jsx: 'react-jsx',
            strict: true,
          },
          include: ['src', 'vite.config.ts'],
        },
        null,
        2,
      ) + '\n',
    '.gitignore': 'node_modules\ndist\n.vite\n*.local\n.DS_Store\n',
    'src/main.tsx':
      "import React from 'react';\n" +
      "import ReactDOM from 'react-dom/client';\n" +
      "import App from './App';\n" +
      "import './styles.css';\n\n" +
      "ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(\n" +
      '  <React.StrictMode>\n    <App />\n  </React.StrictMode>,\n);\n',
    'src/App.tsx':
      'export default function App() {\n' +
      `  const name = ${nameLit};\n` +
      '  return (\n' +
      '    <main className="easel-placeholder">\n' +
      '      <span className="easel-badge">Made with Easel</span>\n' +
      '      <h1>{name}</h1>\n' +
      '      <p>Your site is being crafted from your brief…</p>\n' +
      '      <div className="easel-dots"><span /><span /><span /></div>\n' +
      '    </main>\n' +
      '  );\n}\n',
    'src/styles.css':
      "* { box-sizing: border-box; margin: 0; padding: 0; }\n" +
      'body { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }\n' +
      '.easel-placeholder {\n' +
      '  min-height: 100vh; display: grid; place-content: center; justify-items: center; gap: 18px;\n' +
      '  text-align: center; padding: 24px;\n' +
      '  background: radial-gradient(120% 90% at 50% -10%, #16233a 0%, #0a0e16 60%);\n' +
      '  color: #eef2f7;\n' +
      '}\n' +
      '.easel-badge {\n' +
      '  font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: #34d3b0;\n' +
      '  border: 1px solid rgba(52,211,176,0.3); border-radius: 999px; padding: 5px 12px;\n' +
      '}\n' +
      '.easel-placeholder h1 { font-size: clamp(32px, 6vw, 64px); font-weight: 800; letter-spacing: -0.03em; }\n' +
      '.easel-placeholder p { color: #94a3b8; font-size: 16px; }\n' +
      '.easel-dots { display: flex; gap: 8px; margin-top: 6px; }\n' +
      '.easel-dots span {\n' +
      '  width: 9px; height: 9px; border-radius: 999px; background: #34d3b0;\n' +
      '  animation: easel-pulse 1.2s ease-in-out infinite;\n' +
      '}\n' +
      '.easel-dots span:nth-child(2) { animation-delay: 0.2s; }\n' +
      '.easel-dots span:nth-child(3) { animation-delay: 0.4s; }\n' +
      '@keyframes easel-pulse { 0%,100% { opacity: 0.25; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-4px); } }\n',
  };
}

/* -------------------------------------------------------------------------- */
/*  Create                                                                      */
/* -------------------------------------------------------------------------- */

export async function createNewSite(opts: {
  brief: NewSiteBrief;
  parentDir: string;
  name: string;
}): Promise<ProjectConfig> {
  const slug = slugify(opts.name);
  const dir = path.join(opts.parentDir, slug);
  if (existsSync(dir)) {
    throw new Error(`A folder named "${slug}" already exists here — pick a different name or location.`);
  }

  log.info('Scaffolding new site', { dir });
  emit({ phase: 'writing', message: `Creating ${slug}…` });
  for (const [rel, content] of Object.entries(templateFiles(opts.name, slug))) {
    const p = path.join(dir, rel);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, content, 'utf8');
  }

  // Reuse Easel's shared toolchain instead of a per-project install: warm it
  // (instant if already done — it's pre-warmed when the wizard opens) and symlink
  // the project's node_modules to it. The project stays source-only and creation
  // is ~instant. The package.json still declares real deps, so the project is a
  // standard, standalone-installable project if taken elsewhere.
  if (!isToolchainReady()) {
    emit({ phase: 'installing', message: "Setting up Easel's toolchain (one-time)…" });
  }
  await ensureToolchain((line) => emit({ phase: 'installing', log: line }));
  await symlink(toolchainModulesPath(), path.join(dir, 'node_modules'), 'junction');

  emit({ phase: 'git', message: 'Initialising git…' });
  await gitInit(dir);

  emit({ phase: 'done', message: 'Ready' });
  log.info('New site scaffolded', { dir });
  return loadProject(dir);
}

async function gitInit(dir: string): Promise<void> {
  const env = { ...process.env, GIT_EDITOR: 'true', GIT_TERMINAL_PROMPT: '0' };
  try {
    await execFileAsync('git', ['init'], { cwd: dir, env });
    await execFileAsync('git', ['add', '--all'], { cwd: dir, env });
    await execFileAsync('git', ['commit', '-m', 'chore: initial scaffold (Easel)'], { cwd: dir, env }).catch(
      () => undefined,
    );
  } catch (err) {
    // Non-fatal: the project still works, checkpoints just won't until git is set up.
    log.warn('git init failed (checkpoints may be unavailable)', { err: String(err) });
  }
}
