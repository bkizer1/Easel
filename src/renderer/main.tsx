/**
 * Easel Renderer — React entry point.
 *
 * Mounts the root <App /> component into the `#root` div defined in
 * index.html. StrictMode is enabled in development to surface unsafe
 * lifecycle patterns early; electron-vite strips it in production builds.
 *
 * Import order:
 *   1. styles/globals.css  — Tailwind directives + base tokens (must come
 *                            first so class utilities override base resets).
 *   2. react / react-dom   — core runtime.
 *   3. App                 — root component (pulls in the Zustand store).
 */

import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@fontsource-variable/bricolage-grotesque';
import './styles/globals.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error(
    '[Easel] Mount failed: #root element not found in index.html. ' +
      'Verify that index.html contains <div id="root"></div>.',
  );
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
