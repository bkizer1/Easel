import { describe, it, expect } from 'vitest';
import {
  buildJudgePrompt,
  parseJudgeResult,
  runVisionJudge,
  type VisionClient,
} from './visionJudge';

/** A 1×1 transparent PNG, enough to exercise the data-URL → image-block path. */
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAA==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';

type Block = Record<string, unknown>;
function blocks(prompt: ReturnType<typeof buildJudgePrompt>): Block[] {
  return prompt.messages[0].content as unknown as Block[];
}

describe('buildJudgePrompt', () => {
  it('embeds the instruction text verbatim', () => {
    const prompt = buildJudgePrompt('make the heading bigger', PNG, PNG);
    const texts = blocks(prompt)
      .filter((b) => b['type'] === 'text')
      .map((b) => b['text'] as string)
      .join('\n');
    expect(texts).toContain('make the heading bigger');
  });

  it('includes both before and after image blocks with parsed media type + data', () => {
    const prompt = buildJudgePrompt('x', PNG, JPEG);
    const images = blocks(prompt).filter((b) => b['type'] === 'image');
    expect(images).toHaveLength(2);
    const before = images[0]['source'] as Record<string, unknown>;
    const after = images[1]['source'] as Record<string, unknown>;
    expect(before).toMatchObject({ type: 'base64', media_type: 'image/png' });
    expect(before['data']).toBe(PNG.split(',')[1]);
    expect(after).toMatchObject({ type: 'base64', media_type: 'image/jpeg' });
  });

  it('omits the before block when no before frame is given', () => {
    const prompt = buildJudgePrompt('x', undefined, PNG);
    const images = blocks(prompt).filter((b) => b['type'] === 'image');
    expect(images).toHaveLength(1);
  });

  it('skips a malformed data URL rather than emitting a broken block', () => {
    const prompt = buildJudgePrompt('x', 'not-a-data-url', 'also-bad');
    const images = blocks(prompt).filter((b) => b['type'] === 'image');
    expect(images).toHaveLength(0);
    // The instruction + question text blocks still exist.
    expect(blocks(prompt).filter((b) => b['type'] === 'text').length).toBeGreaterThanOrEqual(2);
  });

  it('skips media types the Anthropic vision API rejects, e.g. svg (issue #13)', () => {
    const svg = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
    const prompt = buildJudgePrompt('x', undefined, svg);
    expect(blocks(prompt).filter((b) => b['type'] === 'image')).toHaveLength(0);
  });

  it('accepts the supported types (png, jpeg)', () => {
    for (const dataUrl of [PNG, JPEG]) {
      const prompt = buildJudgePrompt('x', undefined, dataUrl);
      expect(blocks(prompt).filter((b) => b['type'] === 'image')).toHaveLength(1);
    }
  });

  it('always asks for a JSON-only reply in the system prompt', () => {
    const prompt = buildJudgePrompt('x', PNG, PNG);
    expect(prompt.system).toMatch(/json/i);
    expect(prompt.system).toMatch(/verdict/i);
  });
});

describe('parseJudgeResult', () => {
  it('parses a well-formed pass verdict with confidence', () => {
    const v = parseJudgeResult('{"verdict":"pass","rationale":"looks right","confidence":0.92}');
    expect(v).toEqual({ verdict: 'pass', rationale: 'looks right', confidence: 0.92 });
  });

  it('parses a fail verdict', () => {
    const v = parseJudgeResult('{"verdict":"fail","rationale":"nothing changed"}');
    expect(v).toEqual({ verdict: 'fail', rationale: 'nothing changed' });
  });

  it('extracts JSON embedded in prose / a markdown code fence', () => {
    const raw = 'Here is my assessment:\n```json\n{"verdict":"pass","rationale":"ok"}\n```\nDone.';
    expect(parseJudgeResult(raw)).toEqual({ verdict: 'pass', rationale: 'ok' });
  });

  it('extracts the first complete object even when trailed by prose with braces (issue #5)', () => {
    const raw = '{"verdict":"fail","rationale":"unchanged"}\n\nNote: try margin {e.g. 16px}.';
    expect(parseJudgeResult(raw)).toEqual({ verdict: 'fail', rationale: 'unchanged' });
  });

  it('is unfazed by braces inside string values', () => {
    expect(parseJudgeResult('{"verdict":"pass","rationale":"use {token} syntax"}')).toEqual({
      verdict: 'pass',
      rationale: 'use {token} syntax',
    });
  });

  it('clamps an out-of-range confidence into [0, 1]', () => {
    expect(parseJudgeResult('{"verdict":"pass","rationale":"a","confidence":4}')?.confidence).toBe(1);
    expect(parseJudgeResult('{"verdict":"fail","rationale":"a","confidence":-2}')?.confidence).toBe(0);
  });

  it('omits confidence when absent or non-numeric', () => {
    expect(parseJudgeResult('{"verdict":"pass","rationale":"a"}')?.confidence).toBeUndefined();
    expect(
      parseJudgeResult('{"verdict":"pass","rationale":"a","confidence":"high"}')?.confidence,
    ).toBeUndefined();
  });

  it('defaults rationale to an empty string when missing', () => {
    expect(parseJudgeResult('{"verdict":"pass"}')).toEqual({ verdict: 'pass', rationale: '' });
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   \n  '],
    ['no JSON at all', 'the page looks fine to me'],
    ['malformed JSON', '{"verdict": "pass", rationale}'],
    ['truncated JSON', '{"verdict":"pass","rationale":"abc'],
    ['invalid verdict value', '{"verdict":"maybe","rationale":"a"}'],
    ['JSON array, not object', '["pass"]'],
    ['JSON null', 'null'],
  ])('returns null (never throws) for %s', (_label, input) => {
    expect(() => parseJudgeResult(input)).not.toThrow();
    expect(parseJudgeResult(input)).toBeNull();
  });
});

describe('runVisionJudge', () => {
  function stubClient(impl: VisionClient['messages']['create']): VisionClient {
    return { messages: { create: impl } };
  }

  it('returns the parsed verdict from the model reply', async () => {
    const client = stubClient(async () => ({
      content: [{ type: 'text', text: '{"verdict":"fail","rationale":"unchanged"}' }],
    }));
    const v = await runVisionJudge(client, buildJudgePrompt('x', PNG, PNG), { model: 'm' });
    expect(v).toEqual({ verdict: 'fail', rationale: 'unchanged' });
  });

  it('forwards model, system, messages and a default max_tokens to the client', async () => {
    let captured: Record<string, unknown> | undefined;
    const client = stubClient(async (params) => {
      captured = params;
      return { content: [{ type: 'text', text: '{"verdict":"pass","rationale":"ok"}' }] };
    });
    const prompt = buildJudgePrompt('do x', PNG, PNG);
    await runVisionJudge(client, prompt, { model: 'claude-opus-4-8' });
    expect(captured?.['model']).toBe('claude-opus-4-8');
    expect(captured?.['system']).toBe(prompt.system);
    expect(captured?.['messages']).toBe(prompt.messages);
    expect(typeof captured?.['max_tokens']).toBe('number');
  });

  it('is fail-open: returns null when the client throws', async () => {
    const client = stubClient(async () => {
      throw new Error('network down');
    });
    await expect(
      runVisionJudge(client, buildJudgePrompt('x', PNG, PNG), { model: 'm' }),
    ).resolves.toBeNull();
  });

  it('returns null when the reply carries no usable verdict', async () => {
    const client = stubClient(async () => ({ content: [{ type: 'text', text: 'no idea' }] }));
    const v = await runVisionJudge(client, buildJudgePrompt('x', PNG, PNG), { model: 'm' });
    expect(v).toBeNull();
  });
});
