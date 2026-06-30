/**
 * Tests for buildReplaySteps — pure timeline derivation.
 * Node env, no DOM/jsdom. Run via `vitest run`.
 */

import { describe, it, expect } from 'vitest';
import { buildReplaySteps } from './sessionTimeline';
import type { EaselBundleManifest } from '@shared/types';

/** Minimal manifest factory so tests stay concise. */
function makeManifest(
  overrides: Partial<EaselBundleManifest> = {},
): EaselBundleManifest {
  return {
    schemaVersion: 1,
    easelVersion: '0.4.0',
    exportedAt: Date.now(),
    session: {
      projectName: 'test-project',
      framework: 'vite-react',
      devServerUrl: 'http://localhost:3000',
    },
    chat: [],
    checkpoints: [],
    checkpointRef: 'refs/easel/checkpoint',
    shots: [],
    ...overrides,
  };
}

describe('buildReplaySteps', () => {
  it('returns an empty array for an empty manifest', () => {
    const steps = buildReplaySteps(makeManifest());
    expect(steps).toEqual([]);
  });

  it('produces one step per checkpoint ordered oldest-first', () => {
    const manifest = makeManifest({
      checkpoints: [
        {
          id: 'cp-b',
          commitSha: 'sha-b',
          message: 'second',
          createdAt: 2000,
          changedFiles: [],
        },
        {
          id: 'cp-a',
          commitSha: 'sha-a',
          message: 'first',
          createdAt: 1000,
          changedFiles: [],
        },
      ],
    });

    const steps = buildReplaySteps(manifest);

    expect(steps).toHaveLength(2);
    expect(steps[0].checkpoint.id).toBe('cp-a');
    expect(steps[1].checkpoint.id).toBe('cp-b');
  });

  it('correlates assistantMessage by checkpointId', () => {
    const manifest = makeManifest({
      checkpoints: [
        { id: 'cp-1', commitSha: 'sha-1', message: 'edit', createdAt: 1000, changedFiles: [] },
      ],
      chat: [
        {
          id: 'msg-user',
          role: 'user',
          content: 'Make it blue',
          createdAt: 900,
          requestId: 'req-1',
        },
        {
          id: 'msg-asst',
          role: 'assistant',
          content: 'Changed color to blue',
          createdAt: 1100,
          requestId: 'req-1',
          checkpointId: 'cp-1',
        },
      ],
    });

    const steps = buildReplaySteps(manifest);
    expect(steps[0].assistantMessage?.id).toBe('msg-asst');
  });

  it('correlates userMessage by requestId', () => {
    const manifest = makeManifest({
      checkpoints: [
        {
          id: 'cp-1',
          commitSha: 'sha-1',
          message: 'edit',
          createdAt: 1000,
          changedFiles: [],
          requestId: 'req-1',
        },
      ],
      chat: [
        {
          id: 'msg-user',
          role: 'user',
          content: 'Make it blue',
          createdAt: 900,
          requestId: 'req-1',
        },
        {
          id: 'msg-asst',
          role: 'assistant',
          content: 'Done',
          createdAt: 1100,
          requestId: 'req-1',
          checkpointId: 'cp-1',
        },
      ],
    });

    const steps = buildReplaySteps(manifest);
    expect(steps[0].userMessage?.id).toBe('msg-user');
  });

  it('leaves userMessage and assistantMessage undefined when no correlation', () => {
    const manifest = makeManifest({
      checkpoints: [
        { id: 'cp-orphan', commitSha: 'sha-x', message: 'initial', createdAt: 500, changedFiles: [] },
      ],
      chat: [
        {
          id: 'msg-unrelated',
          role: 'assistant',
          content: 'Unrelated',
          createdAt: 600,
          // checkpointId does NOT match cp-orphan
          checkpointId: 'cp-other',
        },
      ],
    });

    const steps = buildReplaySteps(manifest);
    expect(steps[0].userMessage).toBeUndefined();
    expect(steps[0].assistantMessage).toBeUndefined();
  });

  it('does not correlate userMessage when checkpoint has no requestId', () => {
    const manifest = makeManifest({
      checkpoints: [
        // requestId intentionally absent (initial snapshot checkpoint)
        { id: 'cp-init', commitSha: 'sha-0', message: 'init', createdAt: 100, changedFiles: [] },
      ],
      chat: [
        {
          id: 'msg-user',
          role: 'user',
          content: 'Start',
          createdAt: 50,
          requestId: 'some-req',
        },
      ],
    });

    const steps = buildReplaySteps(manifest);
    expect(steps[0].userMessage).toBeUndefined();
  });

  it('correlates multiple checkpoints with their respective messages', () => {
    const manifest = makeManifest({
      checkpoints: [
        {
          id: 'cp-1',
          commitSha: 'sha-1',
          message: 'first',
          createdAt: 1000,
          changedFiles: [],
          requestId: 'req-1',
        },
        {
          id: 'cp-2',
          commitSha: 'sha-2',
          message: 'second',
          createdAt: 2000,
          changedFiles: [],
          requestId: 'req-2',
        },
      ],
      chat: [
        {
          id: 'u1',
          role: 'user',
          content: 'First instruction',
          createdAt: 900,
          requestId: 'req-1',
        },
        {
          id: 'a1',
          role: 'assistant',
          content: 'First done',
          createdAt: 1100,
          checkpointId: 'cp-1',
        },
        {
          id: 'u2',
          role: 'user',
          content: 'Second instruction',
          createdAt: 1900,
          requestId: 'req-2',
        },
        {
          id: 'a2',
          role: 'assistant',
          content: 'Second done',
          createdAt: 2100,
          checkpointId: 'cp-2',
        },
      ],
    });

    const steps = buildReplaySteps(manifest);
    expect(steps).toHaveLength(2);
    expect(steps[0].userMessage?.id).toBe('u1');
    expect(steps[0].assistantMessage?.id).toBe('a1');
    expect(steps[1].userMessage?.id).toBe('u2');
    expect(steps[1].assistantMessage?.id).toBe('a2');
  });
});
