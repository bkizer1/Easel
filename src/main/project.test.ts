import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// project.ts imports electron + the window module at load time; stub them so the
// pure detection helper can be imported and tested under Node.
vi.mock('electron', () => ({ app: { getPath: () => tmpdir() }, dialog: {} }));
vi.mock('@main/window', () => ({ getMainWindow: () => null }));

import { inferDevServerUrl } from './project';

function withTempDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'easel-proj-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(dir, name), content);
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('inferDevServerUrl', () => {
  it('reads server.port from the vite config (the demo-app regression)', () => {
    withTempDir({ 'vite.config.ts': 'export default { server: { port: 3000 } };' }, (dir) => {
      expect(inferDevServerUrl(dir, 'vite-react', null)).toBe('http://localhost:3000');
    });
  });

  it('prefers an explicit --port in the dev script over the config', () => {
    withTempDir({ 'vite.config.ts': 'export default { server: { port: 3000 } };' }, (dir) => {
      const pkg = { scripts: { dev: 'vite --port 4321' } };
      expect(inferDevServerUrl(dir, 'vite-react', pkg)).toBe('http://localhost:4321');
    });
  });

  it('falls back to the framework default when nothing is configured', () => {
    withTempDir({}, (dir) => {
      expect(inferDevServerUrl(dir, 'vite-react', null)).toBe('http://localhost:5173');
      expect(inferDevServerUrl(dir, 'next', null)).toBe('http://localhost:3000');
    });
  });
});
