# Easel — System Architecture

**Version:** 1.0 | **Status:** Authoritative technical foundation | **Audience:** All Easel engineers

This document is the canonical description of how Easel is built: the Electron process model, the
end-to-end edit pipeline, how the live preview is embedded and reloaded, the pluggable agent backend
design, the IPC contract, the security model, the git-checkpoint undo system, and how the two
annotation interaction modes feed the agent. It is the parent of the contract source files
(`src/shared/types.ts`, `src/shared/agent.ts`, `src/shared/ipc.ts`) and must stay consistent with them.

---

## 1. System Overview

Easel is a cross-platform Electron desktop application that embeds a developer's own running dev server
(e.g. Vite at `http://localhost:5173`, Next.js at `http://localhost:3000`) inside an Electron `<webview>`.
The developer either **clicks** a rendered DOM element or **draws** freeform marks over the page, then
types or speaks a natural-language instruction. A pluggable **agent backend** (the Claude Agent SDK, the
raw Anthropic Messages API, or a local OpenAI-compatible endpoint) edits the project's source files on disk.
The dev server's HMR re-renders the
preview live, and every applied edit is captured as a **git checkpoint** for undo/redo.

### Design principles

| Principle | How Easel applies it |
|---|---|
| **Process isolation by default** | `contextIsolation: ON`, `nodeIntegration: OFF` everywhere. The renderer touches no Node/Electron API directly — only the typed `window.easel` bridge. |
| **One typed contract per boundary** | Every cross-process payload is declared once in `src/shared/*`. No stringly-typed channels, no `any` across IPC. |
| **Pluggability behind narrow interfaces** | `AgentBackend` and `ImageProvider` are the only seams the rest of the app knows about. Implementations are swappable at runtime. |
| **The main process owns side effects** | All filesystem writes, git operations, secret access, and network calls happen in main. The renderer is a pure view + intent layer. |
| **Graceful degradation** | Missing Vite plugin → grep fallback. No Web Speech API → text-only. No image provider → stub. Dev server down → reconnect UI. |
| **Atomic, reversible edits** | Each accepted edit is one git commit on an internal ref; undo/redo is a pointer walk over those commits. |

---

## 2. Process Model

Easel runs four distinct JavaScript contexts. Three are first-class Electron processes built from
separate TypeScript roots by `electron-vite`; the fourth is a guest-injected script that runs inside the
embedded preview page.

```
+===========================================================================================+
|                                   EASEL  (Electron app)                                    |
|                                                                                            |
|  +-------------------------------------------------------------------------------------+   |
|  |  MAIN PROCESS  (Node.js, full privilege)            root: src/main                  |   |
|  |                                                                                     |   |
|  |   index.ts ── app lifecycle, window creation                                        |   |
|  |   window.ts ── BrowserWindow + webPreferences (contextIsolation, no nodeIntegration)|   |
|  |   ipc.ts ──── ipcMain.handle(...) for every channel in shared/ipc.ts                |   |
|  |   project.ts ─ open folder, detect framework + dev-server URL, health-poll          |   |
|  |   settings.ts ─ persisted AppSettings + secrets via Electron safeStorage            |   |
|  |   checkpoints.ts ─ git-backed undo/redo on the easel checkpoint ref                  |   |
|  |   agents/ ──── backend registry + ClaudeAgentSdk + AnthropicApi + tools + ProjectFs  |   |
|  +----------------------------------------+--------------------------------------------+   |
|                                           |                                                |
|                  Electron IPC  (ipcMain.handle  <->  ipcRenderer.invoke)                   |
|              push events: webContents.send(editEvent / previewStatus / ...)                |
|                                           |                                                |
|  +----------------------------------------+--------------------------------------------+   |
|  |  PRELOAD  (host)  isolated, contextBridge only      root: src/preload/index.ts      |   |
|  |   exposes window.easel : EaselApi   (invoke + on* subscriptions, unsubscribe fns)   |   |
|  +----------------------------------------+--------------------------------------------+   |
|                                           |  contextBridge.exposeInMainWorld('easel', ...) |
|  +----------------------------------------+--------------------------------------------+   |
|  |  RENDERER  (Chromium, sandboxed)                    root: src/renderer               |  |
|  |                                                                                      |  |
|  |   App.tsx / store.ts (Zustand)                                                       |  |
|  |   +--------------------------------------------------------------------------+       |  |
|  |   |  PreviewPane                                                             |       |  |
|  |   |   +------------------------------------------------------------------+   |       |  |
|  |   |   |  <webview src=devServerUrl preload=webview/inspector.js>         |   |       |  |
|  |   |   |  ............ the user's live app renders here ...........        |   |       |  |
|  |   |   +------------------------------------------------------------------+   |       |  |
|  |   |  AnnotationOverlay (absolute SVG/Canvas ON TOP of the webview)          |       |  |
|  |   |   ElementInspector | FreeformCanvas                                    |       |  |
|  |   +--------------------------------------------------------------------------+       |  |
|  |   ChatPanel | DiffViewer | Toolbar | SettingsDialog | VoiceButton                    |  |
|  +----------------------------------------+---------------------------------------------+  |
|                                           |   <webview>.send(InspectorCommand)            |
|                       guest IPC           |   <webview> 'ipc-message' (InspectorMessage)  |
|                  (sendToHost / send)      |   via webContents getter, NOT Node             |
|  +----------------------------------------+---------------------------------------------+  |
|  |  WEBVIEW-PRELOAD  (guest)  isolated      root: src/preload/webview/inspector.ts      |  |
|  |   runs inside the dev-server page; reads data-easel-source; hit-tests;               |  |
|  |   computes robust CSS selector; captures bounding boxes; posts InspectorMessage      |  |
|  +--------------------------------------------------------------------------------------+  |
+============================================================================================+
                                            |
                                            |  HTTP / WebSocket (HMR)
                                            v
                       +--------------------------------------------+
                       |  USER'S DEV SERVER (separate OS process)   |
                       |  Vite / Next.js / etc. + @easel/vite-      |
                       |  plugin-inspector (optional) stamping      |
                       |  data-easel-source on JSX/HTML elements    |
                       +--------------------------------------------+
                                            ^
                                            |  edits land on disk; HMR fires
                       +--------------------------------------------+
                       |  PROJECT SOURCE FILES on disk (a git repo) |
                       +--------------------------------------------+
```

### 2.1 Main process (`src/main`, Node.js)

Full Node privilege. The only context allowed to touch the filesystem, run git, read secrets from
`safeStorage`, and make outbound network calls to Anthropic / image providers. It owns:

- **App + window lifecycle** (`index.ts`, `window.ts`). Sets `webPreferences` such that the renderer is
  sandboxed: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: true`.
- **IPC handlers** (`ipc.ts`). Registers one `ipcMain.handle` per invoke channel and pushes events via
  `webContents.send`. Validates every inbound payload before acting (NFR-14).
- **Project services** (`project.ts`). Open-folder dialog, framework/dev-server detection, dev-server
  health polling that drives `preview.status`.
- **Settings + secrets** (`settings.ts`). Persists `AppSettings` to disk; encrypts API keys with
  `safeStorage`; resolves a key to plaintext only transiently when constructing an `AgentBackendContext`.
- **Checkpoints** (`checkpoints.ts`). git-backed undo/redo (Section 8).
- **Agent layer** (`agents/*`). The backend registry, the two backend implementations, the shared agent
  tools, and the `ProjectFs` sandbox.

### 2.2 Preload — host (`src/preload/index.ts`)

A small, isolated bridge. Its sole job is to `contextBridge.exposeInMainWorld('easel', …)` an object that
implements the `EaselApi` interface from `src/shared/ipc.ts`. Each method wraps `ipcRenderer.invoke`;
each `on*` method wraps `ipcRenderer.on` and returns an `Unsubscribe`. The preload never exposes
`ipcRenderer` itself, never exposes `require`, and never leaks a Node primitive into the renderer world.

### 2.3 Renderer (`src/renderer`, React 18 + Vite + Tailwind + Zustand)

The view + intent layer. It renders the UI, hosts the `<webview>`, draws the annotation overlay, builds
`EditRequest`s, and consumes streamed `AgentEvent`s. It has **no** Node access; all privileged work is
delegated through `window.easel`. State lives in a Zustand store (`store.ts`): current project, settings,
annotation draft, in-flight edit + streamed events, checkpoint list, preview status.

### 2.4 Webview-preload — guest (`src/preload/webview/inspector.ts`)

Injected into the dev-server page via the `preload` attribute on the `<webview>` tag. Runs in the guest's
isolated world: it can read the guest DOM but cannot reach the host renderer's JS. It performs element
hit-testing (`elementFromPoint`), walks up to the nearest `data-easel-source` ancestor, computes a robust
CSS selector, captures bounding boxes, and posts `InspectorMessage`s to the host via `sendToHost`. The
host renderer listens on the `<webview>` element's `ipc-message` event and sends `InspectorCommand`s back
via `<webview>.send(...)`. This guest <-> host channel is **distinct** from main <-> renderer IPC.

---

## 3. The Edit Pipeline (End to End)

The edit pipeline is the heart of the system. It carries a user gesture from the preview all the way to a
re-rendered, checkpointed change. The contract objects (`EditRequest`, `AgentEvent`, `FileDiff`,
`Checkpoint`) are defined in `src/shared/types.ts`.

### 3.1 Data flow diagram

```
 USER GESTURE                RENDERER                       MAIN                      AGENT / DISK
 ============                ========                       ====                      ============

 click / draw  ──►  guest inspector posts                                  
                    InspectorMessage(element-picked)
                          │
                          ▼
                    store: add ElementTarget /
                    Annotation to draft batch
                          │
   type / speak  ──► instruction text
                          │
                    [Submit]  build EditRequest
                    {instruction, targets[],
                     annotations[], screenshotDataUrl?,
                     projectRoot, devServerUrl}
                          │  window.easel.edit.submit(req)
                          ▼  (ipcRenderer.invoke 'edit.submit')
                                              validate payload;
                                              resolve AppSettings;
                                              decrypt secrets the active backend
                                              declares (safeStorage) — empty for
                                              SDK inherit/bedrock/vertex;
                                              build ProjectFs sandbox +
                                              ImageProvider + AbortController;
                                              registry[settings.agentBackend](settings)
                                                          │
                                                          ▼  editStream(req, ctx)
                                                                          read_file / grep /
                                                                          resolve source location
                                                                          (data-easel-source or
                                                                          fallback scoring)
                          ◄── editEvent: thinking ─────────────────────────  yield 'thinking'
                          ◄── editEvent: tool-call ────────────────────────  yield 'tool-call'
                                                                          edit_file → ProjectFs.write
                                                                          (validated pre-write)
                          ◄── editEvent: file-edit (FileDiff) ─────────────  yield 'file-edit'
                                                          │
                                                          │  HMR: dev server detects
                                                          │  file change, pushes update
                                                          ▼
                    <webview> hot-reloads; preview                         
                    re-renders the changed module
                          │
                                              ctx.createCheckpoint(msg, id)
                                              → git commit on easel ref
                          ◄── editEvent: checkpoint (Checkpoint) ──────────  yield 'checkpoint'
                          ◄── editEvent: done (summary, diffs[]) ──────────  yield 'done'  (terminal)
                          │
                    DiffViewer shows diffs;
                    ChatPanel shows summary;
                    Toolbar enables Undo
```

### 3.2 Numbered sequence: "user circles an image → live re-render"

1. **Enter Freeform mode.** User clicks the draw tool in `Toolbar`; the store sets interaction mode to
   `freeform`. The host renderer sends `InspectorCommand { type: 'set-mode', mode: 'idle' }` so the guest
   stops hover-highlighting, and `FreeformCanvas` begins capturing pointer events on the overlay.
2. **Draw the circle.** User drags an ellipse over a German-shepherd photo. `FreeformCanvas` records the
   stroke as an `Annotation { kind: 'ellipse', points: [tl, br], boundingBox, color }`
   (see `src/renderer/lib/geometry.ts`).
3. **Resolve overlapping elements.** On stroke completion the renderer sends the annotation's bounding box
   down to the guest: `<webview>.send` with a region query. The guest inspector grid-samples
   `document.elementsFromPoint` across the rect, ranks by overlap/containment/depth, and posts back a
   ranked `ElementTarget[]` (one of which is the `<img>`), each carrying `dataEaselSource` if the plugin
   is active, plus `selector`, `tagName`, `textSnippet`, `attributes`, `pluginPresent`, `confidence`.
4. **Capture the screenshot.** The renderer composites the annotation overlay onto a capture of the marked
   region (`src/renderer/lib/screenshot.ts`) and stores it as `screenshotDataUrl` on the draft
   `AnnotationBatch`.
5. **Attach the instruction.** User types or dictates (`VoiceButton`, Web Speech API) "replace this German
   shepherd photo with a golden doodle." The text lands in the draft.
6. **Build the EditRequest.** On Submit, the renderer assembles
   `EditRequest { id, instruction, annotations:[ellipse], targets:[…ranked…], screenshotDataUrl,
   projectRoot, devServerUrl }` and calls `window.easel.edit.submit({ request })`.
7. **Cross the bridge.** The preload forwards the call as `ipcRenderer.invoke('edit.submit', payload)`.
8. **Main validates + prepares.** `src/main/ipc.ts` validates the payload, loads `AppSettings`, decrypts
   only the secrets the active backend declares via `safeStorage` (empty for the Claude SDK
   `inherit`/`bedrock`/`vertex` modes — see Section 6), constructs an `AgentBackendContext` (`projectRoot`,
   `settings`, the resolved `secrets` map, a `ProjectFs` sandbox rooted at the project, the active
   `ImageProvider`, a `logger`, an `AbortSignal`, and a `createCheckpoint` callback), and resolves the
   backend through the `BackendRegistry` keyed by `settings.agentBackend`. It returns `{ requestId }` to the
   renderer and begins iterating `backend.editStream(request, ctx)`.
9. **Agent reasons + locates source.** The backend emits `thinking` and `tool-call` events. To find the
   image source it prefers the `<img>`'s `dataEaselSource` (`file:line:col`); if absent it uses
   `ProjectFs.grep` over the project, scoring candidates by tag/attributes/text (per
   `docs/ELEMENT_SOURCE_MAPPING.md`).
10. **Generate the new image.** The agent calls its `replace_image` tool, which the host wires to
    `ctx.imageProvider.request({ mode: 'generate', prompt: 'golden doodle …' })`. The provider returns an
    `ImageResult` data URL; the host persists it into the project (e.g. `public/`) via
    `ProjectFs.writeBinary` and returns the new relative asset path.
11. **Edit the source.** The agent rewrites the `<img src>` (or background-image) to the new asset using
    `ProjectFs.writeFile`, which is validated pre-write and computes a `FileDiff`. The backend yields a
    `file-edit` event carrying that diff; main relays it on `edit.event`.
12. **HMR re-renders.** The dev server detects the changed source file, pushes an HMR update over its
    WebSocket, and the `<webview>` swaps the module in place — the golden doodle appears live, no full
    reload (Section 4.3).
13. **Checkpoint.** The backend calls `ctx.createCheckpoint("replace photo with golden doodle", requestId)`;
    `checkpoints.ts` stages and commits the change onto the internal easel ref and returns a `Checkpoint`.
    The backend yields a `checkpoint` event.
14. **Done.** The backend yields the terminal `done` event with a summary and the accumulated `diffs[]`.
    Main stops iterating and the in-flight edit is cleared.
15. **Review.** `DiffViewer` renders the diffs; `ChatPanel` shows the summary; `Toolbar` enables Undo. The
    user accepts (keep the checkpoint) or rejects (restore the previous checkpoint, reverting the source
    and triggering another HMR re-render back to the German shepherd).

### 3.3 The ElementSelect path (variation)

Steps 1–4 differ: the user toggles ElementSelect mode; the host sends
`InspectorCommand { type: 'set-mode', mode: 'element-select' }`; the guest hover-highlights via
`element-hover` messages, and on click posts one fully resolved `ElementTarget` via `element-picked`. The
draft batch then holds a single target (or several, in multi-select). Everything from step 5 onward is
identical. Element and Freeform targets can be combined in one `EditRequest` (US-9.2).

---

## 4. Webview Embedding

The live preview is an Electron `<webview>` tag inside `PreviewPane`. We use `<webview>` (not a
`BrowserView`/`WebContentsView`) because it composites naturally inside the React layout, lets us stack the
annotation overlay on top with normal CSS, and supports a guest `preload` script for the inspector.

### 4.1 Configuration

- `src="{devServerUrl}"` — the user's running dev server.
- `preload="{webviewInspectorPreloadPath}"` — the compiled `src/preload/webview/inspector.ts`.
- `nodeintegration` is **not** set (off). The guest inspector reaches Electron's `ipcRenderer` only because
  the webview preload runs in a context that exposes `sendToHost`; it never gets Node `require`.
- `partition` — a dedicated session partition so guest cookies/storage are isolated from Easel itself.
- `allowpopups` is **off**; navigation is constrained to the dev-server origin.

### 4.2 Overlay alignment

`AnnotationOverlay` is an absolutely-positioned SVG/Canvas layer with `top:0; left:0` matching the
`<webview>`'s bounding rect. In **idle/element-select** mode the overlay uses `pointer-events: none` so
clicks fall through to the webview (the guest does the hit-testing). In **freeform draw** mode the overlay
captures pointer events to draw. The guest posts `viewport-changed` (scroll offset + size) so the overlay
can keep highlights and marks aligned with the underlying content as the user scrolls.

### 4.3 Reload semantics

Three reload mechanisms, in order of preference:

1. **HMR (primary).** The dev server owns hot-module replacement. When the agent edits a source file, the
   dev server's watcher pushes an update over its WebSocket and the guest page swaps the module — fast,
   state-preserving, no Easel involvement. This is the common case and is what makes edits feel live.
2. **Soft reload.** For changes HMR cannot patch (e.g. config files, some Next.js server components) the
   main process can request `preview.reload` (`{ hard: false }`) and the renderer calls
   `<webview>.reload()`.
3. **Hard reload.** `preview.reload { hard: true }` → `<webview>.reloadIgnoringCache()` for cache-busting
   or recovery from a wedged state.

The main process health-polls the dev-server URL and pushes `preview.status { url, reachable, detail }`.
When unreachable (dev server crashed/restarting), `PreviewPane` shows a "Preview disconnected — retrying"
state and the renderer suppresses new edit submissions until `dom-ready` fires again after reconnection
(also closing the HMR-race window described in `ELEMENT_SOURCE_MAPPING.md` §6).

---

## 5. Pluggable Agent Backend Design

The agent is abstracted behind a single interface, `AgentBackend` (`src/shared/agent.ts`). Three
implementations ship and all satisfy the identical contract; the user selects one in Settings
(`AppSettings.agentBackend`). The full authentication/provider matrix that sits behind these backends —
and the firm product constraints governing it — is documented in **Section 6, Authentication & Providers**.

### 5.1 The contract

```
AgentBackend
  ├─ id: AgentBackendId                     // 'claude-agent-sdk' | 'anthropic-api' | 'local-openai'
  ├─ name: string
  ├─ capabilities: AgentCapabilities        // streamsThinking, supportsVision, gitAware, agenticReliability, …
  ├─ editStream(request, ctx): AsyncIterable<AgentEvent>   // the workhorse
  ├─ cancel?(requestId): void               // best-effort eager cancel
  └─ validate?(ctx): Promise<{ ok; problem? }>            // readiness probe
```

`editStream` is an **async iterable** of `AgentEvent`s. The host iterates it and relays each event to the
renderer over `edit.event`. The stream MUST end with exactly one terminal event — `done` or `error`.
Consumers may break early; on early break with an aborted `ctx.signal`, the backend treats it as a
cancellation and yields `error` with code `cancelled`.

### 5.2 Host-provided context

The backend never reaches outside the injected `AgentBackendContext`:

- `projectRoot` — absolute path the agent may edit.
- `settings` — resolved `AppSettings` (selected backend, model id, per-backend config, feature flags).
- `secrets` — a `Readonly<Record<string, string>>` of plaintext secrets the host decrypts from `safeStorage`
  transiently at call time, keyed by `ApiKeyRef.id` (e.g. `anthropic`, `gateway-token`, `local`). A backend
  reads only the refs named in its own `BackendConfigs` entry. The map is **empty** for the Claude SDK
  `inherit` / `bedrock` / `vertex` modes, which use ambient machine credentials (Section 6). Present only for
  the duration of the edit; never persisted by the backend, never sent to the renderer.
- `fs: ProjectFs` — a **sandboxed** filesystem facade. Every `relativePath` is resolved against the
  project root and rejected if it traverses outside (path-escape guard). Provides `readFile`, `writeFile`,
  `exists`, `readdir`, `glob`, `grep`, `writeBinary`, and `diff` (which produces the `FileDiff` for
  `file-edit` events).
- `imageProvider: ImageProvider` — backs the `replace_image` tool.
- `logger: AgentLogger` — backends never touch `console`.
- `signal: AbortSignal` — the cancellation channel.
- `createCheckpoint(message, requestId)` — the host owns git; the backend only requests a checkpoint and
  emits the resulting `Checkpoint` in a `checkpoint` event.

### 5.3 The three implementations

| Aspect | `claudeAgentSdk.ts` (`@anthropic-ai/claude-agent-sdk`) | `anthropicApi.ts` (`@anthropic-ai/sdk`) | `localOpenai.ts` (OpenAI-compatible) |
|---|---|---|---|
| Strategy | Full coding agent; SDK manages the tool loop, file search, and git awareness. | Hand-built agent loop: we own the message turns and tool dispatch. | Hand-built agent loop against any OpenAI-compatible endpoint (Ollama, LM Studio, llama.cpp, vLLM). |
| Auth / credential | Honors `ClaudeAuthMode`: `inherit` (default, ambient Claude login → Pro/Max plan, no extra spend), `api-key`, `bedrock`, `vertex`, `gateway` (Section 6). | Requires an Anthropic API key (`anthropic` secret); **always** API-billed. | `LocalOpenAiConfig.baseUrl` + `model`; optional bearer token (`local` secret). |
| File edits | SDK's own file tools, validated through / mirrored into `ProjectFs` for path safety + diffing. | Custom tools in `agents/tools.ts` (`read_file`, `edit_file`, `grep`, `replace_image`) backed by `ProjectFs`. | Same custom tools as the Anthropic-API loop, backed by `ProjectFs`. |
| `agenticReliability` | `high` | `high` | `variable` — local models may mishandle multi-step tool use; the UI surfaces a warning. |
| Capabilities | `gitAware: true`, `editsFilesDirectly: true`, rich tool streaming. | Leaner; explicit, auditable loop; typically cheaper per edit. | Fully local / private / offline-capable; quality and tool-use reliability depend on the served model. |
| `AgentEvent` mapping | SDK events normalized into Easel's `AgentEvent` union. | Loop emits `AgentEvent`s directly as it dispatches tools. | Loop emits `AgentEvent`s directly as it dispatches tools. |
| When to choose | Complex, multi-file, exploratory edits on your existing Claude plan. | Simple targeted edits, cost control, transparency. | Privacy/offline-first work or experimentation with self-hosted models. |

All three normalize their internal progress into the **same** `AgentEvent` discriminated union, so the
renderer is backend-agnostic. `AgentCapabilities` lets the UI hide features a backend lacks (e.g. only show
the thinking panel when `streamsThinking` is true) and warn when `agenticReliability` is `variable`.

### 5.4 Registry

`agents/index.ts` populates a `BackendRegistry` — a mapped type `{ [Id in AgentBackendId]: BackendFactory }`
— which the type system forces to cover every backend id. The host resolves the active backend with
`registry[settings.agentBackend](settings)`. Backends are stateless; all per-edit state lives in the
context, so a factory call is cheap and switching backends at runtime is trivial (FR-43).

---

## 6. Authentication & Providers

This section is **authoritative** for how Easel authenticates the agent and which providers it supports.
The product constraints below are firm: implementers MUST conform to them exactly. The contract types live
in `src/shared/types.ts` (`AgentBackendId`, `ClaudeAuthMode`, `ClaudeAgentSdkConfig`, `AnthropicApiConfig`,
`LocalOpenAiConfig`, `BackendConfigs`, `ApiKeyRef`) and `src/shared/agent.ts` (`AgentBackendContext.secrets`,
`AgentCapabilities.agenticReliability`).

### 6.0 The firm product constraint (read first)

> **Easel never implements its own "Login with Claude" OAuth flow, and never reads `~/.claude` credentials
> directly.** Anthropic's Terms of Service forbid a redistributed third-party application from implementing
> subscription login or harvesting another tool's stored subscription credentials.

Easel stays compliant by **deferring** to the Claude Agent SDK's own credential resolution rather than
re-implementing it. In the default `inherit` mode Easel sets **no** credential environment variables at all;
it simply runs the SDK and lets the SDK use whatever Claude credential already exists on the machine — for
example an existing Claude Code login that maps to the user's Pro/Max plan. The consequence is that ordinary
use incurs **no extra pay-as-you-go API spend** beyond the plan the user already has. Every other auth mode
is an explicit, user-chosen opt-in.

### 6.1 The three backends at a glance

| Backend (`AgentBackendId`) | Implementation | Credential source | Billing | `agenticReliability` |
|---|---|---|---|---|
| `claude-agent-sdk` (default) | `@anthropic-ai/claude-agent-sdk` | Per `ClaudeAuthMode` (§6.2) — ambient by default | None extra in `inherit`; varies by mode | `high` |
| `anthropic-api` | Hand-built loop on `@anthropic-ai/sdk` | Anthropic API key (required) | Always API-billed | `high` |
| `local-openai` | Hand-built loop, OpenAI-compatible HTTP | Local endpoint; optional token | Free / self-hosted | `variable` (UI warns) |

The active backend is `AppSettings.agentBackend`; its configuration is `AppSettings.backends[id]`
(`BackendConfigs` guarantees one config object per id). The Claude-family backends use `AppSettings.model`
(default `claude-sonnet-4-6`); the `local-openai` backend uses its own `LocalOpenAiConfig.model` instead.

### 6.2 `claude-agent-sdk` — the five `ClaudeAuthMode`s

`ClaudeAgentSdkConfig.authMode` selects one of five strategies. The backend translates the config into
**environment variables / SDK options that scope only to the SDK subprocess or call** — it never mutates the
global Easel process environment permanently. Ambient-credential modes leave `AgentBackendContext.secrets`
empty; secret-bearing modes read exactly the refs they declare.

| `authMode` | What the backend sets for the SDK | Where the credential comes from | Secrets used (`ApiKeyRef`) |
|---|---|---|---|
| `inherit` **(default)** | **Nothing** — no credential env vars at all. | The SDK's own resolution: an existing Claude Code / Claude login → the user's Pro/Max plan. | none |
| `api-key` | `ANTHROPIC_API_KEY` = resolved secret. | An Anthropic API key the user entered (pay-as-you-go). | `apiKeyRef` → secret `id` |
| `bedrock` | `CLAUDE_CODE_USE_BEDROCK=1` (+ `AWS_REGION` / profile from `bedrock` config). | The **ambient AWS credential chain** (env / shared config / SSO / instance role). Never supplied by Easel. | none |
| `vertex` | `CLAUDE_CODE_USE_VERTEX=1` (+ project / region from `vertex` config). | **Application Default Credentials (ADC)** for GCP. Never supplied by Easel. | none |
| `gateway` | `ANTHROPIC_BASE_URL` = `baseUrl` (+ `ANTHROPIC_AUTH_TOKEN` = resolved secret). | A local/other model behind an Anthropic-compatible proxy (e.g. LiteLLM). | `authTokenRef` → secret `id` |

Notes:
- `inherit` is intentionally a no-op on credentials. It does **not** read or copy any credential file; it just
  refrains from overriding the SDK's resolution. This is the mechanism that keeps Easel within ToS.
- `bedrock` and `vertex` rely entirely on the host machine's ambient cloud credentials. Easel passes only
  non-secret routing config (region / profile / project) and the `CLAUDE_CODE_USE_*` flags.
- `gateway` is how a Claude-SDK user points at a non-Anthropic or local model server while keeping the SDK's
  agentic loop.

### 6.3 `anthropic-api` — the raw Messages-API loop

`AnthropicApiConfig.apiKeyRef` is **required**: this backend has no ambient-credential path and is always
billed against the Anthropic API. The host resolves the referenced secret into `secrets[apiKeyRef.id]`; the
hand-built loop constructs `@anthropic-ai/sdk` with that key (and the optional `baseUrl` override). Choose it
for a leaner, explicit, auditable tool loop or for cost control on simple edits.

### 6.4 `local-openai` — OpenAI-compatible / offline

`LocalOpenAiConfig` carries a `baseUrl` (e.g. `http://localhost:11434/v1` for Ollama), a `model`
(e.g. `qwen2.5-coder:14b`), and an optional `apiKeyRef` for servers that expect a bearer token. The backend
runs the same hand-built tool loop as `anthropic-api` but against the OpenAI-compatible endpoint. Because
small local models are inconsistent at multi-step tool use, this backend's `capabilities.agenticReliability`
is **`variable`** (vs. `high` for the two Claude-family backends). The Settings UI MUST surface a warning to
that effect (§6.6).

### 6.5 How `secrets` + per-backend config map to env / SDK options

The flow, end to end:

```
AppSettings.backends[id]          ── per-backend config (auth mode, baseUrl, refs, region/project)
        │
        │   host (main): for each ApiKeyRef the active backend declares,
        │   decrypt via Electron safeStorage → plaintext, keyed by ApiKeyRef.id
        ▼
AgentBackendContext.secrets       ── Readonly<Record<ApiKeyRef.id, plaintext>>; empty for ambient modes
        │
        │   backend translates (config + secrets) → env vars / SDK client options,
        │   scoped to the SDK subprocess / API call only (never global process.env)
        ▼
    SDK / HTTP client              ── claude-agent-sdk subprocess | @anthropic-ai/sdk | OpenAI-compatible fetch
```

Rules that all backends obey:

- A backend reads **only** the secret ids named in its own `BackendConfigs` entry (`apiKeyRef`,
  `authTokenRef`). It never iterates the whole `secrets` map.
- Plaintext secrets exist only inside `AgentBackendContext` for the duration of one edit. They are never
  persisted by the backend, never logged (the `AgentLogger` must redact), and never returned to the renderer
  (the renderer only ever sees `ApiKeyRef` with its 4-char `hint`).
- Credential env vars are applied to the SDK subprocess/call environment only; the global Easel
  `process.env` is never permanently mutated, so concurrent edits and mode switches do not leak across each
  other.
- `validate()` (the readiness probe) uses the lighter `ValidateContext` — which also carries `secrets` — so
  Settings can verify a backend with no project open: `inherit` checks the SDK can resolve a credential at
  all; `api-key` / `anthropic-api` / `gateway` confirm the referenced secret is present and accepted; the
  ambient cloud modes confirm the flags + routing config are coherent.

### 6.6 `agenticReliability` and the UI warning

`AgentCapabilities.agenticReliability` is `'high' | 'medium' | 'variable'`. The two Claude-family backends
report `high`; `local-openai` reports `variable`. When the active (or selected-in-Settings) backend reports
`variable`, the renderer MUST show a non-blocking warning — e.g. *"Local models can be unreliable at
multi-step edits; results may be incomplete. Claude backends are recommended for complex changes."* This is
the single capability-driven warning surfaced for provider choice; the UI otherwise hides features a backend
lacks (e.g. no thinking panel when `streamsThinking` is false).

### 6.7 Defaults & environment seeding

First-run defaults (and the `.env.example` that documents them, consumed only to seed initial settings —
runtime auth always flows through `AppSettings` + `safeStorage`, never raw env):

- `EASEL_DEFAULT_BACKEND=claude-agent-sdk`
- `EASEL_DEFAULT_MODEL=claude-sonnet-4-6` (current Claude ids, June 2026: Opus 4.8 `claude-opus-4-8`,
  Sonnet 4.6 `claude-sonnet-4-6`, Haiku 4.5 `claude-haiku-4-5-20251001`)
- Claude SDK auth mode defaults to `inherit` (no credential env vars set).

`.env.example` additionally documents the optional opt-in variables (`ANTHROPIC_API_KEY`,
`CLAUDE_CODE_USE_BEDROCK` + `AWS_REGION`, `CLAUDE_CODE_USE_VERTEX`, `ANTHROPIC_BASE_URL`, and a local
OpenAI-compatible base URL) so a developer can pre-seed any mode. None of these are required for the default
`inherit` path.

---

## 7. IPC Contract Overview

All main <-> renderer communication is declared once in `src/shared/ipc.ts` and is fully typed (NFR-13).

### 7.1 Shape

- **`IpcChannels`** — a `const` object of channel-name string literals (`as const`), grouped:
  `project.*`, `edit.*`, `settings.*`, `checkpoint.*`, `preview.*`.
- **`IpcInvokeMap`** — maps each request/response channel to `{ request; response }`. Main types its
  `ipcMain.handle` registrations against this; the preload types its `ipcRenderer.invoke` calls against it.
- **`IpcEventMap`** — maps each push channel (main → renderer) to its payload type, for `webContents.send`
  and the preload's `ipcRenderer.on` listeners.
- **`IpcResult<T>`** — `{ ok: true; value } | { ok: false; error; code? }`. Handlers return failures as
  values rather than throwing across the boundary, so the renderer always gets a typed result.
- **`EaselApi`** — the object the preload exposes at `window.easel`. Methods return `Promise<IpcResult<…>>`;
  `on*` methods register a listener and return an `Unsubscribe`.

### 7.2 Channel summary

| Group | Channels | Direction |
|---|---|---|
| `project.*` | `open`, `getCurrent`, `close` (invoke); `changed` (push) | renderer↔main; main→renderer |
| `edit.*` | `submit`, `cancel` (invoke); `event` (push, streamed `AgentEvent`) | renderer↔main; main→renderer |
| `settings.*` | `get`, `update`, `setSecret`, `clearSecret`, `validateBackend` (invoke); `changed` (push) | renderer↔main; main→renderer |
| `checkpoint.*` | `list`, `restore`, `undo`, `redo` (invoke); `changed` (push) | renderer↔main; main→renderer |
| `preview.*` | `reload`, `capture`, `requestImage` (invoke); `status` (push) | renderer↔main; main→renderer |
| `session.*` | `export`, `import`, `replayStep` (invoke) — session replay as a runnable `.easel` bundle (#18) | renderer↔main |

### 7.3 The other channel: guest ↔ host renderer

Distinct from Electron IPC, the guest inspector and host renderer talk over the `<webview>`'s
`ipc-message` / `send` mechanism using two typed unions in `ipc.ts`:

- **`InspectorMessage`** (guest → host): `inspector-ready`, `element-hover`, `element-picked`,
  `viewport-changed`.
- **`InspectorCommand`** (host → guest): `set-mode`, `highlight`, `request-target`.

This keeps the source-mapping contract typed end to end without granting the guest any host-renderer or
main-process access.

---

## 8. Git-Checkpoint Undo/Redo Design

Undo/redo is git-backed and lives in `src/main/checkpoints.ts`. The design goal (NFR-18): every checkpoint
is a clean, atomic, reversible state, and undo never destroys uncommitted user work.

### 8.1 Model

- Easel uses the project's existing git repository but isolates its checkpoints on a dedicated internal
  ref (e.g. `refs/easel/checkpoints`), so it never disturbs the user's own branches, HEAD, or staging area
  for unrelated work.
- One **`Checkpoint`** = one commit on that ref, created after an edit's files are applied. Fields:
  `id`, `commitSha`, `requestId?`, `message` (the truncated instruction), `createdAt`, `changedFiles`.
- The set of checkpoints forms an **ordered timeline**. A cursor marks the checkpoint the working tree
  currently matches (`currentId`).

### 8.2 Operations

| Operation | Mechanics | UI effect |
|---|---|---|
| **Create** (after an applied edit) | Stage the edited paths, commit onto the easel ref, return a `Checkpoint`. | Backend emits `checkpoint`; Toolbar enables Undo; ChatPanel records `checkpointId`. |
| **Undo** | Move the cursor back one; restore the working tree to the previous checkpoint's tree. | `<webview>` reloads/HMR reverts; Redo enabled. |
| **Redo** | Move the cursor forward one; restore that checkpoint's tree. | Re-applied; preview re-renders. |
| **Restore** (history jump) | Restore the working tree to any chosen `checkpointId` (confirmation dialog). | Jump to an arbitrary point in the timeline. |
| **Reject** (in diff review) | Restore to the checkpoint immediately before the edit, discarding it. | Preview reverts to pre-edit state. |

Undo/redo are pointer walks over the timeline; restoring a tree is a single atomic operation. Making a
**new** edit after an undo truncates the redo branch (standard editor semantics). The renderer drives all
of this through `checkpoint.undo` / `checkpoint.redo` / `checkpoint.restore` / `checkpoint.list`, and main
pushes `checkpoint.changed { checkpoints, currentId }` whenever the timeline or cursor moves.

### 8.3 Safety

- Before each checkpoint, main verifies the project is a git repo and that free disk space is adequate
  (risk register), surfacing a friendly error otherwise rather than corrupting state.
- Pre-write validation in `ProjectFs.writeFile` (formatting/parse sanity) protects against committing
  syntactically broken files (NFR-17).
- Because checkpoints live on a separate ref, an uncommitted change the user made by hand is never silently
  destroyed by an Easel undo; conflicts are surfaced.

---

## 9. How the Two Annotation Modes Feed the Agent

Both interaction modes converge on the same `EditRequest` shape, so the agent receives a uniform brief
regardless of how the user expressed intent. The difference is only in how `targets[]` and `annotations[]`
are populated.

### 9.1 ElementSelect mode

- Guest hover-highlights elements (`element-hover`) and, on click, posts one fully resolved
  `ElementTarget` (`element-picked`) with `selector`, `tagName`, `dataEaselSource?`, `boundingBox`,
  `textSnippet`, `attributes`, `pluginPresent`, `confidence`.
- Multi-select accumulates several `ElementTarget`s. Each may carry a derived `pin`/`rect` `Annotation`
  bound via `targetElementId` for visual feedback.
- The agent receives precise, structured targets — ideal for "make this button red" or
  "align these three headings."

### 9.2 Freeform mode

- `FreeformCanvas` records marks as `Annotation`s (`rect`/`ellipse`/`arrow`/`freehand`/`pin`) with
  structured `points`, a `boundingBox`, and a `color`.
- On stroke completion, the renderer asks the guest to resolve which DOM elements the region overlaps
  (grid-sampled `elementsFromPoint`, ranked by overlap/containment/depth), yielding a ranked
  `ElementTarget[]`. The most relevant become the `EditRequest.targets`.
- A composited screenshot of the marked region (`screenshotDataUrl`) is attached so a vision-capable
  backend (`capabilities.supportsVision`) literally sees what the user drew.
- The agent receives spatial + visual context — ideal for "widen this section" or
  "replace this photo," where the precise element isn't named.

### 9.3 What the agent does with both

The `EditRequest` carries `instruction`, the structured `annotations` (geometry the model can reason about
spatially), the `targets` (with source hints), and the optional `screenshotDataUrl`. The backend resolves
each target's source (plugin attribute first, grep fallback second — see `ELEMENT_SOURCE_MAPPING.md`),
selects the most semantically relevant element(s) for the instruction, edits the source via `ProjectFs`,
emits diffs, requests a checkpoint, and finishes. Combined edits (US-9.2) simply contain both element
targets and freeform annotations in one request.

---

## 10. Security Model

Security is enforced primarily through Electron process isolation and main-process gatekeeping (NFR-5,
NFR-15, and the contextIsolation risk in the register).

| Control | Implementation | Threat mitigated |
|---|---|---|
| **Context isolation** | `contextIsolation: true` on the renderer; renderer JS runs in a separate world from the preload. | Malicious/compromised page content cannot reach preload internals or Node. |
| **No node integration** | `nodeIntegration: false`, `sandbox: true` on the renderer; `nodeintegration` unset on `<webview>`. | Renderer and guest pages have no `require`/Node API; no arbitrary code-as-OS-process. |
| **Minimal bridge** | Preload exposes only the typed `EaselApi`; never `ipcRenderer`, `require`, or raw channels. | Reduces the attack surface to a small, audited, typed surface. |
| **Payload validation** | Main validates every inbound IPC payload before acting; malformed requests are rejected and logged, never crash main (NFR-14). | Injection / malformed-input crashes. |
| **Path sandbox** | `ProjectFs` resolves all paths against `projectRoot` and rejects traversal outside it. | Agent (esp. hand-built loop) writing outside the project. |
| **Secret handling** | API keys/tokens encrypted at rest via `safeStorage`; resolved to plaintext only transiently into `AgentBackendContext.secrets` (keyed by `ApiKeyRef.id`) when building a context; a backend reads only the refs it declares; never sent to the renderer (only `ApiKeyRef` with a 4-char hint), never logged (logger redacts). | Key exfiltration; plaintext in renderer memory or logs. |
| **No first-party credential harvesting** | Easel never implements "Login with Claude" and never reads `~/.claude`; the `inherit` auth mode sets **no** credential env vars and defers to the SDK's resolution. Cloud modes (`bedrock`/`vertex`) use ambient AWS/GCP credentials Easel never sees (§6). | Anthropic ToS violation; mishandling of subscription credentials. |
| **Scoped credential env** | Per-backend credential env vars (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK`/`_VERTEX`) are applied only to the SDK subprocess/call, never to global `process.env`. | Credential leakage across edits/modes; stale env after a backend switch. |
| **Webview origin lock** | Navigation constrained to the dev-server origin; `allowpopups` off; dedicated session partition. | Drive-by navigation / popup abuse from page content. |
| **No telemetry** | No analytics or phoning-home by default; opt-in only (NFR-6). | Privacy leakage. |
| **Guest isolation** | The webview-preload can post `InspectorMessage`s and read the guest DOM, but cannot access the host renderer's JS context or main. | Page content cannot drive privileged operations. |

The `data-easel-source` attribute is dev-only (the Vite plugin no-ops on `command !== 'serve'`), so it
never leaks source paths into production bundles.

---

## 11. Cross-Process Contract Files

These three files in `src/shared/` are imported by every other module and are the single source of truth
for all boundaries. They contain **types/interfaces/const-literals only** — no runtime logic — and compile
cleanly under TypeScript `strict`.

| File | Role |
|---|---|
| `src/shared/types.ts` | All domain types: `SourceLocation`, `ConfidenceLevel`, `ElementTarget`, `Annotation` (+ `AnnotationMode`/`AnnotationKind`), `AnnotationBatch`, `EditRequest`, `FileDiff`, `AgentEvent` (discriminated union), `Checkpoint`, `ChatMessage`, `ProjectConfig`, `AppSettings` (+ `FeatureFlags`, `ApiKeyRef`, `AgentBackendId`), the auth/provider matrix (`ClaudeAuthMode`, `ClaudeAgentSdkConfig`, `AnthropicApiConfig`, `LocalOpenAiConfig`, `BackendConfigs`), and the `ImageProvider` interface with `ImageRequest`/`ImageResult`. |
| `src/shared/agent.ts` | The pluggable `AgentBackend` interface (`editStream` async stream, `capabilities` incl. `agenticReliability`, `cancel?`, `validate?`), the host-provided `AgentBackendContext` (incl. the `ProjectFs` sandbox, the `secrets` map, `ImageProvider`, `AgentLogger`, `AbortSignal`, `createCheckpoint`), the lighter `ValidateContext`, and the `BackendFactory` / `BackendRegistry` registry types. |
| `src/shared/ipc.ts` | The typed IPC contract: `IpcChannels` literals, per-channel request/response payloads, `IpcInvokeMap`, `IpcEventMap`, `IpcResult<T>`, the `EaselApi` surface for `window.easel`, and the guest↔host `InspectorMessage` / `InspectorCommand` unions. |

See `docs/FILE_MANIFEST.md` for the exhaustive file-by-file breakdown of the whole codebase, and
`docs/ELEMENT_SOURCE_MAPPING.md` for the deep design of element→source resolution.

---

## 12. Architectural Risks & Decisions (ADR Summary)

| Decision | Rationale | Trade-off / mitigation |
|---|---|---|
| **`<webview>` over `WebContentsView`** | Composites in the React layout; supports guest preload; overlay stacks via CSS. | `<webview>` is heavier and historically discouraged; we lock down origin/partition and keep guest isolated. |
| **Pluggable `AgentBackend` (three impls)** | Lets users trade power (SDK on their ambient Claude plan) vs. cost/transparency (raw API) vs. privacy/offline (local OpenAI-compatible) without app changes. | Three code paths to maintain; mitigated by a single normalized `AgentEvent` contract and a shared `ProjectFs`/tools layer reused by the two hand-built loops. |
| **No first-party "Login with Claude"; `inherit` is the default auth mode** | Anthropic ToS forbids a redistributed third-party app implementing subscription login or reading `~/.claude` credentials. Deferring to the SDK's ambient credential resolution keeps Easel compliant while letting users run on their existing Claude plan at no extra spend. | Easel cannot show a "you are logged in as…" state for `inherit`; readiness is probed via `validate()` and the SDK surfaces auth errors at edit time. See Section 6. |
| **`data-easel-source` Vite plugin as primary source map** | Survives bundling/HMR; framework-agnostic in the DOM. | Requires user to install the plugin; grep fallback + confidence scoring covers the rest. |
| **Git checkpoints on an isolated ref** | Atomic, reversible, leverages a tool the user already trusts. | Assumes a git repo; checked before each checkpoint with a friendly failure. |
| **Main owns all side effects** | One privileged surface to audit; renderer stays a pure view. | More IPC plumbing; mitigated by the fully typed `ipc.ts` contract. |
| **`AsyncIterable<AgentEvent>` streaming** | Natural backpressure-friendly model; backend-agnostic UI. | Requires careful terminal-event discipline (exactly one `done`/`error`); documented in the interface. |

---

*End of Architecture Document. Keep this in sync with `src/shared/*` and the file manifest (NFR-20).*
