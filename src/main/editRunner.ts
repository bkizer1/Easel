/**
 * Easel — edit pipeline orchestrator.
 *
 * This module is the seam between the IPC layer and the pluggable agent backends.
 * It:
 *  1. Constructs an `AgentBackendContext` from the current settings + secrets.
 *  2. Resolves the active backend from the `BackendRegistry`.
 *  3. Iterates `backend.editStream(request, ctx)` and pushes each `AgentEvent`
 *     to the renderer over the `edit.event` IPC channel.
 *  4. Manages an `AbortController` per in-flight edit so `cancelEdit()` can abort.
 *  5. Builds the `ProjectFs` sandbox scoped to the project root.
 *
 * The `BackendRegistry` is populated by `src/main/agents/index.ts`.  We import
 * it lazily to avoid circular-module issues at startup.
 */

import path from 'node:path';
import fs from 'node:fs';
import type {
  AgentEvent,
  AppSettings,
  Checkpoint,
  CheckpointProvenance,
  ConfidenceLevel,
  FileDiff,
  EditRequest,
  VisionVerdict,
} from '@shared/types';
import type {
  AgentBackendContext,
  ProjectFs,
  GrepQuery,
  GrepMatch,
  ValidateContext,
} from '@shared/agent';
import { IpcChannels } from '@shared/ipc';
import type { EditEventPayload } from '@shared/ipc';
import { getMainWindow } from '@main/window';
import { getActiveImageProvider } from '@main/imageProvider';
import { createLogger } from '@main/logger';
import { loadPolicy, evaluateWrite, type LoadedPolicy } from '@main/policy';

const log = createLogger('edit-runner');

/* -------------------------------------------------------------------------- */
/*  In-flight edit registry (for cancellation)                                */
/* -------------------------------------------------------------------------- */

const _inFlight = new Map<string, AbortController>();

/** Cancel an in-flight edit by request id. No-op if not found. */
export function cancelEdit(requestId: string): void {
  const controller = _inFlight.get(requestId);
  if (controller) {
    log.info('Cancelling edit', { requestId });
    controller.abort();
  }
}

/* -------------------------------------------------------------------------- */
/*  Guardrail policy enforcement (.easel/policy.json)                          */
/* -------------------------------------------------------------------------- */

/**
 * Pending `requireConfirm` approvals, keyed by request id + path. The renderer
 * resolves one via {@link respondPolicyConfirm} after the user clicks
 * allow-once / deny on the prompt surfaced by the `policy-confirm` warning.
 */
const _pendingConfirms = new Map<string, (allow: boolean) => void>();

function _confirmKey(requestId: string, relPath: string): string {
  return `${requestId}\x00${relPath}`;
}

/**
 * Resolve a pending guardrail confirmation. Called from the IPC layer when the
 * renderer answers a `policy-confirm` prompt. No-op if the path is not pending
 * (e.g. the edit already finished or was cancelled).
 */
export function respondPolicyConfirm(requestId: string, relPath: string, allow: boolean): void {
  const key = _confirmKey(requestId, relPath);
  const resolve = _pendingConfirms.get(key);
  if (resolve) {
    _pendingConfirms.delete(key);
    resolve(allow);
  }
}

/** Await the user's allow-once decision for a path; aborting resolves to deny. */
function _awaitConfirm(requestId: string, relPath: string, signal: AbortSignal): Promise<boolean> {
  const key = _confirmKey(requestId, relPath);
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      _pendingConfirms.delete(key);
      resolve(false);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    _pendingConfirms.set(key, (allow) => {
      signal.removeEventListener('abort', onAbort);
      resolve(allow);
    });
  });
}

/**
 * A per-edit write gate. Both the {@link ProjectFs} chokepoint (hand-built
 * backends) and the Claude Agent SDK's `canUseTool` hook funnel through one
 * instance so the policy decision and blast-radius counter are shared across an
 * edit, regardless of how the backend writes.
 */
export interface WriteGate {
  check(relativePath: string): Promise<{ allow: boolean; reason?: string }>;
}

export function createWriteGate(opts: {
  loaded: LoadedPolicy;
  requestId: string;
  signal: AbortSignal;
  emit: (event: AgentEvent) => void;
}): WriteGate {
  const { loaded, requestId, signal, emit } = opts;
  /** Distinct files written (or approved-for-write) so far this edit. */
  const written = new Set<string>();
  /** Paths the user has already approved this edit, so we ask only once. */
  const approved = new Set<string>();

  return {
    async check(relativePath) {
      const norm = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
      const filesSoFar = written.has(norm) ? written.size - 1 : written.size;
      const result = evaluateWrite(loaded, norm, filesSoFar);

      if (result.decision === 'deny') {
        emit({ type: 'warning', requestId, message: result.reason, code: 'policy-blocked', path: norm });
        return { allow: false, reason: result.reason };
      }

      if (result.decision === 'confirm' && !approved.has(norm)) {
        emit({
          type: 'warning',
          requestId,
          message: `${result.reason} — awaiting your approval`,
          code: 'policy-confirm',
          path: norm,
        });
        const allow = await _awaitConfirm(requestId, norm, signal);
        if (!allow) {
          const reason = `Write to "${norm}" denied`;
          emit({ type: 'warning', requestId, message: reason, code: 'policy-blocked', path: norm });
          return { allow: false, reason };
        }
        approved.add(norm);
      }

      written.add(norm);
      return { allow: true };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  ProjectFs sandbox                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build a sandboxed `ProjectFs` implementation rooted at `projectRoot`.
 * Every relative path argument is resolved against the root and rejected if
 * it escapes (path-traversal guard). When a {@link WriteGate} is supplied, every
 * write is additionally checked against the project's guardrail policy *before*
 * any byte is written, so a denied path never changes the working tree.
 */
export function buildProjectFs(projectRoot: string, gate?: WriteGate): ProjectFs {
  /** Resolve and validate a relative path; throws on traversal. */
  function resolve(relativePath: string): string {
    const absolute = path.resolve(projectRoot, relativePath);
    if (!absolute.startsWith(projectRoot + path.sep) && absolute !== projectRoot) {
      throw new Error(`Path traversal denied: ${relativePath}`);
    }
    return absolute;
  }

  /** Enforce the guardrail policy for a write; throws (blocking it) on deny. */
  async function guardWrite(relativePath: string): Promise<void> {
    if (!gate) return;
    const verdict = await gate.check(relativePath);
    if (!verdict.allow) {
      throw new Error(verdict.reason ?? `Blocked by Easel policy: ${relativePath}`);
    }
  }

  return {
    async readFile(relativePath) {
      return fs.promises.readFile(resolve(relativePath), 'utf8');
    },

    async writeFile(relativePath, contents) {
      const abs = resolve(relativePath);
      await guardWrite(relativePath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, contents, 'utf8');
    },

    async exists(relativePath) {
      try {
        await fs.promises.access(resolve(relativePath));
        return true;
      } catch {
        return false;
      }
    },

    async readdir(relativePath) {
      return fs.promises.readdir(resolve(relativePath));
    },

    async glob(pattern) {
      // Recursive directory walk with simple pattern matching — covers the
      // common cases (*.ext, src/**/*.tsx). Backends needing richer globs can
      // layer picomatch on top later.
      const matches: string[] = [];
      await _walkGlob(projectRoot, pattern, matches);
      return matches;
    },

    async grep(query: GrepQuery): Promise<GrepMatch[]> {
      return _grep(projectRoot, query);
    },

    async writeBinary(relativePath, data) {
      const abs = resolve(relativePath);
      await guardWrite(relativePath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, data);
    },

    async diff(relativePath, nextContents): Promise<FileDiff> {
      const abs = resolve(relativePath);
      let original = '';
      try {
        original = await fs.promises.readFile(abs, 'utf8');
      } catch {
        // File is new; treat original as empty.
      }

      const changeType = original === '' ? 'created' : 'modified';
      const { unifiedDiff, additions, deletions } = _computeUnifiedDiff(
        relativePath,
        original,
        nextContents,
      );

      return { filePath: relativePath, changeType, unifiedDiff, additions, deletions };
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Edit stream runner                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The self-heal vision judge (issue #16), injected so the verify step is
 * testable without a real model or GUI. Given the edit's instruction and the
 * before/after preview frames, returns a {@link VisionVerdict} or `null` when no
 * verdict could be produced (fail-open). Must never throw.
 */
export type VerifyFn = (input: {
  instruction: string;
  before?: string;
  after: string;
  /** Aborts the (potentially slow) judge call when the edit is cancelled. */
  signal?: AbortSignal;
}) => Promise<VisionVerdict | null>;

export interface RunEditStreamOptions {
  request: EditRequest;
  settings: AppSettings;
  secrets: Readonly<Record<string, string>>;
  projectRoot: string;
  createCheckpointFn: (
    message: string,
    requestId: string,
    provenance?: CheckpointProvenance,
  ) => Promise<Checkpoint>;
  /**
   * Optional self-heal vision judge (issue #16). When provided and
   * `featureFlags.selfHealVerify` is on, a `verify` event is emitted after the
   * edit's checkpoint settles. Omitted ⇒ the verify step is skipped entirely.
   */
  verify?: VerifyFn;
}

/**
 * Build the {@link CheckpointProvenance} for an edit from its request, settings,
 * and the most recent confidence the backend reported. `Easel-Target` records
 * the DOM selectors the user pointed at; `Easel-Source` records the resolved
 * source locations (file:line) when `data-easel-source` was present.
 */
export function buildProvenance(
  request: EditRequest,
  settings: AppSettings,
  confidence: ConfidenceLevel | undefined,
): CheckpointProvenance {
  const targets = request.targets
    .map((t) => t.selector || t.tagName)
    .filter((s): s is string => Boolean(s));
  const sources = request.targets
    .map((t) => t.dataEaselSource)
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map((s) => `${s.filePath}:${s.line}`);

  const provenance: CheckpointProvenance = {
    instruction: request.instruction,
    model: settings.model,
    backend: settings.agentBackend,
  };
  if (targets.length > 0) provenance.targets = targets;
  if (sources.length > 0) provenance.sources = sources;
  if (confidence) provenance.confidence = confidence;
  return provenance;
}

/**
 * Run the agent edit stream for a single request.  Pushes `AgentEvent`s to
 * the renderer over `edit.event` and cleans up the in-flight registry when done.
 *
 * This function is intentionally async-fire-and-forget from the IPC handler
 * (the handler returns `{ requestId }` immediately and the events stream async).
 */
export async function runEditStream(opts: RunEditStreamOptions): Promise<void> {
  const { request, settings, secrets, projectRoot, createCheckpointFn } = opts;
  const requestId = request.id;

  const controller = new AbortController();
  _inFlight.set(requestId, controller);

  // Load the project's guardrail policy and build the per-edit write gate that
  // both the ProjectFs chokepoint and the SDK's permission hook share.
  const loadedPolicy = loadPolicy(projectRoot);
  const gate = createWriteGate({
    loaded: loadedPolicy,
    requestId,
    signal: controller.signal,
    emit: _pushEvent,
  });

  const fsInstance = buildProjectFs(projectRoot, gate);
  const logger = createLogger(`agent:${requestId.slice(0, 8)}`);

  // Track the latest confidence the backend reports so it can be recorded as
  // checkpoint provenance when the backend requests a checkpoint.
  let latestConfidence: ConfidenceLevel | undefined;

  const ctx: AgentBackendContext = {
    projectRoot,
    settings,
    secrets,
    fs: fsInstance,
    imageProvider: getActiveImageProvider(),
    logger,
    signal: controller.signal,
    createCheckpoint: (message, rid) =>
      createCheckpointFn(message, rid, buildProvenance(request, settings, latestConfidence)),
    checkWrite: (relativePath) => gate.check(relativePath),
  };

  // Issue #7: capture the pre-edit preview frame before the agent runs.
  const beforeShot = await _captureShot();
  let shotCheckpointId: string | undefined;

  try {
    const { getBackendRegistry } = await import('@main/agents/index');
    const registry = getBackendRegistry();
    const backend = registry[settings.agentBackend](settings);

    log.info('Starting edit stream', {
      requestId,
      backend: backend.id,
      model: settings.model,
      policy: loadedPolicy.source,
    });

    let succeeded = false;
    for await (const event of backend.editStream(request, ctx)) {
      if (event.type === 'confidence') latestConfidence = event.level;
      // Issue #7: remember the checkpoint to key before/after screenshots on.
      if (event.type === 'checkpoint') shotCheckpointId = event.checkpoint.id;
      _pushEvent(event);
      // A terminal event ends the stream.
      if (event.type === 'done' || event.type === 'error') {
        succeeded = event.type === 'done';
        break;
      }
    }

    // Whether the self-heal verify step (issue #16) will actually run. Computed
    // up front so we only pay the HMR settle + capture when an "after" frame is
    // genuinely needed (a checkpoint to illustrate, or verify enabled) — not on
    // every successful no-checkpoint edit with verify off.
    const wantVerify =
      succeeded && settings.featureFlags.selfHealVerify && opts.verify !== undefined;

    // Issue #7 + #16: capture the settled "after" frame ONCE and reuse it for
    // both the checkpoint visual diff and the verify judge (no double settle).
    let afterShot: string | undefined;
    if (shotCheckpointId !== undefined || wantVerify) {
      afterShot = await _captureAfterShot();
    }
    await _persistCheckpointShots(shotCheckpointId, beforeShot, afterShot);

    // Issue #16: self-heal verify — only judge edits that completed successfully.
    // Purely additive and fail-open: it runs after the terminal event was already
    // pushed, so it can never alter the edit it follows. Decoupled from the
    // checkpoint, so it also fires for successful edits that made no checkpoint.
    if (wantVerify) {
      await runVerifyStep({
        request,
        settings,
        before: beforeShot,
        after: afterShot,
        verify: opts.verify,
        emit: _pushEvent,
        signal: controller.signal,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('Edit stream error', { requestId, err: msg });
    _pushEvent({
      type: 'error',
      requestId,
      message: msg,
      recoverable: false,
    });
  } finally {
    _inFlight.delete(requestId);
    log.info('Edit stream complete', { requestId });
  }
}

/** Push a single AgentEvent to the renderer. */
function _pushEvent(event: AgentEvent): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  const payload: EditEventPayload = { event };
  win.webContents.send(IpcChannels.editEvent, payload);
}

/* -------------------------------------------------------------------------- */
/*  Issue #7: checkpoint visual diff — before/after screenshots                */
/* -------------------------------------------------------------------------- */

/** Delay after a checkpoint before capturing "after" so HMR has re-rendered. */
const SHOT_SETTLE_MS = 600;

/** Capture the current preview as a PNG data URL (best-effort, never throws). */
async function _captureShot(): Promise<string | undefined> {
  try {
    const win = getMainWindow();
    if (!win) return undefined;
    const { capturePreview } = await import('@main/window');
    if (typeof capturePreview !== 'function') return undefined;
    return await capturePreview();
  } catch {
    return undefined;
  }
}

/** Wait for HMR to settle, then capture the "after" preview frame (best-effort). */
async function _captureAfterShot(): Promise<string | undefined> {
  await new Promise((resolve) => setTimeout(resolve, SHOT_SETTLE_MS));
  return _captureShot();
}

/**
 * Persist the before/after preview frames for a checkpoint. Entirely
 * best-effort: the visual diff is a non-essential aid, so any failure here must
 * never affect the edit. The `after` frame is captured by the caller (once, via
 * {@link _captureAfterShot}) so it can be shared with the verify step (#16).
 */
async function _persistCheckpointShots(
  checkpointId: string | undefined,
  before: string | undefined,
  after: string | undefined,
): Promise<void> {
  if (!checkpointId) return;
  try {
    const { writeShot } = await import('@main/checkpointShots');
    if (before) await writeShot(checkpointId, 'before', before);
    if (after) await writeShot(checkpointId, 'after', after);
  } catch {
    // Visual diff is non-essential; swallow.
  }
}

/* -------------------------------------------------------------------------- */
/*  Issue #16: self-healing edit loop — post-edit verify step                  */
/* -------------------------------------------------------------------------- */

/**
 * Run the self-heal verify step for a completed edit and emit a `verify` event
 * with the judge's verdict. This is the pure, directly-testable core of issue
 * #16's verify slice; `runEditStream` calls it after the checkpoint settles.
 *
 * It is fail-open and emits NOTHING (the edit is unaffected) when any of:
 *  - the `selfHealVerify` feature flag is off,
 *  - no judge was injected, or no "after" frame was captured,
 *  - the judge throws, or
 *  - the judge returns `null` (could not produce a verdict).
 *
 * The emitted `verify` event arrives after the terminal `done`; the renderer
 * correlates it by `requestId` and does not gate it on the active request.
 */
export async function runVerifyStep(opts: {
  request: EditRequest;
  settings: AppSettings;
  before: string | undefined;
  after: string | undefined;
  verify: VerifyFn | undefined;
  emit: (event: AgentEvent) => void;
  /** When aborted, the step skips the judge and emits nothing. */
  signal?: AbortSignal;
}): Promise<void> {
  // The entire body is wrapped so NOTHING here — the judge call, the settings
  // read, or the emit — can throw into runEditStream's catch and produce a
  // spurious post-`done` error. The step is strictly fail-open.
  try {
    const { request, settings, before, after, verify, emit, signal } = opts;

    if (!settings.featureFlags.selfHealVerify) return;
    if (!verify || !after) return;
    if (signal?.aborted) return;

    const verdict = await verify({ instruction: request.instruction, before, after, signal });
    if (!verdict) return;

    emit({
      type: 'verify',
      requestId: request.id,
      verdict: verdict.verdict,
      rationale: verdict.rationale,
      ...(verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}),
    });
  } catch {
    // Fail-open: a verify failure must never disrupt the edit it follows.
  }
}

/* -------------------------------------------------------------------------- */
/*  Backend validation                                                         */
/* -------------------------------------------------------------------------- */

/** Run the selected backend's `validate` probe and return the result. */
export async function validateActiveBackend(): Promise<{ ok: boolean; problem?: string }> {
  const { getSettings } = await import('@main/settings');
  const { resolveSecrets } = await import('@main/settings');
  const { getBackendRegistry } = await import('@main/agents/index');

  const settings = getSettings();
  const secrets = resolveSecrets(['anthropic', 'gateway-token', 'local', 'claude-oauth-token']);
  const logger = createLogger('validate');

  const registry = getBackendRegistry();
  const backend = registry[settings.agentBackend](settings);

  if (!backend.validate) return { ok: true };

  const ctx: ValidateContext = {
    settings,
    secrets,
    logger,
    signal: new AbortController().signal,
  };

  return backend.validate(ctx);
}

/* -------------------------------------------------------------------------- */
/*  Internal grep implementation                                               */
/* -------------------------------------------------------------------------- */

async function _grep(root: string, query: GrepQuery): Promise<GrepMatch[]> {
  const matches: GrepMatch[] = [];
  const maxResults = query.maxResults ?? 200;

  const includeGlobs = query.include ?? ['**/*'];
  const files = await _collectFiles(root, includeGlobs);

  const flags = query.ignoreCase ? 'gi' : 'g';
  let re: RegExp;
  try {
    re = query.isRegex
      ? new RegExp(query.pattern, flags)
      : new RegExp(escapeRegex(query.pattern), flags);
  } catch {
    return [];
  }

  for (const relFile of files) {
    if (matches.length >= maxResults) break;
    const abs = path.join(root, relFile);
    let content: string;
    try {
      content = await fs.promises.readFile(abs, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (matches.length >= maxResults) break;
      const lineText = lines[i];
      re.lastIndex = 0;
      const m = re.exec(lineText);
      if (m) {
        matches.push({
          filePath: relFile,
          line: i + 1,
          column: m.index + 1,
          lineText,
        });
      }
    }
  }

  return matches;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function _collectFiles(root: string, globs: string[]): Promise<string[]> {
  const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build', '.cache']);
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = path.relative(root, fullPath);
      if (entry.isDirectory()) {
        if (!IGNORE_DIRS.has(entry.name)) await walk(fullPath);
      } else if (entry.isFile()) {
        if (_matchesAnyGlob(relPath, globs)) results.push(relPath);
      }
    }
  }

  await walk(root);
  return results;
}

function _matchesAnyGlob(relPath: string, globs: string[]): boolean {
  // Very simple glob matching: support `**/*`, `*.ext`, `src/**/*.tsx` patterns.
  for (const glob of globs) {
    if (_simpleGlobMatch(glob, relPath)) return true;
  }
  return false;
}

function _simpleGlobMatch(glob: string, str: string): boolean {
  if (glob === '**/*') return true;
  // Convert glob to regex.
  const regexStr = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*\//g, '(?:.+/)?')
    .replace(/\*/g, '[^/]*');
  try {
    return new RegExp(`^${regexStr}$`).test(str);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*  Minimal unified diff generator                                             */
/* -------------------------------------------------------------------------- */

function _computeUnifiedDiff(
  filePath: string,
  original: string,
  next: string,
): { unifiedDiff: string; additions: number; deletions: number } {
  const origLines = original.split('\n');
  const nextLines = next.split('\n');
  let additions = 0;
  let deletions = 0;
  const hunks: string[] = [];

  // Produce a simple line-by-line diff hunk (not LCS-optimised, but correct).
  const header = `--- a/${filePath}\n+++ b/${filePath}`;
  const contextLines = 3;

  // Find changed line ranges.
  const maxLen = Math.max(origLines.length, nextLines.length);
  const changeBlocks: Array<{ origStart: number; origEnd: number; nextStart: number; nextEnd: number }> = [];
  let i = 0;
  let j = 0;

  // Simple patience-like: skip equal prefix/suffix; emit a single hunk for the rest.
  // For a production system this would use Myers diff; this is correct and readable.
  while (i < origLines.length || j < nextLines.length) {
    if (i < origLines.length && j < nextLines.length && origLines[i] === nextLines[j]) {
      i++;
      j++;
    } else {
      // Find the next matching line to bound the hunk.
      const blockOrigStart = i;
      const blockNextStart = j;
      // Advance both pointers until they re-sync or exhaust.
      let synced = false;
      for (let lookahead = 1; lookahead < maxLen; lookahead++) {
        const oi = i + lookahead;
        const nj = j + lookahead;
        if (oi < origLines.length && origLines[oi] === nextLines[j]) {
          // orig skipped some lines
          changeBlocks.push({ origStart: blockOrigStart, origEnd: oi, nextStart: blockNextStart, nextEnd: j });
          i = oi;
          synced = true;
          break;
        }
        if (nj < nextLines.length && origLines[i] === nextLines[nj]) {
          // next inserted some lines
          changeBlocks.push({ origStart: blockOrigStart, origEnd: i, nextStart: blockNextStart, nextEnd: nj });
          j = nj;
          synced = true;
          break;
        }
        if (oi < origLines.length && nj < nextLines.length && origLines[oi] === nextLines[nj]) {
          changeBlocks.push({ origStart: blockOrigStart, origEnd: oi, nextStart: blockNextStart, nextEnd: nj });
          i = oi;
          j = nj;
          synced = true;
          break;
        }
      }
      if (!synced) {
        // Remaining lines all differ.
        changeBlocks.push({ origStart: blockOrigStart, origEnd: origLines.length, nextStart: blockNextStart, nextEnd: nextLines.length });
        i = origLines.length;
        j = nextLines.length;
      }
    }
  }

  // Emit unified diff hunks.
  for (const block of changeBlocks) {
    const origCtxStart = Math.max(0, block.origStart - contextLines);
    const origCtxEnd = Math.min(origLines.length, block.origEnd + contextLines);
    const nextCtxEnd = Math.min(nextLines.length, block.nextEnd + contextLines);

    const hunkLines: string[] = [];
    // Context before
    for (let k = origCtxStart; k < block.origStart; k++) hunkLines.push(` ${origLines[k]}`);
    // Removed
    for (let k = block.origStart; k < block.origEnd; k++) {
      hunkLines.push(`-${origLines[k]}`);
      deletions++;
    }
    // Added
    for (let k = block.nextStart; k < block.nextEnd; k++) {
      hunkLines.push(`+${nextLines[k]}`);
      additions++;
    }
    // Context after
    for (let k = block.origEnd; k < origCtxEnd && k - block.origEnd < contextLines; k++) hunkLines.push(` ${origLines[k]}`);
    void nextCtxEnd; // used implicitly by context window

    const origCount = (block.origEnd - origCtxStart) + Math.min(contextLines, origLines.length - block.origEnd);
    const nextCount = (block.nextEnd - block.nextStart) + (block.origStart - origCtxStart) + Math.min(contextLines, nextLines.length - block.nextEnd);

    hunks.push(`@@ -${origCtxStart + 1},${origCount} +${origCtxStart + 1},${nextCount} @@\n${hunkLines.join('\n')}`);
  }

  const unifiedDiff = changeBlocks.length === 0
    ? ''
    : `${header}\n${hunks.join('\n')}`;

  return { unifiedDiff, additions, deletions };
}

/* -------------------------------------------------------------------------- */
/*  Glob walk fallback                                                         */
/* -------------------------------------------------------------------------- */

async function _walkGlob(root: string, pattern: string, results: string[]): Promise<void> {
  // Simple recursive walk without proper glob support; treat pattern as suffix match.
  const ext = pattern.split('.').pop() ?? '';
  const IGNORE = new Set(['node_modules', '.git', 'dist', 'out', '.next', 'build']);

  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory() && !IGNORE.has(entry.name)) {
        await walk(fullPath);
      } else if (entry.isFile() && (ext === '*' || entry.name.endsWith(`.${ext}`))) {
        results.push(path.relative(root, fullPath));
      }
    }
  }

  await walk(root);
}
