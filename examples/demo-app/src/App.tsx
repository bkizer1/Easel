/**
 * Nimbus — a demo landing page for trying Easel.
 *
 * Things to try (point at them in Easel and describe a change):
 *   • the grey hero subtext    → "make this text white, it's hard to read"
 *   • the hero image           → "replace this with a photo of a golden doodle"
 *   • the "Get started" button → "make this button green and bigger"
 *   • a feature card           → "move this card to the front and add a border"
 *   • the three pricing cards  → switch to freeform mode, lasso all three, and
 *       choose "Extract a reusable component" (issue #15). Each card is the same
 *       markup duplicated across StarterPlan/ProPlan/TeamPlan in separate files.
 *
 * State Puppeteer targets (enable State Puppeteer first, then ask):
 *   • "pretend /api/products returns 50 items"  → fetch-mock fills the product list
 *   • "show the empty cart state"               → state-override writes [] into Cart.items
 */

import React, { useRef, useState } from 'react';
import { StarterPlan } from './sections/StarterPlan';
import { ProPlan } from './sections/ProPlan';
import { TeamPlan } from './sections/TeamPlan';
import ProductList from './ProductList';
import Cart from './Cart';

const features = [
  { title: 'Lightning fast', body: 'Ship in milliseconds with our edge-native runtime and zero cold starts.' },
  { title: 'Secure by default', body: 'End-to-end encryption, SOC 2, and least-privilege access on every request.' },
  { title: 'Scales with you', body: 'From a side project to millions of users without changing a line of code.' },
];

function TiltImage({ src, alt, width, height }: { src: string; alt: string; width: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tilt, setTilt] = useState({ rotateX: 0, rotateY: 0, scale: 1 });

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width - 0.5;   // -0.5 to 0.5
    const y = (e.clientY - rect.top) / rect.height - 0.5;
    setTilt({ rotateX: -y * 20, rotateY: x * 20, scale: 1.06 });
  }

  function handleMouseLeave() {
    setTilt({ rotateX: 0, rotateY: 0, scale: 1 });
  }

  return (
    <div
      ref={ref}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={{ perspective: '800px', cursor: 'pointer' }}
    >
      <img
        src={src}
        alt={alt}
        width={width}
        height={height}
        style={{
          transform: `rotateX(${tilt.rotateX}deg) rotateY(${tilt.rotateY}deg) scale(${tilt.scale})`,
          transition: tilt.scale === 1 ? 'transform 0.6s cubic-bezier(0.23,1,0.32,1)' : 'transform 0.1s ease-out',
          willChange: 'transform',
        }}
      />
    </div>
  );
}

export default function App(): React.ReactElement {
  return (
    <div className="page">
      <header className="nav">
        <div className="brand">
          <span className="brand-mark" />
          Nimbus
        </div>
        <nav className="nav-links">
          <a href="#">Product</a>
          <a href="#">Pricing</a>
          <a href="#">Docs</a>
          <a href="#">Company</a>
        </nav>
        <button className="btn btn-ghost">Sign in</button>
      </header>

      <main className="hero">
        <div className="hero-copy">
          <span className="eyebrow">NOW IN PUBLIC BETA</span>
          <h1>
            Deploy your ideas
            <br />
            at the speed of thought.
          </h1>
          <p className="subtext">
            Nimbus is the developer cloud that gets out of your way. Push to deploy, scale to zero, and
            never think about infrastructure again.
          </p>
          <div className="hero-actions">
            <button className="btn btn-primary">Get started</button>
            <button className="btn btn-secondary">Watch demo</button>
          </div>
          <p className="microcopy">No credit card required · Free for hobby projects</p>
        </div>

        <div className="hero-art">
          <TiltImage
            src="https://picsum.photos/seed/nimbus/640/440"
            alt="Product preview"
            width={640}
            height={440}
          />
        </div>
      </main>

      <section className="features">
        {features.map((f) => (
          <article className="card" key={f.title}>
            <h3>{f.title}</h3>
            <p>{f.body}</p>
          </article>
        ))}
      </section>

      <section className="pricing">
        <StarterPlan />
        <ProPlan />
        <TeamPlan />
      </section>

      {/* ── State Puppeteer demo section ────────────────────────────────────── */}
      <section className="puppeteer-section">
        <div className="puppeteer-section-header">
          <span className="eyebrow">EASEL #17 — LIVE STATE PUPPETEER</span>
          <h2 className="puppeteer-section-title">Manual verification targets</h2>
          <p className="puppeteer-section-desc">
            Enable State Puppeteer in Easel, then use natural language to drive these
            components into hard-to-reach states — without touching source code.
          </p>
        </div>
        <div className="puppeteer-grid">
          <ProductList />
          <Cart />
        </div>
      </section>

      <footer className="footer">
        <span>© 2026 Nimbus, Inc.</span>
        <span className="footer-links">
          <a href="#">Privacy</a>
          <a href="#">Terms</a>
          <a href="#">Status</a>
        </span>
      </footer>
    </div>
  );
}
