import { describe, it, expect } from 'vitest';

import { pickCaptureTargetId } from './window';

describe('pickCaptureTargetId', () => {
  it('returns the requested id when it is among the guests (Responsive Matrix)', () => {
    expect(pickCaptureTargetId([10, 20, 30], 20)).toBe(20);
  });

  it('falls back to the first guest when the requested id is not in the list', () => {
    expect(pickCaptureTargetId([10, 20, 30], 99)).toBe(10);
  });

  it('returns the first guest when no id is requested', () => {
    expect(pickCaptureTargetId([10, 20, 30], undefined)).toBe(10);
  });

  it('returns null when there are no guests', () => {
    expect(pickCaptureTargetId([], 20)).toBeNull();
    expect(pickCaptureTargetId([], undefined)).toBeNull();
  });
});
