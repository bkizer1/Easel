import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEvent, AppSettings, EditRequest, ElementTarget } from '@shared/types';
import type { LoadedPolicy } from './policy';

// editRunner pulls in the main window for event push; stub it for Node tests.
vi.mock('@main/window', () => ({ getMainWindow: () => null }));

import {
  buildProjectFs,
  buildProvenance,
  createWriteGate,
  isDegenerateCrop,
  pollUntilStable,
  respondPolicyConfirm,
  runVerifyStep,
  type WriteGate,
  type VerifyFn,
} from './editRunner';

const tmpDirs: string[] = [];
function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'easel-runner-'));
  tmpDirs.push(dir);
  return dir;
}
beforeEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

/** A gate stub that always returns a fixed verdict. */
function fixedGate(verdict: { allow: boolean; reason?: string }): WriteGate {
  return { check: async () => verdict };
}

const filePolicy = (policy: LoadedPolicy['policy']): LoadedPolicy => ({ policy, source: 'file' });

describe('buildProjectFs guardrail enforcement', () => {
  it('blocks a denied write and leaves no file on disk (acceptance: .env is blocked)', async () => {
    const dir = projectDir();
    const pfs = buildProjectFs(dir, fixedGate({ allow: false, reason: 'denied by policy' }));

    await expect(pfs.writeFile('.env', 'SECRET=1')).rejects.toThrow(/denied by policy/);
    expect(existsSync(join(dir, '.env'))).toBe(false);
  });

  it('allows a permitted write through to disk', async () => {
    const dir = projectDir();
    const pfs = buildProjectFs(dir, fixedGate({ allow: true }));

    await pfs.writeFile('src/App.tsx', 'export const App = () => null;');
    expect(existsSync(join(dir, 'src/App.tsx'))).toBe(true);
  });

  it('also enforces the gate on binary writes', async () => {
    const dir = projectDir();
    const pfs = buildProjectFs(dir, fixedGate({ allow: false, reason: 'no images' }));

    await expect(pfs.writeBinary('public/x.png', new Uint8Array([1, 2]))).rejects.toThrow(/no images/);
    expect(existsSync(join(dir, 'public/x.png'))).toBe(false);
  });

  it('still rejects path traversal before consulting the gate', async () => {
    const dir = projectDir();
    const pfs = buildProjectFs(dir, fixedGate({ allow: true }));
    await expect(pfs.writeFile('../escape.txt', 'x')).rejects.toThrow(/traversal/i);
  });
});

describe('createWriteGate decisions', () => {
  function setup(policy: LoadedPolicy['policy']) {
    const events: AgentEvent[] = [];
    const controller = new AbortController();
    const gate = createWriteGate({
      loaded: filePolicy(policy),
      requestId: 'req-1',
      signal: controller.signal,
      emit: (e) => events.push(e),
    });
    return { gate, events, controller };
  }

  it('allows ordinary files and denies deny-rule matches with a policy-blocked warning', async () => {
    const { gate, events } = setup({ deny: ['**/.env*'], requireConfirm: [] });

    expect(await gate.check('src/App.tsx')).toEqual({ allow: true });

    const verdict = await gate.check('.env');
    expect(verdict.allow).toBe(false);
    expect(events.some((e) => e.type === 'warning' && e.code === 'policy-blocked' && e.path === '.env')).toBe(true);
  });

  it('pauses requireConfirm writes until the user allows once', async () => {
    const { gate, events } = setup({ deny: [], requireConfirm: ['package.json'] });

    const pending = gate.check('package.json');
    // The confirm warning is emitted synchronously before resolution.
    await Promise.resolve();
    const confirmEvent = events.find((e) => e.type === 'warning' && e.code === 'policy-confirm');
    expect(confirmEvent).toBeTruthy();

    respondPolicyConfirm('req-1', 'package.json', true);
    expect(await pending).toEqual({ allow: true });

    // A second write to the same path is not re-prompted.
    const before = events.length;
    expect(await gate.check('package.json')).toEqual({ allow: true });
    expect(events.length).toBe(before);
  });

  it('denies a requireConfirm write when the user declines', async () => {
    const { gate, events } = setup({ deny: [], requireConfirm: ['package.json'] });

    const pending = gate.check('package.json');
    respondPolicyConfirm('req-1', 'package.json', false);
    const verdict = await pending;
    expect(verdict.allow).toBe(false);
    expect(events.some((e) => e.type === 'warning' && e.code === 'policy-blocked')).toBe(true);
  });

  it('treats an aborted edit as a denial for a pending confirm', async () => {
    const { gate, controller } = setup({ deny: [], requireConfirm: ['package.json'] });
    const pending = gate.check('package.json');
    controller.abort();
    expect((await pending).allow).toBe(false);
  });

  it('enforces the blast-radius cap across multiple writes', async () => {
    const { gate } = setup({ deny: [], requireConfirm: [], maxFilesPerEdit: 2 });
    expect((await gate.check('a.ts')).allow).toBe(true);
    expect((await gate.check('b.ts')).allow).toBe(true);
    expect((await gate.check('c.ts')).allow).toBe(false);
    // Re-writing an already-counted file is still allowed (not a new file).
    expect((await gate.check('a.ts')).allow).toBe(true);
  });
});

describe('buildProvenance', () => {
  const settings = { model: 'claude-opus-4-8', agentBackend: 'claude-agent-sdk' } as AppSettings;

  function target(over: Partial<ElementTarget>): ElementTarget {
    return {
      id: 't1',
      selector: 'div#root',
      tagName: 'div',
      boundingBox: { x: 0, y: 0, width: 1, height: 1 },
      textSnippet: '',
      attributes: {},
      pluginPresent: false,
      confidence: 'high',
      ...over,
    };
  }

  function request(targets: ElementTarget[]): EditRequest {
    return {
      id: 'req-1',
      instruction: 'Do the thing',
      annotations: [],
      targets,
      projectRoot: '/proj',
      devServerUrl: 'http://localhost:3000',
    };
  }

  it('maps instruction/model/backend and the latest confidence', () => {
    const p = buildProvenance(request([]), settings, 'medium');
    expect(p.instruction).toBe('Do the thing');
    expect(p.model).toBe('claude-opus-4-8');
    expect(p.backend).toBe('claude-agent-sdk');
    expect(p.confidence).toBe('medium');
  });

  it('derives Easel-Target selectors and Easel-Source file:line from targets', () => {
    const p = buildProvenance(
      request([
        target({ selector: 'h1.hero', dataEaselSource: { filePath: 'src/Hero.tsx', line: 12, column: 3 } }),
        target({ selector: 'button#cta' }), // no data-easel-source → no source entry
      ]),
      settings,
      undefined,
    );
    expect(p.targets).toEqual(['h1.hero', 'button#cta']);
    expect(p.sources).toEqual(['src/Hero.tsx:12']);
    expect(p.confidence).toBeUndefined(); // omitted when not reported
  });

  it('omits targets/sources entirely when there are no element targets', () => {
    const p = buildProvenance(request([]), settings, undefined);
    expect(p.targets).toBeUndefined();
    expect(p.sources).toBeUndefined();
  });
});

describe('runVerifyStep (issue #16 self-heal verify)', () => {
  function settingsWith(selfHealVerify: boolean): AppSettings {
    return { featureFlags: { selfHealVerify } } as AppSettings;
  }
  function req(): EditRequest {
    return { id: 'req-9', instruction: 'make it pop' } as EditRequest;
  }
  /** Collect emitted events for assertions. */
  function collector(): { emit: (e: AgentEvent) => void; events: AgentEvent[] } {
    const events: AgentEvent[] = [];
    return { emit: (e) => events.push(e), events };
  }

  it('emits a single verify event carrying the judge verdict + rationale', async () => {
    const { emit, events } = collector();
    const verify: VerifyFn = async () => ({ verdict: 'pass', rationale: 'looks good' });
    await runVerifyStep({
      request: req(),
      settings: settingsWith(true),
      before: 'data:before',
      after: 'data:after',
      verify,
      emit,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'verify',
      requestId: 'req-9',
      verdict: 'pass',
      rationale: 'looks good',
    });
  });

  it('carries the judge confidence through when present, omits it otherwise', async () => {
    const withConf = collector();
    await runVerifyStep({
      request: req(),
      settings: settingsWith(true),
      before: undefined,
      after: 'data:after',
      verify: async () => ({ verdict: 'fail', rationale: 'no change', confidence: 0.4 }),
      emit: withConf.emit,
    });
    expect(withConf.events[0]).toMatchObject({ verdict: 'fail', confidence: 0.4 });

    const noConf = collector();
    await runVerifyStep({
      request: req(),
      settings: settingsWith(true),
      before: undefined,
      after: 'data:after',
      verify: async () => ({ verdict: 'fail', rationale: 'no change' }),
      emit: noConf.emit,
    });
    expect('confidence' in (noConf.events[0] as Record<string, unknown>)).toBe(false);
  });

  it('passes the instruction, before/after frames, and the abort signal to the judge', async () => {
    let seen: Parameters<VerifyFn>[0] | undefined;
    const verify: VerifyFn = async (input) => {
      seen = input;
      return { verdict: 'pass', rationale: 'ok' };
    };
    const ctrl = new AbortController();
    await runVerifyStep({
      request: req(),
      settings: settingsWith(true),
      before: 'data:b',
      after: 'data:a',
      verify,
      emit: () => {},
      signal: ctrl.signal,
    });
    expect(seen).toMatchObject({ instruction: 'make it pop', before: 'data:b', after: 'data:a' });
    expect(seen?.signal).toBe(ctrl.signal);
  });

  it('skips the judge entirely when the signal is already aborted', async () => {
    const { emit, events } = collector();
    let called = false;
    const verify: VerifyFn = async () => {
      called = true;
      return { verdict: 'pass', rationale: 'x' };
    };
    const ctrl = new AbortController();
    ctrl.abort();
    await runVerifyStep({
      request: req(),
      settings: settingsWith(true),
      before: 'b',
      after: 'a',
      verify,
      emit,
      signal: ctrl.signal,
    });
    expect(called).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('is gated: emits nothing when the feature flag is off (and never calls the judge)', async () => {
    const { emit, events } = collector();
    let called = false;
    const verify: VerifyFn = async () => {
      called = true;
      return { verdict: 'pass', rationale: 'x' };
    };
    await runVerifyStep({
      request: req(),
      settings: settingsWith(false),
      before: 'b',
      after: 'a',
      verify,
      emit,
    });
    expect(called).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('emits nothing when no judge is injected', async () => {
    const { emit, events } = collector();
    await runVerifyStep({
      request: req(),
      settings: settingsWith(true),
      before: 'b',
      after: 'a',
      verify: undefined,
      emit,
    });
    expect(events).toHaveLength(0);
  });

  it('emits nothing and never calls the judge when no after frame was captured', async () => {
    const { emit, events } = collector();
    let called = false;
    const verify: VerifyFn = async () => {
      called = true;
      return { verdict: 'pass', rationale: 'x' };
    };
    await runVerifyStep({
      request: req(),
      settings: settingsWith(true),
      before: 'b',
      after: undefined,
      verify,
      emit,
    });
    expect(called).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('fails open: a throwing judge emits nothing and does not reject', async () => {
    const { emit, events } = collector();
    const verify: VerifyFn = async () => {
      throw new Error('judge exploded');
    };
    await expect(
      runVerifyStep({
        request: req(),
        settings: settingsWith(true),
        before: 'b',
        after: 'a',
        verify,
        emit,
      }),
    ).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });

  it('stays silent when the judge returns null (no verdict)', async () => {
    const { emit, events } = collector();
    await runVerifyStep({
      request: req(),
      settings: settingsWith(true),
      before: 'b',
      after: 'a',
      verify: async () => null,
      emit,
    });
    expect(events).toHaveLength(0);
  });
});

describe('pollUntilStable (issue #33 poll-until-stable settle)', () => {
  /**
   * A `capture` driven by a fixed sequence; once exhausted it keeps yielding the
   * last value (so a never-stabilizing sequence still terminates by maxWait).
   */
  function sequenceCapture(seq: Array<string | undefined>): {
    capture: () => Promise<string | undefined>;
    calls: () => number;
  } {
    let i = 0;
    return {
      capture: async () => seq[Math.min(i++, seq.length - 1)],
      calls: () => i,
    };
  }

  /** A fake sleep that records how many times (and how long) it was called. */
  function countingSleep(): { sleep: (ms: number) => Promise<void>; count: () => number; total: () => number } {
    let count = 0;
    let total = 0;
    return {
      sleep: async (ms) => {
        count++;
        total += ms;
      },
      count: () => count,
      total: () => total,
    };
  }

  it('returns early once two consecutive captures are byte-identical', async () => {
    const cap = sequenceCapture(['a', 'b', 'b', 'c']);
    const slp = countingSleep();
    const result = await pollUntilStable({
      capture: cap.capture,
      sleep: slp.sleep,
      intervalMs: 150,
      maxWaitMs: 2500,
    });
    // 'a' (initial), sleep, 'b', sleep, 'b' === previous ⇒ stop and return 'b'.
    expect(result).toBe('b');
    // Two sleeps before stability; it did NOT run out the full budget.
    expect(slp.count()).toBe(2);
    expect(cap.calls()).toBe(3);
  });

  it('honors maxWaitMs when frames never stabilize', async () => {
    // Every frame differs ⇒ never stable; loop must stop at the wall-time cap.
    const cap = sequenceCapture(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l']);
    const slp = countingSleep();
    const result = await pollUntilStable({
      capture: cap.capture,
      sleep: slp.sleep,
      intervalMs: 150,
      maxWaitMs: 600,
    });
    // 600 / 150 = 4 sleeps, then elapsed reaches the cap and we return the last.
    expect(slp.count()).toBe(4);
    expect(slp.total()).toBe(600);
    // Returns the most recent captured frame (initial + 4 captures = index 4 ⇒ 'e').
    expect(result).toBe('e');
  });

  it('tolerates intermittent undefined captures and keeps polling', async () => {
    // 'a', undefined (not stable), 'a' again — two undefineds in a row would NOT
    // be treated as stable; only equal DEFINED frames count.
    const cap = sequenceCapture(['a', undefined, 'a', 'a']);
    const slp = countingSleep();
    const result = await pollUntilStable({
      capture: cap.capture,
      sleep: slp.sleep,
      intervalMs: 150,
      maxWaitMs: 2500,
    });
    // 'a', undefined (reset), 'a', 'a' === previous ⇒ stop and return 'a'.
    expect(result).toBe('a');
    expect(slp.count()).toBe(3);
  });

  it('does not treat two consecutive undefined captures as stable', async () => {
    // All undefined until the cap; never short-circuits, returns undefined.
    const cap = sequenceCapture([undefined, undefined, undefined, undefined, undefined]);
    const slp = countingSleep();
    const result = await pollUntilStable({
      capture: cap.capture,
      sleep: slp.sleep,
      intervalMs: 100,
      maxWaitMs: 300,
    });
    expect(result).toBeUndefined();
    expect(slp.count()).toBe(3); // 300 / 100
  });

  it('never throws when capture rejects — treats it as undefined and falls back', async () => {
    let i = 0;
    const capture = async (): Promise<string | undefined> => {
      i++;
      if (i === 2) throw new Error('capture exploded');
      return 'a';
    };
    const slp = countingSleep();
    // 'a', (throw ⇒ undefined, resets), 'a', 'a' === previous ⇒ returns 'a'.
    const result = await pollUntilStable({
      capture,
      sleep: slp.sleep,
      intervalMs: 100,
      maxWaitMs: 2500,
    });
    expect(result).toBe('a');
  });
});

describe('isDegenerateCrop (issue #33 region-cropped verify frame)', () => {
  it('is true for a missing box', () => {
    expect(isDegenerateCrop(undefined)).toBe(true);
  });

  it('is true for zero or negative dimensions', () => {
    expect(isDegenerateCrop({ x: 10, y: 10, width: 0, height: 50 })).toBe(true);
    expect(isDegenerateCrop({ x: 10, y: 10, width: 50, height: 0 })).toBe(true);
    expect(isDegenerateCrop({ x: 10, y: 10, width: -5, height: 50 })).toBe(true);
    expect(isDegenerateCrop({ x: 10, y: 10, width: 50, height: -5 })).toBe(true);
  });

  it('is true for non-finite coordinates or extents', () => {
    expect(isDegenerateCrop({ x: NaN, y: 0, width: 10, height: 10 })).toBe(true);
    expect(isDegenerateCrop({ x: 0, y: 0, width: Infinity, height: 10 })).toBe(true);
  });

  it('is false for a sane in-bounds box', () => {
    expect(isDegenerateCrop({ x: 10, y: 20, width: 100, height: 80 })).toBe(false);
  });

  it('respects a viewport: out-of-bounds or off-screen boxes are degenerate', () => {
    const viewport = { x: 0, y: 0, width: 1000, height: 800 };
    // Sane and fully inside the viewport.
    expect(isDegenerateCrop({ x: 10, y: 20, width: 100, height: 80 }, viewport)).toBe(false);
    // Extends past the right/bottom edge.
    expect(isDegenerateCrop({ x: 950, y: 20, width: 100, height: 80 }, viewport)).toBe(true);
    expect(isDegenerateCrop({ x: 10, y: 760, width: 100, height: 80 }, viewport)).toBe(true);
    // Starts off-screen.
    expect(isDegenerateCrop({ x: -5, y: 20, width: 100, height: 80 }, viewport)).toBe(true);
  });
});
