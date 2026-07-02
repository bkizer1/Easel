/**
 * Starter plan card — intentionally DUPLICATED inline markup.
 *
 * One of three near-identical pricing cards (see ProPlan, TeamPlan) living in
 * separate files. In Easel, switch to freeform mode, lasso across all three
 * cards, and choose "Extract a reusable component" to factor them into one
 * shared <PlanCard> — a multi-file refactor no text selection can express
 * (issue #15). The data-easel-source attribute is what the inspector plugin
 * normally stamps; it is hand-written here so the demo works without the plugin.
 */

import React from 'react';

export function StarterPlan(): React.ReactElement {
  return (
    <article className="plan-card" data-easel-source="src/sections/StarterPlan.tsx:16:5">
      <h3 className="plan-name">Starter</h3>
      <p className="plan-price">
        $0<span>/mo</span>
      </p>
      <ul className="plan-features">
        <li>1 project</li>
        <li>Community support</li>
        <li>1 GB bandwidth</li>
      </ul>
      <button className="btn btn-secondary">Choose Starter</button>
    </article>
  );
}
