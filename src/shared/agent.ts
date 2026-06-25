/**
 * Easel — pluggable agent backend contract.
 *
 * Defines the single interface that both shipping implementations satisfy:
 *   - `src/main/agents/claudeAgentSdk.ts` — built on `@anthropic-ai/claude-agent-sdk`.
 *   - `src/main/agents/anthropicApi.ts`   — a hand-built agent loop on `@anthropic-ai/sdk`.
 *
 * The host (main process) selects an implementation from {@link AppSettings.agentBackend},
 * constructs it through a {@link BackendFactory}, and drives one edit by consuming
 * the {@link AgentEvent} stream returned by {@link AgentBackend.editStream}.
 *
 * Pure types/interfaces only — no runtime logic, no imports of Node/Electron APIs.
 */

import type {
  AgentBackendId,
  AgentEvent,
  AppSettings,
  Checkpoint,
  EditRequest,
  FileDiff,
  ImageProvider,
} from './types';

/* -------------------------------------------------------------------------- */
/*  Capabilities                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Static description of what a backend can do. The UI uses this to enable or
 * hide features (e.g. only show a "thinking" panel if `streamsThinking`).
 */
export interface AgentCapabilities {
  /** Emits incremental `thinking` events as it reasons. */
  streamsThinking: boolean;
  /** Surfaces `tool-call` events for each tool invocation. */
  streamsToolCalls: boolean;
  /** Can accept the composited screenshot as multimodal input. */
  supportsVision: boolean;
  /** Edits files directly on disk (vs. proposing patches the host applies). */
  editsFilesDirectly: boolean;
  /** Understands git state when locating/relating changes. */
  gitAware: boolean;
  /** Can invoke the `replace_image` tool through the {@link ImageProvider}. */
  supportsImageTool: boolean;
  /** Honors mid-flight cancellation via {@link AgentBackendContext.signal}. */
  cancellable: boolean;
  /**
   * How reliably this backend handles multi-step agentic edits: `high` for
   * frontier Claude models, `variable` for local models that may struggle with
   * tool use. The UI surfaces a warning when this is `variable`.
   */
  agenticReliability: 'high' | 'medium' | 'variable';
  /** Model identifiers this backend is known to support, if constrained. */
  supportedModels?: string[];
}

/* -------------------------------------------------------------------------- */
/*  Host-provided services                                                     */
/* -------------------------------------------------------------------------- */

/** Severity levels for {@link AgentLogger}. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured logger the host injects so backends never touch console directly. */
export interface AgentLogger {
  log(level: LogLevel, message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Sandboxed filesystem facade scoped to the project root. The host implements
 * this so that backends (especially the hand-built Anthropic-API loop) cannot
 * escape the project directory, and so all paths are normalized relative to
 * {@link AgentBackendContext.projectRoot}. The Claude Agent SDK backend may use
 * its own tools but is given this for consistency and for path validation.
 *
 * All `relativePath` arguments are resolved against the project root and
 * rejected if they traverse outside it.
 */
export interface ProjectFs {
  /** Read a UTF-8 text file. Rejects if outside the project root. */
  readFile(relativePath: string): Promise<string>;
  /** Write a UTF-8 text file, creating parent directories as needed. */
  writeFile(relativePath: string, contents: string): Promise<void>;
  /** Whether a path exists within the project. */
  exists(relativePath: string): Promise<boolean>;
  /** List entries of a directory relative to the project root. */
  readdir(relativePath: string): Promise<string[]>;
  /**
   * Glob for files matching a pattern (e.g. `src/**\/*.tsx`), returning paths
   * relative to the project root. Respects `.gitignore`.
   */
  glob(pattern: string): Promise<string[]>;
  /**
   * Search file contents for a pattern. Used by the fallback source-mapping
   * path when `data-easel-source` is unavailable.
   */
  grep(query: GrepQuery): Promise<GrepMatch[]>;
  /** Persist a binary asset (e.g. a generated image) and return its relative path. */
  writeBinary(relativePath: string, data: Uint8Array): Promise<void>;
  /** Compute the unified diff a write would/did produce, for `file-edit` events. */
  diff(relativePath: string, nextContents: string): Promise<FileDiff>;
}

/** A content search request handed to {@link ProjectFs.grep}. */
export interface GrepQuery {
  /** Literal substring or regular-expression source. */
  pattern: string;
  /** Treat {@link pattern} as a regular expression. */
  isRegex?: boolean;
  /** Case-insensitive match. */
  ignoreCase?: boolean;
  /** Restrict to files matching these globs. */
  include?: string[];
  /** Maximum number of matches to return. */
  maxResults?: number;
}

/** A single grep hit. */
export interface GrepMatch {
  /** Path relative to the project root. */
  filePath: string;
  /** 1-based line number of the match. */
  line: number;
  /** 1-based column where the match begins. */
  column: number;
  /** The full text of the matching line. */
  lineText: string;
}

/**
 * Everything a backend needs to execute one edit, injected by the host. The
 * backend MUST NOT reach outside this context for filesystem, secrets, or
 * image generation.
 */
export interface AgentBackendContext {
  /** Absolute path to the project root being edited. */
  projectRoot: string;
  /** Resolved settings, including the model id and feature flags. */
  settings: AppSettings;
  /**
   * Plaintext secrets resolved by the host from safeStorage at call time, keyed
   * by {@link ApiKeyRef.id} (e.g. `anthropic`, `gateway-token`, `local`). A
   * backend reads only the refs named in its own `BackendConfigs` entry. Present
   * only for the duration of the edit; never persisted. Empty for the Claude SDK
   * `inherit`/`bedrock`/`vertex` modes, which use ambient credentials.
   */
  secrets: Readonly<Record<string, string>>;
  /** Sandboxed filesystem access scoped to {@link projectRoot}. */
  fs: ProjectFs;
  /** Image provider exposed to the backend's `replace_image` tool. */
  imageProvider: ImageProvider;
  /** Structured logger. */
  logger: AgentLogger;
  /**
   * Cancellation signal. The host aborts it when the user cancels; backends
   * must stop work and emit a terminal `error` event with code `cancelled`.
   */
  signal: AbortSignal;
  /**
   * Creates a git checkpoint after edits are applied and resolves with it, so
   * the backend can emit a `checkpoint` event. The host owns git mechanics
   * (see `src/main/checkpoints.ts`); the backend only requests one.
   */
  createCheckpoint(message: string, requestId: string): Promise<Checkpoint>;

  /**
   * Host-provided guardrail check against the project's `.easel/policy.json`.
   * Backends that write through {@link ProjectFs} are guarded automatically at
   * that chokepoint and need not call this. Backends that write via their own
   * tools (e.g. the Claude Agent SDK's `Edit`/`Write`) MUST call this from their
   * permission hook so the same policy is enforced. Resolves
   * `{ allow: false, reason }` for a blocked path (a `requireConfirm` path may
   * resolve only after the user approves). Absent when no policy is wired.
   */
  checkWrite?(relativePath: string): Promise<{ allow: boolean; reason?: string }>;
}

/**
 * Lightweight context for {@link AgentBackend.validate}. Unlike
 * {@link AgentBackendContext} it carries no project-scoped services, so a
 * readiness probe can run from the Settings UI with no project open.
 */
export interface ValidateContext {
  /** Resolved settings (selected backend, model, per-backend config). */
  settings: AppSettings;
  /** Resolved secrets keyed by {@link ApiKeyRef.id} (see {@link AgentBackendContext.secrets}). */
  secrets: Readonly<Record<string, string>>;
  /** Structured logger. */
  logger: AgentLogger;
  /** Cancellation signal for the probe. */
  signal: AbortSignal;
}

/* -------------------------------------------------------------------------- */
/*  The backend interface                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The pluggable coding-agent contract. Both shipping backends implement this.
 *
 * Lifecycle for one edit:
 *   1. Host resolves settings/secrets and builds an {@link AgentBackendContext}.
 *   2. Host calls {@link editStream} and iterates the returned async stream.
 *   3. Backend yields `thinking` / `tool-call` / `file-edit` / `diff` events as
 *      it works, requests a checkpoint via the context, and finishes with a
 *      single terminal `done` or `error` event.
 *   4. Cancellation: host aborts `ctx.signal`; backend stops and yields a
 *      terminal `error` with code `cancelled`.
 */
export interface AgentBackend {
  /** Stable identifier matching {@link AppSettings.agentBackend}. */
  readonly id: AgentBackendId;
  /** Human-readable name for settings UI. */
  readonly name: string;
  /** Static capability descriptor. */
  readonly capabilities: AgentCapabilities;

  /**
   * Execute one edit, streaming progress as {@link AgentEvent}s. The stream
   * MUST end with exactly one terminal event (`done` or `error`). Consumers
   * may stop early; backends should treat early break + aborted signal as a
   * cancellation.
   *
   * The host relays exactly one terminal event per {@link EditRequest.id} on the
   * `edit.event` IPC channel — including a terminal `error` with code `cancelled`
   * after a cancel. The renderer keys edit-completion off that terminal event,
   * never off the `edit.cancel` acknowledgement.
   */
  editStream(request: EditRequest, ctx: AgentBackendContext): AsyncIterable<AgentEvent>;

  /**
   * Optional eager cancel hook for backends that hold non-AbortSignal
   * resources. Cancellation primarily flows through `ctx.signal`; this is a
   * best-effort supplement keyed by {@link EditRequest.id}.
   */
  cancel?(requestId: string): void;

  /**
   * Optional lightweight readiness probe (e.g. validate the API key/model)
   * without performing an edit. Uses {@link ValidateContext} so it can run with
   * no project open. Returns a problem message if not ready.
   */
  validate?(ctx: ValidateContext): Promise<{ ok: boolean; problem?: string }>;
}

/* -------------------------------------------------------------------------- */
/*  Factory registry                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Constructs an {@link AgentBackend} for a given backend id. Stateless: any
 * per-edit state lives in the context, not the backend instance.
 */
export type BackendFactory = (settings: AppSettings) => AgentBackend;

/**
 * Registry mapping each {@link AgentBackendId} to its factory. The host's
 * `src/main/agents/index.ts` populates this and resolves the active backend
 * from settings. The mapped type guarantees every id has a factory.
 */
export type BackendRegistry = {
  readonly [Id in AgentBackendId]: BackendFactory;
};
