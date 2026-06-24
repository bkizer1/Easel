# Easel — File Manifest

**Version:** 1.0 | **Status:** Authoritative | **Audience:** All Easel engineers

This is the exhaustive map of every file in the Easel codebase: its responsibility, its key exports, and
its dependencies. It is the build-order and ownership reference for all subsequent implementation work.
Paths are relative to the repo root (`/path/to/Easel`). Keep this in sync with the actual
tree and with `docs/ARCHITECTURE.md` (NFR-20).

**Legend — Process:** `shared` (cross-process contracts) · `main` (Node) · `preload` (host bridge) ·
`webview-preload` (guest inspector) · `renderer` (React UI) · `plugin` (Vite plugin) · `config` (tooling) ·
`docs`.

**Build priority:** 1 = build first (no Easel-internal deps). Higher numbers depend on lower ones.

---

## 1. Shared contracts — `src/shared/` (priority 1)

The single source of truth for every cross-process boundary. Types/interfaces/const-literals only; no
runtime logic. Imported by every other module. Compile cleanly under `strict`.

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `src/shared/types.ts` | All domain types crossing a process or persistence boundary. | `Point`, `BoundingBox`, `SourceLocation`, `ConfidenceLevel`, `ElementTarget`, `AnnotationMode`, `AnnotationKind`, `Annotation`, `AnnotationBatch`, `EditRequest`, `FileDiff`, `AgentEvent`, `AgentEventOf`, `Checkpoint`, `ChatRole`, `ChatMessage`, `ProjectFramework`, `ProjectConfig`, `AgentBackendId`, `ClaudeAuthMode`, `ClaudeAgentSdkConfig`, `AnthropicApiConfig`, `LocalOpenAiConfig`, `BackendConfigs`, `FeatureFlags`, `ApiKeyRef`, `AppSettings`, `ImageRequestMode`, `ImageRequest`, `ImageResult`, `ImageProvider` | (none) |
| `src/shared/agent.ts` | The pluggable agent-backend contract + host-provided services. | `AgentCapabilities`, `LogLevel`, `AgentLogger`, `ProjectFs`, `GrepQuery`, `GrepMatch`, `AgentBackendContext`, `ValidateContext`, `AgentBackend`, `BackendFactory`, `BackendRegistry` | `./types` (type-only) |
| `src/shared/ipc.ts` | The typed main↔renderer IPC contract + guest↔host inspector messages. | `IpcChannels`, `IpcChannelName`, `IpcResult`, request/response payload types (`ProjectOpenResponse`, `EditSubmitRequest`/`Response`, `EditEventPayload`, `Settings*`, `Checkpoint*`, `Preview*`, etc.), `Unsubscribe`, `EaselApi`, `IpcInvokeMap`, `IpcEventMap`, `InspectorMessage`, `InspectorCommand` | `./types` (type-only) |
| `src/shared/result.ts` | Helper constructors for `IpcResult<T>`: avoids hand-building and ensures type safety. | `ok<T>`, `okVoid`, `fail` | `./ipc` (type-only) |

---

## 2. Main process — `src/main/` (priority 2–4)

Full Node privilege. Owns app lifecycle, IPC handlers, filesystem, git, secrets, and outbound network.

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `src/main/index.ts` | App entrypoint: `app` lifecycle (`ready`, `window-all-closed`, `activate`), single-instance lock, bootstraps settings, creates the main window, registers all IPC handlers. | `main()` (bootstrap; invoked on import) | `electron`, `./window`, `./ipc`, `./settings`, `./project`, `./agents` |
| `src/main/window.ts` | Creates the `BrowserWindow` with the secure `webPreferences` (`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: true`), points it at the renderer entry, resolves the host + webview preload paths. | `createMainWindow(): BrowserWindow`, `getMainWindow(): BrowserWindow \| null` | `electron`, `node:path`, `../shared/*` (paths/types) |
| `src/main/ipc.ts` | Registers one `ipcMain.handle` per invoke channel in `IpcChannels`; pushes events via `webContents.send`; validates every inbound payload before acting; wraps results in `IpcResult`. | `registerIpcHandlers(win: BrowserWindow): void`, `pushEvent<C>(channel, payload)` | `electron`, `../shared/ipc`, `../shared/types`, `./project`, `./settings`, `./checkpoints`, `./agents` |
| `src/main/settings.ts` | Persists `AppSettings` to disk (userData); encrypts/decrypts API keys via Electron `safeStorage`; exposes secrets only as `ApiKeyRef` (with 4-char hint) to the renderer, plaintext only transiently to backends. | `loadSettings()`, `saveSettings(patch)`, `setSecret(id, value)`, `clearSecret(id)`, `resolveSecret(id): string \| null`, `getSettings(): AppSettings` | `electron` (`safeStorage`, `app`), `node:fs`, `../shared/types` |
| `src/main/project.ts` | Open-folder dialog; detects `ProjectFramework` and dev-server URL (auto-detect common ports + manual override); detects `inspectorPluginPresent`; health-polls the dev server and emits `preview.status`; remembers last project. | `openProjectDialog()`, `getCurrentProject()`, `closeProject()`, `detectFramework(root)`, `startDevServerHealthPoll(url, onStatus)` | `electron` (`dialog`), `node:fs`, `node:http`, `../shared/types`, `../shared/ipc` |
| `src/main/checkpoints.ts` | Git-backed undo/redo on the internal `refs/easel/checkpoints` ref; create/list/restore/undo/redo; tracks the timeline cursor; verifies repo + disk space; emits `checkpoint.changed`. | `createCheckpoint(message, requestId): Promise<Checkpoint>`, `listCheckpoints()`, `restoreCheckpoint(id)`, `undo()`, `redo()`, `getCurrentCheckpointId()` | `node:child_process`/git, `node:fs`, `../shared/types`, `../shared/ipc` |
| `src/main/agents/index.ts` | The `BackendRegistry`: maps each `AgentBackendId` to a `BackendFactory`; resolves the active backend from settings; builds the `AgentBackendContext` (ProjectFs, ImageProvider, logger, AbortSignal, createCheckpoint); drives `editStream` and relays `AgentEvent`s. | `backendRegistry: BackendRegistry`, `resolveBackend(settings): AgentBackend`, `createBackendContext(...): AgentBackendContext`, `runEdit(request, win): Promise<void>` | `../../shared/agent`, `../../shared/types`, `./claudeAgentSdk`, `./anthropicApi`, `./localOpenAi`, `./tools`, `../checkpoints`, `../settings` |
| `src/main/agents/claudeAgentSdk.ts` | `AgentBackend` impl on `@anthropic-ai/claude-agent-sdk`: a full coding agent; translates auth config (inherit/api-key/bedrock/vertex/gateway) to SDK options; normalizes SDK tool/stream events into Easel's `AgentEvent` union; routes file ops through `ProjectFs` for path safety + diffing; git-aware. | `createClaudeAgentSdkBackend: BackendFactory`, `ClaudeAgentSdkBackend` (impl of `AgentBackend`) | `@anthropic-ai/claude-agent-sdk`, `../../shared/agent`, `../../shared/types`, `./tools` |
| `src/main/agents/anthropicApi.ts` | `AgentBackend` impl on `@anthropic-ai/sdk`: a hand-built agent loop owning message turns + tool dispatch; requires an API key; emits `AgentEvent`s directly; leaner/cheaper path. | `createAnthropicApiBackend: BackendFactory`, `AnthropicApiBackend` (impl of `AgentBackend`) | `@anthropic-ai/sdk`, `../../shared/agent`, `../../shared/types`, `./tools` |
| `src/main/agents/localOpenAi.ts` | `AgentBackend` impl for OpenAI-compatible endpoints (Ollama, LM Studio, llama.cpp, vLLM, etc.): hand-built agent loop against the endpoint; capabilities.agenticReliability = 'variable' (UI warns); emits `AgentEvent`s directly. | `createLocalOpenAiBackend: BackendFactory`, `LocalOpenAiBackend` (impl of `AgentBackend`) | `node:http`, `../../shared/agent`, `../../shared/types`, `./tools` |
| `src/main/agents/tools.ts` | The shared agent tool set + `ProjectFs` implementation: `read_file`, `edit_file` (pre-write validation + `FileDiff`), `grep`/`grep_source` (fallback source resolution + confidence scoring), `replace_image` (wires the `ImageProvider`). Path-sandboxed to `projectRoot`. | `createProjectFs(projectRoot): ProjectFs`, `agentToolDefinitions`, `grepSource(...)`, `scoreCandidate(...)`, `replaceImageTool(...)` | `node:fs`, `node:path`, ripgrep/glob, `../../shared/agent`, `../../shared/types`, `./imageProvider` |
| `src/main/agents/imageProvider.ts` | Pluggable `ImageProvider` interface + stub implementation. The stub always returns `ok: false` (no-op provider). Real implementations (DALL-E, Replicate, etc.) can be registered optionally. | `createStubImageProvider(): ImageProvider`, `registerImageProvider(impl): void` | `../../shared/types` |

---

## 3. Host preload — `src/preload/` (priority 2)

The isolated bridge between renderer and main. Exposes only the typed `EaselApi`.

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `src/preload/index.ts` | Implements `EaselApi` and installs it at `window.easel` via `contextBridge.exposeInMainWorld`. Each method wraps `ipcRenderer.invoke`; each `on*` wraps `ipcRenderer.on` and returns an `Unsubscribe`. Never exposes `ipcRenderer`/`require`. | (side-effect module; `easel` global typed as `EaselApi`) | `electron` (`contextBridge`, `ipcRenderer`), `../shared/ipc`, `../shared/types` (type-only) |

---

## 4. Webview-preload (guest) — `src/preload/webview/` (priority 2)

Injected into the dev-server page. Reads the guest DOM, hit-tests, resolves source, posts back to host.

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `src/preload/webview/inspector.ts` | Guest inspector: `mousemove`/`click` capture, `elementFromPoint` hit-testing, walk to nearest `data-easel-source` ancestor, robust CSS selector fallback, `getBoundingClientRect`, region grid-sampling for freeform, builds `ElementTarget`, posts `InspectorMessage` via `sendToHost`, handles `InspectorCommand`. | (side-effect module) `buildElementTarget`, `buildSelector`, `findSourceElement`, `findElementsInRegion` | `electron` (`ipcRenderer.sendToHost`), `../../shared/types`, `../../shared/ipc` (type-only) |

---

## 5. Renderer — `src/renderer/` (priority 3–5)

React 18 + Vite + Tailwind + Zustand. Pure view + intent; no Node access. Talks only to `window.easel`.

### 5.1 Renderer shell & state

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `src/renderer/index.html` | Vite HTML entry for the renderer; mounts `#root`; CSP meta; loads `main.tsx`. | (HTML) | `./main.tsx` |
| `src/renderer/main.tsx` | React bootstrap: creates the root, renders `<App/>`, imports global styles, wires `window.easel` subscriptions on mount. | (entry; no exports) | `react`, `react-dom/client`, `./App`, `./styles` |
| `src/renderer/App.tsx` | Top-level layout: composes `Toolbar`, `PreviewPane` (+ overlay), `ChatPanel`, `DiffViewer`, `SettingsDialog`; routes between empty/project states. | `App` (default) | `react`, `./store`, `./components/*` |
| `src/renderer/store.ts` | Zustand store: current `ProjectConfig`, `AppSettings`, interaction mode, draft `AnnotationBatch` (targets + annotations + instruction), in-flight edit + streamed `AgentEvent`s, `Checkpoint[]`, preview status, `ChatMessage[]`. Actions wrap `window.easel`. | `useEaselStore`, `EaselState`, action creators (`submitEdit`, `addTarget`, `addAnnotation`, `setMode`, `undo`, `redo`, …) | `zustand`, `../shared/types`, `../shared/ipc` (type-only) |

### 5.2 Renderer styles — `src/renderer/styles/`

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `src/renderer/styles/globals.css` | Global stylesheet: Tailwind `@tailwind base/components/utilities`, CSS variables for theme tokens, overlay/z-index layering rules. | (CSS) | Tailwind, `tailwind.config.ts` |

### 5.3 Renderer components — `src/renderer/components/`

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `src/renderer/components/PreviewPane.tsx` | Hosts the `<webview src=devServerUrl preload=inspector>`; wires `dom-ready`/`ipc-message`/`did-fail-load`; sends `InspectorCommand`s; renders the disconnected/retry state from `preview.status`; positions `AnnotationOverlay` on top. | `PreviewPane` | `react`, `../store`, `../../shared/ipc`, `./AnnotationOverlay`, `lucide-react` |
| `src/renderer/components/AnnotationOverlay.tsx` | The absolutely-positioned SVG/Canvas layer over the webview; switches `pointer-events` by mode; hosts `ElementInspector` (idle/select) and `FreeformCanvas` (draw); keeps marks aligned via `viewport-changed`; triggers region resolution on stroke completion. | `AnnotationOverlay` | `react`, `../store`, `../lib/geometry`, `../lib/screenshot`, `./ElementInspector`, `./FreeformCanvas` |
| `src/renderer/components/ElementInspector.tsx` | ElementSelect UX: renders hover highlight + selected-element badges from `element-hover`/`element-picked`; shows tag/source/dimensions; multi-select list; "attach instruction" affordance. | `ElementInspector` | `react`, `../store`, `../lib/selector`, `../../shared/types`, `lucide-react` |
| `src/renderer/components/FreeformCanvas.tsx` | Freeform drawing surface: rect/ellipse/arrow/freehand/pen + eraser tools; captures strokes as `Annotation`s; per-stroke undo/redo; emits the bounding box for region resolution. | `FreeformCanvas` | `react`, `../store`, `../lib/geometry`, `../../shared/types`, `lucide-react` |
| `src/renderer/components/ChatPanel.tsx` | Conversation transcript (`ChatMessage[]`): user instructions, assistant summaries, streamed `thinking`/`message`, per-message diff/checkpoint links; instruction input + submit. | `ChatPanel` | `react`, `../store`, `../../shared/types`, `./VoiceButton`, `lucide-react` |
| `src/renderer/components/DiffViewer.tsx` | Renders `FileDiff[]` (unified/side-by-side, additions/deletions); Accept (keep checkpoint) / Reject (restore prior checkpoint) controls. | `DiffViewer` | `react`, `../store`, `../../shared/types`, `lucide-react` |
| `src/renderer/components/Toolbar.tsx` | Top toolbar: mode toggle (Select/Freeform), drawing tools, Undo/Redo (enabled from checkpoint state), reload, settings, project switcher. | `Toolbar` | `react`, `../store`, `lucide-react` |
| `src/renderer/components/SettingsDialog.tsx` | Settings UI: agent-backend select, model, API-key entry (masked, via `setSecret`), image-provider key, feature-flag toggles, dev-server URL, theme; validates backend. | `SettingsDialog` | `react`, `../store`, `../../shared/types`, `lucide-react` |
| `src/renderer/components/VoiceButton.tsx` | Web Speech API mic button behind the `voiceInput` flag; transcribes speech into the instruction field; degrades gracefully (disabled + tooltip) when unavailable. | `VoiceButton` | `react`, `../store`, `lucide-react` |

### 5.4 Renderer libraries — `src/renderer/lib/`

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `src/renderer/lib/selector.ts` | Renderer-side selector utilities mirroring the guest inspector's algorithm (id/`data-testid`/`:nth-of-type`); parse/format helpers for `data-easel-source`. | `buildSelector`, `parseDataEaselSource`, `formatSourceLocation` | `../../shared/types` |
| `src/renderer/lib/geometry.ts` | Geometry helpers: bounding-box from points, rect intersection/containment/overlap fraction, grid sampling for freeform region resolution, point-in-shape hit-testing. | `boundsOfPoints`, `rectsOverlap`, `overlapFraction`, `sampleGrid`, `pointInRect` | `../../shared/types` |
| `src/renderer/lib/screenshot.ts` | Captures the marked preview region and composites the annotation overlay into a PNG data URL for `EditRequest.screenshotDataUrl`. | `captureRegion(bbox): Promise<string>`, `compositeOverlay(...)` | `../../shared/types`, browser canvas APIs |

---

## 6. Vite plugin — `packages/vite-plugin-inspector/` (priority 1, independent package)

The user-installable plugin that stamps `data-easel-source` on JSX/HTML in dev builds. Published to npm as
`@easel/vite-plugin-inspector`. Standalone package with its own `package.json`/`tsconfig`.

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `packages/vite-plugin-inspector/package.json` | Package manifest: name `@easel/vite-plugin-inspector`, MIT, build scripts, peerDep on `vite`, deps on Babel. | (manifest) | — |
| `packages/vite-plugin-inspector/tsconfig.json` | Strict TS config for the plugin build (library output). | (config) | base tsconfig |
| `packages/vite-plugin-inspector/src/index.ts` | The Vite `Plugin`: `configResolved` dev guard (`command === 'serve'`), `transform` hook gating on `.[jt]sx?`, delegates to `transform.ts`; the public `easelInspector()` factory. | `easelInspector(): Plugin` (default + named) | `vite` (types), `./transform` |
| `packages/vite-plugin-inspector/src/transform.ts` | Babel AST transform: parse → traverse `JSXOpeningElement` → idempotently inject `data-easel-source="relativeFile:line:col"` → generate with source map passthrough. | `transformSource(code, absoluteId, projectRoot): { code; map } \| null` | `@babel/core`, `@babel/parser`, `@babel/traverse`, `@babel/generator`, `@babel/types`, `node:path` |
| `packages/vite-plugin-inspector/src/vue-transform.ts` | (Post-MVP) Vue SFC `compilerOptions.nodeTransforms` hook that stamps every `ElementNode`. | `vueNodeTransform` | Vue compiler types |
| `packages/vite-plugin-inspector/README.md` | Install/usage docs: add after the framework plugin; dev-only; the `data-easel-source` contract. | (docs) | — |

---

## 7. Project tooling & config — repo root (priority 1)

| File | Responsibility | Key exports | Depends on |
|---|---|---|---|
| `package.json` | Root manifest: deps (`electron`, `electron-vite`, `react`, `react-dom`, `tailwindcss`, `zustand`, `lucide-react`, `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk`), scripts (`dev`, `build`, `lint`, `typecheck`), AGPL-3.0 license. | (manifest) | — |
| `electron.vite.config.ts` | `electron-vite` config defining the four roots (main/preload/renderer/webview-preload) and their build targets; React + Tailwind plugins for the renderer; path aliases (`@shared`, `@main`, `@preload`, `@renderer`). | `default` config | `electron-vite`, `@vitejs/plugin-react`, `tailwindcss` |
| `tsconfig.json` | Base strict TS config (project references to the three roots: main/preload/renderer); `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`. | (config) | — |
| `tsconfig.node.json` | TS config for main + preload (Node/Electron libs). | (config) | `./tsconfig.json` |
| `tsconfig.renderer.json` | TS config for the renderer (DOM libs, JSX, React types). | (config) | `./tsconfig.json` |
| `tailwind.config.ts` | Tailwind theme tokens, content globs over `src/renderer`. | `default` config | `tailwindcss` |
| `postcss.config.js` | PostCSS pipeline (Tailwind + autoprefixer). | (config) | `tailwindcss`, `autoprefixer` |
| `.eslintrc.cjs` | Lint rules (TS strict, React hooks, import boundaries between process roots). | (config) | eslint plugins |
| `.gitignore` | Ignore `node_modules`, `dist`, `out`, logs, local secrets. | — | — |
| `LICENSE` | AGPL-3.0 license text. | — | — |
| `README.md` | Project overview, setup, and contribution guide. | (docs) | — |

---

## 8. Build Outputs — `out/` (generated)

| Path | Responsibility | Contains |
|---|---|---|
| `out/main` | Compiled main process (Node) | `index.js` + source maps |
| `out/preload` | Compiled host preload | `index.js` + source maps |
| `out/preload/webview` | Compiled webview-preload (guest) | `inspector.js` + source maps |
| `out/renderer` | Compiled renderer (Vite SPA) | `index.html`, assets bundle, manifest |

---

## 9. Documentation — `docs/` (priority: docs)

| File | Responsibility | Status |
|---|---|---|
| `docs/REQUIREMENTS.md` | Product requirements: vision, personas, user stories, FR/NFR tables (including provider matrix), MVP scope, milestones, risks. | Authored |
| `docs/ARCHITECTURE.md` | System architecture: process model, edit pipeline, webview embedding/reload, pluggable backend + auth model, IPC overview, security model, git-checkpoint undo, annotation→agent flow, ADR summary. | Authored |
| `docs/FILE_MANIFEST.md` | This file: exhaustive file-by-file responsibilities, exports, dependencies, build order. | Authored |
| `docs/ELEMENT_SOURCE_MAPPING.md` | Deep design of element→source resolution: the Vite plugin, guest inspector (InspectorMessage/InspectorCommand), agent-side grep fallback, freeform mapping, edge cases, confidence scoring via AgentEvent union. | Authored |
| `docs/ROADMAP.md` | Delivery roadmap (M0–M3) and post-MVP backlog. | Planned |
| `docs/REVIEW_NOTES.md` | Running architecture/code-review notes and decisions log. | Planned |

---

## 10. Build-Order Summary

1. **Priority 1** — `src/shared/*` (types, agent contract, ipc contract, result helpers), 
   `packages/vite-plugin-inspector/*` (independent package), all root tooling/config. 
   (No Easel-internal dependencies; everything else imports these.)
2. **Priority 2** — `src/main/{window,settings,project}.ts`, `src/preload/index.ts`,
   `src/preload/webview/inspector.ts`. (Depend only on shared contracts + platform APIs.)
3. **Priority 3** — `src/main/{checkpoints,ipc}.ts`, `src/main/agents/{index,claudeAgentSdk,anthropicApi,localOpenAi,tools,imageProvider}.ts`, 
   `src/renderer/{store,main,App}.tsx`. (Agents wire together; ipc registers all handlers.)
4. **Priority 4** — `src/renderer/lib/*`, then `src/main/index.ts` (wires everything).
5. **Priority 5** — `src/renderer/components/*` (the UI surface, depends on store + lib + shared).

---

*End of File Manifest. Keep in sync with the codebase tree and `docs/ARCHITECTURE.md` (NFR-20).*
*Last reconciled with contracts: `src/shared/{types,agent,ipc,result}.ts` (June 2026).*
