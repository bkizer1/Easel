/**
 * Pro plan card — intentionally DUPLICATED inline markup.
 *
 * One of three near-identical pricing cards (see StarterPlan, TeamPlan) living
 * in separate files. In Easel, switch to freeform mode, lasso across all three
 * cards, and choose "Extract a reusable component" to factor them into one
 * shared <PlanCard> — a multi-file refactor no text selection can express
 * (issue #15). The data-easel-source attribute is what the inspector plugin
 * normally stamps; it is hand-written here so the demo works without the plugin.
 */

import React from 'react';

export function ProPlan(): React.ReactElement {
  return (
    <article className="plan-card" data-easel-source="src/sections/ProPlan.tsx:16:5">
      <h3 className="plan-name">Pro</h3>
      <p className="plan-price">
        $29<span>/mo</span>
      </p>
      <ul className="plan-features">
        <li>Unlimited projects</li>
        <li>Priority support</li>
        <li>100 GB bandwidth</li>
      </ul>
      <button className="btn btn-secondary">Choose Pro</button>
    </article>
  );
}
