import { resolve } from 'path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * Electron + Vite build configuration for Easel.
 *
 * Builds FOUR bundles:
 *   1. main     -> out/main/index.js              (Electron main process, Node + Electron APIs)
 *   2. preload  -> out/preload/index.js           (host preload; exposes window.easel)
 *   3. inspector-> out/preload/webview/inspector.js (GUEST preload injected into the <webview>;
 *                                                    does element hit-testing / source mapping)
 *   4. renderer -> out/renderer/*                 (React UI; talks to main over IPC only)
 *
 * The guest inspector is emitted as a second preload input. The main process
 * sets it as the <webview> `preload` attribute, resolving it at runtime as
 * `path.join(__dirname, '../preload/webview/inspector.js')` (from out/main).
 * See src/main/window.ts.
 */
const sharedAlias = { '@shared': resolve(__dirname, 'src/shared') };

export default defineConfig({
  main: {
    // The Claude Agent SDK is an optionalDependency that is NOT bundled into
    // installers (it's proprietary; resolved at runtime from the user's own
    // Claude Code). Force-externalize it so it's never inlined into out/main.
    plugins: [externalizeDepsPlugin({ include: ['@anthropic-ai/claude-agent-sdk'] })],
    resolve: { alias: { ...sharedAlias, '@main': resolve(__dirname, 'src/main') } },
    build: {
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
    },
  },

  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { ...sharedAlias, '@preload': resolve(__dirname, 'src/preload') } },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          'webview/inspector': resolve(__dirname, 'src/preload/webview/inspector.ts'),
        },
        output: {
          format: 'cjs',
          // Emit .cjs so Electron can require() these preloads even though the
          // root package.json is "type": "module" (a .js preload would be
          // classified as ESM and fail with ERR_REQUIRE_ESM).
          // Preserves the `webview/` subdir → out/preload/webview/inspector.cjs.
          entryFileNames: '[name].cjs',
        },
      },
    },
  },

  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    resolve: { alias: { ...sharedAlias, '@renderer': resolve(__dirname, 'src/renderer') } },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
