# Easel Roadmap

Easel today nails the **make-a-change loop**: point at a live element (or draw on the
page), describe a change in plain English, and an AI edits your **source**; HMR
re-renders and every edit is a git checkpoint you can revert. This roadmap is about
what comes next.

> The original MVP delivery plan (M0–M3, now largely shipped) lives in
> [`docs/ROADMAP.md`](docs/ROADMAP.md). This document is the **living feature roadmap**.

## Themes

The gaps cluster into three areas — the make-loop is solid; these are the frontiers:

1. **Understand the running app** — Easel can *change* the page but can't yet *see into*
   it. Live state, network, and errors are the biggest missing capability (and Easel's
   most defensible one, because it already maps any element to `file:line`).
2. **Ship the change** — accepted edits are trapped on an internal git ref. There's no
   path to a branch / PR / merge.
3. **Trust the agent** — nothing yet bounds what the AI may touch, or proves what it did.

Effort is rough: **S** ≈ hours–day, **M** ≈ days, **L** ≈ week+. Impact is the expected
lift to the day-to-day experience.

---

## ⭐ Now — top picks

### 1. Console error → "Fix this" autopsy · S–M · high
One-click fix for a runtime error on the page. A guest `window.onerror` /
`unhandledrejection` hook in `src/preload/webview/inspector.ts` serializes a
sourcemapped stack as a new `page-error` `InspectorMessage` (no new IPC channel); the
ConsolePanel grows a **Fix** button that builds an `EditRequest` with
`instruction = error + symbolicated stack` and `targets = the stack's source frames`.
After HMR, watch whether the same `PageLog` re-fires to confirm the fix.
- *Why first:* ~80% of the plumbing exists (ConsolePanel already captures console
  errors). Turns the dreaded blank screen into a one-click fix — the demo that sells it.
- *Done when:* an uncaught error shows a Fix button; clicking it edits the right file and
  the error clears after reload.

### 2. State X-Ray — the inspection cockpit · M · high
The flagship inspector (full spec [below](#-the-inspection-cockpit-state-x-ray)). Live
component state / props / hooks / store / computed CSS for the picked element, each row
source-anchored, with a **Change this** affordance that drops the variable's exact
identity into an `EditRequest`.
- *Done when:* selecting an element shows its live React/Vue/Svelte state; "set initial
  count to 1" edits the precise `useState` default.

### 3. Guardrail policies (no-go files & blast-radius gate) · S · high
`.easel/policy.json` (denylist globs, max-files-per-edit, require-confirm globs) enforced
at the single `ProjectFs.writeFile` chokepoint in `editRunner.ts`. Violations emit a
`policy-blocked` `AgentEvent` the renderer turns into an allow-once prompt.
- *Why:* the trust floor that makes auto-accept, longer agent loops, and unattended runs
  defensible — cheap insurance that de-risks everything more ambitious.
- *Done when:* an edit that touches `.env` / a lockfile / `migrations/` is blocked and
  surfaced for explicit approval.

### 4. Branch & open PR from accepted checkpoints · M · high
Squash a selected checkpoint range onto a fresh real branch off `HEAD`, use the active
`AgentBackend` to write the PR body from the accumulated diffs + plain-English
instructions, and `gh pr create`. Completes the arc from "point at the page" → "merged
code." Pairs with provenance trailers.
- *Done when:* "Open PR" turns a run's checkpoints into a real branch + PR with a
  generated description.

---

## ⚡ Quick wins (S)

- **Edit provenance trailers** — `createCheckpoint` writes structured git trailers
  (`Easel-Instruction`, `Easel-Target`, `Easel-Source`, `Easel-Confidence`,
  `Easel-Model`, `Easel-Backend`) on the internal ref, carried onto real commits when
  branching. Every edit auditable via `git blame`/`log`. Feeds the PR feature.
- **Pinned macros** — persist `{name, instructionTemplate, hotkey}` in settings; on
  invoke, interpolate `{element}`/`{text}` from the selected target and call the existing
  `submitEdit`. Repeated phrasings ("match our design tokens", "add aria-label") become
  one-click verbs. Right-click a past instruction → "Save as macro."
- **Alignment grid & rhythm overlay** — a guest-side grid overlay plus an off-grid pass
  (`getBoundingClientRect` over visible elements) that flags misaligned nodes with their
  `data-easel-source`; "snap to grid" batches into one `EditRequest`.

---

## 🚀 High-impact bets (M / L)

- **Live DOM/CSS tweak → durable source patch** · M — nudge styles on the live element
  like DevTools (instant, no agent round-trip), accumulate a `{property, old, new}`
  delta, then "Apply to source" ships the structured delta so the agent edits the exact
  Tailwind class / styled-component / CSS rule. Precise for "make it 8px bigger / this
  blue / more padding."
- **Checkpoint visual diff** · M — `previewCapture` before the edit and after HMR settles,
  stored per `Checkpoint.id`; an onion-skin / slider / delta-mask view in HistoryPanel.
  Catches unintended layout shifts the file diff hides.
- **Responsive matrix edit** · L — render the dev-server URL in 2–3 stacked `<webview>`s
  at the Desktop/Tablet/Mobile presets; on submit, capture each frame and attach all to
  the `EditRequest` so the agent fixes responsive CSS with full cross-breakpoint context.
- **Live token inspector + "tokenize this value"** · M — `getComputedStyle` on the picked
  element; grep `tailwind.config` / CSS custom properties / theme files to match computed
  values to token names; "use token" swaps a magic hex for `var(--color-slate-800)`.
- **Scratch branches — throwaway experiments** · L — a `refs/easel/scratch/<id>` forked
  from the current checkpoint; edits commit there, "Keep" fast-forwards, "Discard" deletes
  it. Try "make it brutalist / glassmorphic" as parallel lines and keep one; real git HEAD
  untouched.
- **Lasso refactor** · L — when a freeform region resolves to several structurally-similar
  targets (multi-file), offer "Extract a reusable component"; the multi-file diff streams
  into DiffViewer as one atomic checkpoint. A UI-driven refactor no text selection can
  express.
- **Drop-an-image design-to-code surgery** · M — drop an image on the preview; resolve the
  drop point to a precise target; build an `EditRequest` with the image as
  `screenshotDataUrl` and "restyle this element's source to match." Targets one existing
  component, so the result stays maintainable JSX/CSS.

---

## 🌙 Moonshots

- **Self-healing edit loop (point-fix-verify)** — after the agent's `done`, re-capture the
  target region and feed before/after frames to a vision backend for a pass/fail
  judgment (`verify` event); on fail, auto-resubmit once with the visual delta. The
  checkpoint is the rollback. Turns "edits source" into "edits source until the page
  actually looks right."
- **Live state puppeteer** — natural-language state/data mutation: "show the empty-cart
  state", "pretend the API returns 50 items" — a scoped eval-in-guest command + a
  `set_app_state` agent tool (clear a store, intercept `fetch` with MSW the agent writes)
  drive the app into hard-to-reach states so you can fix them.
- **Session replay as a runnable `.easel` artifact** — _shipped (#18)._ Export the chat
  (annotations + diffs + checkpoints) plus the checkpoint trees (`git bundle`) into a
  portable `.easel` ZIP a colleague scrubs frame-by-frame, with "Re-run this step"
  deterministically re-applying a recorded checkpoint's delta to current code. Design
  intent as a replayable program, not a Loom + Slack thread.
- **Review mode (propose-don't-write)** — a staged runner writes to a shadow git worktree;
  diffs stream and, because each maps to a `data-easel-source`, the PreviewPane highlights
  the on-page element each pending change affects. Approve element-by-element on the live
  page; only full approval copies the staged tree into the project. The trust model that
  makes a more autonomous agent acceptable.

---

## 🔬 The inspection cockpit: State X-Ray

**Concept — Easel DevTools turned inside out.** Every other inspector (React DevTools,
Burp) is read-only and *separate* from where you edit. Easel's is **read-and-write and
source-anchored**: because the guest inspector already maps any DOM node to `file:line`,
*every inspected fact carries a `data-easel-source` pointer* — so "this value is wrong /
this request is failing / this error is here" converts in one click into a precisely
targeted `EditRequest`. Inspection that **acts**.

**Three coordinated taps on the guest Easel already drives:**

- **State tap** — the inspector preload runs in the page's isolated context with full DOM
  access, so from a picked element it reaches framework internals on the node: React
  (`__reactFiber$` → `memoizedProps` + the `memoizedState` hook chain), Vue
  (`__vueParentComponent.setupState`/`props`), Svelte (`$$.ctx`), plus subscribed store
  slices. It serializes a depth-limited, cycle-safe snapshot and pushes it as a new
  `element-state` `InspectorMessage` over the existing `sendToHost('inspector-message')`
  channel — near-zero new IPC. Writes (scrub/bake) go back as new `InspectorCommand`s.
- **Network tap (the Burp part)** — main already locates the guest `WebContents`
  (`window.ts`, used for `capturePage`); attach a CDP debugger to it
  (`debugger.attach` + `Network.enable` / `Fetch.enable`) to capture and **pause**
  requests for interception, streamed on a new `network.event` push channel that mirrors
  the existing `previewStatus`/`devServerEvent` pattern.
- **Error tap** — a guest `window.onerror` / `unhandledrejection` hook symbolicates
  `error.stack` against the dev sourcemaps and sends a `page-error` message; each row maps
  to real source frames, not inert text.

**What it inspects:** component props/hooks/store/computed CSS · network request/response
log with mock+intercept · symbolicated runtime + console errors · render causes (which
prop/state changed last commit) · design tokens (computed values resolved to token
sources) · state across time (snapshot per checkpoint, deep-diffed in HistoryPanel).

**The AI pairing — the part nothing else can do.** The panel is the agent's structured
input layer, not a dead-end. Each tap has a one-click bridge into the existing
`EditRequest → backend → file-write → HMR → checkpoint` pipeline:
- Pick a wrong value → "start count at 1" → Easel drops the variable's exact identity
  (`Cart.tsx:18`, hook index) into the request so the agent edits the precise `useState`
  default instead of guessing from a screenshot.
- Click a failing request → "add loading + error states" → the request carries the URL,
  status body, and the fetch's source location from the initiator stack.
- Click a symbolicated error → Fix hands the agent message + stack + nearest element's
  source, and Easel watches whether it re-fires after HMR.

The agent gains what a code-only assistant never has: the running program's **actual
state, network, and errors as first-class, source-anchored context** — so "find and fix
the cause of this wrong value" is a literal, supported gesture, made safe and auditable by
guardrail policies and provenance trailers.

---

*This roadmap is a living document — open an issue to propose, refine, or claim an item.*
