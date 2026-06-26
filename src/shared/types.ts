/**
 * Easel — cross-process domain types.
 *
 * This module is the single source of truth for every domain object that
 * crosses a process boundary (renderer <-> preload <-> main <-> agent) or a
 * persistence boundary (settings on disk, git checkpoints). It contains ONLY
 * types/interfaces — no runtime logic — so it can be imported safely from any
 * of the three TypeScript roots (main / preload / renderer) and from the
 * webview-preload guest script.
 *
 * Compatible with TypeScript `strict` mode. Every exported symbol is documented.
 */

/* -------------------------------------------------------------------------- */
/*  Geometry primitives                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A 2D point in CSS pixels, relative to the top-left of the embedded preview
 * viewport (the `<webview>` content area), NOT the host window. The overlay
 * and the guest inspector agree on this coordinate space.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * An axis-aligned bounding box in CSS pixels, relative to the preview viewport.
 * `x`/`y` are the top-left corner; `width`/`height` are non-negative extents.
 */
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/* -------------------------------------------------------------------------- */
/*  Source mapping                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A location inside a project source file. Produced by the
 * `@easel/vite-plugin-inspector` plugin, which stamps elements with a
 * `data-easel-source="relativeFile:line:col"` attribute that the guest
 * inspector parses into this shape.
 */
export interface SourceLocation {
  /** Path relative to {@link ProjectConfig.root}, e.g. `src/components/Hero.tsx`. */
  filePath: string;
  /** 1-based line number of the element's opening tag. */
  line: number;
  /** 1-based column number of the element's opening tag. */
  column: number;
}

/* -------------------------------------------------------------------------- */
/*  Source-resolution confidence                                               */
/* -------------------------------------------------------------------------- */

/**
 * How sure the system is that a DOM element was mapped to the correct source
 * location. Drives UI affordances (green check / amber warning / red blocked)
 * and whether the agent edits directly or asks the user to confirm. See
 * `docs/ELEMENT_SOURCE_MAPPING.md` for the scoring model.
 *
 * - `high`    : `data-easel-source` present and verified, or a unique grep hit.
 * - `medium`  : line shifted slightly (HMR race) or a single grep candidate.
 * - `low`     : multiple grep candidates; user confirmation recommended.
 * - `none`    : no match; edit blocked until the user specifies the file.
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'none';

/* -------------------------------------------------------------------------- */
/*  Element targeting                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A concrete DOM element the user has identified as the subject of an edit.
 * Built by the guest inspector (in the webview) during ElementSelect mode, or
 * inferred from a Freeform annotation that overlaps a single dominant element.
 *
 * The agent uses these fields in priority order to locate the corresponding
 * source: {@link dataEaselSource} (exact) > {@link selector} + {@link textSnippet}
 * (grep-able) > {@link tagName} + {@link attributes} (last resort).
 */
export interface ElementTarget {
  /** Stable id for this target within a single {@link EditRequest}. */
  id: string;
  /**
   * A robust CSS selector computed by the guest inspector, resilient to
   * sibling reordering (prefers ids, stable classes, and `:nth-of-type`).
   */
  selector: string;
  /** Lowercased tag name, e.g. `div`, `img`, `h1`. */
  tagName: string;
  /**
   * Parsed value of `data-easel-source` if the inspector plugin was present.
   * Absent for projects that did not install the Vite plugin (fallback path).
   */
  dataEaselSource?: SourceLocation;
  /** Element bounding box in preview-viewport CSS pixels. */
  boundingBox: BoundingBox;
  /**
   * Trimmed visible text content of the element (and immediate children),
   * truncated to a reasonable length. Used by the agent to grep source when
   * {@link dataEaselSource} is unavailable.
   */
  textSnippet: string;
  /**
   * Whitelisted attributes captured from the element (e.g. `id`, `class`,
   * `src`, `alt`, `href`, `data-testid`). Values are raw strings.
   */
  attributes: Record<string, string>;
  /**
   * Whether `data-easel-source` was found on this element (or a stamped
   * ancestor). When false the agent uses the grep fallback path.
   */
  pluginPresent: boolean;
  /**
   * The inspector's a-priori confidence in {@link dataEaselSource}. The agent
   * may downgrade this after verifying the source on disk (HMR race detection).
   */
  confidence: ConfidenceLevel;
  /**
   * Issue #8: a curated set of the element's computed CSS values (color,
   * spacing, typography) keyed by kebab-case property, so the token panel can
   * match them to project design tokens.
   */
  computedStyles?: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/*  Alignment grid (issue #5)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One element the off-grid detector flagged as misaligned against the active
 * alignment grid. Carries enough provenance for the host to list it and, on
 * "snap to grid", to build an {@link EditRequest} that points the agent at the
 * right source. Produced guest-side by `src/preload/webview/inspector.ts`.
 */
export interface OffGridElement {
  /** Stable id within one scan (mirrors {@link ElementTarget.id} semantics). */
  id: string;
  /** A robust CSS selector for the element (same builder as element-select). */
  selector: string;
  /** Lowercased tag name, e.g. `div`, `section`, `button`. */
  tagName: string;
  /** Parsed `data-easel-source` if the inspector plugin stamped this element. */
  dataEaselSource?: SourceLocation;
  /** Element bounding box in preview-viewport CSS pixels. */
  boundingBox: BoundingBox;
  /**
   * The single largest edge-to-grid distance in px (max of left/right vs.
   * column edges and top/bottom vs. baseline). Drives ranking + the UI label.
   */
  worstOffsetPx: number;
}

/* -------------------------------------------------------------------------- */
/*  Annotations                                                                */
/* -------------------------------------------------------------------------- */

/** Which interaction mode produced an annotation. */
export type AnnotationMode = 'element' | 'freeform';

/**
 * The geometric kind of a freeform mark, or `pin` for a point callout.
 * `element` annotations conventionally use {@link AnnotationKind} `pin` or a
 * `rect` derived from the element's bounding box.
 */
export type AnnotationKind = 'rect' | 'ellipse' | 'arrow' | 'freehand' | 'pin';

/**
 * A single mark drawn on (or attached to) the preview. Stored as structured
 * geometry so it can be re-rendered, serialized to the agent, and reasoned
 * about spatially. All coordinates are in preview-viewport CSS pixels.
 */
export interface Annotation {
  /** Stable id within an {@link AnnotationBatch}. */
  id: string;
  /** Whether this came from clicking an element or drawing freehand. */
  mode: AnnotationMode;
  /** The geometric kind of mark. */
  kind: AnnotationKind;
  /**
   * Geometry interpreted by {@link kind}:
   * - `rect` / `ellipse`: exactly two points (top-left, bottom-right of bbox).
   * - `arrow`: exactly two points (tail, head).
   * - `freehand`: an ordered polyline of >= 2 points.
   * - `pin`: exactly one point.
   */
  points: Point[];
  /**
   * The bounding box that encloses {@link points}, precomputed for hit-testing
   * and for cropping the screenshot region sent to the agent.
   */
  boundingBox: BoundingBox;
  /** Stroke/fill color as a CSS color string (e.g. `#ff3b30`). */
  color: string;
  /** Optional short text the user typed next to the mark. */
  label?: string;
  /**
   * For `element`-mode annotations: the {@link ElementTarget.id} this mark is
   * bound to. Undefined for pure freeform marks.
   */
  targetElementId?: string;
  /**
   * The preview scroll offset (from {@link InspectorMessage} `viewport-changed`)
   * at the moment this mark was drawn. {@link points}/{@link boundingBox} are in
   * viewport CSS pixels relative to this origin, so the overlay can re-align the
   * mark after scrolling: `screenPoint = point - (currentScroll - scrollOrigin)`.
   */
  scrollOrigin: Point;
}

/**
 * A collection of annotations captured in one editing gesture, plus the
 * cropped screenshot that visually accompanies them. One batch maps to one
 * {@link EditRequest}.
 */
export interface AnnotationBatch {
  /** Stable id for the batch. */
  id: string;
  /** All marks in this batch, in draw order. */
  annotations: Annotation[];
  /**
   * Data URL (`data:image/png;base64,...`) of the marked region, with the
   * annotation overlay composited on top so the agent "sees what the user
   * drew". May be the full viewport or a cropped union of annotation bboxes.
   */
  screenshotDataUrl?: string;
  /** Epoch milliseconds when the batch was created. */
  createdAt: number;
}

/* -------------------------------------------------------------------------- */
/*  Edit request (renderer -> main -> agent)                                   */
/* -------------------------------------------------------------------------- */

/**
 * The complete payload describing one requested change. Assembled in the
 * renderer, sent over IPC to the main process, then handed to the selected
 * {@link AgentBackend} (see `agent.ts`). This is the agent's full task brief.
 */
export interface EditRequest {
  /** Stable id; also used to correlate streamed {@link AgentEvent}s. */
  id: string;
  /** The user's natural-language instruction (typed or transcribed). */
  instruction: string;
  /** All marks for this edit. */
  annotations: Annotation[];
  /** All element targets resolved for this edit. */
  targets: ElementTarget[];
  /**
   * Optional composited screenshot of the marked region (data URL). Lifted
   * from {@link AnnotationBatch.screenshotDataUrl} for direct multimodal use.
   */
  screenshotDataUrl?: string;
  /** Absolute path to the project root on disk the agent may edit. */
  projectRoot: string;
  /** The dev-server URL currently loaded in the preview, e.g. `http://localhost:3000`. */
  devServerUrl: string;
}

/* -------------------------------------------------------------------------- */
/*  Agent streaming events (agent -> main -> renderer)                         */
/* -------------------------------------------------------------------------- */

/** A unified diff for a single file touched by an edit. */
export interface FileDiff {
  /** Path relative to {@link ProjectConfig.root}. */
  filePath: string;
  /** How the file was changed. */
  changeType: 'modified' | 'created' | 'deleted' | 'renamed';
  /** Unified-diff text (git-style hunks). */
  unifiedDiff: string;
  /** New path when {@link changeType} is `renamed`. */
  renamedTo?: string;
  /** Count of added lines (for compact UI summaries). */
  additions: number;
  /** Count of removed lines (for compact UI summaries). */
  deletions: number;
}

/**
 * A discriminated union of everything the agent can stream back during an edit.
 * The renderer switches on `type` to drive the chat/diff UI. Every variant
 * carries `requestId` so multiple concurrent (or replayed) edits stay separated.
 */
export type AgentEvent =
  | {
      type: 'thinking';
      requestId: string;
      /** Incremental reasoning/explanatory text (may arrive in chunks). */
      text: string;
    }
  | {
      type: 'tool-call';
      requestId: string;
      /** Tool name, e.g. `read_file`, `edit_file`, `grep`, `replace_image`. */
      tool: string;
      /** JSON-serializable tool input as provided by the model. */
      input: unknown;
      /** Stable id correlating this call to its eventual result. */
      callId: string;
    }
  | {
      type: 'file-edit';
      requestId: string;
      /** The diff applied to the file ({@link FileDiff.filePath} is authoritative). */
      diff: FileDiff;
    }
  | {
      type: 'message';
      requestId: string;
      /** A user-facing assistant message (final or interim narration). */
      text: string;
    }
  | {
      type: 'confidence';
      requestId: string;
      /** The {@link ElementTarget.id} this refers to, when target-specific. */
      targetId?: string;
      /** Resolved confidence that the edit is touching the correct source. */
      level: ConfidenceLevel;
      /** Human-readable explanation (e.g. "matched data-easel-source exactly"). */
      message: string;
    }
  | {
      type: 'warning';
      requestId: string;
      /** Non-fatal warning surfaced mid-edit (e.g. "ambiguous match; picked best"). */
      message: string;
      /**
       * Optional stable code for programmatic handling. Guardrail policy
       * (`.easel/policy.json`) writes surface here — both are NON-terminal, so
       * the edit stream continues after them:
       *  - `policy-confirm` — a `requireConfirm` path needs the user to approve
       *    the write to {@link path}; the edit pauses until the renderer replies
       *    via `edit.policyRespond`.
       *  - `policy-blocked` — a write to {@link path} was denied (deny rule,
       *    blast-radius cap, or the user declined). The agent's tool call fails,
       *    no file changed, but the edit is NOT terminated.
       */
      code?: string;
      /** Project-relative path this warning concerns (`policy-confirm`/`policy-blocked`). */
      path?: string;
    }
  | {
      type: 'diff';
      requestId: string;
      /** The full set of diffs accumulated so far for this request. */
      diffs: FileDiff[];
    }
  | {
      type: 'checkpoint';
      requestId: string;
      /** The git checkpoint created after the edit was applied. */
      checkpoint: Checkpoint;
    }
  | {
      type: 'done';
      requestId: string;
      /** Final summary text shown when the edit completes successfully. */
      summary: string;
      /** All diffs produced by this request. */
      diffs: FileDiff[];
    }
  | {
      type: 'error';
      requestId: string;
      /** Human-readable error message. */
      message: string;
      /** Stable error code for programmatic handling (e.g. `auth`, `cancelled`, `needs-file`). */
      code?: string;
      /** Whether the caller may retry the same request. */
      recoverable: boolean;
      /**
       * For `code: 'needs-file'` (confidence `none`): candidate source files the
       * user can disambiguate between. The renderer re-submits the EditRequest
       * with an explicit file hint, keeping the event stream one-way.
       */
      candidates?: string[];
    };

/** Narrows {@link AgentEvent} to a specific `type`. */
export type AgentEventOf<T extends AgentEvent['type']> = Extract<AgentEvent, { type: T }>;

/* -------------------------------------------------------------------------- */
/*  Git checkpoints (undo/redo)                                                */
/* -------------------------------------------------------------------------- */

/**
 * One git-backed snapshot of the project, created after an edit is applied.
 * Undo/redo walks the ordered list of checkpoints; see `src/main/checkpoints.ts`.
 */
export interface Checkpoint {
  /** Stable id (also the short label shown in the timeline). */
  id: string;
  /** The git commit SHA captured on the internal Easel checkpoint ref. */
  commitSha: string;
  /** The {@link EditRequest.id} that produced this checkpoint, if any. */
  requestId?: string;
  /** One-line description (usually the user's instruction, truncated). */
  message: string;
  /** Epoch milliseconds when the checkpoint was created. */
  createdAt: number;
  /** Files changed by the edit, for timeline display. */
  changedFiles: string[];
}

/**
 * Structured "why this edit happened" metadata recorded onto a checkpoint commit
 * as git trailers (see `src/main/provenance.ts`). Makes every Easel edit
 * auditable via `git log`/`git blame`, and lets the data ride onto real commits
 * when the Branch/PR feature promotes a checkpoint. Every field is optional so a
 * checkpoint created outside the edit pipeline (e.g. the initial snapshot) can
 * still be recorded.
 */
export interface CheckpointProvenance {
  /** The user's natural-language instruction that drove the edit. */
  instruction?: string;
  /**
   * DOM target descriptors the user pointed at (selector or tag), one per
   * {@link ElementTarget}. Recorded as `Easel-Target` trailers.
   */
  targets?: string[];
  /**
   * Source locations the edit resolved to (e.g. `src/Hero.tsx:42`), derived from
   * {@link ElementTarget.dataEaselSource} or the changed files. Recorded as
   * `Easel-Source` trailers.
   */
  sources?: string[];
  /** The resolved {@link ConfidenceLevel} for the edit, if known. */
  confidence?: ConfidenceLevel;
  /** The model id that produced the edit (e.g. `claude-opus-4-8`). */
  model?: string;
  /** The {@link AgentBackendId} that produced the edit. */
  backend?: AgentBackendId;
}

/* -------------------------------------------------------------------------- */
/*  Chat transcript                                                            */
/* -------------------------------------------------------------------------- */

/** Role of a transcript entry shown in the ChatPanel. */
export type ChatRole = 'user' | 'assistant' | 'system';

/**
 * One entry in the conversation transcript rendered by the ChatPanel. User
 * entries may carry the annotations/targets that accompanied the instruction.
 */
export interface ChatMessage {
  /** Stable id. */
  id: string;
  /** Who authored the entry. */
  role: ChatRole;
  /** Rendered text content. */
  content: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** For user turns: the request this message initiated. */
  requestId?: string;
  /** For user turns: snapshot of annotations attached to the instruction. */
  annotations?: Annotation[];
  /** Diffs produced by the assistant turn, if any. */
  diffs?: FileDiff[];
  /** Checkpoint id created by this turn, enabling per-message undo. */
  checkpointId?: string;
}

/* -------------------------------------------------------------------------- */
/*  Project configuration                                                      */
/* -------------------------------------------------------------------------- */

/** The framework Easel detected for the open project (affects source mapping). */
export type ProjectFramework = 'vite-react' | 'next' | 'vite-vue' | 'vite-svelte' | 'unknown';

/**
 * Describes the project currently open in Easel. Detected when a folder is
 * opened; persisted per-project so the user need not reconfigure each session.
 */
export interface ProjectConfig {
  /** Absolute path to the project root on disk. */
  root: string;
  /** Display name (defaults to the directory basename). */
  name: string;
  /** Detected framework, used to tune the source-mapping strategy. */
  framework: ProjectFramework;
  /** The dev-server URL to load in the preview, e.g. `http://localhost:3000`. */
  devServerUrl: string;
  /** Whether `@easel/vite-plugin-inspector` is detected/active for this project. */
  inspectorPluginPresent: boolean;
  /**
   * Optional dev-server start command (e.g. `npm run dev`). When present Easel
   * may offer to launch it; otherwise the user starts it manually.
   */
  devCommand?: string;
}

/* -------------------------------------------------------------------------- */
/*  Application settings & secrets                                             */
/* -------------------------------------------------------------------------- */

/** Which pluggable agent backend implementation is active. */
export type AgentBackendId = 'claude-agent-sdk' | 'anthropic-api' | 'local-openai';

/**
 * How the Claude Agent SDK backend authenticates. `inherit` is the default and
 * recommended path: Easel sets NO credential env vars and lets the SDK use
 * whatever Claude credential already exists on the machine (e.g. an existing
 * Claude Code login → the user's Pro/Max plan), so normal use incurs no extra
 * pay-as-you-go API spend. The other modes are explicit opt-ins.
 *
 * NOTE: Easel never implements its own "Login with Claude" OAuth flow and never
 * reads `~/.claude` credentials directly — `inherit` simply does not override
 * the SDK's own credential resolution. See `docs/ARCHITECTURE.md` §Auth.
 */
export type ClaudeAuthMode = 'inherit' | 'setup-token' | 'api-key' | 'bedrock' | 'vertex' | 'gateway';

/** Configuration for the default Claude Agent SDK backend. */
export interface ClaudeAgentSdkConfig {
  /** See {@link ClaudeAuthMode}. Defaults to `inherit`. */
  authMode: ClaudeAuthMode;
  /** Secret ref for `setup-token` mode (host sets `CLAUDE_CODE_OAUTH_TOKEN`). */
  oauthTokenRef?: ApiKeyRef;
  /** Secret ref for `api-key` mode (host sets `ANTHROPIC_API_KEY`). */
  apiKeyRef?: ApiKeyRef;
  /**
   * Base URL for `gateway` mode (host sets `ANTHROPIC_BASE_URL`). Enables routing
   * to local or other models behind an Anthropic-compatible proxy (e.g. LiteLLM).
   */
  baseUrl?: string;
  /** Bearer-token secret ref for `gateway` mode (host sets `ANTHROPIC_AUTH_TOKEN`). */
  authTokenRef?: ApiKeyRef;
  /**
   * AWS settings for `bedrock` mode (host sets `CLAUDE_CODE_USE_BEDROCK=1`).
   * Credentials come from the ambient AWS credential chain, never from Easel.
   */
  bedrock?: { region?: string; profile?: string };
  /**
   * GCP settings for `vertex` mode (host sets `CLAUDE_CODE_USE_VERTEX=1`).
   * Credentials come from Application Default Credentials, never from Easel.
   */
  vertex?: { project?: string; region?: string };
}

/** Configuration for the raw Anthropic Messages API backend (always API-billed). */
export interface AnthropicApiConfig {
  /** Secret ref for the Anthropic API key (required for this backend). */
  apiKeyRef: ApiKeyRef;
  /** Optional override base URL. */
  baseUrl?: string;
}

/**
 * Configuration for a local / OpenAI-compatible backend (Ollama, LM Studio,
 * llama.cpp, vLLM, …). Easel runs its own agent tool-loop against the endpoint.
 */
export interface LocalOpenAiConfig {
  /** OpenAI-compatible base URL, e.g. `http://localhost:11434/v1` (Ollama). */
  baseUrl: string;
  /** Model name served by the endpoint, e.g. `qwen2.5-coder:14b`. */
  model: string;
  /** Optional API-key secret ref (some local servers expect a token). */
  apiKeyRef?: ApiKeyRef;
}

/** Per-backend configuration; one entry per {@link AgentBackendId}. */
export interface BackendConfigs {
  'claude-agent-sdk': ClaudeAgentSdkConfig;
  'anthropic-api': AnthropicApiConfig;
  'local-openai': LocalOpenAiConfig;
}

/**
 * A reusable, one-click instruction template ("macro"). Saved once, then
 * invoked on any selected element via the chat-panel macro bar (or its hotkey).
 *
 * The {@link instructionTemplate} may contain `{element}` and `{text}`
 * placeholders that are interpolated from the currently selected
 * {@link ElementTarget} at invoke time (see `interpolateMacro` in
 * `src/shared/macros.ts`) before being handed to the existing edit pipeline.
 */
export interface InstructionMacro {
  /** Stable id for this macro within {@link AppSettings.macros}. */
  id: string;
  /** Human-readable label shown on the macro bar button. */
  name: string;
  /**
   * The instruction phrasing to submit. May embed `{element}` (the target's
   * selector/tag) and `{text}` (its text snippet); both are replaced at invoke
   * time. A macro with no placeholders is submitted verbatim.
   */
  instructionTemplate: string;
  /**
   * Optional keyboard shortcut to invoke the macro (e.g. `mod+1`), captured as
   * a normalized chord string. Empty/undefined means no hotkey is bound.
   */
  hotkey?: string;
}

/** Feature flags for capabilities that degrade gracefully. */
export interface FeatureFlags {
  /** Enable Web Speech API voice input in the renderer. */
  voiceInput: boolean;
  /** Enable the (optional) real image-generation provider vs. the stub. */
  imageGeneration: boolean;
  /** Show streamed agent reasoning ('thinking') in the chat panel. */
  showThinking: boolean;
  /** Auto-create a git checkpoint before every applied edit. */
  autoCheckpoint: boolean;
}

/**
 * An opaque reference to a secret stored via Electron `safeStorage`. The raw
 * key never lives in this object or in renderer state; only this handle does.
 * The main process resolves it to plaintext at call time. See `src/main/settings.ts`.
 */
export interface ApiKeyRef {
  /** Logical name of the secret, e.g. `anthropic` or `image-provider`. */
  id: string;
  /** Whether a value is currently stored for this reference. */
  isSet: boolean;
  /** Last 4 characters for display (e.g. `…aB3x`), never the full key. */
  hint?: string;
}

/**
 * User-tunable application settings. Persisted by the main process. The
 * renderer reads/writes these via typed IPC; secrets are referenced indirectly
 * through {@link ApiKeyRef} so plaintext keys never enter renderer memory.
 */
export interface AppSettings {
  /** Selected agent backend implementation. */
  agentBackend: AgentBackendId;
  /**
   * Model id for the Claude-family backends (`claude-agent-sdk`, `anthropic-api`).
   * The `local-openai` backend uses {@link LocalOpenAiConfig.model} instead.
   */
  model: string;
  /** Per-backend configuration (auth/provider mode, endpoints, secret refs). */
  backends: BackendConfigs;
  /** Optional reference to an image-provider API key in safeStorage. */
  imageApiKeyRef?: ApiKeyRef;
  /** Capability toggles. */
  featureFlags: FeatureFlags;
  /** UI theme preference. */
  theme: 'system' | 'light' | 'dark';
  /**
   * Saved instruction macros, in display order. Persisted to disk alongside the
   * rest of {@link AppSettings} so they survive restarts.
   */
  macros: InstructionMacro[];
}

/* -------------------------------------------------------------------------- */
/*  Image provider (replace_image tool)                                        */
/* -------------------------------------------------------------------------- */

/** How an image should be produced by an {@link ImageProvider}. */
export type ImageRequestMode = 'generate' | 'edit' | 'fetch';

/** Input for an image operation requested by the agent's `replace_image` tool. */
export interface ImageRequest {
  /** Stable id. */
  id: string;
  /** What to do: generate from scratch, edit a source image, or fetch by URL. */
  mode: ImageRequestMode;
  /** Natural-language description of the desired image. */
  prompt: string;
  /** For `edit` mode: data URL of the source image to transform. */
  sourceImageDataUrl?: string;
  /** For `fetch` mode: the URL to retrieve. */
  sourceUrl?: string;
  /** Desired output width in pixels, if the provider supports sizing. */
  width?: number;
  /** Desired output height in pixels, if the provider supports sizing. */
  height?: number;
  /** Preferred output format. */
  format?: 'png' | 'jpeg' | 'webp';
}

/** Result of an {@link ImageProvider} operation. */
export interface ImageResult {
  /** Echoes {@link ImageRequest.id}. */
  id: string;
  /** Whether the operation succeeded. */
  ok: boolean;
  /**
   * On success, the resulting image as a data URL. The main process is
   * responsible for writing it to the project (e.g. `public/`) and rewriting
   * the referencing source.
   */
  imageDataUrl?: string;
  /** Suggested file extension for persistence (without dot), e.g. `png`. */
  extension?: string;
  /** Error message when {@link ok} is false. */
  error?: string;
}

/**
 * Pluggable provider that fulfills the agent's image needs. A stub
 * implementation ships by default; a real generation/editing provider can be
 * registered optionally. Lives behind the `replace_image` agent tool.
 */
export interface ImageProvider {
  /** Stable id, e.g. `stub`, `openai-images`, `replicate`. */
  readonly id: string;
  /** Human-readable name for settings UI. */
  readonly name: string;
  /** Whether the provider is currently usable (e.g. has a configured key). */
  isAvailable(): boolean;
  /** Produce or transform an image per the request. */
  request(input: ImageRequest): Promise<ImageResult>;
}

/* -------------------------------------------------------------------------- */
/*  Issue #6: Live DOM/CSS tweak — structured style delta                       */
/* -------------------------------------------------------------------------- */

/**
 * One ephemeral inline-style change made via the tweak tool. Accumulated per
 * element and shipped to the agent by "Apply to source" so the edit is precise.
 */
export interface StyleEdit {
  /** CSS property name in kebab-case, e.g. `padding`, `border-radius`. */
  property: string;
  /** The element's value for {@link property} before the first tweak. */
  oldValue: string;
  /** The value the user tweaked it to (applied live as an inline style). */
  newValue: string;
}

/* -------------------------------------------------------------------------- */
/*  Issue #8: Live token inspector — design tokens                             */
/* -------------------------------------------------------------------------- */

/** Where a design token came from (drives the suggested source replacement). */
export type TokenKind = 'css-var' | 'tailwind';

/** A resolved design token discovered in the project's token sources. */
export interface DesignToken {
  /** Token identity, e.g. `--color-slate-800` or `slate-800`. */
  name: string;
  /** The token's raw value, e.g. `#1e293b` or `1rem`. */
  value: string;
  /** Source kind. */
  kind: TokenKind;
  /** What to write in source to use this token (CSS var) or a hint (Tailwind). */
  replacement: string;
}

/** A computed value and the design token it maps to (or null when off-system). */
export interface TokenMatch {
  /** CSS property the value came from. */
  property: string;
  /** The element's computed value for {@link property}. */
  value: string;
  /** The matched token, or null when no token matches (off-system). */
  token: DesignToken | null;
}

/* -------------------------------------------------------------------------- */
/*  Issue #11: Scratch branches — throwaway experiment state                    */
/* -------------------------------------------------------------------------- */

/**
 * The current scratch-experiment state. While a scratch is active, new
 * checkpoints are routed to a `refs/easel/scratch/<id>` ref; "Keep" lands them
 * on the main checkpoint line and "Discard" deletes the ref and restores the
 * pre-scratch tree. The user's real git `HEAD`/branches are never touched.
 */
export interface ScratchInfo {
  /** Whether a scratch experiment is currently active. */
  active: boolean;
  /** The scratch id (also the `refs/easel/scratch/<id>` segment). */
  id?: string;
  /** Optional user-supplied name for the experiment. */
  name?: string;
  /** The checkpoint id the scratch was forked from. */
  baseCheckpointId?: string;
}
