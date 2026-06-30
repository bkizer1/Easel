/**
 * Easel — settings persistence and secret management.
 *
 * Responsibilities:
 *  - Persist {@link AppSettings} to `userData/settings.json` (plain JSON; no secrets).
 *  - Encrypt/decrypt API keys via Electron `safeStorage`; store encrypted blobs in a
 *    separate `userData/secrets.json` so they never co-mingle with serialisable settings.
 *  - Expose helpers used by the IPC layer and agent context builder:
 *      getSettings()                         → current AppSettings
 *      updateSettings(patch)                 → merge + save; returns new settings
 *      setSecret(id, value)                  → encrypt + store; returns ApiKeyRef
 *      clearSecret(id)                       → remove from store
 *      resolveSecrets(ids)                   → decrypt + return plaintext map (transient)
 *
 * Secret ids used by Easel:
 *   'anthropic'     — Anthropic API key (anthropic-api backend + claude-agent-sdk api-key mode)
 *   'gateway-token' — Bearer token for gateway/proxy mode
 *   'local'         — Optional API key for local OpenAI-compat server
 *   'image-provider'— API key for the optional image generation provider
 *
 * IMPORTANT: Plaintext secrets NEVER enter AppSettings, renderer memory, or logs.
 * Only ApiKeyRef (isSet + last-4 hint) is surfaced outside this module.
 */

import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ApiKeyRef,
  AppSettings,
  BackendConfigs,
} from '@shared/types';
import { createLogger } from '@main/logger';

const log = createLogger('settings');

/* -------------------------------------------------------------------------- */
/*  Paths                                                                      */
/* -------------------------------------------------------------------------- */

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function secretsPath(): string {
  return path.join(app.getPath('userData'), 'secrets.json');
}

/* -------------------------------------------------------------------------- */
/*  Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Fully-populated default BackendConfigs. Every backend has a valid (empty)
 * configuration so the Settings UI always has something to render.
 */
function defaultBackendConfigs(): BackendConfigs {
  return {
    'claude-agent-sdk': {
      authMode: 'inherit',
    },
    'anthropic-api': {
      apiKeyRef: { id: 'anthropic', isSet: false },
    },
    'local-openai': {
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen2.5-coder:14b',
    },
  };
}

function defaultSettings(): AppSettings {
  return {
    agentBackend: 'claude-agent-sdk',
    model: 'claude-sonnet-4-6',
    backends: defaultBackendConfigs(),
    featureFlags: {
      voiceInput: true,
      imageGeneration: false,
      showThinking: true,
      autoCheckpoint: true,
      selfHealVerify: false,
    },
    theme: 'system',
    maxRetries: 1,
    macros: [],
  };
}

/* -------------------------------------------------------------------------- */
/*  In-memory state                                                            */
/* -------------------------------------------------------------------------- */

let _settings: AppSettings | null = null;

/** Encrypted blobs keyed by secret id. Values are hex-encoded bytes. */
type SecretsStore = Record<string, string>;
let _secrets: SecretsStore | null = null;

/* -------------------------------------------------------------------------- */
/*  Disk I/O                                                                   */
/* -------------------------------------------------------------------------- */

function loadSettingsFromDisk(): AppSettings {
  const p = settingsPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // Deep-merge onto defaults so new fields added in future versions get
    // populated automatically.
    const defaults = defaultSettings();
    return {
      ...defaults,
      ...parsed,
      backends: {
        ...defaults.backends,
        ...(parsed.backends ?? {}),
        'claude-agent-sdk': {
          ...defaults.backends['claude-agent-sdk'],
          ...(parsed.backends?.['claude-agent-sdk'] ?? {}),
        },
        'anthropic-api': {
          ...defaults.backends['anthropic-api'],
          ...(parsed.backends?.['anthropic-api'] ?? {}),
        },
        'local-openai': {
          ...defaults.backends['local-openai'],
          ...(parsed.backends?.['local-openai'] ?? {}),
        },
      },
      featureFlags: {
        ...defaults.featureFlags,
        ...(parsed.featureFlags ?? {}),
      },
      // Macros are a whole-collection field; fall back to the default empty
      // array if the persisted value is missing or not an array (e.g. settings
      // written by a version predating this feature).
      macros: Array.isArray(parsed.macros) ? parsed.macros : defaults.macros,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Failed to load settings from disk; using defaults', { err: String(err) });
    }
    return defaultSettings();
  }
}

function saveSettingsToDisk(s: AppSettings): void {
  const p = settingsPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2), 'utf8');
  } catch (err) {
    log.error('Failed to write settings to disk', { err: String(err) });
  }
}

function loadSecretsFromDisk(): SecretsStore {
  const p = secretsPath();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw) as SecretsStore;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn('Failed to load secrets store; starting empty', { err: String(err) });
    }
    return {};
  }
}

function saveSecretsToDisk(store: SecretsStore): void {
  const p = secretsPath();
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    // Restrict file permissions to owner-only (0o600) on POSIX.
    fs.writeFileSync(p, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    log.error('Failed to write secrets to disk', { err: String(err) });
  }
}

/* -------------------------------------------------------------------------- */
/*  Boot                                                                       */
/* -------------------------------------------------------------------------- */

/** Must be called once after `app.whenReady()` before any other settings call. */
export function initSettings(): void {
  _settings = loadSettingsFromDisk();
  _secrets = loadSecretsFromDisk();
  log.info('Settings initialised', {
    backend: _settings.agentBackend,
    model: _settings.model,
  });
}

/* -------------------------------------------------------------------------- */
/*  Public API                                                                 */
/* -------------------------------------------------------------------------- */

/** Return current in-memory settings (safe to expose to renderer via IPC). */
export function getSettings(): AppSettings {
  if (!_settings) {
    log.warn('getSettings called before initSettings; loading now');
    _settings = loadSettingsFromDisk();
  }
  return _settings;
}

/**
 * Merge `patch` over current settings, persist to disk, and return the new
 * settings. Secrets are intentionally excluded from the patch surface — use
 * `setSecret` / `clearSecret` instead.
 */
export function updateSettings(
  patch: Partial<Omit<AppSettings, 'apiKeyRef' | 'imageApiKeyRef'>>,
): AppSettings {
  const current = getSettings();
  const updated: AppSettings = {
    ...current,
    ...patch,
    // Nested merge for backends and featureFlags.
    backends: patch.backends
      ? {
          ...current.backends,
          ...patch.backends,
          'claude-agent-sdk': {
            ...current.backends['claude-agent-sdk'],
            ...(patch.backends?.['claude-agent-sdk'] ?? {}),
          },
          'anthropic-api': {
            ...current.backends['anthropic-api'],
            ...(patch.backends?.['anthropic-api'] ?? {}),
          },
          'local-openai': {
            ...current.backends['local-openai'],
            ...(patch.backends?.['local-openai'] ?? {}),
          },
        }
      : current.backends,
    featureFlags: patch.featureFlags
      ? { ...current.featureFlags, ...patch.featureFlags }
      : current.featureFlags,
  };
  _settings = updated;
  saveSettingsToDisk(updated);
  log.info('Settings updated');
  return updated;
}

/**
 * Encrypt `value` with `safeStorage` and persist it, keyed by `id`.
 * Returns an {@link ApiKeyRef} carrying just a display hint (last 4 chars).
 * Updates the matching ref inside `_settings` so callers can persist the
 * updated settings by calling `updateSettings`.
 *
 * Falls back to base64-encoding on platforms where `safeStorage` is unavailable
 * (e.g., headless CI), logging a warning — plaintext is never written to disk in
 * that case either (we at minimum base64 it; full encryption requires OS keychain).
 */
export function setSecret(id: string, value: string): ApiKeyRef {
  if (!_secrets) _secrets = loadSecretsFromDisk();

  let encrypted: Buffer;
  if (safeStorage.isEncryptionAvailable()) {
    encrypted = safeStorage.encryptString(value);
  } else {
    log.warn('safeStorage encryption unavailable; using base64 fallback', { id });
    encrypted = Buffer.from(Buffer.from(value).toString('base64'));
  }

  _secrets[id] = encrypted.toString('hex');
  saveSecretsToDisk(_secrets);

  const hint = value.length >= 4 ? `...${value.slice(-4)}` : '...';
  const ref: ApiKeyRef = { id, isSet: true, hint };

  // Update the corresponding ref inside _settings.
  _applyRefToSettings(id, ref);

  log.info('Secret stored', { id, hint });
  return ref;
}

/** Remove the stored secret for `id`. Clears the ref in _settings. */
export function clearSecret(id: string): void {
  if (!_secrets) _secrets = loadSecretsFromDisk();
  delete _secrets[id];
  saveSecretsToDisk(_secrets);

  const ref: ApiKeyRef = { id, isSet: false };
  _applyRefToSettings(id, ref);

  log.info('Secret cleared', { id });
}

/**
 * Decrypt and return the plaintext secrets for the requested ids. The returned
 * record is ephemeral — callers must not persist it. Returns an empty string for
 * ids that are not set (backends should check `ApiKeyRef.isSet` before calling).
 */
export function resolveSecrets(ids: string[]): Record<string, string> {
  if (!_secrets) _secrets = loadSecretsFromDisk();
  const result: Record<string, string> = {};

  for (const id of ids) {
    const hex = _secrets[id];
    if (!hex) {
      result[id] = '';
      continue;
    }
    try {
      const buf = Buffer.from(hex, 'hex');
      if (safeStorage.isEncryptionAvailable()) {
        result[id] = safeStorage.decryptString(buf);
      } else {
        // Fallback: the value was base64-encoded during storage.
        result[id] = Buffer.from(buf.toString(), 'base64').toString('utf8');
      }
    } catch (err) {
      log.error('Failed to decrypt secret', { id, err: String(err) });
      result[id] = '';
    }
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/*  Internal helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Writes the given `ApiKeyRef` back into the appropriate location inside
 * `_settings` (e.g. the `apiKeyRef` on the anthropic-api backend config).
 * This keeps the in-memory settings consistent without a full save round-trip.
 */
function _applyRefToSettings(id: string, ref: ApiKeyRef): void {
  if (!_settings) return;

  switch (id) {
    case 'anthropic':
      _settings = {
        ..._settings,
        backends: {
          ..._settings.backends,
          'anthropic-api': { ..._settings.backends['anthropic-api'], apiKeyRef: ref },
          'claude-agent-sdk': {
            ..._settings.backends['claude-agent-sdk'],
            apiKeyRef: ref,
          },
        },
      };
      break;
    case 'gateway-token':
      _settings = {
        ..._settings,
        backends: {
          ..._settings.backends,
          'claude-agent-sdk': {
            ..._settings.backends['claude-agent-sdk'],
            authTokenRef: ref,
          },
        },
      };
      break;
    case 'claude-oauth-token':
      _settings = {
        ..._settings,
        backends: {
          ..._settings.backends,
          'claude-agent-sdk': {
            ..._settings.backends['claude-agent-sdk'],
            oauthTokenRef: ref,
          },
        },
      };
      break;
    case 'local':
      _settings = {
        ..._settings,
        backends: {
          ..._settings.backends,
          'local-openai': { ..._settings.backends['local-openai'], apiKeyRef: ref },
        },
      };
      break;
    case 'image-provider':
      _settings = { ..._settings, imageApiKeyRef: ref };
      break;
    default:
      log.warn('Unknown secret id — not reflected in settings refs', { id });
  }
  saveSettingsToDisk(_settings);
}
