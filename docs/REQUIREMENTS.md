# Easel: Product Requirements Document

**Version:** 1.0 | **Last Updated:** June 2026 | **Status:** MVP Specification

---

## 1. Vision & Problem Statement

### Vision
Easel is an open-source (AGPL-3.0) agentic desktop app that transforms web development from a keyboard-centric, context-switching workflow into a **visual, conversational, and immediate** interaction with live code. A developer points to (or marks up) a rendered element on their running project and issues an instruction in natural language—click an element to select it, freehand-draw over the page like a whiteboard, speak or type a change request—and Claude edits the source files. The preview hot-reloads in real time. Every change is git-checkpointed. The result: **faster iteration, lower cognitive load, and joyful development.**

### Problem Statement
Modern web development incurs significant friction:
- **Context switching:** devs toggle between their editor, browser, browser DevTools, and file system to understand what code produces what visual output.
- **Translation overhead:** converting a visual design concept or screenshot annotation into CSS/HTML changes is laborious and error-prone.
- **Slow feedback loops:** even with HMR, minor layout tweaks require write-save-view cycles.
- **Design-to-code gaps:** designers and less-experienced devs struggle to bridge visual intent and implementation, leading to back-and-forth revisions.
- **Undo/versioning risk:** experimental changes without clear checkpoints can get tangled; git workflow is assumed but not always leveraged.

### Target Users
**Primary:**
- **Frontend engineers** (mid-career to senior) iterating on UI/UX in real time; value speed and live feedback.
- **Designers who code** (design-systems engineers, indie hackers, part-time devs) who want to bridge design intent and HTML/CSS without leaving the visual context.
- **Full-stack indie developers** shipping solo who want a "copilot for the UI" to move faster.

**Secondary:**
- QA/design stakeholders who spot bugs or have design feedback and want a frictionless way to communicate fixes (via Easel's annotation + instruction interface).

---

## 2. User Personas & Jobs to Be Done

### Persona 1: Maya, Frontend Engineer (25 yrs, Mid-Level)
**Profile:** Works at a mid-size startup, shipping a React/Next.js SaaS product. Uses Figma + VS Code daily. Iterates on landing pages, dashboards, and modals.

**Jobs to Be Done:**
- Tweak a button's color, spacing, or position based on design feedback without re-reading CSS files.
- Replace a stock photo with a more relevant image in a few seconds (including API calls if needed).
- Quickly test multiple layout variations (mobile vs. desktop, light vs. dark mode) without committing changes.
- Revert an experimental CSS change if it breaks something across the page.
- Record a video demo of a UI change for a design review (git checkpoint + diff view aides this).

**Key Needs:**
- Speed: minimize click/typing overhead.
- Visibility: see the before/after diff, reject bad edits.
- Safety: undo via git; never lose work.
- Context: know which file was edited, what lines changed.

---

### Persona 2: Alex, Designer-Who-Codes (31 yrs, Design System Owner)
**Profile:** Owns a design system at an e-commerce company; bridges design and engineering. Fluent in Figma, React, Tailwind CSS. Mentors junior engineers.

**Jobs to Be Done:**
- Quickly export a Figma component to HTML/CSS without manual handoff friction.
- Adjust spacing, colors, typography system-wide in response to a design audit, spotting inconsistencies visually then fixing them in code.
- Annotate a screenshot ("this heading should be 24px, not 20px") and have an agent execute the change; demo the fix to stakeholders in seconds.
- Maintain consistency: apply a design token update (e.g., rebrand primary color) across multiple components.
- Collaborate with engineers: give visual feedback via annotations + voice instructions; Easel logs the change as a git commit for clear accountability.

**Key Needs:**
- Visual authoring: design tool metaphors (drawing, marking up) feel natural.
- Precision: CSS changes must respect the design system (Tailwind utility classes, token colors).
- Auditability: every change is a git commit; can show stakeholders a diff.
- Extensibility: maybe plug in a custom ImageProvider to generate hero images from prompts.

---

### Persona 3: Jamie, Indie Hacker (27 yrs, Solo Founder)
**Profile:** Bootstrapping a side project (Next.js + Vercel). Wears all hats: product, design, engineering. Limited time; high stakes.

**Jobs to Be Done:**
- Launch an MVP in 2 weeks instead of 3 by cutting out repetitive CSS/layout tweaks.
- Take a screenshot of a competitor's landing page, annotate it ("I like this hero section"), and quickly build something similar.
- A/B test two landing-page headlines, layouts, and CTA button colors by iterating in Easel instead of in Figma then re-coding.
- Get feedback from an investor ("logo is too small") and fix it live on Zoom.
- Keep a clean git history (one commit per feature) so the product backlog is easy to navigate and rollback is risk-free.

**Key Needs:**
- Efficiency: do more with less; Easel is a force multiplier.
- Reliability: no random agent failures that corrupt the codebase.
- Simplicity: minimal setup; works with a standard dev server (Vite, Next.js, etc.).
- Transparency: understand what the agent changed; accept or reject each edit.

---

## 3. User Stories & Acceptance Criteria

### Epic 1: Project Connection & Dev Server Embedding

#### US-1.1: Developer Opens a Local Web Project
**As a** developer  
**I want to** open Easel, select a local project folder, and immediately see the running dev server preview live in the app  
**So that** I can start annotating and issuing instructions without manual setup.

**Acceptance Criteria:**
- Easel app launches with an onboarding/project selector dialog.
- User browses filesystem and selects a project folder.
- Easel detects the dev server URL (auto-detect http://localhost:3000, 5173, 8000, etc.; or allow manual override).
- The embedded webview loads and displays the dev server's current content.
- If dev server is not running, show a friendly error message with next steps.
- Easel remembers the last project and reopens it on app launch (unless closed explicitly).

---

#### US-1.2: Developer Changes the Dev Server URL
**As a** developer  
**I want to** change the dev server URL (e.g., switch from localhost:3000 to localhost:8000) via settings  
**So that** I can work on multiple projects or use a non-standard dev server port.

**Acceptance Criteria:**
- Settings dialog has a "Dev Server URL" field, editable and validated (must be http://).
- Changing the URL reloads the webview to the new address.
- Easel shows a loading state while the webview reconnects.
- If the new URL is unreachable, show a retry prompt and fallback to the last valid URL.

---

### Epic 2: Element Selection Interaction Mode

#### US-2.1: Developer Hovers Over and Clicks a DOM Element
**As a** developer  
**I want to** click on a rendered element in the preview (button, heading, image, etc.)  
**So that** Easel highlights it and I can issue an instruction to edit just that element.

**Acceptance Criteria:**
- When hover-highlighting is enabled, the mouse cursor hovers over the preview and elements are visually highlighted (e.g., blue border + semi-transparent overlay).
- User clicks a highlighted element.
- Easel captures the element's DOM tree path, CSS selector, bounding box, and (if available via data-easel-source attribute or fallback) the source file and line.
- A selection panel appears showing: element tag, CSS classes, computed dimensions, source file/line, and a text field to attach an instruction.
- User can type an instruction (e.g., "make this button red") and submit it.
- The element remains highlighted until the user selects a different element or closes the selection.

---

#### US-2.2: Developer Selects Multiple Elements Sequentially
**As a** developer  
**I want to** select two or more elements (e.g., a heading and a button) and issue a **single** instruction  
**So that** I can make coordinated changes (e.g., "align these to the top and give them the same color").

**Acceptance Criteria:**
- A "Select multiple" toggle or checkbox is available.
- User clicks the first element; it is added to a selection list (visually marked, e.g., blue border).
- User clicks the second element; it is added to the selection list.
- The instruction panel shows all selected elements (count, list preview).
- User types an instruction and submits; the agent receives all selected elements in the EditRequest.
- User can deselect an individual element by clicking it again while in multi-select mode.
- Clear/reset clears all selections.

---

#### US-2.3: Developer Sees Element's Source File and Line Number
**As a** developer  
**I want to** see which source file and line number a rendered element comes from  
**So that** I understand the codebase structure and can provide more precise instructions (e.g., "edit the heading in components/Header.tsx").

**Acceptance Criteria:**
- If the project uses @easel/vite-plugin-inspector, the data-easel-source attribute is stamped on JSX/HTML elements in dev builds.
- Easel's element inspector displays "Source: src/components/Header.tsx:24" or similar.
- If the attribute is missing (project does not use the plugin or the element is dynamic), Easel falls back to a robust CSS selector + grepping the source for the closest matching tag/class (UX: "Source: inferred from CSS selector").
- Clicking the source file path opens the file in the user's default editor (VS Code, Sublime, etc.).

---

### Epic 3: Freeform Markup Interaction Mode

#### US-3.1: Developer Draws Shapes to Annotate the Preview
**As a** developer  
**I want to** click a "draw" button, then freehand-draw or place geometric shapes (rectangles, circles, arrows) on the preview  
**So that** I can visually mark areas of the page that need changes (e.g., "this section should be wider").

**Acceptance Criteria:**
- A drawing toolbar appears with tools: rectangle, circle, arrow, freehand pen, eraser.
- User selects a tool and draws on the preview (SVG overlay, rendered on top of the webview).
- Strokes are rendered in a bright, semi-transparent color (e.g., red or yellow).
- User can undo/redo individual strokes within the drawing.
- The drawn annotation is captured as structured geometry data (list of strokes, shapes, coordinates).
- A screenshot of the annotated region is automatically cropped and attached to the EditRequest (context for the agent).
- User can clear all drawings or switch back to selection mode.

---

#### US-3.2: Developer Attaches an Instruction to a Freeform Annotation
**As a** developer  
**I want to** finalize a freeform drawing and attach a text or voice instruction to it  
**So that** the agent understands what change I want (e.g., "widen this section to 80% of the viewport").

**Acceptance Criteria:**
- After drawing, a "Finalize annotation" button or voice button appears.
- User types or speaks an instruction (see Epic 4 for voice details).
- Easel captures the drawing (geometry + screenshot), the instruction, and the metadata (timestamp, selected annotation mode).
- User can submit the instruction to the agent or continue drawing/refining.
- Multiple annotations can be queued; user reviews them in a list before submitting all at once or one by one.

---

#### US-3.3: Developer Marks Multiple Regions and Submits One Instruction for All
**As a** developer  
**I want to** draw annotations on three separate parts of the page, then issue a **single** instruction  
**So that** I can say "make all these sections use the same background color" without repeating the instruction.

**Acceptance Criteria:**
- Drawing mode remains active; user can draw, finalize, and draw again without returning to selection mode.
- A panel shows a list of annotations: thumbnail, instruction text, submission status.
- User can add, edit, or delete annotations before final submission.
- User types a global instruction (or attaches one to a specific annotation).
- Submit button sends all annotations + the instruction to the agent in a single EditRequest.
- Agent receives all annotation geometries and the screenshot composite.

---

### Epic 4: Natural Language Instruction (Text & Voice)

#### US-4.1: Developer Types an Instruction in Text
**As a** developer  
**I want to** type a plain-English instruction (e.g., "make the heading bold and navy blue")  
**So that** the agent knows exactly what I want and can execute the change.

**Acceptance Criteria:**
- A text input field is available in the element inspector or annotation panel.
- User types an instruction in any tone (imperative, question, casual phrasing all OK).
- Instructions are kept in a history (recent instructions list for re-use).
- Submit button sends the instruction + context (selected elements/annotations) to the agent.
- If the instruction is ambiguous, the agent can ask a clarifying question (v2 feature; not MVP).

---

#### US-4.2: Developer Issues a Voice Instruction
**As a** developer  
**I want to** click a microphone button and speak an instruction instead of typing  
**So that** I can iterate hands-free while mousing/drawing, and speaking is faster than typing for complex ideas.

**Acceptance Criteria:**
- A microphone button is visible (in the instruction panel or toolbar).
- Clicking it starts recording audio via the Web Speech API (browser/OS speech recognition).
- User speaks (e.g., "move the signup button to the top right corner").
- Easel transcribes the speech to text and populates the instruction field.
- If speech recognition is unavailable (browser doesn't support it, OS permission denied), the microphone button is disabled with a helpful message.
- User can edit the transcribed text before submitting.
- Audio is NOT stored; only the transcribed text is sent to the agent.

---

### Epic 5: Agent Edit Pipeline & Live Re-Render

#### US-5.1: Developer Submits an Instruction and Sees Live Changes
**As a** developer  
**I want to** submit an instruction and see the source code change and the preview re-render in real time  
**So that** I get immediate visual feedback and can iterate quickly.

**Acceptance Criteria:**
- User submits instruction (element-select or freeform mode).
- Easel builds an EditRequest: instruction text, element targets (CSS selectors, source hints), annotation geometries, screenshot, backend preference.
- EditRequest is sent to the main process, which selects the configured agent backend (Claude Agent SDK or Anthropic Messages API).
- Agent backend is called with the EditRequest and begins processing.
- Main process streams AgentEvent messages back to the renderer (e.g., "parsing instruction", "identifying files", "writing changes", "done").
- Renderer displays a live progress panel: "Analyzing... Editing src/components/Button.tsx... Waiting for dev server...".
- Dev server hot-reloads the changed files; webview auto-refreshes (via HMR or browser reload).
- Once the change is visible, the agent confirms completion; user sees a "Done" state.
- If an error occurs (agent cannot parse the instruction, file edit fails, etc.), user sees the error message and can retry or try a different instruction.

---

#### US-5.2: Developer Reviews and Accepts the Agent's Changes
**As a** developer  
**I want to** see a diff of what the agent changed before confirming the change  
**So that** I can verify the agent didn't introduce bugs or make unintended changes.

**Acceptance Criteria:**
- After the agent applies edits to disk, a "diff review" panel appears showing the changes.
- The diff shows file-by-file changes: old code (red), new code (green), side-by-side or unified view.
- User can scroll through all changed files and diffs.
- User can click "Accept" to keep the changes and create a git checkpoint (commit).
- User can click "Reject" to revert to the previous git checkpoint (git reset --hard), undoing the agent's edits.
- If changes are rejected, the files revert on disk and the webview reloads to reflect the previous state.
- The checkpoint is created after changes are applied (commit-after-apply model). Rejection restores the prior checkpoint, not a "preview" state.

---

#### US-5.3: Developer Receives Clear Agent Feedback on What It Did
**As a** developer  
**I want to** understand what changes the agent made and why  
**So that** I can debug if the change is wrong, or improve my next instruction.

**Acceptance Criteria:**
- After agent processing, a summary message is displayed: "Edited src/components/Button.tsx: changed background color from blue to red; updated padding from 8px to 12px. (2 edits, ~5 lines changed)."
- The agent includes a brief reasoning or explanation (e.g., "Increased padding to match design token spacing scale").
- If the agent edited multiple files, a summary lists each file and the number of changes.
- User can expand each summary to see the full diff.

---

### Epic 6: Undo/Redo via Git Checkpoints

#### US-6.1: Developer Undoes a Change via Git Checkpoint
**As a** developer  
**I want to** click "Undo" and revert the last agent edit  
**So that** I can roll back bad changes or experiment with alternative approaches.

**Acceptance Criteria:**
- Each accepted and committed edit is a git checkpoint with a message like "Easel: change button color to red".
- An "Undo" button is visible in the toolbar (greyed out if there are no checkpoints to undo).
- Clicking "Undo" moves the checkpoint pointer back one and restores the working tree to the previous checkpoint's state (via git reset --hard).
- The webview reloads to reflect the reverted state.
- The undo action is recorded in Easel's internal checkpoint timeline for redo.
- Undo can be repeated to go back multiple edits (standard undo/redo semantics).

---

#### US-6.2: Developer Redoes an Undone Change
**As a** developer  
**I want to** click "Redo" after undoing, to re-apply the change  
**So that** I can recover from an undo without retyping the instruction.

**Acceptance Criteria:**
- A "Redo" button is visible in the toolbar (greyed out if there's nothing to redo).
- Clicking "Redo" reapplies the last undone commit.
- The webview reloads to reflect the re-applied state.
- Redo is available until the user makes a new edit (standard git behavior: new commits clear the redo stack).

---

#### US-6.3: Developer Views a History of All Edits
**As a** developer  
**I want to** see a git log / timeline of all edits made via Easel in this session  
**So that** I can navigate to a previous state, understand the progression of changes, and review what the agent did.

**Acceptance Criteria:**
- A "History" panel or sidebar shows a list of commits: timestamp, instruction text, file(s) changed, diff summary.
- User can click any commit to see its full diff.
- User can click any commit to git reset --hard to that point (with a confirmation dialog).
- Commits are labeled with the original instruction text (e.g., "make button red").

---

### Epic 7: Image Replace & Generate

#### US-7.1: Developer Selects an Image Element and Replaces It
**As a** developer  
**I want to** click on an <img> or background-image element and issue an instruction like "replace with a golden doodle"  
**So that** I can swap out placeholder images without manually finding/uploading new files.

**Acceptance Criteria:**
- User selects an <img> or element with background-image via ElementSelect mode.
- The element inspector identifies it as an image element and shows the current src/URL.
- An instruction might be: "replace with a golden doodle photo".
- Agent backend checks if an ImageProvider is configured; if yes, calls it to generate or fetch the image.
- The ImageProvider returns a URL or a base64-encoded image.
- Agent updates the src attribute or background-image CSS property to point to the new image.
- Dev server reloads; the new image is displayed in the preview.
- If no ImageProvider is configured, the agent can suggest a placeholder image URL or ask the user to provide one.

---

#### US-7.2: Developer Generates an Image via Prompts
**As a** developer  
**I want to** say "generate a hero image for a SaaS landing page, showing a team collaboration scene"  
**So that** I can quickly create a unique, on-brand image without stock-photo hunting or Photoshop.

**Acceptance Criteria:**
- An instruction like "generate a hero image: team collaboration, modern, bright colors" triggers the agent to call the ImageProvider with a detailed prompt.
- ImageProvider (if plugged in) calls an image generation API (e.g., DALL-E, Midjourney, etc.) and returns a URL or image data.
- Agent inserts the image into the HTML (new <img> tag or updates an existing one).
- User sees the generated image in the preview immediately.
- If image generation fails (API quota, network error, etc.), user sees a friendly error and can retry or use a fallback image.

---

### Epic 8: Pluggable Agent Backends & Settings

#### US-8.1: Developer Selects Between Agent Backends and Authentication Modes
**As a** developer  
**I want to** choose an agent backend and configure how it authenticates  
**So that** I can pick the backend and credentials method that best fits my use case.

**Acceptance Criteria:**
- Settings dialog has an "Agent Backend" dropdown with three options:
  - "Claude Agent SDK" (full coding agent, git-aware; recommended)
  - "Anthropic API" (hand-built agent loop, leaner and cheaper)
  - "Local OpenAI-Compatible" (Ollama, LM Studio, llama.cpp; variable reliability)
- For Claude Agent SDK, a nested "Auth Mode" selector appears:
  - **Inherit** (default, recommended): Easel uses no credential env vars; the SDK uses whatever Claude credential exists on the machine (e.g., existing Claude Code login → Pro/Max plan). Normal use incurs no extra API spend.
  - **API Key**: User provides Anthropic API key; Easel sets ANTHROPIC_API_KEY in the SDK subprocess only, for this edit.
  - **Bedrock**: Easel sets CLAUDE_CODE_USE_BEDROCK=1; credentials come from ambient AWS credential chain.
  - **Vertex**: Easel sets CLAUDE_CODE_USE_VERTEX=1; credentials come from Application Default Credentials (GCP).
  - **Gateway**: User provides a custom base URL and bearer token for routing to local/alternative models.
- For Anthropic API, a required API Key field appears.
- For Local OpenAI-Compatible, base URL and model name fields appear, with optional API key.
- Selecting a backend/auth mode updates the app config (stored in settings).
- User can switch backends/modes at any time; the next edit uses the new configuration.
- Easel never implements a custom "Login with Claude" OAuth flow; inherit mode simply delegates to the SDK's own credential resolution.

---

#### US-8.2: Developer Configures API Keys & Provider Settings
**As a** developer  
**I want to** securely enter API keys (Anthropic, image provider, gateway) in settings  
**So that** the agent can access the APIs on my behalf.

**Acceptance Criteria:**
- Settings dialog displays fields for API keys depending on the selected backend and auth mode:
  - Anthropic API Key (required for "Anthropic API" backend and "API Key" auth mode of Claude SDK). Stored securely via Electron safeStorage, never logged, never sent to renderer.
  - Gateway Auth Token (required for Claude SDK "Gateway" mode). Also secure-stored.
  - Local OpenAI API Key (optional for "Local OpenAI-Compatible" backend if the server requires authentication). Secure-stored.
  - Image Provider API Key (optional, e.g., for DALL-E, Replicate, etc.). Secure-stored.
- Keys are validated when saved (e.g., a connectivity check or test call).
- If a key is invalid, user sees a clear error message; the old key remains in use until corrected.
- Keys are never displayed in plain text; the UI shows only the last 4 characters (e.g., `…aB3x`) plus a "Set" or "Change" button.
- An option to "Clear & Re-enter" revokes the key and removes it from storage.
- No telemetry or analytics are sent (privacy-first approach).

---

#### US-8.3: Developer Enables/Disables Advanced Features
**As a** developer  
**I want to** toggle advanced features (voice input, image generation, detailed logging)  
**So that** I can streamline the UI for my workflow and save costs on features I don't use.

**Acceptance Criteria:**
- Settings dialog has toggles for:
  - "Voice Input" (on/off; disables microphone button if off).
  - "Image Generation" (on/off; if off, image replacement falls back to URL input).
  - "Detailed Logging" (on/off; if on, logs agent operations and API calls to a file for debugging).
  - "Auto-accept changes" (on/off; if on, skips the diff review and auto-commits after agent finishes).
- Toggling a setting applies immediately (for toggles) or on next edit (for API keys).
- Defaults are conservative (features disabled unless the user has API keys set up).

---

### Epic 9: Multi-Element & Multi-Annotation Edits

#### US-9.1: Developer Edits Multiple Elements with One Instruction
**As a** developer  
**I want to** select three buttons and issue an instruction like "increase font size to 16px and add margin-bottom of 8px"  
**So that** I can apply consistent styling across related elements in one shot.

**Acceptance Criteria:**
- Using ElementSelect multi-select mode, user selects 3 or more elements.
- Instruction is attached to the multi-selection (e.g., "increase font size to 16px").
- EditRequest includes all selected elements' CSS selectors and source hints.
- Agent backend analyzes the elements and issues edits to the relevant CSS/component files to apply the instruction to all selected elements.
- Diff review shows changes to each component file.
- User accepts or rejects the bundled changes.

---

#### US-9.2: Developer Combines Element Selections and Freeform Annotations
**As a** developer  
**I want to** click on one element, then draw a freeform annotation around a separate region, and issue a global instruction like "align these two sections"  
**So that** I can coordinate changes across different interaction modes.

**Acceptance Criteria:**
- User selects one element via ElementSelect mode.
- User switches to Freeform mode and draws an annotation around a different region.
- Both selections are captured in a single EditRequest (one element target, one annotation with screenshot).
- A single instruction applies to both (e.g., "make these align to the left edge").
- Agent backend receives both and makes coordinated edits.

---

## 4. Functional Requirements

| ID   | Requirement                                                                                  | Priority | Status       |
|------|----------------------------------------------------------------------------------------------|----------|--------------|
| FR-1 | Detect and embed the running dev server URL in the webview                                  | Must     | MVP          |
| FR-2 | Allow manual configuration of dev server URL via settings                                   | Must     | MVP          |
| FR-3 | Implement ElementSelect mode: hover-highlight + click to select a DOM element                | Must     | MVP          |
| FR-4 | Capture robust CSS selector and bounding box for selected elements                          | Must     | MVP          |
| FR-5 | Display source file and line number (via data-easel-source attribute or fallback grepping)  | Must     | MVP          |
| FR-6 | Support multi-element selection in ElementSelect mode                                       | Must     | MVP          |
| FR-7 | Implement Freeform mode: draw rectangles, circles, arrows, freehand strokes                 | Must     | MVP          |
| FR-8 | Capture annotation geometries (stroke coordinates, shape types) and cropped screenshot       | Must     | MVP          |
| FR-9 | Support chaining multiple freeform annotations before submission                            | Should   | MVP          |
| FR-10 | Accept text instruction input for both ElementSelect and Freeform modes                    | Must     | MVP          |
| FR-11 | Implement voice instruction input via Web Speech API (with graceful degradation)            | Should   | MVP          |
| FR-12 | Maintain a history of recent instructions for quick re-use                                 | Could    | Post-MVP    |
| FR-13 | Build EditRequest object combining instruction + context (elements/annotations/screenshot)  | Must     | MVP          |
| FR-14 | Route EditRequest to selected agent backend (Claude SDK, Anthropic API, or Local OpenAI)   | Must     | MVP          |
| FR-15 | Stream AgentEvent progress updates to the renderer during agent processing                 | Must     | MVP          |
| FR-16 | Display real-time progress panel: "Analyzing...", "Editing file X", "Waiting for reload"  | Must     | MVP          |
| FR-17 | Trigger webview reload/HMR when dev server signals a change                                | Must     | MVP          |
| FR-18 | Display a diff review panel: old code (red), new code (green), file-by-file view           | Must     | MVP          |
| FR-19 | Allow user to accept or reject the agent's changes (after they are applied to disk)        | Must     | MVP          |
| FR-20 | Revert to previous git checkpoint if user rejects changes (commit-after-apply model)       | Must     | MVP          |
| FR-21 | Display a summary message of agent actions (files edited, number of changes)                | Must     | MVP          |
| FR-22 | Create one git commit per accepted EditRequest after changes are applied (commit-after-apply) | Must | MVP |
| FR-23 | Implement undo: revert to the previous git checkpoint and reload the webview                | Must     | MVP          |
| FR-24 | Implement redo: re-apply an undone commit                                                  | Must     | MVP          |
| FR-25 | Display git history/timeline of all edits in this session                                  | Should   | MVP          |
| FR-26 | Allow navigation to any previous git checkpoint via history UI                             | Should   | MVP          |
| FR-27 | Detect <img> and background-image elements; allow image replacement instruction            | Should   | MVP          |
| FR-28 | Call plugged ImageProvider to generate or fetch replacement images                        | Should   | MVP          |
| FR-29 | Support image generation from textual prompts                                              | Could    | Post-MVP    |
| FR-30 | Implement AgentBackend interface with three implementations (Claude SDK, Anthropic API, Local OpenAI) | Must | MVP |
| FR-31 | Allow user to select between agent backends and auth modes in settings                    | Must     | MVP          |
| FR-31a | Claude SDK: support inherit (default), api-key, bedrock, vertex, gateway auth modes      | Must     | MVP          |
| FR-31b | Anthropic API: require API key; validate and store securely                              | Must     | MVP          |
| FR-31c | Local OpenAI: accept base URL, model name, optional API key; warn of variable reliability | Should   | MVP          |
| FR-32 | Store API keys securely using Electron safeStorage                                         | Must     | MVP          |
| FR-33 | Provide settings dialog for configuring Anthropic API key                                 | Must     | MVP          |
| FR-34 | Provide settings dialog for optional ImageProvider API key                                 | Should   | MVP          |
| FR-35 | Provide settings dialog for optional custom ImageProvider URL                              | Could    | Post-MVP    |
| FR-36 | Validate API keys on save; test connectivity to confirm valid credentials                 | Must     | MVP          |
| FR-37 | Toggle voice input feature on/off in settings (graceful degradation if unsupported)       | Should   | MVP          |
| FR-38 | Toggle image generation feature on/off in settings                                         | Should   | MVP          |
| FR-39 | Toggle detailed logging on/off; write logs to a file for debugging                        | Could    | Post-MVP    |
| FR-40 | Toggle auto-accept changes (skip diff review); default off                                 | Could    | Post-MVP    |
| FR-41 | Remember last opened project folder; auto-open on app startup                              | Should   | MVP          |
| FR-42 | Support concurrent multi-element and multi-annotation edits in single instruction          | Should   | MVP          |
| FR-43 | Gracefully handle agent backend switching at runtime                                       | Should   | MVP          |
| FR-44 | Provide an "Inject @easel/vite-plugin-inspector" flow for projects that don't have it      | Could    | Post-MVP    |
| FR-45 | Fall back to CSS-selector-based source mapping if vite plugin not installed                | Must     | MVP          |

---

## 5. Non-Functional Requirements

| ID   | Requirement                                                                                  | Target   | Rationale              |
|------|----------------------------------------------------------------------------------------------|----------|------------------------|
| NFR-1 | Edit latency: from submission to first visible change on screen < 3 seconds                 | P0       | Real-time feedback critical to UX |
| NFR-2 | API call latency: agent response time < 15 seconds for typical instructions                 | P0       | Iteration speed |
| NFR-3 | App startup time: cold launch < 2 seconds, warm launch < 500ms                            | P1       | Daily usability |
| NFR-4 | Preview webview should not freeze during agent processing (async/non-blocking)              | P0       | Responsiveness |
| NFR-5 | All API keys stored encrypted via Electron safeStorage; never logged or sent over cleartext | P0       | Security & compliance |
| NFR-6 | No telemetry, analytics, or phoning-home by default (opt-in only, explicit consent)        | P0       | Privacy-first |
| NFR-7 | Git checkpoint data stored locally only; no cloud sync or backups (user's responsibility)   | P0       | Data ownership |
| NFR-8 | Cross-platform support: macOS, Windows, Linux (via Electron)                               | P0       | Inclusivity |
| NFR-9 | Accessibility: WCAG 2.1 Level A compliance for UI controls, keyboard navigation support    | P1       | Inclusive design |
| NFR-10 | Error messages are specific and actionable (not "Error"; e.g., "API key invalid: check Settings") | P1 | User support |
| NFR-11 | Agent backend interface is versioned; supports future backend implementations                | P1       | Extensibility |
| NFR-12 | ImageProvider interface is pluggable; default no-op provider (returns placeholder)          | P1       | Extensibility |
| NFR-13 | Renderer-main IPC is fully typed (no string-based magic); all channels in src/shared/ipc.ts | P0       | Type safety |
| NFR-14 | Main process never crashes from a bad EditRequest; malformed inputs are logged and rejected | P0       | Reliability |
| NFR-15 | Webview contextIsolation ON; renderer cannot access preload or node APIs                    | P0       | Security |
| NFR-16 | WebGL/Canvas performance: freeform drawing remains smooth at 60fps (target < 16ms per frame) | P1       | UX polish |
| NFR-17 | Code editing must never corrupt source files; all edits validated pre-write (formatting, syntax) | P0 | Data integrity |
| NFR-18 | Undo/redo via git is atomic: each checkpoint is a clean, reversible state                   | P0       | Reliability |
| NFR-19 | File watch/HMR resilience: app handles dev server restarts and network hiccups gracefully   | P1       | Robustness |
| NFR-20 | Documentation (README, ARCHITECTURE, API reference) kept in sync with code                 | P1       | Maintainability |

---

## 6. MVP Scope vs. Post-MVP

### In MVP (M0–M3, Delivery: End of Q3 2026)

**Core functionality:**
- Dev server embedding (webview + live reload).
- ElementSelect mode: click to select, see source file.
- Freeform mode: draw shapes & strokes, capture geometry & screenshot.
- Text instruction input; voice input (if Web Speech API available).
- Agent edit pipeline: Claude Agent SDK and Anthropic Messages API (both implementations shipping).
- Diff review & accept/reject.
- Git-backed undo/redo.
- Settings: API key configuration, backend selection, feature toggles (voice, image generation).
- Image replacement (via pluggable ImageProvider interface; stub provider included).

**Not in MVP:**
- Image generation from prompts (v1.1).
- History timeline UI (git log accessible via CLI; UI in v1.1).
- Custom ImageProvider URL configuration UI (can be added manually in future).
- Auto-accept changes toggle (v1.1).
- Detailed logging UI (v1.1).
- Instruction history/re-use suggestions (v1.1).
- IDE integration (VS Code extension, etc.; post-MVP exploration).
- Collaborative features (sharing, real-time sync; far future).
- Mobile support (Easel is desktop-first).

---

## 7. Milestones & Delivery Timeline

### Milestone 0 (M0): Scaffolding & Infrastructure (Weeks 1–2)
**Deliverables:**
- Electron + electron-vite project set up (main, preload, renderer).
- IPC contract defined in src/shared/ipc.ts (typed channels).
- Settings store and API key management (Electron safeStorage).
- AgentBackend interface and plugin architecture.
- Project detector and dev server URL validator.
- Basic UI shell: window layout, toolbar, empty preview.

**Acceptance:** Project compiles, IPC channels are typed, settings are persisted.

---

### Milestone 1 (M1): Interaction Modes & Annotation (Weeks 3–6)
**Deliverables:**
- ElementSelect mode: hover-highlight, click-select, multi-select, source mapping fallback.
- Freeform mode: drawing tools (rect, circle, arrow, pen), annotation geometry capture.
- Webview preload script for element hit-testing and selector generation.
- Annotation overlay (SVG/Canvas on top of webview).
- Text and voice instruction input; instruction submission flow.
- Instruction validation (non-empty, reasonable length).

**Acceptance:** User can click/draw/annotate and submit an instruction without errors.

---

### Milestone 2 (M2): Agent Integration & Edit Pipeline (Weeks 7–11)
**Deliverables:**
- Claude Agent SDK implementation (agent.ts with file tools, git awareness).
- Anthropic Messages API implementation (hand-built agent loop with custom tools).
- EditRequest builder (combines instruction + context).
- AgentEvent streaming back to renderer.
- Progress panel in renderer (real-time updates).
- Dev server reload detection and webview HMR handling.
- Diff review panel (side-by-side code view).
- Accept/reject logic with git checkpoint commits.
- Initial error handling and logging.

**Acceptance:** User can issue an instruction, agent edits a file, diff is displayed, user accepts, git checkpoint is created.

---

### Milestone 3 (M3): Polish, Undo/Redo, Settings & Release (Weeks 12–16)
**Deliverables:**
- Undo/redo buttons and git-checkpoint-based reversions.
- Settings dialog: API key entry, backend selection, feature toggles.
- Image replacement mode and pluggable ImageProvider interface.
- Comprehensive error messages and user guidance.
- Cross-platform testing (macOS, Windows, Linux).
- README, ARCHITECTURE.md, FILE_MANIFEST.md.
- @easel/vite-plugin-inspector package (published to npm).
- Electron app signing and distribution (DMG for macOS, NSIS for Windows, AppImage/snap for Linux).
- CI/CD pipeline for builds.

**Acceptance:** App is signed, installable, documented, and passes smoke tests on all platforms.

---

## 8. Risks & Mitigations

| Risk                                                                            | Likelihood | Impact | Mitigation                                                                                |
|---------------------------------------------------------------------------------|------------|--------|-------------------------------------------------------------------------------------------|
| Element-to-source mapping unreliable: CSS selectors are fragile, grepping fails | High       | High   | Require @easel/vite-plugin-inspector for full accuracy; fallback selector + context is good enough for 80% of cases. Provide clear "Source: inferred" label. |
| Agent edits corrupt source files (syntax errors, breaking changes)              | Medium     | Critical | Validate edits pre-write (AST check, formatter run). Always use git checkpoints (atomic). Test agent on known projects before release. Dry-run mode in dev. |
| Agent costs: high API call volume during user iteration                         | Medium     | Medium | Default to Anthropic Messages API (cheaper). Provide token/cost estimates. Offer per-request toggles. Set soft limits (warn user at $10/session). |
| Dev server crashes or hot-reload fails; user sees stale preview                | Medium     | Medium | Monitor dev server health; detect crashes and reconnect. Show "Preview disconnected" state. Auto-reload fallback. |
| Webview preload script injection fails; hit-testing breaks                      | Low        | High   | Test preload injection on multiple dev servers. Graceful fallback: CSS-selector-only mode (no source mapping). |
| User's disk is out of space; git checkpoint fails                              | Low        | High   | Check free space before each edit. Show warning dialog. Suggest cleaning up old checkpoints. |
| Image generation API quota exhausted                                           | Medium     | Low    | Graceful error message. Fallback to placeholder. Suggest user check API credits. |
| Voice input unsupported in user's browser/OS                                    | Low        | Low    | Detect Web Speech API availability. Disable voice button with explanation. Text input always available. |
| Electron contextIsolation misconfiguration; XSS in webview                     | Medium     | Critical | Code review IPC boundaries. Automated security testing (no eval, no innerHTML on untrusted input). Audit preload script. |

---

## 9. Success Metrics & KPIs (Post-Launch)

| Metric                                         | Target   | Rationale                                                        |
|------------------------------------------------|----------|------------------------------------------------------------------|
| User satisfaction (NPS or post-launch survey) | ≥ 70     | Core product is delightful                                       |
| Feature adoption (voice, multi-select, etc.)  | ≥ 60%    | Advanced features are discoverable and valued                    |
| Agent success rate (edit accepted by user)    | ≥ 85%    | Agent is reliable and produces good changes                      |
| Edit latency (submission to visible change)   | < 3 sec  | Real-time feedback loop is responsive                            |
| Crash-free hours                              | ≥ 99%    | App is stable and reliable                                       |
| API cost per session (Anthropic)              | < $2     | Economical for users; sustainable business model                 |
| Retention (weekly active users)               | ≥ 40%    | Users find ongoing value; not a one-time toy                     |
| GitHub stars (if open-sourced)                | ≥ 500    | Community interest and adoption                                  |
| Developer sentiment (GitHub issues/feedback)  | Positive | Users report genuine productivity gains                          |

---

## 10. Assumptions & Dependencies

### Key Assumptions
1. **Dev servers are standard** (localhost, typical ports 3000–8000; auto-detect works for 90%+ of projects).
2. **Vite plugin adoption is reasonable** (projects with the plugin get source mapping; projects without fallback to CSS-selector grepping).
3. **Claude Agent SDK and Messages API are stable** during MVP development (we're building on released, documented APIs).
4. **Users have valid Anthropic API keys and budget** for the initial product; cost management comes in v1.1 if needed.
5. **HMR/dev server reloads are reliable** (Vite, Next.js, etc. work as expected).
6. **Web Speech API is available on most modern OSes** (fallback to text-only is acceptable).
7. **Git is available in the user's project** (Easel assumes a git repo; checkpoints require git).

### External Dependencies
- **@anthropic-ai/sdk** (Anthropic Messages API client)
- **@anthropic-ai/claude-agent-sdk** (Claude Agent SDK)
- **Electron** (desktop framework)
- **React 18, Tailwind CSS, Zustand** (renderer UI)
- **electron-vite** (build tooling)
- **lucide-react** (icons)
- Optional: **DALL-E, Midjourney, Replicate** (image generation, via pluggable providers)

---

## 11. Glossary & Definitions

| Term | Definition |
|------|-----------|
| **EditRequest** | A data structure combining a user's instruction, selected element targets, freeform annotations, and screenshot, sent to the agent backend for processing. |
| **AgentEvent** | A streaming event emitted by the agent backend (e.g., "parsing", "identifying files", "writing changes", "done"), relayed to the renderer for progress display. |
| **Checkpoint** | A git commit snapshot of the source code at a point in time. Easel creates one checkpoint per accepted edit, enabling undo/redo. |
| **Hot Module Reload (HMR)** | A dev server feature (Vite, Next.js, etc.) that reloads only changed modules in the browser without a full page refresh. |
| **Freeform Annotation** | A user-drawn shape or stroke (rectangle, circle, arrow, freehand) placed on top of the preview, with an attached instruction. |
| **ElementSelect Mode** | An interaction mode where the user clicks a DOM element to select it and attach an instruction. |
| **Freeform Mode** | An interaction mode where the user draws shapes/strokes to annotate regions of the page. |
| **ImageProvider** | A pluggable interface for generating or fetching replacement images (e.g., via DALL-E). |
| **AgentBackend** | A pluggable implementation of the agent (e.g., Claude Agent SDK or Anthropic Messages API). |
| **CSS Selector** | A robust, unique identifier for a DOM element (e.g., `div.hero-section > h1.title`). |
| **data-easel-source** | An HTML attribute stamped on elements by the @easel/vite-plugin-inspector, recording the source file and line number. |
| **Source Mapping** | The process of identifying which source file and line a rendered DOM element originates from. |
| **Diff Review** | A UI panel showing the before/after code changes, allowing the user to accept or reject the agent's edits. |
| **Preload Script** | An Electron script that runs in the main/renderer bridge, with access to Node.js APIs (e.g., IPC, file system). |
| **WebView** | An Electron <webview> tag that embeds a web page (the dev server) into the app. |
| **Webview Preload** | A script injected into the webview (guest process) to enable element hit-testing and selector generation. |
| **IPC (Inter-Process Communication)** | Typed message channels between Electron's main and renderer processes. |

---

## Appendix: User Story Map

```
                    Project Connection
                          |
                ___________+___________
               |                       |
          Dev Server               Settings
          Embedding               & Backends
               |                       |
        [Select Project]      [Configure API]
        [Auto-detect URL]     [Select Backend]
        [Manual URL Entry]    [Enable Features]
               |                       |
        Interaction Modes         Instruction
             |                    Input
         ____|____              |
        |        |         _____|_____
      Click   Draw      |           |
      (Select) (Freeform)  Text   Voice
        |        |        |        |
     [Hover]  [Shapes]  [Type]  [Speak]
     [Click]  [Strokes]         [Transcribe]
     [Multi]  [Erase]           [Edit]
        |        |        |        |
        +--------+--------+--------+
                 |
            Submit Edit
                 |
         Agent Processing
         (Edit Pipeline)
                 |
        _________|_________
       |                   |
    Progress           Live Reload
    Display            & Re-render
       |                   |
   [Streaming]         [HMR/Reload]
   [Status Msgs]       [Preview Update]
       |                   |
       +---────+───────────+
               |
          Diff Review
               |
       _________|_________
      |                   |
    Accept              Reject
      |                   |
  Git Commit         Git Rollback
  Undo Stack        Clear Pending
      |                   |
    Success            Reverted
      |                   |
  Enable Undo         Back to Edit
  Disable Redo
```

---

## Document History

| Version | Date      | Author | Changes |
|---------|-----------|--------|---------|
| 1.0     | Jun 2026  | PM     | Initial MVP specification |

---

**End of Requirements Document**

---

**Document Status:** APPROVED FOR MVP IMPLEMENTATION  
**Next Review:** After M1 completion (week 6) for scope validation.
