# Easel — Architecture & Foundation Review Notes

**Reviewer:** Staff Architecture Reviewer
**Date:** 2026-06-23
**Scope:** `src/shared/{types,agent,ipc}.ts`, `package.json`, `electron.vite.config.ts`, the three
tsconfigs + plugin tsconfig, `docs/{ARCHITECTURE,FILE_MANIFEST,REQUIREMENTS,ELEMENT_SOURCE_MAPPING}.md`,
and the placeholder source stubs.
**Question asked:** Are the foundations consistent and implementation-ready?

**Verdict:** **Not yet ready.** The three shared contract files (`types.ts`, `agent.ts`, `ipc.ts`)
are high quality, internally coherent, and compile cleanly as written. However there is a tier of
**critical build/contract gaps** and a set of **doc-vs-contract contradictions** that the
implementation phase will hit on day one. They must be fixed first. Specific findings below; severities
are summarized in the returned issues list.

---

## 1. Critical — build & toolchain will not work as shipped

### 1.1 The webview-preload (`inspector.ts`) is never built
`electron.vite.config.ts` defines exactly three build targets: `main`, `preload`, `renderer`. The
config's own comment (lines 13–15) claims the guest inspector "is built separately in the main build
output," and `ARCHITECTURE.md` §4.1 + `FILE_MANIFEST.md` rely on a compiled
`src/preload/webview/inspector.ts` to set as the `<webview preload=…>` attribute — but **no build entry
emits it**. electron-vite's `preload` target only bundles `src/preload/index.ts`. As written, the guest
inspector is dead code and the entire element-selection / freeform-mapping subsystem (the product's core)
cannot run. Fix: add a second preload entry (electron-vite supports multiple preload inputs via
`build.rollupOptions.input`) or a dedicated lib build that emits `out/preload/webview/inspector.js`, and
document the exact runtime path `src/main/window.ts` will reference.

### 1.2 `tsconfig.json` type-checks nothing under the `typecheck` script
The root `tsconfig.json` has `"include": []` and uses project `references` to `tsconfig.node.json` and
`tsconfig.renderer.json`. References are only honored in **build mode** (`tsc -b`). The `typecheck`
script is `tsc --noEmit` (not `tsc -b --noEmit`), so it compiles the empty root include set and exits
**0 without checking any file**. CI/precommit will give a false green. Fix: either change the script to
`tsc -b --noEmit` (and add `composite: true` to the referenced configs, which is required for
references), or point `typecheck` at the leaf configs explicitly
(`tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.renderer.json --noEmit`). Note: `composite` is
currently absent from both referenced configs, so even `tsc -b` would error today.

### 1.3 `@types/electron` is a deprecated stub and will shadow real types
`package.json` devDeps include `@types/electron@^1.6.10`. Electron has shipped its own bundled type
definitions since v1.x; the DefinitelyTyped `@types/electron` package is a long-deprecated stub pinned at
1.6.10 (years out of date). Installing it can shadow/conflict with Electron 32's real types and cause
spurious or missing type errors in `main`/`preload`. Fix: remove `@types/electron` entirely; rely on
`electron`'s own types.

### 1.4 Renderer tsconfig is named `tsconfig.renderer.json`, but every doc says `tsconfig.web.json`
The real file is `tsconfig.renderer.json` (and the root `references` + `.eslintrc.cjs` `parserOptions.project`
both point at `tsconfig.renderer.json`). `FILE_MANIFEST.md` line 137 and `ARCHITECTURE.md`'s tooling notes
call it `tsconfig.web.json`. Pick one name and make docs + references + eslint agree. (Functionally the
code currently uses `renderer`; the manifest is wrong.)

---

## 2. Critical — doc claims that contradict the actual contracts

These will mislead implementers who follow the docs literally.

### 2.1 `AgentEvent` has no `progress`/`warning` variants, but ELEMENT_SOURCE_MAPPING relies on them
`ELEMENT_SOURCE_MAPPING.md` (§4 failure handling, §6 confidence summary, line 467) says the system emits
`AgentEvent` of `type: 'progress'` with `type: 'warning'`, and "the confidence value is included in the
`AgentEvent` of type `'progress'`." **No such variant exists.** The real union is
`thinking | tool-call | file-edit | message | diff | checkpoint | done | error`. There is **nowhere** in
the contract to surface per-target `ConfidenceLevel`, the "I think this is Hero.tsx, confirm?" prompt, or
a non-fatal warning. This is a real contract gap, not just a doc typo: confidence scoring is a headline
feature of the mapping design and the streaming protocol cannot express it. Fix: add a `confidence` (or
`warning`/`needs-confirmation`) variant to `AgentEvent` carrying `{ targetId?, confidence, message }`, and
update the doc to use real type names.

### 2.2 No mechanism for the agent to ask the user to confirm / pick a file
ELEMENT_SOURCE_MAPPING §4 and the confidence table both require an interactive "confirm this file"
round-trip ("Ask user to confirm file" for low confidence; "Block edit, prompt user" for none). The
`AgentBackend.editStream` contract is a one-way `AsyncIterable<AgentEvent>` ending in `done`/`error`;
there is no inbound channel for a user answer mid-stream, and `editCancel` is the only inbound edit
control. As designed, a `low`/`none` confidence edit can only either guess or fail — it cannot pause for
input. Decide the MVP behavior: (a) downgrade to "block + error with code `needs-file`, user re-submits
with an explicit file hint" (cheapest, fits current contract), or (b) add a request/response interaction
event. Either way, the doc currently overpromises relative to the contract.

### 2.3 `ElementTarget` shape in the doc does not match `types.ts`
ELEMENT_SOURCE_MAPPING §3 prints an `ElementTarget` with `sourceFile/sourceLine/sourceCol`, `cssSelector`,
`textContent`, `relevantAttributes`, `innerHtml`, and `boundingBox: DOMRect`. The real `types.ts`
interface uses `dataEaselSource: SourceLocation`, `selector`, `textSnippet`, `attributes`, `boundingBox:
BoundingBox`, plus `id`, `pluginPresent`, `confidence`, and has **no** `innerHtml`. Two concrete
consequences: (1) the doc's grep heuristics reference `innerHtml` (first 500 chars) that the contract
never carries; decide whether to add it or drop those heuristics. (2) `DOMRect` is not serializable across
the guest→host `postMessage`/`ipc-message` boundary the way a plain `BoundingBox` is — the doc's snippet
would break in practice. Align the doc to the real type (or vice versa) before anyone codes the inspector.

### 2.4 Checkpoint timing contradicts FR-22 / the accept-reject flow
`types.ts`, `agent.ts`, and `ARCHITECTURE.md` §3 create a git checkpoint **after the edit is applied but
before the user accepts** (the backend emits a `checkpoint` event, then `done`; the user then accepts or
"rejects" by restoring the prior checkpoint). But `REQUIREMENTS.md` FR-22 says "Create one git commit per
**accepted** EditRequest," and FR-19/FR-20 describe accept/reject as happening *before* anything is
committed. These are two different models (commit-then-maybe-revert vs. stage-then-commit-on-accept). They
need reconciling. The implemented contract favors commit-then-revert; if that is the decision, FR-19/20/22
wording must change, and the "Reject" semantics (restore previous checkpoint) must be the source of truth.

### 2.5 Inspector channel/message names in ELEMENT_SOURCE_MAPPING do not match `ipc.ts`
The doc uses string channels `inspector:element-selected`, `inspector:query-rect`,
`webview:reload-complete`, and `window.parent.postMessage`. The real contract (`ipc.ts`
`InspectorMessage`/`InspectorCommand`) uses structured discriminated unions sent via
`ipcRenderer.sendToHost` / `<webview>.send` with `type: 'element-picked' | 'element-hover' | ...`. The doc
also references registering these as **main-process** IPC channels (§7 step 6: "`src/main/ipc.ts`:
Register `inspector:element-selected`…") — but per ARCHITECTURE §2.4/§6.3 the guest↔host channel is
renderer-local and never touches main. Fix the doc to use the typed unions and the correct process
boundary.

---

## 3. Major — contract gaps the edit pipeline / IPC will need

### 3.1 No IPC channel to feed `InspectorCommand`/`InspectorMessage` mode changes from store → webview
`InspectorCommand` (`set-mode`/`highlight`/`request-target`) and `InspectorMessage` are defined, but they
travel renderer↔guest directly via the `<webview>` element. That is fine — however the **region-query for
freeform mode** (ARCHITECTURE §3.2 step 3 / ELEMENT_SOURCE_MAPPING §5: "send the annotation's bounding box
down to the guest … posts back a ranked `ElementTarget[]`") has **no representative in either union**.
`InspectorCommand` has no `query-region` variant and `InspectorMessage` has no `region-resolved` variant.
Freeform→source mapping, a first-class MVP mode, is unrepresentable in the current contract. Add
`InspectorCommand { type: 'query-region'; box: BoundingBox; queryId: string }` and
`InspectorMessage { type: 'region-resolved'; queryId: string; targets: ElementTarget[] }`.

### 3.2 `previewCapture` exists but the screenshot flow is renderer-side per the docs
`ipc.ts` exposes `preview.capture` (`PreviewCaptureResponse`) and `ARCHITECTURE`/`FILE_MANIFEST` also say
the renderer composites the screenshot itself in `src/renderer/lib/screenshot.ts`. Two screenshot paths
exist with no statement of which is authoritative for `EditRequest.screenshotDataUrl`. Electron
`<webview>` content cannot be read by renderer canvas APIs cross-process (the guest is a separate
WebContents), so the renderer-side `captureRegion` in `screenshot.ts` likely **cannot** capture the
webview pixels — it can only capture the overlay. Capturing the actual page almost certainly must go
through main (`webContents.capturePage`) via `preview.capture`. Clarify the contract: who composites,
which process captures, and whether `preview.capture` takes a bbox argument (it currently takes none but
the response is "the captured region").

### 3.3 `validate?` on the backend has no path to the `settings.validateBackend` IPC handler's context
`settings.validateBackend` returns `{ ok, problem? }` and `AgentBackend.validate?(ctx)` produces the same
shape — good. But `validate` requires a full `AgentBackendContext` (projectRoot, fs, imageProvider,
createCheckpoint, signal). Validating a backend from Settings may happen with **no project open**. The
contract gives no "lightweight context" for validation; building a full context (esp. `ProjectFs` rooted
at a non-existent project) is awkward. Consider a separate minimal `ValidateContext { settings, apiKey,
logger, signal }` or make the heavy fields optional for the validate path.

### 3.4 No `cancelled`/terminal correlation between `editCancel` and the stream
`edit.cancel` triggers `ctx.signal` abort and the backend yields a terminal `error{code:'cancelled'}` —
described well in `agent.ts`. But `EditCancelRequest` returns `IpcResult<void>` and there is no guarantee
in the contract that the **stream's** terminal `error` will still arrive on `edit.event` after cancel
(vs. the host tearing down the iterator). The renderer needs to know definitively when an in-flight edit
is fully done. Document that the host always relays exactly one terminal event per `requestId` even on
cancel, and that the renderer should key completion off the `edit.event` terminal, not the
`edit.cancel` ack.

### 3.5 `AgentEvent.file-edit` duplicates data already in `FileDiff`
`file-edit` carries both `filePath` and `diff: FileDiff`, and `FileDiff` already has `filePath`. Minor
redundancy that invites drift (which wins if they disagree?). Drop the outer `filePath` or document that
`diff.filePath` is authoritative.

### 3.6 `Annotation.boundingBox` / `points` are required, but `pin` is one point and overlay needs scroll
`Annotation` stores coordinates "in preview-viewport CSS pixels" while the guest reports
`viewport-changed { scrollX, scrollY }`. There is no field tying an annotation to the scroll offset at
which it was drawn, so after scrolling, a stored annotation's `points` (viewport-relative) no longer map
to the same content. Either store annotations in **content/document coordinates** (page-relative, scroll-
independent) or add the scroll origin to `Annotation`/`AnnotationBatch`. As written, overlay re-alignment
on scroll (ARCHITECTURE §4.2) is underspecified and will drift.

---

## 4. Minor — polish, hygiene, and small inconsistencies

- **`FILE_MANIFEST.md` lists files/exports that don't exist yet** as if authored, with specific export
  names (`buildElementTarget`, `transformSource`, `vue-transform.ts`, `screenshot.ts`'s `compositeOverlay`,
  etc.). That's acceptable as a forward map, but the manifest also names `tsconfig.web.json`,
  `src/renderer/styles/index.css` (actual file is `globals.css`), and claims tsconfig has
  `exactOptionalPropertyTypes`/`noUncheckedIndexedAccess`/`verbatimModuleSyntax` (none are set in the real
  `tsconfig.json`). Reconcile the manifest with the tree.
- **Styles filename mismatch:** manifest says `src/renderer/styles/index.css`; actual is
  `src/renderer/styles/globals.css` (imported by `main.tsx`). Pick one.
- **`@babel/*` deps are undeclared.** `ELEMENT_SOURCE_MAPPING.md` and `FILE_MANIFEST.md` require
  `@babel/core`, `@babel/parser`, `@babel/traverse`, `@babel/generator`, `@babel/types` for the plugin
  transform, but `packages/vite-plugin-inspector/package.json` declares **none** of them (only a `vite`
  peer dep + `@types/node`). The plugin cannot be implemented without adding these (and `@types/babel__*`).
- **The plugin stub's actual code diverges from its own spec.** `packages/vite-plugin-inspector/src/index.ts`
  exports `easelInspector(options)` taking `InspectorOptions` with `apply: dev ? 'serve' : undefined` and
  references `this.environment?.name` (Vite 6 environment API) — while the doc spec uses
  `configResolved(config){ isDev = config.command === 'serve' }` and a `transform.ts` delegate with no
  options object. Decide the real API surface (options vs. none; `apply` vs. `configResolved` guard;
  Vite 5 vs. 6 environment API — note `peerDependencies` pins `vite ^5.0.0`, which does **not** have
  `this.environment`).
- **`.env.example` model id is stale for a June 2026 product.** `claude-3-5-sonnet-20241022` /
  `claude-3-opus-20240229` are old defaults; pick a current model id (the brief says keep versions
  current). `AppSettings.model` is a free string so it's not a type error, just a stale default.
- **`@anthropic-ai/claude-agent-sdk` version pin (`^0.1.5`) and `@anthropic-ai/sdk` (`^0.27.3`)** should be
  re-verified against the latest published versions at implementation time; both are pre-1.0 and move
  fast. Not necessarily wrong, but flag for a version sweep (brief says "latest-stable").
- **`IpcResult<void>` ergonomics:** the `ok:true` branch is `{ ok:true; value: void }`. Preload wrappers
  must return `{ ok:true, value: undefined }`. Works under strict TS but is a sharp edge worth a helper
  (`ok()` / `okVoid()` constructor) so implementers don't write `{ ok:true }` (a type error).
- **`InspectorMessage` `element-hover` lacks a selector/target id**, so the host cannot correlate a hover
  to anything but a bbox+tag. If hover should drive the `highlight` command round-trip, it likely needs at
  least the selector. Minor, but worth confirming against the ElementInspector UX.
- **`ApiKeyRef.hint` example `…aB3x` uses an ellipsis char**; ensure display code doesn't assume ASCII.
  Trivial.
- **No CSP is actually set** in `src/renderer/index.html` though `FILE_MANIFEST.md` line 78 says the HTML
  has a "CSP meta." Add the `Content-Security-Policy` meta (or document main-side header injection) to
  match the security model in ARCHITECTURE §9.

---

## 5. What is solid (so the next phase keeps it)

- The three shared contract files are well-documented, strict-clean, and the `AgentEvent` discriminated
  union + `AgentEventOf<T>` helper + `BackendRegistry` mapped type are correctly formed. Imports are
  type-only and resolve. No undefined types, no obvious strict-mode violations.
- `IpcInvokeMap`/`IpcEventMap`/`EaselApi` are consistent with `IpcChannels` and cover project / edit /
  settings / checkpoint / preview. The split of invoke vs. push channels is correct and complete for those
  domains (modulo the inspector region-query gap in §3.1, which lives on a different boundary).
- The security model (contextIsolation, sandbox, ProjectFs path-escape guard, safeStorage refs that keep
  plaintext out of the renderer) is coherent and the types enforce it (`ApiKeyRef` vs. transient
  `ctx.apiKey`).
- Settings/secret separation in IPC (`SettingsUpdateRequest` excludes `apiKeyRef`/`imageApiKeyRef` via
  `Omit`) is exactly right.

---

## 6. Recommended fix order before implementation

1. Fix the build (§1.1 webview-preload entry, §1.2 typecheck/`composite`, §1.3 drop `@types/electron`,
   §1.4 tsconfig name). Nothing compiles/ships correctly until these are done.
2. Close the contract gaps the core feature needs: confidence/warning + confirm flow (§2.1, §2.2),
   freeform region-query messages (§3.1), screenshot ownership (§3.2).
3. Reconcile the checkpoint-vs-accept model (§2.4) — it changes both UX and `checkpoints.ts`.
4. Bring `ELEMENT_SOURCE_MAPPING.md` into line with the real types/channels (§2.3, §2.5) so implementers
   of the inspector and tools build against the contract, not the prose.
5. Sweep deps (`@babel/*`, version pins, model id) and the manifest/tree mismatches (§4).

*End of review.*
