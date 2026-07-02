import { describe, it, expect } from 'vitest';
import {
  MATRIX_PRESETS,
  DEFAULT_MATRIX_FRAME_ID,
  assembleFrames,
  type FrameCaptureResult,
  type MatrixFrameDef,
} from './responsiveMatrix';

describe('MATRIX_PRESETS', () => {
  it('defines Desktop/Tablet/Mobile widest → narrowest with unique ids', () => {
    expect(MATRIX_PRESETS.map((p) => p.label)).toEqual(['Desktop', 'Tablet', 'Mobile']);
    const widths = MATRIX_PRESETS.map((p) => p.width);
    const descending = [...widths].sort((a, b) => b - a);
    expect(widths).toEqual(descending);
    const ids = MATRIX_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('defaults the active frame to the widest preset', () => {
    expect(DEFAULT_MATRIX_FRAME_ID).toBe(MATRIX_PRESETS[0].id);
  });
});

describe('assembleFrames', () => {
  const def = (id: string, label: string, width: number): MatrixFrameDef => ({ id, label, width });
  const url = (n: string): string => `data:image/png;base64,${n}`;

  it('builds a ResponsiveFrame per successful capture, preserving label/width/active', () => {
    const results: FrameCaptureResult[] = [
      { def: def('desktop', 'Desktop', 1280), active: false, screenshotDataUrl: url('d') },
      { def: def('tablet', 'Tablet', 834), active: true, screenshotDataUrl: url('t') },
      { def: def('mobile', 'Mobile', 390), active: false, screenshotDataUrl: url('m') },
    ];
    expect(assembleFrames(results)).toEqual([
      { label: 'Desktop', width: 1280, active: false, screenshotDataUrl: url('d') },
      { label: 'Tablet', width: 834, active: true, screenshotDataUrl: url('t') },
      { label: 'Mobile', width: 390, active: false, screenshotDataUrl: url('m') },
    ]);
  });

  it('drops frames whose capture failed (null data URL)', () => {
    const results: FrameCaptureResult[] = [
      { def: def('desktop', 'Desktop', 1280), active: true, screenshotDataUrl: url('d') },
      { def: def('tablet', 'Tablet', 834), active: false, screenshotDataUrl: null },
    ];
    const frames = assembleFrames(results);
    expect(frames).toHaveLength(1);
    expect(frames?.[0].label).toBe('Desktop');
  });

  it('returns undefined when there are no usable captures', () => {
    expect(assembleFrames([])).toBeUndefined();
    expect(
      assembleFrames([
        { def: def('mobile', 'Mobile', 390), active: true, screenshotDataUrl: null },
      ]),
    ).toBeUndefined();
  });
});
