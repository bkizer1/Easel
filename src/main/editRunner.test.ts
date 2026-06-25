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
  respondPolicyConfirm,
  type WriteGate,
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
