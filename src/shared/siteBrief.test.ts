import { describe, it, expect } from 'vitest';
import { buildSitePrompt, type NewSiteBrief } from './siteBrief';

const base: NewSiteBrief = {
  siteType: 'Portfolio',
  name: 'Aria Studio',
  oneLiner: 'A design studio for bold brands',
  vibes: ['Bold & punchy', 'Editorial'],
  sections: ['Hero', 'Work', 'Contact'],
};

describe('buildSitePrompt', () => {
  it('includes the name, brief facts, and the chosen vibe', () => {
    const p = buildSitePrompt(base);
    expect(p).toContain('"Aria Studio"');
    expect(p).toContain('A design studio for bold brands');
    expect(p).toContain('Visual direction: Bold & punchy, Editorial');
    expect(p).toContain('Sections to include: Hero, Work, Contact');
  });

  it('omits empty optional fields', () => {
    const p = buildSitePrompt(base);
    expect(p).not.toContain('Audience:');
    expect(p).not.toContain('Tagline:');
  });

  it('adapts the motion guidance', () => {
    expect(buildSitePrompt({ ...base, motion: 'lively' })).toContain('lively but not noisy');
    expect(buildSitePrompt({ ...base, motion: 'none' })).toContain('no animation');
    expect(buildSitePrompt({ ...base, motion: 'subtle' })).toContain('subtle, restrained motion');
  });

  it('falls back gracefully when the name is blank', () => {
    expect(buildSitePrompt({ ...base, name: '  ' })).toContain('"this site"');
  });
});
