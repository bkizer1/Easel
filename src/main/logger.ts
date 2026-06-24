/**
 * Easel — structured logger for the main process.
 *
 * Provides a thin wrapper that formats log records consistently and routes
 * them to stdout/stderr. All main-process modules call `createLogger(scope)`
 * so every line carries a scope prefix for easy grepping. The agent backend
 * context receives an `AgentLogger`-shaped slice of this.
 *
 * This module has no Electron imports so it is also safe to unit-test in Node.
 */

import type { AgentLogger, LogLevel } from '@shared/agent';

/** Formats an epoch-ms timestamp as HH:MM:SS.mmm (local time). */
function formatTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms3 = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms3}`;
}

/** Serialises `meta` for inline display; replaces sensitive keys with `***`. */
const REDACTED_KEYS = new Set(['apiKey', 'apikey', 'ANTHROPIC_API_KEY', 'token', 'secret', 'password']);

function serializeMeta(meta: Record<string, unknown>): string {
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    safe[k] = REDACTED_KEYS.has(k) ? '***' : v;
  }
  return JSON.stringify(safe);
}

/** A scoped, structured logger instance. */
export interface ScopedLogger extends AgentLogger {
  /** Create a child logger with an additional sub-scope. */
  child(subScope: string): ScopedLogger;
}

/** Creates a logger scoped to the given label (e.g. `'window'`, `'checkpoints'`). */
export function createLogger(scope: string): ScopedLogger {
  function emit(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const time = formatTime(Date.now());
    const metaStr = meta && Object.keys(meta).length > 0 ? ` ${serializeMeta(meta)}` : '';
    const line = `[${time}] [${level.toUpperCase().padEnd(5)}] [${scope}] ${message}${metaStr}`;
    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  return {
    log: emit,
    debug: (msg, meta) => emit('debug', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child: (subScope) => createLogger(`${scope}:${subScope}`),
  };
}

/** Singleton root logger for modules that don't need a custom scope. */
export const rootLogger = createLogger('easel');
