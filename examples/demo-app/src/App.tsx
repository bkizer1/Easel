/**
 * Nimbus — a demo landing page for trying Easel.
 *
 * Things to try (point at them in Easel and describe a change):
 *   • the grey hero subtext  → "make this text white, it's hard to read"
 *   • the hero image         → "replace this with a photo of a golden doodle"
 *   • the "Get started" button → "make this button green and bigger"
 *   • a feature card          → "move this card to the front and add a border"
 */

import React from 'react';

const features = [
  { title: 'Lightning fast', body: 'Ship in milliseconds with our edge-native runtime and zero cold starts.' },
  { title: 'Secure by default', body: 'End-to-end encryption, SOC 2, and least-privilege access on every request.' },
  { title: 'Scales with you', body: 'From a side project to millions of users without changing a line of code.' },
];

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
          <img
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
