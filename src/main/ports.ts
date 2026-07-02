/**
 * Easel — free-port discovery.
 *
 * New sites scaffold a Vite config with an explicit `server.port`. If that port
 * is already taken — e.g. the demo app, or another Easel project, is already
 * serving on it — two bad things happen:
 *   1. Easel's reachability probe (see `probe` in project.ts) sees *something*
 *      answering on that port and decides the dev server is "already running",
 *      so it never starts the new project and just shows whatever is there —
 *      the reported bug where creating a new project loaded the demo app.
 *   2. Vite itself, without `strictPort`, silently picks the next free port and
 *      desyncs from Easel's `devServerUrl`.
 *
 * So at create-time we pick a port nothing is currently listening on.
 */

import net from 'node:net';

/**
 * Resolve `true` if `port` on `host` is free to bind, `false` if it's in use.
 * We bind a throwaway server rather than probing over HTTP: binding detects a
 * port held by *any* process (even one that doesn't answer HTTP), and binding
 * 127.0.0.1 fails with EADDRINUSE even when the holder bound 0.0.0.0.
 */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false)); // EADDRINUSE / EACCES → taken.
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

/**
 * Find a free port, scanning upward from `start`. Returns the first port in
 * `[start, start + range)` that nothing is listening on. Falls back to an
 * OS-assigned ephemeral port if the whole range is busy (never throws).
 */
export async function findFreePort(start = 3000, range = 100): Promise<number> {
  for (let port = start; port < start + range; port++) {
    if (await isPortFree(port)) return port;
  }
  return ephemeralPort();
}

/** Ask the OS for any free port by binding to 0 and reading it back. */
function ephemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error('No free port available'))));
    });
  });
}
