/**
 * Tests for the dependency-free ZIP reader/writer (`src/main/zip.ts`).
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, unzipSync, crc32, type ZipEntry } from './zip';

describe('crc32', () => {
  it('matches the well-known CRC-32 for a canonical input', () => {
    const buf = Buffer.from('The quick brown fox jumps over the lazy dog');
    // Standard reference value (ISO-HDLC CRC-32) for this exact string.
    expect(crc32(buf)).toBe(0x414fa339);
  });

  it('is 0 for the empty buffer', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe('zipSync / unzipSync round-trip', () => {
  it('round-trips multiple text + binary entries', () => {
    const entries: ZipEntry[] = [
      { name: 'manifest.json', data: Buffer.from('{"schemaVersion":1}', 'utf8') },
      { name: 'nested/dir/file.txt', data: Buffer.from('hello world', 'utf8') },
      { name: 'bin.dat', data: Buffer.from([0, 1, 2, 3, 255, 254, 128, 0]) },
    ];
    const zip = zipSync(entries);
    const out = unzipSync(zip);

    expect(out.size).toBe(3);
    for (const e of entries) {
      expect(out.get(e.name)?.equals(e.data)).toBe(true);
    }
  });

  it('round-trips a highly-compressible entry (deflate path)', () => {
    const data = Buffer.from('A'.repeat(50_000), 'utf8');
    const out = unzipSync(zipSync([{ name: 'big.txt', data }]));
    expect(out.get('big.txt')?.equals(data)).toBe(true);
    // Deflate should make the archive far smaller than the raw data.
    expect(zipSync([{ name: 'big.txt', data }]).length).toBeLessThan(data.length);
  });

  it('round-trips an incompressible entry (stored fallback)', () => {
    // Pseudo-random-ish bytes won't deflate smaller, exercising the STORE path.
    const data = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 31 + 7) % 256));
    const out = unzipSync(zipSync([{ name: 'noise.bin', data }]));
    expect(out.get('noise.bin')?.equals(data)).toBe(true);
  });

  it('round-trips an empty entry', () => {
    const out = unzipSync(zipSync([{ name: 'empty', data: Buffer.alloc(0) }]));
    expect(out.get('empty')?.length).toBe(0);
  });

  it('is deterministic for identical input', () => {
    const entries: ZipEntry[] = [{ name: 'a.txt', data: Buffer.from('same') }];
    expect(zipSync(entries).equals(zipSync(entries))).toBe(true);
  });
});

describe('unzipSync error handling', () => {
  it('throws on non-ZIP bytes', () => {
    expect(() => unzipSync(Buffer.from('not a zip at all'))).toThrow(/ZIP/);
  });

  it('throws on a CRC mismatch (corrupted data)', () => {
    const zip = zipSync([{ name: 'x.txt', data: Buffer.from('original content here') }]);
    // Flip a byte inside the compressed/stored data region (well after the
    // local header + name, before the central directory).
    const corrupt = Buffer.from(zip);
    corrupt[40] = corrupt[40] ^ 0xff;
    expect(() => unzipSync(corrupt)).toThrow();
  });
});

describe('interoperability with the system unzip', () => {
  it('produces an archive the OS `unzip` can list', () => {
    let hasUnzip = true;
    try {
      execFileSync('unzip', ['-v'], { stdio: 'ignore' });
    } catch {
      hasUnzip = false;
    }
    if (!hasUnzip) return; // environment without unzip — skip silently

    const dir = mkdtempSync(join(tmpdir(), 'easel-zip-'));
    try {
      const zip = zipSync([
        { name: 'manifest.json', data: Buffer.from('{"ok":true}', 'utf8') },
        { name: 'shots/a/before.png', data: Buffer.from([1, 2, 3]) },
      ]);
      const p = join(dir, 'out.zip');
      writeFileSync(p, zip);
      const listing = execFileSync('unzip', ['-l', p], { encoding: 'utf8' });
      expect(listing).toContain('manifest.json');
      expect(listing).toContain('shots/a/before.png');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
