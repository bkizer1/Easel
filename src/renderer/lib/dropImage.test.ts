import { describe, it, expect } from 'vitest';
import {
  DROP_IMAGE_INSTRUCTION,
  dropPointToQueryBox,
  buildDropImageEditRequest,
} from './dropImage';
import type { ElementTarget } from '@shared/types';

const target: ElementTarget = {
  id: 'et-1',
  selector: 'button.cta',
  tagName: 'button',
  boundingBox: { x: 0, y: 0, width: 10, height: 10 },
  textSnippet: 'Get started',
  attributes: {},
  pluginPresent: true,
  confidence: 'high',
};

describe('dropPointToQueryBox', () => {
  it('centers a small box on the drop point', () => {
    expect(dropPointToQueryBox({ x: 100, y: 200 }, 8)).toEqual({
      x: 96,
      y: 196,
      width: 8,
      height: 8,
    });
  });

  it('clamps the top-left to non-negative near the edge', () => {
    expect(dropPointToQueryBox({ x: 2, y: 1 }, 8)).toEqual({ x: 0, y: 0, width: 8, height: 8 });
  });

  it('never produces a negative size', () => {
    const box = dropPointToQueryBox({ x: 50, y: 50 }, -10);
    expect(box.width).toBe(0);
    expect(box.height).toBe(0);
    expect(box).toEqual({ x: 50, y: 50, width: 0, height: 0 });
  });
});

describe('buildDropImageEditRequest', () => {
  it('attaches the image as screenshotDataUrl and targets the single element', () => {
    const req = buildDropImageEditRequest({
      id: 'req-1',
      target,
      imageDataUrl: 'data:image/png;base64,AAAA',
      projectRoot: '/proj',
      devServerUrl: 'http://localhost:3000',
    });
    expect(req.id).toBe('req-1');
    expect(req.screenshotDataUrl).toBe('data:image/png;base64,AAAA');
    expect(req.targets).toEqual([target]);
    expect(req.annotations).toEqual([]);
    expect(req.projectRoot).toBe('/proj');
    expect(req.devServerUrl).toBe('http://localhost:3000');
  });

  it('uses an instruction that edits the existing component, not new codegen', () => {
    const req = buildDropImageEditRequest({
      id: 'r',
      target,
      imageDataUrl: 'data:image/png;base64,AAAA',
      projectRoot: '/p',
      devServerUrl: 'http://x',
    });
    expect(req.instruction).toBe(DROP_IMAGE_INSTRUCTION);
    expect(req.instruction).toContain('do NOT generate a new component tree');
    expect(req.instruction.toLowerCase()).toContain('match the attached image');
  });
});
