/**
 * Easel — "new site" creative brief.
 *
 * When the user has nothing loaded, Easel offers to start a site from scratch.
 * A short, delightful intake (see `NewSiteWizard`) collects this brief, which we
 * (1) scaffold a real Vite + React + TS project for, then (2) synthesize into the
 * agent's first instruction so it builds the initial site from the user's vision.
 *
 * This module is pure (no DOM / Electron) so the prompt synthesis is unit-tested.
 */

/** Everything the intake collects about the site to build. */
export interface NewSiteBrief {
  /** What kind of site, e.g. "Portfolio", "SaaS landing", "Restaurant". */
  siteType: string;
  /** Brand / site name. */
  name: string;
  /** Optional tagline / slogan. */
  tagline?: string;
  /** One-line description of what it's about. */
  oneLiner: string;
  /** Who it's for. */
  audience?: string;
  /** Visual directions the user picked (1–3), e.g. "Minimal & clean". */
  vibes: string[];
  /** Color mood, e.g. "Jewel tones" or a free description. */
  colorMood?: string;
  /** Optional explicit accent color (hex). */
  accentColor?: string;
  /** Sites whose vibe the user loves (free text — names or URLs). */
  references?: string;
  /** What they like about those references. */
  referenceNotes?: string;
  /** Sections to include, e.g. ["Hero", "Pricing", "Contact"]. */
  sections: string[];
  /** Any must-haves in free text. */
  mustHaves?: string;
  /** Typography vibe, e.g. "Modern sans", "Editorial serif". */
  typography?: string;
  /** Motion appetite. */
  motion?: 'subtle' | 'lively' | 'none';
  /** Theme preference. */
  theme?: 'light' | 'dark' | 'both';
}

function line(label: string, value: string | undefined | null): string | null {
  const v = (value ?? '').trim();
  return v ? `${label}: ${v}` : null;
}

/**
 * Synthesize the brief into a rich, opinionated instruction for the agent to
 * build the initial site on top of the fresh scaffold.
 */
export function buildSitePrompt(brief: NewSiteBrief): string {
  const name = brief.name.trim() || 'this site';
  const vibes = brief.vibes.filter(Boolean);

  const facts = [
    line('Site type', brief.siteType),
    line('What it is', brief.oneLiner),
    line('Audience', brief.audience),
    line('Tagline', brief.tagline),
    vibes.length ? `Visual direction: ${vibes.join(', ')}` : null,
    line('Color mood', brief.colorMood),
    line('Accent color', brief.accentColor),
    line('Typography', brief.typography),
    line('Motion', brief.motion),
    line('Theme', brief.theme),
    line('Reference vibes the user loves', brief.references),
    line('What they like about those', brief.referenceNotes),
    brief.sections.length ? `Sections to include: ${brief.sections.join(', ')}` : null,
    line('Must-haves', brief.mustHaves),
  ].filter(Boolean) as string[];

  return [
    `Build a complete, polished, single-page website for "${name}".`,
    '',
    'THE BRIEF',
    ...facts.map((f) => `  • ${f}`),
    '',
    'CONTEXT',
    '  • This is a fresh Vite + React + TypeScript scaffold. `src/App.tsx` is a placeholder and',
    '    `src/styles.css` is nearly empty — replace them with the real site.',
    '  • Build the whole page in `src/App.tsx` (extract components/files as it grows) and style it',
    '    in `src/styles.css`. Keep it a single cohesive page unless the sections imply more.',
    '',
    'MAKE IT EXCELLENT',
    '  • Write real, specific copy that fits the brand and audience — never lorem ipsum or filler.',
    '  • Commit hard to the chosen visual direction: distinctive type pairing, a deliberate color',
    '    palette from the color mood, intentional spacing and hierarchy. Avoid generic "AI template"',
    '    looks (no default Inter-on-white, no purple-gradient-on-white clichés).',
    brief.motion === 'lively'
      ? '  • Add tasteful, performant motion (entrance reveals, hover states) — lively but not noisy.'
      : brief.motion === 'none'
        ? '  • Keep it static — no animation.'
        : '  • Add subtle, restrained motion (gentle hover states, a soft entrance) — nothing flashy.',
    '  • Fully responsive (mobile → desktop). Accessible: semantic HTML, good contrast, alt text.',
    '  • Where imagery helps, use https://picsum.photos/seed/<word>/<w>/<h> placeholders.',
    '',
    'Make something memorable that the user would be proud to ship as a first draft. When in doubt,',
    'be bolder and more specific, not blander.',
  ].join('\n');
}
