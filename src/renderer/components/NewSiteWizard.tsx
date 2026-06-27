/**
 * Easel — NewSiteWizard.
 *
 * When the user has nothing loaded, Easel offers to start a site from scratch.
 * This is a short, delightful creative intake: what it's about, the brand, the
 * vibe, inspiration, sections, finishing touches — then it scaffolds a real
 * Vite + React + TS project and hands the brief to the agent to build it.
 */

import React, { useState } from 'react';
import {
  Sparkles, ArrowLeft, ArrowRight, FolderOpen, X, Wand2, Loader2, Check,
} from 'lucide-react';
import { useEaselStore } from '../store';
import type { NewSiteBrief } from '@shared/siteBrief';

/* -------------------------------------------------------------------------- */
/*  Option vocabularies                                                        */
/* -------------------------------------------------------------------------- */

const SITE_TYPES = ['Portfolio', 'Personal site', 'SaaS / product', 'Landing page', 'Blog', 'Online store', 'Restaurant / café', 'Event / wedding', 'Agency / studio', 'Nonprofit', 'Docs', 'App showcase'];
const VIBES = ['Minimal & clean', 'Bold & punchy', 'Playful & colorful', 'Elegant & editorial', 'Dark & techy', 'Warm & organic', 'Brutalist', 'Retro / Y2K', 'Luxury', 'Hand-crafted', 'Corporate & trustworthy', 'Futuristic'];
const COLOR_MOODS = ['Monochrome', 'Jewel tones', 'Pastels', 'Earthy & natural', 'Neon & electric', 'Ocean blues', 'Sunset warm', 'Forest greens'];
const SECTIONS = ['Hero', 'About', 'Features', 'Services', 'Gallery', 'Pricing', 'Testimonials', 'Team', 'Blog', 'FAQ', 'Contact', 'Newsletter'];
const TYPOGRAPHY = ['Modern sans', 'Classic serif', 'Editorial mix', 'Mono / techy', 'Playful display'];

const STEPS = ['About', 'Brand', 'Vibe', 'Inspiration', 'Finish'];

/* -------------------------------------------------------------------------- */
/*  Small building blocks                                                      */
/* -------------------------------------------------------------------------- */

function Chip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-3 py-1.5 text-[12.5px] transition-all duration-150 active:scale-[0.97] ${
        active
          ? 'border-brand-500/50 bg-brand-500/15 text-brand-200 shadow-[0_0_12px_-4px_rgba(52,211,176,0.8)]'
          : 'border-white/10 bg-ink-800/50 text-gray-300 hover:border-white/20 hover:text-gray-100'
      }`}
    >
      {label}
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2 text-[12.5px] font-medium text-gray-300">
        {label}
        {hint && <span className="text-[11px] font-normal text-gray-600">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const inputCls =
  'w-full rounded-lg border border-white/10 bg-ink-800/70 px-3 py-2 text-[13px] text-gray-100 placeholder-gray-600 focus:border-brand-500/50 focus:bg-ink-800 focus:outline-none focus:shadow-[0_0_0_3px_rgba(52,211,176,0.10)] transition-all';

function Segmented<T extends string>({ value, options, onChange }: { value: T | undefined; options: { v: T; label: string }[]; onChange: (v: T) => void }): React.ReactElement {
  return (
    <div className="inline-flex rounded-lg border border-white/10 bg-ink-800/60 p-0.5">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`rounded-md px-3 py-1.5 text-[12px] font-medium transition-colors ${
            value === o.v ? 'bg-brand-500/20 text-brand-200' : 'text-gray-400 hover:text-gray-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Wizard                                                                     */
/* -------------------------------------------------------------------------- */

export function NewSiteWizard(): React.ReactElement {
  const closeNewSite = useEaselStore((s) => s.closeNewSite);
  const chooseSiteLocation = useEaselStore((s) => s.chooseSiteLocation);
  const createNewSite = useEaselStore((s) => s.createNewSite);
  const scaffold = useEaselStore((s) => s.scaffold);

  const [step, setStep] = useState(0);
  const [parentDir, setParentDir] = useState<string | null>(null);
  const [brief, setBrief] = useState<NewSiteBrief>({
    siteType: '',
    name: '',
    oneLiner: '',
    vibes: [],
    sections: [],
    motion: 'subtle',
    theme: 'dark',
  });

  const update = (patch: Partial<NewSiteBrief>): void => setBrief((b) => ({ ...b, ...patch }));
  const toggle = (field: 'vibes' | 'sections', value: string): void =>
    setBrief((b) => {
      const arr = b[field];
      const has = arr.includes(value);
      // Cap vibes at 3 so the direction stays focused.
      if (!has && field === 'vibes' && arr.length >= 3) return b;
      return { ...b, [field]: has ? arr.filter((x) => x !== value) : [...arr, value] };
    });

  const building = scaffold !== null;
  const canNext =
    (step === 0 && brief.oneLiner.trim().length > 0) ||
    (step === 1 && brief.name.trim().length > 0) ||
    step === 2 ||
    step === 3;
  const canBuild = brief.name.trim().length > 0 && brief.oneLiner.trim().length > 0 && !!parentDir;

  async function pickLocation(): Promise<void> {
    const dir = await chooseSiteLocation();
    if (dir) setParentDir(dir);
  }

  function build(): void {
    if (!parentDir) return;
    void createNewSite(brief, parentDir, brief.name.trim());
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 backdrop-blur-sm animate-fade-in" onMouseDown={() => !building && closeNewSite()}>
      <div
        className="relative w-[min(640px,calc(100vw-2rem))] max-h-[calc(100vh-3rem)] overflow-hidden rounded-2xl border border-white/10 bg-ink-900/95 shadow-[0_40px_120px_-30px_rgba(0,0,0,0.8)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {building ? (
          <ScaffoldProgress />
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-5 pt-5">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 place-items-center rounded-xl bg-gradient-to-br from-brand-300 via-brand-400 to-brand-600 shadow-[0_0_16px_-4px_rgba(52,211,176,0.8)]">
                  <Wand2 className="h-4 w-4 text-ink-950" />
                </span>
                <div>
                  <h2 className="font-display text-[16px] font-semibold text-gray-100">Let&rsquo;s design your site</h2>
                  <p className="text-[11.5px] text-gray-500">A few quick questions, then the AI builds a first draft.</p>
                </div>
              </div>
              <button onClick={closeNewSite} aria-label="Close" className="grid h-8 w-8 place-items-center rounded-lg text-gray-500 hover:bg-white/[0.06] hover:text-gray-200 transition-colors">
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Step dots */}
            <div className="flex items-center gap-1.5 px-5 pt-4">
              {STEPS.map((s, i) => (
                <div key={s} className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? 'bg-brand-400' : 'bg-white/10'}`} title={s} />
              ))}
            </div>

            {/* Step body */}
            <div className="max-h-[58vh] overflow-y-auto px-5 py-5">
              {step === 0 && (
                <div className="space-y-4">
                  <Field label="What are you building?" hint="pick one or skip">
                    <div className="flex flex-wrap gap-2">
                      {SITE_TYPES.map((t) => (
                        <Chip key={t} label={t} active={brief.siteType === t} onClick={() => update({ siteType: brief.siteType === t ? '' : t })} />
                      ))}
                    </div>
                  </Field>
                  <Field label="In a sentence, what's it about?">
                    <input autoFocus className={inputCls} value={brief.oneLiner} onChange={(e) => update({ oneLiner: e.target.value })} placeholder="e.g. A studio that designs bold brands for ambitious founders" />
                  </Field>
                  <Field label="Who's it for?" hint="optional">
                    <input className={inputCls} value={brief.audience ?? ''} onChange={(e) => update({ audience: e.target.value })} placeholder="e.g. early-stage startup founders" />
                  </Field>
                </div>
              )}

              {step === 1 && (
                <div className="space-y-4">
                  <Field label="What's it called?">
                    <input autoFocus className={inputCls} value={brief.name} onChange={(e) => update({ name: e.target.value })} placeholder="Your site / brand name" />
                  </Field>
                  <Field label="Tagline" hint="optional">
                    <input className={inputCls} value={brief.tagline ?? ''} onChange={(e) => update({ tagline: e.target.value })} placeholder="A short, memorable line" />
                  </Field>
                </div>
              )}

              {step === 2 && (
                <div className="space-y-4">
                  <Field label="Pick a vibe" hint="up to 3">
                    <div className="flex flex-wrap gap-2">
                      {VIBES.map((v) => (
                        <Chip key={v} label={v} active={brief.vibes.includes(v)} onClick={() => toggle('vibes', v)} />
                      ))}
                    </div>
                  </Field>
                  <Field label="Color mood">
                    <div className="flex flex-wrap gap-2">
                      {COLOR_MOODS.map((c) => (
                        <Chip key={c} label={c} active={brief.colorMood === c} onClick={() => update({ colorMood: brief.colorMood === c ? undefined : c })} />
                      ))}
                    </div>
                  </Field>
                  <Field label="Accent color" hint="optional">
                    <div className="flex items-center gap-2.5">
                      <input type="color" value={brief.accentColor ?? '#34d3b0'} onChange={(e) => update({ accentColor: e.target.value })} className="h-9 w-12 cursor-pointer rounded-lg border border-white/10 bg-transparent" />
                      <span className="font-mono text-[12px] text-gray-500">{brief.accentColor ?? 'auto'}</span>
                      {brief.accentColor && (
                        <button onClick={() => update({ accentColor: undefined })} className="text-[11px] text-gray-600 hover:text-gray-400">clear</button>
                      )}
                    </div>
                  </Field>
                </div>
              )}

              {step === 3 && (
                <div className="space-y-4">
                  <Field label="Any sites whose vibe you love?" hint="names or URLs, optional">
                    <textarea className={`${inputCls} h-[60px] resize-none`} value={brief.references ?? ''} onChange={(e) => update({ references: e.target.value })} placeholder="e.g. linear.app, the way stripe.com feels, my friend's portfolio…" />
                  </Field>
                  <Field label="What do you like about them?" hint="optional">
                    <input className={inputCls} value={brief.referenceNotes ?? ''} onChange={(e) => update({ referenceNotes: e.target.value })} placeholder="e.g. the calm spacing and crisp type" />
                  </Field>
                  <Field label="What's on it?">
                    <div className="flex flex-wrap gap-2">
                      {SECTIONS.map((s) => (
                        <Chip key={s} label={s} active={brief.sections.includes(s)} onClick={() => toggle('sections', s)} />
                      ))}
                    </div>
                  </Field>
                  <Field label="Any must-haves?" hint="optional">
                    <input className={inputCls} value={brief.mustHaves ?? ''} onChange={(e) => update({ mustHaves: e.target.value })} placeholder="e.g. a booking button, an email capture, a big photo" />
                  </Field>
                </div>
              )}

              {step === 4 && (
                <div className="space-y-4">
                  <Field label="Typography">
                    <div className="flex flex-wrap gap-2">
                      {TYPOGRAPHY.map((t) => (
                        <Chip key={t} label={t} active={brief.typography === t} onClick={() => update({ typography: brief.typography === t ? undefined : t })} />
                      ))}
                    </div>
                  </Field>
                  <div className="flex flex-wrap gap-6">
                    <Field label="Motion">
                      <Segmented value={brief.motion} options={[{ v: 'subtle', label: 'Subtle' }, { v: 'lively', label: 'Lively' }, { v: 'none', label: 'None' }]} onChange={(v) => update({ motion: v })} />
                    </Field>
                    <Field label="Theme">
                      <Segmented value={brief.theme} options={[{ v: 'light', label: 'Light' }, { v: 'dark', label: 'Dark' }, { v: 'both', label: 'Both' }]} onChange={(v) => update({ theme: v })} />
                    </Field>
                  </div>
                  <Field label="Where should it live?">
                    <button onClick={() => void pickLocation()} className="flex w-full items-center gap-2.5 rounded-lg border border-white/10 bg-ink-800/70 px-3 py-2.5 text-left text-[12.5px] text-gray-300 hover:border-white/20 transition-colors">
                      <FolderOpen className="h-4 w-4 text-brand-400" />
                      {parentDir ? (
                        <span className="truncate font-mono text-[11.5px] text-gray-300">{parentDir}/{(brief.name.trim() || 'your-site').toLowerCase().replace(/[^a-z0-9]+/g, '-')}</span>
                      ) : (
                        <span className="text-gray-500">Choose a folder…</span>
                      )}
                      {parentDir && <Check className="ml-auto h-4 w-4 flex-shrink-0 text-brand-400" />}
                    </button>
                  </Field>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between border-t border-white/[0.07] px-5 py-3.5">
              <button
                onClick={() => setStep((s) => Math.max(0, s - 1))}
                disabled={step === 0}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-2 text-[12.5px] text-gray-400 hover:text-gray-100 disabled:opacity-0 transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" /> Back
              </button>
              {step < STEPS.length - 1 ? (
                <button
                  onClick={() => setStep((s) => s + 1)}
                  disabled={!canNext}
                  className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-[12.5px] font-semibold text-white hover:bg-brand-500 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-[0.98]"
                >
                  Next <ArrowRight className="h-3.5 w-3.5" />
                </button>
              ) : (
                <button
                  onClick={build}
                  disabled={!canBuild}
                  className="flex items-center gap-2 rounded-lg bg-gradient-to-br from-brand-400 to-brand-600 px-4 py-2 text-[12.5px] font-semibold text-white shadow-[0_0_18px_-5px_rgba(52,211,176,0.9)] hover:brightness-110 disabled:opacity-30 disabled:cursor-not-allowed transition-all active:scale-[0.98]"
                >
                  <Sparkles className="h-4 w-4" /> Build it
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Scaffolding progress                                                       */
/* -------------------------------------------------------------------------- */

const PHASE_LABEL: Record<string, string> = {
  writing: 'Creating your project',
  installing: 'Installing dependencies',
  git: 'Setting up version history',
  done: 'Ready — building your site',
  error: 'Something went wrong',
};

function ScaffoldProgress(): React.ReactElement {
  const scaffold = useEaselStore((s) => s.scaffold);
  const closeNewSite = useEaselStore((s) => s.closeNewSite);
  const phase = scaffold?.phase ?? 'writing';
  const isError = phase === 'error';

  return (
    <div className="px-6 py-9 text-center">
      {isError ? (
        <X className="mx-auto h-10 w-10 text-rose-400" />
      ) : (
        <Loader2 className="mx-auto h-10 w-10 animate-spin text-brand-400" />
      )}
      <h2 className="mt-4 font-display text-[16px] font-semibold text-gray-100">
        {scaffold?.message && isError ? scaffold.message : PHASE_LABEL[phase]}
      </h2>
      {!isError && (
        <p className="mt-1.5 text-[12px] text-gray-500">
          Scaffolding a Vite + React project, then the AI builds your first draft from the brief.
        </p>
      )}
      {scaffold?.log && !isError && (
        <pre className="mx-auto mt-4 max-h-24 max-w-md overflow-hidden truncate rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-left text-[11px] font-mono text-gray-500">
          {scaffold.log}
        </pre>
      )}
      {isError && (
        <button onClick={closeNewSite} className="mt-5 rounded-lg border border-white/10 bg-white/[0.06] px-4 py-2 text-[12.5px] text-gray-200 hover:bg-white/[0.1] transition-colors">
          Close
        </button>
      )}
    </div>
  );
}
