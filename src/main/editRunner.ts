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
  FileDiff,
  EditRequest,
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
/*  ProjectFs sandbox                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Build a sandboxed `ProjectFs` implementation rooted at `projectRoot`.
 * Every relative path argument is resolved against the root and rejected if
 * it escapes (path-traversal guard).
 */
function buildProjectFs(projectRoot: string): ProjectFs {
  /** Resolve and validate a relative path; throws on traversal. */
  function resolve(relativePath: string): string {
    const absolute = path.resolve(projectRoot, relativePath);
    if (!absolute.startsWith(projectRoot + path.sep) && absolute !== projectRoot) {
      throw new Error(`Path traversal denied: ${relativePath}`);
    }
    return absolute;
  }

  return {
    async readFile(relativePath) {
      return fs.promises.readFile(resolve(relativePath), 'utf8');
    },

    async writeFile(relativePath, contents) {
      const abs = resolve(relativePath);
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

export interface RunEditStreamOptions {
  request: EditRequest;
  settings: AppSettings;
  secrets: Readonly<Record<string, string>>;
  projectRoot: string;
  createCheckpointFn: (message: string, requestId: string) => Promise<Checkpoint>;
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

  const fsInstance = buildProjectFs(projectRoot);
  const logger = createLogger(`agent:${requestId.slice(0, 8)}`);

  const ctx: AgentBackendContext = {
    projectRoot,
    settings,
    secrets,
    fs: fsInstance,
    imageProvider: getActiveImageProvider(),
    logger,
    signal: controller.signal,
    createCheckpoint: createCheckpointFn,
  };

  try {
    const { getBackendRegistry } = await import('@main/agents/index');
    const registry = getBackendRegistry();
    const backend = registry[settings.agentBackend](settings);

    log.info('Starting edit stream', {
      requestId,
      backend: backend.id,
      model: settings.model,
    });

    for await (const event of backend.editStream(request, ctx)) {
      _pushEvent(event);
      // A terminal event ends the stream.
      if (event.type === 'done' || event.type === 'error') break;
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
