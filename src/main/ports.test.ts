/**
 * Tests for free-port discovery (`src/main/ports.ts`).
 */

import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import { isPortFree, findFreePort } from './ports';

/** Bind a listener on `port` (0 = OS-assigned) and resolve once it's up. */
function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe('isPortFree', () => {
  const servers: net.Server[] = [];
  afterEach(async () => {
    while (servers.length) await close(servers.pop()!);
  });

  it('is false for a port that is in use', async () => {
    const server = await occupy(0);
    servers.push(server);
    const port = (server.address() as net.AddressInfo).port;
    expect(await isPortFree(port)).toBe(false);
  });

  it('is true again after the holder closes', async () => {
    const server = await occupy(0);
    const port = (server.address() as net.AddressInfo).port;
    expect(await isPortFree(port)).toBe(false);
    await close(server);
    expect(await isPortFree(port)).toBe(true);
  });
});

describe('findFreePort', () => {
  it('skips an occupied port and returns the next free one', async () => {
    // Grab a concrete free port, then hold it and ask findFreePort to start there.
    const taken = await findFreePort(3000);
    const holder = await occupy(taken);
    try {
      const next = await findFreePort(taken);
      expect(next).toBeGreaterThan(taken);
      expect(await isPortFree(next)).toBe(true);
    } finally {
      await close(holder);
    }
  });

  it('returns the start port when it is free', async () => {
    const port = await findFreePort(3000);
    expect(port).toBeGreaterThanOrEqual(3000);
    expect(await isPortFree(port)).toBe(true);
  });
});
