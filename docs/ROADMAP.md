# Easel Roadmap

**Vision:** A joyful, AI-powered visual web development environment that collapses the feedback loop from "change idea" to "rendered result" from minutes to seconds.

**Status:** MVP in active development (M0–M3, targeting delivery end of Q3 2026).

---

## Phased Delivery Plan

### M0: Scaffolding & Infrastructure (Weeks 1–2, Complete)

**Deliverables:**

- ✅ Electron + electron-vite project (main, preload, renderer roots)
- ✅ IPC contract fully typed in `src/shared/ipc.ts`
- ✅ Settings store with Electron safeStorage for secrets
- ✅ AgentBackend interface and pluggable registry
- ✅ Project detector and dev-server URL validator
- ✅ Basic UI shell (window layout, toolbar, empty preview pane)
- ✅ CI/CD scaffolding (build config, lint/typecheck)

**Status:** ✅ Delivered

---

### M1: Interaction Modes & Annotation (Weeks 3–6, In Progress)

**Deliverables:**

- [ ] **ElementSelect mode**
  - [ ] Hover-highlight DOM elements with visual feedback (border + overlay)
  - [ ] Click to select a single element
  - [ ] Multi-select (Shift+click or checkbox toggle)
  - [ ] Display element details: tag name, CSS classes, dimensions, bounding box
  - [ ] Source file and line mapping (via data-easel-source attribute or CSS-selector fallback)
  - [ ] Instruction input field
  - [ ] Clear/deselect controls

- [ ] **Freeform annotation mode**
  - [ ] Drawing toolbar: rectangle, ellipse, arrow, freehand pen, eraser
  - [ ] Capture strokes as structured `Annotation` objects (points, bounding box, color)
  - [ ] Per-stroke undo/redo
  - [ ] Screenshot capture of marked region
  - [ ] Region-to-element resolution (grid-sampled `elementsFromPoint`)
  - [ ] Clear/finalize controls

- [ ] **Annotation overlay**
  - [ ] Absolutely-positioned SVG/Canvas layer on top of webview
  - [ ] Alignment tracking (handle scrolling via `viewport-changed`)
  - [ ] Mode-aware pointer-events (`none` in idle, capture in draw)

- [ ] **Text instruction input**
  - [ ] Text field with submission button
  - [ ] Instruction validation (non-empty, reasonable length)
  - [ ] Recent instructions list (for re-use)

- [ ] **Voice instruction input (feature flag)**
  - [ ] Microphone button behind `voiceInput` feature flag
  - [ ] Web Speech API integration (browser/OS speech recognition)
  - [ ] Transcription to text
  - [ ] Graceful degradation (disabled button + tooltip if unavailable)

- [ ] **Webview preload (guest inspector)**
  - [ ] Element hit-testing (`elementFromPoint`, walk to nearest source)
  - [ ] Robust CSS selector generation (id, testid, :nth-of-type fallback)
  - [ ] Bounding box capture (`getBoundingClientRect`)
  - [ ] Region grid-sampling for freeform mode
  - [ ] `ElementTarget` building (tag, selector, source, text snippet, attributes)
  - [ ] `InspectorMessage` posting to host
  - [ ] `InspectorCommand` handling from host

**Status:** In progress

---

### M2: Agent Integration & Edit Pipeline (Weeks 7–11, Planned)

**Deliverables:**

- [ ] **EditRequest builder**
  - [ ] Combine instruction + element targets + annotations + screenshot
  - [ ] Validate payload before submission
  - [ ] Pass to main via `window.easel.edit.submit()`

- [ ] **Claude Agent SDK backend** (`src/main/agents/claudeAgentSdk.ts`)
  - [ ] Initialize SDK client with API key
  - [ ] Implement `AgentBackend` interface
  - [ ] Full coding agent with file search, tool loop, git awareness
  - [ ] Map SDK events to Easel's `AgentEvent` union
  - [ ] Route file ops through `ProjectFs` (path-sandboxed)
  - [ ] Capabilities: `gitAware`, `editsFilesDirectly`, `streamsThinking`, `supportsVision`

- [ ] **Anthropic Messages API backend** (`src/main/agents/anthropicApi.ts`)
  - [ ] Hand-built agent loop (own message turns + tool dispatch)
  - [ ] Implement `AgentBackend` interface
  - [ ] Custom tools: `read_file`, `edit_file`, `grep`, `replace_image`
  - [ ] Emit `AgentEvent`s directly from loop
  - [ ] Leaner/cheaper path for simple edits
  - [ ] Capabilities: `editsFilesDirectly`, `supportsVision` (no `gitAware`)

- [ ] **Shared agent tools** (`src/main/agents/tools.ts`)
  - [ ] `read_file(path)` → file contents
  - [ ] `edit_file(path, edits)` → `FileDiff` (validated pre-write)
  - [ ] `grep(pattern, cwd)` → `GrepMatch[]` (fallback source mapping)
  - [ ] `replace_image(selector, prompt/url)` → new asset path
  - [ ] `ProjectFs` sandbox (path traversal guard)

- [ ] **EditRequest → file edits pipeline**
  - [ ] Main receives EditRequest
  - [ ] Validate + prepare: load settings, decrypt key, build context
  - [ ] Route to selected backend
  - [ ] Backend emits streaming `AgentEvent`s (thinking, tool-call, file-edit, checkpoint, done)

- [ ] **Stream events to renderer**
  - [ ] `edit.event` push channel relays `AgentEvent` to renderer
  - [ ] Renderer displays progress panel: "Analyzing… Editing file X… Waiting for reload…"
  - [ ] Thinking panel (if backend supports `streamsThinking`)
  - [ ] Tool-call display (file being read, grep being run, etc.)

- [ ] **Dev server reload detection**
  - [ ] Detect HMR signals from dev server (primary)
  - [ ] Soft reload fallback via `<webview>.reload()`
  - [ ] Hard reload fallback via `<webview>.reloadIgnoringCache()`
  - [ ] Health-poll dev server; show "Preview disconnected" if down

- [ ] **Diff review panel**
  - [ ] Show `FileDiff[]` for each changed file
  - [ ] Unified or side-by-side view toggles
  - [ ] Syntax highlighting (JSON/HTML/CSS/JS/etc.)
  - [ ] Accept / Reject buttons
  - [ ] File navigation

- [ ] **Accept/Reject logic**
  - [ ] Accept → call `createCheckpoint()` to commit changes
  - [ ] Reject → restore previous git checkpoint, revert preview
  - [ ] Emit success/failure status to UI

- [ ] **Error handling**
  - [ ] Malformed agent response → clear error message
  - [ ] File write failure → rollback + explain (e.g., disk full)
  - [ ] API error (rate limit, invalid key) → user-facing guidance
  - [ ] Network error → retry UI
  - [ ] Agent timeout → cancel + message

**Status:** Planned

---

### M3: Polish, Undo/Redo, Settings & Release (Weeks 12–16, Planned)

**Deliverables:**

- [ ] **Git-backed undo/redo** (`src/main/checkpoints.ts`)
  - [ ] One checkpoint = one git commit on `refs/easel/checkpoints`
  - [ ] Cursor-based undo/redo (pointer walks the timeline)
  - [ ] `checkpoint.undo()` → restore previous state + reload preview
  - [ ] `checkpoint.redo()` → restore next state + reload preview
  - [ ] `checkpoint.list()` → timeline with instruction messages
  - [ ] `checkpoint.restore(id)` → jump to any checkpoint (with confirmation)
  - [ ] Reject edit → restore prior checkpoint
  - [ ] Verify git repo + disk space before each checkpoint
  - [ ] Emit `checkpoint.changed` events to UI

- [ ] **Undo/Redo UI**
  - [ ] Toolbar buttons (grayed out if unavailable)
  - [ ] Keyboard shortcuts (Ctrl+Z / Cmd+Z for undo, Ctrl+Shift+Z / Cmd+Shift+Z for redo)
  - [ ] History sidebar or panel (list of checkpoints with descriptions)
  - [ ] Diff preview per checkpoint

- [ ] **Settings dialog**
  - [ ] Agent backend selector (Claude SDK vs. Anthropic API)
  - [ ] Model ID input (default to latest stable)
  - [ ] API key entry (masked display, secure storage via `safeStorage`)
  - [ ] Test connection button
  - [ ] Feature toggles:
    - Voice input (on/off)
    - Image generation (on/off)
    - Auto-accept changes (on/off, MVP: default off)
    - Detailed logging (on/off, MVP: default off)
  - [ ] Dev server URL override (manual entry + validation)
  - [ ] Theme picker (light/dark/auto)
  - [ ] Reset to defaults button
  - [ ] About / Version info

- [ ] **Image replacement & generation**
  - [ ] Detect `<img>` and background-image elements in ElementSelect
  - [ ] `ImageProvider` interface (pluggable)
  - [ ] Stub provider (returns placeholder URL)
  - [ ] Agent tool: `replace_image(selector, prompt/url)`
  - [ ] Image generation flow:
    - User instruction: "replace with a golden doodle"
    - Agent calls `replace_image` tool with prompt
    - ImageProvider generates/fetches image
    - Agent updates src/background-image
    - Preview reloads with new image
  - [ ] Fallback: if no provider, suggest image URL input

- [ ] **@easel/vite-plugin-inspector package**
  - [ ] Publishable npm package (`@easel/vite-plugin-inspector`)
  - [ ] Babel transform for JSX/HTML (React + Vue SFC support)
  - [ ] Inject `data-easel-source="file.tsx:line:col"` idempotently
  - [ ] Dev-only guard (`command === 'serve'` → only active in dev)
  - [ ] Source map passthrough for debuggers
  - [ ] Minimal overhead (no-op in production builds)
  - [ ] Clear install/usage docs in `packages/vite-plugin-inspector/README.md`

- [ ] **Documentation**
  - [ ] README.md (feature overview, quick start, FAQ, license)
  - [ ] CONTRIBUTING.md (dev setup, code standards, PR process)
  - [ ] CODE_OF_CONDUCT.md (Contributor Covenant)
  - [ ] ROADMAP.md (this file)
  - [ ] ARCHITECTURE.md (system design, already authored)
  - [ ] FILE_MANIFEST.md (file-by-file breakdown, already authored)
  - [ ] ELEMENT_SOURCE_MAPPING.md (source mapping deep-dive, already authored)

- [ ] **Cross-platform testing**
  - [ ] macOS (Intel + Apple Silicon)
  - [ ] Windows (11, 10)
  - [ ] Linux (Ubuntu 22.04+)
  - [ ] Smoke tests: project open, element select, freeform, submit, undo/redo

- [ ] **App signing & distribution**
  - [ ] macOS: Sign with developer certificate, notarize, package as DMG
  - [ ] Windows: Sign with code certificate, package as NSIS installer
  - [ ] Linux: Package as AppImage and/or snap
  - [ ] Publish to GitHub Releases

- [ ] **CI/CD pipeline**
  - [ ] GitHub Actions: lint, typecheck, build on every push
  - [ ] Build matrix: macOS, Windows, Linux
  - [ ] Automated release artifacts (DMG, exe, AppImage)
  - [ ] Test on multiple Node versions (18, 20, 22)

**Status:** Planned

---

## Post-MVP Backlog (v1.1+)

### v1.1: Advanced Features & UX Polish

- [ ] **Image generation from prompts**
  - DALL-E integration (via Anthropic API or direct)
  - Midjourney integration (via webhook)
  - Replicate integration (open-source models)
  - Cost estimation / quota warnings

- [ ] **Instruction history & re-use**
  - Save frequent instructions as snippets
  - Search/filter recent instructions
  - Suggest corrections for ambiguous instructions

- [ ] **Git history timeline UI**
  - Full git log viewer (commits before Easel + Easel checkpoints)
  - Visual timeline with instruction labels
  - Diff comparison between arbitrary checkpoints
  - Bulk commit squashing / rebase

- [ ] **VS Code extension**
  - Edit sidebar (open Easel, send instruction from sidebar)
  - Command palette integration
  - Keyboard shortcut to toggle Easel
  - Sync open file in editor with selection in Easel

- [ ] **Multi-file templates**
  - Save snapshots of multiple files as "before" state
  - Apply instruction to all files atomically
  - Rollback as a single checkpoint

- [ ] **Performance optimizations**
  - Lazy-load agent backends
  - Stream large diffs more efficiently
  - Preload common models
  - Cache file content between edits

- [ ] **Advanced logging & debugging**
  - Detailed operation logs (to file)
  - Agent reasoning/trace export
  - Cost tracking (tokens → $)
  - Replay mode (re-run past edits)

- [ ] **Collaborative features** (research phase)
  - Share a live preview link with team members
  - Real-time sync of edits
  - Comments on changesets
  - Approval workflow

### v1.2: Integration & Ecosystem

- [ ] **Figma plugin**
  - Export Figma frames to HTML
  - Push design updates to Easel
  - Two-way sync of color/spacing tokens

- [ ] **GitHub integration**
  - Auto-commit Easel changes to PRs
  - Link checkpoints to GitHub commits
  - Run CI/CD on Easel edits
  - Auto-close related issues

- [ ] **Slack integration**
  - Post diffs to Slack for review
  - Receive feedback in Slack, apply to Easel
  - Auto-notify team of changes

- [ ] **Browser extension**
  - Right-click "Edit in Easel" on any website
  - Annotate live pages, send instruction

- [ ] **Custom image providers**
  - User-defined image generation APIs
  - Pluggable image selector UI
  - Cost tracking per provider

### v2.0: Mobile & Advanced Authoring

- [ ] **iOS/Android app**
  - Native mobile preview (WebView)
  - Touch drawing / annotation
  - Voice input (native speech-to-text)
  - Simplified UI for small screens

- [ ] **Design token system**
  - Inspect computed token values
  - Bulk update token references
  - Design system linting

- [ ] **Accessibility audit mode**
  - WCAG compliance checker
  - Agent-assisted fixes (color contrast, alt text, etc.)

- [ ] **A/B testing support**
  - Capture variant snapshots
  - Visual diff between variants
  - Checkpoint branching

---

## Priorities by Audience

### For Frontend Engineers (Primary)
- M1: ElementSelect mode (click elements)
- M2: Agent backends (immediate live edits)
- M3: Undo/redo (safety)
- v1.1: Instruction history (speed)
- v1.1: VS Code extension (closer to editor)

### For Designers-Who-Code
- M1: Freeform annotation mode (visual feedback)
- M2: Image replacement (quick asset swaps)
- M3: Settings + backends (cost control)
- v1.1: Image generation (on-brand assets)
- v1.2: Figma plugin (design sync)

### For Indie Hackers
- M1: Both modes (flexibility)
- M2: Both backends (cost options)
- M3: Full feature set MVP
- v1.1: Instruction history (move faster)
- v1.1: Image generation (polish landing page)

---

## Success Metrics (Post-Launch)

| Metric | Target | Rationale |
|--------|--------|-----------|
| User NPS | ≥ 70 | Product is genuinely delightful |
| Agent success rate | ≥ 85% | Edits are reliable, users trust it |
| Edit latency | < 3 sec | Feedback loop remains immediate |
| Weekly active users | Growing trend | Users return for recurring value |
| GitHub stars | ≥ 500 | Community interest and adoption |
| API cost per session | < $2 | Economical for users |
| Crash-free hours | ≥ 99% | Stability |

---

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|-----------|
| Element-to-source mapping fragile | High | High | Plugin first-class; grep fallback covers 80% of cases |
| Agent writes broken code | Medium | Critical | Pre-write validation, git checkpoints, test before release |
| High API costs | Medium | Medium | Cheaper backend as default; cost warnings; session limits |
| Dev server crashes | Medium | Medium | Health polling; reconnect UI; auto-reload fallback |
| Webview preload injection fails | Low | High | Test on multiple dev servers; graceful degradation |
| User disk full | Low | High | Check space before checkpoint; friendly error |
| Electron contextIsolation bug | Low | Critical | Code review + automated security testing |

---

## Decision Log

### Why Electron + <webview> (not Web-only)?
- Desktop context (access to git, filesystem, secrets) is essential.
- <webview> composites naturally in React, supports guest preload, and allows overlay on top via CSS.
- Downside: heavier than a pure web app; mitigated by minimal guest exposure and strong process isolation.

### Why pluggable agent backends?
- Users value choice: power (Claude Agent SDK) vs. cost/transparency (raw API).
- Switching at runtime should be frictionless; users don't rebuild the app.
- Mitigated by unified `AgentBackend` interface and normalized `AgentEvent` stream.

### Why git checkpoints on an internal ref?
- Git is already trusted and installed; leverages existing workflow.
- Isolated ref doesn't touch user's branches/HEAD; undo is safe.
- Atomic, reversible; fits the "checkpoint every edit" mental model.
- Downside: assumes git repo; checked with friendly failure.

### Why Vite plugin as primary source map?
- Survives bundling, HMR, and framework transpilation (unlike AST analysis at runtime).
- Tiny DOM attribute cost; dev-only (no production leak).
- Optional (grep fallback works); lowers friction.

---

## See Also

- [REQUIREMENTS.md](REQUIREMENTS.md) — Full product spec (personas, user stories, FR/NFR tables)
- [ARCHITECTURE.md](ARCHITECTURE.md) — System design, process model, security
- [FILE_MANIFEST.md](FILE_MANIFEST.md) — Every file's responsibility
- [README.md](../README.md) — Feature overview and quick start

---

**Last updated:** June 2026  
**Next review:** After M1 completion (week 6)
