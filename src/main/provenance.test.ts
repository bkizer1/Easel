import { describe, it, expect } from 'vitest';
import type { CheckpointProvenance } from '@shared/types';
import {
  TrailerKeys,
  formatProvenanceTrailers,
  parseTrailers,
  parseProvenance,
} from './provenance';

describe('formatProvenanceTrailers', () => {
  it('emits one trailer line per field, repeating target/source keys', () => {
    const p: CheckpointProvenance = {
      instruction: 'Make the hero bigger',
      targets: ['h1.hero', 'button#cta'],
      sources: ['src/Hero.tsx:12', 'src/Cta.tsx:4'],
      confidence: 'high',
      model: 'claude-opus-4-8',
      backend: 'claude-agent-sdk',
    };
    const block = formatProvenanceTrailers(p);
    expect(block.split('\n')).toEqual([
      `${TrailerKeys.instruction}: Make the hero bigger`,
      `${TrailerKeys.target}: h1.hero`,
      `${TrailerKeys.target}: button#cta`,
      `${TrailerKeys.source}: src/Hero.tsx:12`,
      `${TrailerKeys.source}: src/Cta.tsx:4`,
      `${TrailerKeys.confidence}: high`,
      `${TrailerKeys.model}: claude-opus-4-8`,
      `${TrailerKeys.backend}: claude-agent-sdk`,
    ]);
  });

  it('collapses a multi-line instruction into a single trailer line', () => {
    const block = formatProvenanceTrailers({ instruction: 'line one\n   line two\tthree' });
    expect(block).toBe(`${TrailerKeys.instruction}: line one line two three`);
  });

  it('returns an empty string when there is nothing to record', () => {
    expect(formatProvenanceTrailers({})).toBe('');
    expect(formatProvenanceTrailers({ targets: [], sources: [] })).toBe('');
  });
});

describe('parseTrailers', () => {
  it('parses only the trailing trailer paragraph, ignoring subject colons', () => {
    const message = [
      'Make the hero bigger: now with feeling', // colon in subject must NOT register
      '',
      'Some body prose describing the change.',
      '',
      `${TrailerKeys.instruction}: Make the hero bigger`,
      `${TrailerKeys.source}: src/Hero.tsx:12`,
    ].join('\n');

    const trailers = parseTrailers(message);
    expect(trailers[TrailerKeys.instruction]).toEqual(['Make the hero bigger']);
    expect(trailers[TrailerKeys.source]).toEqual(['src/Hero.tsx:12']);
    // The subject "Key: value"-looking line is not in the trailer paragraph.
    expect(Object.keys(trailers)).not.toContain('Make the hero bigger');
  });

  it('tolerates trailing blank lines after the trailer block', () => {
    const message = `subject\n\n${TrailerKeys.model}: claude-opus-4-8\n\n`;
    expect(parseTrailers(message)[TrailerKeys.model]).toEqual(['claude-opus-4-8']);
  });
});

describe('round-trip (format -> parse)', () => {
  it('recovers the provenance via parseProvenance', () => {
    const original: CheckpointProvenance = {
      instruction: 'Tighten the spacing',
      targets: ['section.features'],
      sources: ['src/Features.tsx:30'],
      confidence: 'medium',
      model: 'claude-sonnet-4-6',
      backend: 'anthropic-api',
    };
    // Simulate the commit message git produces: subject, blank line, trailers.
    const commit = `Tighten the spacing\n\n${formatProvenanceTrailers(original)}`;
    expect(parseProvenance(commit)).toEqual(original);
  });

  it('drops an unknown confidence value but keeps the rest', () => {
    const commit = [
      'subject',
      '',
      `${TrailerKeys.instruction}: do a thing`,
      `${TrailerKeys.confidence}: bogus`,
      `${TrailerKeys.model}: m1`,
    ].join('\n');
    const p = parseProvenance(commit);
    expect(p.instruction).toBe('do a thing');
    expect(p.confidence).toBeUndefined();
    expect(p.model).toBe('m1');
  });

  it('returns an empty object for a commit with no Easel trailers', () => {
    expect(parseProvenance('just a normal commit message\n\nwith a body')).toEqual({});
  });
});
