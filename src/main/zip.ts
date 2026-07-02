/**
 * Easel — minimal, dependency-free ZIP reader/writer (Issue #18).
 *
 * The `.easel` session bundle is a ZIP archive: a JSON manifest, a `git bundle`
 * of the checkpoint ref, and per-checkpoint preview PNGs. Easel deliberately
 * keeps a tiny runtime dependency surface (it shells out to `git` rather than
 * pulling a git library), so rather than add a zip dependency we implement the
 * small slice of the ZIP format we need ourselves, in pure Node:
 *
 *  - DEFLATE compression via the built-in `zlib` (method 8), with a STORED
 *    (method 0) fallback so the reader also handles uncompressed entries.
 *  - A CRC-32 over each entry's uncompressed bytes (required by the format and
 *    validated on read).
 *  - Local file headers + a central directory + an end-of-central-directory
 *    record, so the archives we produce open in standard tools (`unzip`, Finder,
 *    Explorer) and remain inspectable.
 *
 * This is intentionally NOT a general ZIP implementation: no ZIP64, no
 * encryption, no multi-disk. It round-trips its own output and reads the simple
 * archives those tools produce, which is all the bundle pipeline requires.
 */

import zlib from 'node:zlib';

/** One file inside a ZIP archive. `name` uses forward slashes. */
export interface ZipEntry {
  /** Archive-relative path, e.g. `shots/ab12cd34/before.png`. */
  name: string;
  /** Raw uncompressed bytes. */
  data: Buffer;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** General-purpose bit 11: file name is UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
/**
 * A fixed DOS timestamp (1980-01-01 00:00:00) stamped on every entry. The
 * bundle carries its own `exportedAt` in the manifest, so per-entry mtimes add
 * nothing but non-determinism — pinning them keeps byte-identical output for a
 * given input, which makes the writer trivially testable.
 */
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/* -------------------------------------------------------------------------- */
/*  CRC-32                                                                      */
/* -------------------------------------------------------------------------- */

const CRC_TABLE: number[] = (() => {
  const table = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Compute the ZIP/PNG CRC-32 of a buffer. */
export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* -------------------------------------------------------------------------- */
/*  Writer                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Build a ZIP archive from the given entries. Each entry is DEFLATE-compressed
 * unless that would make it larger (e.g. already-compressed PNGs), in which case
 * it is STORED uncompressed.
 */
export function zipSync(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const uncompressedSize = entry.data.length;

    const deflated = zlib.deflateRawSync(entry.data);
    const useDeflate = deflated.length < uncompressedSize;
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    const body = useDeflate ? deflated : entry.data;
    const compressedSize = body.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    localParts.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const localBlock = Buffer.concat(localParts);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralDir.length, 12); // central dir size
  eocd.writeUInt32LE(localBlock.length, 16); // central dir offset
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([localBlock, centralDir, eocd]);
}

/* -------------------------------------------------------------------------- */
/*  Reader                                                                      */
/* -------------------------------------------------------------------------- */

/** Locate the End-Of-Central-Directory record by scanning backwards. */
function findEocd(buf: Buffer): number {
  // EOCD is 22 bytes with an optional trailing comment; scan from the latest
  // position it could start at back toward the front.
  const minStart = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= minStart; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/**
 * Parse a ZIP archive into a map of entry name -> uncompressed bytes. Throws on
 * a malformed archive or a CRC mismatch.
 */
export function unzipSync(buf: Buffer): Map<string, Buffer> {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a ZIP archive (no end-of-central-directory record)');

  const total = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16); // central directory offset

  const out = new Map<string, Buffer>();
  for (let i = 0; i < total; i++) {
    if (buf.readUInt32LE(ptr) !== CENTRAL_SIG) {
      throw new Error('Corrupt ZIP: bad central directory header');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const crc = buf.readUInt32LE(ptr + 16);
    const compressedSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);

    // Jump to the local header to find where the data actually starts (its
    // name/extra lengths can differ from the central directory's).
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
      throw new Error(`Corrupt ZIP: bad local header for ${name}`);
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(dataStart, dataStart + compressedSize);

    let data: Buffer;
    if (method === METHOD_STORE) {
      data = Buffer.from(body);
    } else if (method === METHOD_DEFLATE) {
      data = zlib.inflateRawSync(body);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }

    if (crc32(data) !== crc) {
      throw new Error(`Corrupt ZIP: CRC mismatch for ${name}`);
    }
    out.set(name, data);

    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return out;
}
