/**
 * Easel — checkpoint provenance trailers.
 *
 * Encodes {@link CheckpointProvenance} as git "trailers" — the `Key: value`
 * lines git recognises in the last paragraph of a commit message (the same
 * mechanism behind `Signed-off-by:` / `Co-authored-by:`). Recording the *why*
 * of every Easel edit as trailers makes checkpoints auditable with plain
 * `git log` / `git interpret-trailers`, and lets the data ride onto a real
 * commit when the Branch/PR feature promotes a checkpoint.
 *
 * The trailer KEYS are a stable contract (the PR feature parses them), so do not
 * rename them. Values are sanitised to a single line each; repeatable keys
 * (`Easel-Target`, `Easel-Source`) emit one line per value.
 *
 * Pure module — no Node/Electron imports — so the format/parse round-trip is
 * unit-testable in isolation.
 */

import type { CheckpointProvenance, ConfidenceLevel } from '@shared/types';

/* -------------------------------------------------------------------------- */
/*  Trailer keys (stable contract — do not rename)                             */
/* -------------------------------------------------------------------------- */

export const TrailerKeys = {
  instruction: 'Easel-Instruction',
  target: 'Easel-Target',
  source: 'Easel-Source',
  confidence: 'Easel-Confidence',
  model: 'Easel-Model',
  backend: 'Easel-Backend',
} as const;

/** A git trailer key is a token of letters, digits and hyphens. */
const TRAILER_LINE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]?(.*)$/;

/** Cap on a single trailer value so an enormous instruction can't bloat commits. */
const MAX_VALUE_LEN = 500;

/* -------------------------------------------------------------------------- */
/*  Formatting (provenance -> trailer block)                                   */
/* -------------------------------------------------------------------------- */

/** Collapse a value to a single trimmed line (trailers are line-oriented). */
function sanitizeValue(raw: string): string {
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_VALUE_LEN ? oneLine.slice(0, MAX_VALUE_LEN - 1) + '…' : oneLine;
}

/**
 * Build the trailer block (one `Key: value` per line) for a provenance record.
 * Returns `''` when there is nothing worth recording, so callers can skip
 * appending an empty paragraph.
 */
export function formatProvenanceTrailers(p: CheckpointProvenance): string {
  const lines: string[] = [];

  const push = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    const clean = sanitizeValue(value);
    if (clean) lines.push(`${key}: ${clean}`);
  };

  push(TrailerKeys.instruction, p.instruction);
  for (const t of p.targets ?? []) push(TrailerKeys.target, t);
  for (const s of p.sources ?? []) push(TrailerKeys.source, s);
  push(TrailerKeys.confidence, p.confidence);
  push(TrailerKeys.model, p.model);
  push(TrailerKeys.backend, p.backend);

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/*  Parsing (commit message -> trailers / provenance)                          */
/* -------------------------------------------------------------------------- */

/**
 * Parse the trailing trailer paragraph of a commit message into a map of
 * key -> values (preserving repeats and order). Only the final block of
 * consecutive trailer-shaped lines is considered, matching git's own semantics,
 * so a colon in the subject line never registers as a trailer.
 */
export function parseTrailers(message: string): Record<string, string[]> {
  const lines = message.replace(/\r\n/g, '\n').split('\n');

  // Drop trailing blank lines, then walk upward collecting trailer lines until
  // we hit a blank line or a line that is not trailer-shaped.
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;

  let start = end;
  while (start > 0) {
    const line = lines[start - 1];
    if (line.trim() === '' || !TRAILER_LINE.test(line)) break;
    start--;
  }

  const out: Record<string, string[]> = {};
  for (let i = start; i < end; i++) {
    const m = TRAILER_LINE.exec(lines[i]);
    if (!m) continue;
    const [, key, value] = m;
    (out[key] ??= []).push(value);
  }
  return out;
}

const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ['high', 'medium', 'low', 'none'];

/**
 * Extract a typed {@link CheckpointProvenance} from a commit message's trailers.
 * Inverse of {@link formatProvenanceTrailers} for round-trip use by the PR
 * feature. Unknown / missing trailers are simply absent from the result.
 */
export function parseProvenance(message: string): CheckpointProvenance {
  const t = parseTrailers(message);
  const first = (key: string): string | undefined => t[key]?.[0];

  const confidenceRaw = first(TrailerKeys.confidence);
  const confidence = CONFIDENCE_LEVELS.includes(confidenceRaw as ConfidenceLevel)
    ? (confidenceRaw as ConfidenceLevel)
    : undefined;

  const provenance: CheckpointProvenance = {};
  const instruction = first(TrailerKeys.instruction);
  if (instruction !== undefined) provenance.instruction = instruction;
  if (t[TrailerKeys.target]) provenance.targets = t[TrailerKeys.target];
  if (t[TrailerKeys.source]) provenance.sources = t[TrailerKeys.source];
  if (confidence) provenance.confidence = confidence;
  const model = first(TrailerKeys.model);
  if (model !== undefined) provenance.model = model;
  const backend = first(TrailerKeys.backend);
  if (backend !== undefined) provenance.backend = backend as CheckpointProvenance['backend'];

  return provenance;
}
