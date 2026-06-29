/**
 * Easel — self-heal vision judge (issue #16).
 *
 * After an edit settles, Easel re-captures the preview and asks a vision model
 * one question: *did the page actually end up the way the user asked?* This
 * module is the pure, backend-agnostic core of that judgment:
 *
 *  - {@link buildJudgePrompt} assembles the multimodal `messages.create` payload
 *    (instruction text + before/after image blocks). Pure; no IO.
 *  - {@link parseJudgeResult} parses the model's constrained JSON reply into a
 *    {@link VisionVerdict}. It NEVER throws and returns `null` on any malformed
 *    output, so a confused model can never fabricate a misleading verdict.
 *  - {@link runVisionJudge} calls an injected Anthropic-style client and parses
 *    the reply. It is fail-open: any error (network, SDK, parse) yields `null`,
 *    never an exception — the verify step is a non-essential aid and must never
 *    disrupt the edit it follows.
 *
 * The client is passed in (see {@link VisionClient}) so this is fully unit
 * testable with a stub — no real network and no bundled-SDK dependency here.
 */

import type { VisionVerdict, VerifyVerdict } from '@shared/types';

/** An Anthropic-style multimodal content block (text or base64 image). */
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/** The shape consumed by {@link runVisionJudge} / an Anthropic `messages.create`. */
export interface JudgePrompt {
  system: string;
  messages: Array<{ role: 'user'; content: ContentBlock[] }>;
}

/** The minimal slice of an Anthropic client {@link runVisionJudge} needs. */
export interface VisionClient {
  messages: {
    create: (
      params: Record<string, unknown>,
      opts?: { signal?: AbortSignal },
    ) => Promise<unknown>;
  };
}

const JUDGE_SYSTEM = [
  'You are a meticulous visual QA reviewer for a web-development tool.',
  'You are shown the page BEFORE and AFTER an automated code edit, plus the change the user requested.',
  'Judge ONLY whether the AFTER screenshot satisfies the requested change. Ignore unrelated content.',
  'Be strict: if the requested change is not clearly visible in AFTER, the verdict is "fail".',
  'Reply with ONLY a single JSON object and nothing else:',
  '{"verdict":"pass"|"fail","rationale":"<one concise sentence>","confidence":<number 0-1>}',
].join('\n');

/** The image media types the Anthropic vision API accepts. */
const SUPPORTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * Convert a `data:` URL (as produced by `capturePreview`) into an Anthropic
 * base64 image block. Returns `null` when the string is not a base64 image URL
 * or carries a media type the vision API would reject (so we never build a block
 * the API is guaranteed to 400 on).
 */
function dataUrlToImageBlock(dataUrl: string): Extract<ContentBlock, { type: 'image' }> | null {
  const match = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  const mediaType = match[1].toLowerCase();
  if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) return null;
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data: match[2] } };
}

/**
 * Extract the first *complete top-level* JSON object from a string, tolerating
 * surrounding prose / markdown fences and trailing commentary. Walks brace depth
 * from the first `{` and returns at the matching close, so a valid object
 * followed by a sentence that itself contains braces still parses. String-literal
 * aware, so braces inside JSON string values don't skew the depth count.
 */
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return raw.slice(start, i + 1);
  }
  return null;
}

/**
 * Build the vision-judge prompt comparing a before/after preview against the
 * instruction. `before` is optional (the judge can assess `after` alone); any
 * data URL that isn't a valid base64 image is simply skipped.
 */
export function buildJudgePrompt(
  instruction: string,
  before: string | undefined,
  after: string,
): JudgePrompt {
  const content: ContentBlock[] = [
    {
      type: 'text',
      text: `The user asked Easel to make this change to a web page:\n\n"${instruction}"`,
    },
  ];

  if (before) {
    const beforeBlock = dataUrlToImageBlock(before);
    if (beforeBlock) {
      content.push({ type: 'text', text: 'BEFORE — the page before the edit:' });
      content.push(beforeBlock);
    }
  }

  const afterBlock = dataUrlToImageBlock(after);
  if (afterBlock) {
    content.push({ type: 'text', text: 'AFTER — the page after the edit:' });
    content.push(afterBlock);
  }

  content.push({
    type: 'text',
    text: 'Did the AFTER page satisfy the requested change? Respond with ONLY the JSON object.',
  });

  return { system: JUDGE_SYSTEM, messages: [{ role: 'user', content }] };
}

/**
 * Parse the model's reply into a {@link VisionVerdict}. Tolerates surrounding
 * prose / markdown fences by extracting the first complete top-level JSON object
 * (see {@link extractFirstJsonObject}). Returns `null` (never throws) when the
 * reply is missing, unparseable, or does not carry a valid `pass`/`fail`
 * verdict — the caller treats `null` as "no verdict" and stays silent rather
 * than guessing.
 */
export function parseJudgeResult(raw: string): VisionVerdict | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const json = extractFirstJsonObject(raw);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  const verdict = obj['verdict'];
  if (verdict !== 'pass' && verdict !== 'fail') return null;

  const result: VisionVerdict = {
    verdict: verdict as VerifyVerdict,
    rationale: typeof obj['rationale'] === 'string' ? (obj['rationale'] as string) : '',
  };

  const confidence = obj['confidence'];
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    result.confidence = Math.max(0, Math.min(1, confidence));
  }

  return result;
}

/**
 * Run the vision judge against an injected client and parse its reply.
 * Fail-open: returns `null` on any error or unparseable output. Never throws.
 */
export async function runVisionJudge(
  client: VisionClient,
  prompt: JudgePrompt,
  opts: { model: string; maxTokens?: number; signal?: AbortSignal },
): Promise<VisionVerdict | null> {
  try {
    const response = (await client.messages.create(
      {
        model: opts.model,
        max_tokens: opts.maxTokens ?? 512,
        system: prompt.system,
        messages: prompt.messages,
      },
      opts.signal ? { signal: opts.signal } : undefined,
    )) as { content?: Array<Record<string, unknown>> };

    const text = (response?.content ?? [])
      .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
      .map((b) => b['text'] as string)
      .join('\n');

    return parseJudgeResult(text);
  } catch {
    return null;
  }
}
