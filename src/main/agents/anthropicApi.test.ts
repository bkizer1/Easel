import { describe, it, expect } from 'vitest';
import { systemPrompt } from './anthropicApi';
import type { EditRequest } from '@shared/types';

function makeBaseRequest(overrides: Partial<EditRequest> = {}): EditRequest {
  return {
    id: 'req-1',
    instruction: 'Make it look nicer',
    annotations: [],
    targets: [],
    projectRoot: '/proj',
    devServerUrl: 'http://localhost:3000',
    ...overrides,
  };
}

describe('systemPrompt — refactor section', () => {
  it('does NOT include the refactor heading when refactor is absent', () => {
    const prompt = systemPrompt(makeBaseRequest());
    expect(prompt).not.toContain('REFACTOR — EXTRACT A REUSABLE COMPONENT');
  });

  it('includes the refactor heading when refactor is present', () => {
    const request = makeBaseRequest({
      refactor: {
        kind: 'extract-component',
        memberTargetIds: ['t1', 't2'],
        files: ['src/A.tsx', 'src/B.tsx'],
        suggestedName: 'ProductCard',
      },
    });
    const prompt = systemPrompt(request);
    expect(prompt).toContain('REFACTOR — EXTRACT A REUSABLE COMPONENT');
  });

  it('includes the suggested component name', () => {
    const request = makeBaseRequest({
      refactor: {
        kind: 'extract-component',
        memberTargetIds: ['t1', 't2'],
        files: ['src/A.tsx', 'src/B.tsx'],
        suggestedName: 'ProductCard',
      },
    });
    const prompt = systemPrompt(request);
    expect(prompt).toContain('ProductCard');
  });

  it('includes both source file paths', () => {
    const request = makeBaseRequest({
      refactor: {
        kind: 'extract-component',
        memberTargetIds: ['t1', 't2'],
        files: ['src/A.tsx', 'src/B.tsx'],
        suggestedName: 'ProductCard',
      },
    });
    const prompt = systemPrompt(request);
    expect(prompt).toContain('src/A.tsx');
    expect(prompt).toContain('src/B.tsx');
  });

  it('includes key refactor verbs: reusable component, call site, props', () => {
    const request = makeBaseRequest({
      refactor: {
        kind: 'extract-component',
        memberTargetIds: ['t1', 't2'],
        files: ['src/A.tsx', 'src/B.tsx'],
        suggestedName: 'ProductCard',
      },
    });
    const prompt = systemPrompt(request);
    expect(prompt).toContain('reusable component');
    expect(prompt).toContain('call site');
    expect(prompt).toContain('props');
  });
});
