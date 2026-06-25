/**
 * Tests for per-checkpoint state-snapshot persistence (State X-Ray, issue #13).
 *
 * Exercises the real filesystem (electron `app` mocked to a throwaway temp dir)
 * so save → read → list → prune and the time-travel deep-diff are validated
 * end-to-end, not just in theory.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import { diffSerialized, type StateSnapshot } from '@shared/xray';

// Hoisted so the temp dir exists before the electron mock factory runs.
const { TMP } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fsm = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('node:path') as typeof import('node:path');
  return { TMP: fsm.mkdtempSync(path.join(os.tmpdir(), 'xray-snap-')) };
});

vi.mock('electron', () => ({ app: { getPath: () => TMP } }));

import { saveSnapshot, getSnapshot, listSnapshots } from '@main/stateSnapshots';

function mk(id: string, val: number): StateSnapshot {
  return {
    checkpointId: id,
    capturedAt: 1_700_000_000_000,
    label: `cp ${id}`,
    data: {
      kind: 'object',
      truncated: false,
      entries: [{ key: 'count', value: { kind: 'number', value: val } }],
    },
  };
}

describe('stateSnapshots persistence', () => {
  beforeEach(() => {
    // Start each test from an empty snapshot dir.
    fs.rmSync(`${TMP}/xray-snapshots`, { recursive: true, force: true });
  });

  it('saves and reads a snapshot back', () => {
    saveSnapshot(mk('aaa11111', 1));
    const got = getSnapshot('aaa11111');
    expect(got?.checkpointId).toBe('aaa11111');
    expect(got?.label).toBe('cp aaa11111');
  });

  it('returns null for a missing checkpoint', () => {
    expect(getSnapshot('does-not-exist')).toBeNull();
  });

  it('lists checkpoint ids that have a snapshot', () => {
    saveSnapshot(mk('aaa11111', 1));
    saveSnapshot(mk('bbb22222', 2));
    expect(listSnapshots().sort()).toEqual(['aaa11111', 'bbb22222']);
  });

  it('refuses to save without a checkpointId', () => {
    saveSnapshot({ ...mk('', 1) });
    expect(listSnapshots()).toEqual([]);
  });

  it('feeds the time-travel deep-diff between two checkpoints', () => {
    saveSnapshot(mk('aaa11111', 1));
    saveSnapshot(mk('bbb22222', 2));
    const a = getSnapshot('aaa11111');
    const b = getSnapshot('bbb22222');
    expect(diffSerialized(a!.data, b!.data)).toEqual([
      { path: 'count', kind: 'changed', before: '1', after: '2' },
    ]);
  });

  it('prunes oldest snapshots past the retention cap', () => {
    for (let i = 0; i < 60; i++) saveSnapshot(mk('c' + String(i).padStart(7, '0'), i));
    expect(listSnapshots().length).toBeLessThanOrEqual(50);
  });
});
