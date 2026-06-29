import { describe, it, expect } from 'vitest';
import { selfHealPhaseLabel } from './selfHealLabel';

describe('selfHealPhaseLabel', () => {
  it('labels the verifying phase', () => {
    expect(selfHealPhaseLabel({ requestId: 'r1', phase: 'verifying' })).toBe('Verifying edit…');
  });

  it('labels a retry with its attempt number and rationale', () => {
    expect(
      selfHealPhaseLabel({
        requestId: 'r1',
        phase: 'retrying',
        attempt: 2,
        rationale: 'button is still blue',
      }),
    ).toBe('Retrying (attempt 2)… — button is still blue');
  });

  it('omits the trailing dash when the rationale is empty', () => {
    expect(
      selfHealPhaseLabel({ requestId: 'r1', phase: 'retrying', attempt: 2, rationale: '' }),
    ).toBe('Retrying (attempt 2)…');
  });

  it('omits the trailing dash when the rationale is whitespace-only', () => {
    expect(
      selfHealPhaseLabel({ requestId: 'r1', phase: 'retrying', attempt: 3, rationale: '   ' }),
    ).toBe('Retrying (attempt 3)…');
  });

  it('trims surrounding whitespace from the rationale', () => {
    expect(
      selfHealPhaseLabel({ requestId: 'r1', phase: 'retrying', attempt: 2, rationale: '  nope  ' }),
    ).toBe('Retrying (attempt 2)… — nope');
  });
});
