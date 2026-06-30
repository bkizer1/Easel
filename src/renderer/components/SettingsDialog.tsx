/**
 * Easel — SettingsDialog component.
 *
 * Modal settings panel. Exposes the full provider matrix + ClaudeAuthMode
 * conditional fields and the agenticReliability='variable' warning for the
 * local-openai backend.
 *
 * Layout:
 *   Backend select → per-backend config section (auth mode / endpoints / secrets)
 *   → Model select (Claude backends) → Feature flags → Theme → Test connection
 *
 * Secrets are set through store.setSecret / store.clearSecret so plaintext
 * keys never live in renderer state beyond the transient input value.
 *
 * AUTH MODEL (matches ARCHITECTURE.md):
 *   claude-agent-sdk:
 *     inherit  (default) — no credential env vars set; SDK uses existing Claude Code login
 *     api-key            — ANTHROPIC_API_KEY from key input
 *     bedrock            — CLAUDE_CODE_USE_BEDROCK=1 + region/profile
 *     vertex             — CLAUDE_CODE_USE_VERTEX=1 + project/region
 *     gateway            — ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN from key input
 *   anthropic-api        — always requires API key
 *   local-openai         — baseUrl + model (+ optional key)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { X, AlertTriangle, CheckCircle2, Loader2, Eye, EyeOff } from 'lucide-react';
import type {
  AgentBackendId,
  ClaudeAuthMode,
  AppSettings,
} from '@shared/types';
import { useEaselStore } from '../store';
import { Tooltip } from './Tooltip';

/* -------------------------------------------------------------------------- */
/*  Available Claude models (June 2026)                                      */
/* -------------------------------------------------------------------------- */

const CLAUDE_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (default)' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
];

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function Label({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <label className="input-label">{children}</label>
  );
}

function SelectField({
  value,
  onChange,
  children,
}: {
  value: string;
  onChange(v: string): void;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="select-field"
    >
      {children}
    </select>
  );
}

interface SecretInputProps {
  placeholder: string;
  hint?: string;
  isSet: boolean;
  onSave(value: string): Promise<void>;
  onClear(): Promise<void>;
}

function SecretInput({ placeholder, hint, isSet, onSave, onClear }: SecretInputProps): React.ReactElement {
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);

  async function handleSave(): Promise<void> {
    if (!value.trim()) return;
    await onSave(value.trim());
    setValue('');
  }

  return (
    <div className="flex flex-col gap-1.5">
      {isSet && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-emerald-400 font-medium">
            Key set {hint ? `(…${hint})` : ''}
          </span>
          <button
            onClick={() => void onClear()}
            className="text-xs text-gray-500 hover:text-rose-400 transition-colors duration-150 ease-spring"
          >
            Clear
          </button>
        </div>
      )}
      <div className="flex gap-2">
        <div className="relative flex-1">
          <input
            type={show ? 'text' : 'password'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={isSet ? 'Replace key…' : placeholder}
            className="input-field pr-9"
          />
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-600 hover:text-gray-400 transition-colors duration-150 ease-spring"
          >
            {show ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <button
          onClick={() => void handleSave()}
          disabled={!value.trim()}
          className="btn-primary px-3 py-2 text-xs"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function TextField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange(v: string): void;
  placeholder?: string;
}): React.ReactElement {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="input-field"
    />
  );
}

/* -------------------------------------------------------------------------- */
/*  Claude Agent SDK section                                                  */
/* -------------------------------------------------------------------------- */

function ClaudeAgentSdkSection({
  settings,
  onUpdateSettings,
  onSetSecret,
  onClearSecret,
}: {
  settings: AppSettings;
  onUpdateSettings(patch: Partial<AppSettings['backends']['claude-agent-sdk']>): void;
  onSetSecret(id: string, value: string): Promise<void>;
  onClearSecret(id: string): Promise<void>;
}): React.ReactElement {
  const cfg = settings.backends['claude-agent-sdk'];
  const authMode = cfg.authMode;

  function setAuthMode(mode: ClaudeAuthMode): void {
    onUpdateSettings({ authMode: mode });
  }

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label>Auth mode</Label>
        <SelectField value={authMode} onChange={(v) => setAuthMode(v as ClaudeAuthMode)}>
          <option value="inherit">Inherit (use existing Claude Code login)</option>
          <option value="setup-token">Setup token (paste from `claude setup-token`)</option>
          <option value="api-key">API Key (Anthropic API, billed)</option>
          <option value="bedrock">Amazon Bedrock</option>
          <option value="vertex">Google Vertex AI</option>
          <option value="gateway">Custom Gateway / Proxy</option>
        </SelectField>
        {authMode === 'inherit' && (
          <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">
            No credentials are set by Easel. The Claude Agent SDK will use
            whatever Claude Code login exists on this machine (Pro/Max plan —
            no extra API spend).
          </p>
        )}
      </div>

      {authMode === 'setup-token' && (
        <div>
          <Label>Claude setup token</Label>
          <SecretInput
            placeholder="Paste token from `claude setup-token`…"
            hint={cfg.oauthTokenRef?.hint}
            isSet={cfg.oauthTokenRef?.isSet ?? false}
            onSave={(v) => onSetSecret('claude-oauth-token', v)}
            onClear={() => onClearSecret('claude-oauth-token')}
          />
          <p className="mt-1.5 text-xs text-gray-500 leading-relaxed">
            In a terminal run <span className="font-mono text-gray-400">claude setup-token</span>, then paste the
            token here. Uses your Claude subscription — no extra API spend. Stored encrypted in your OS keychain.
          </p>
        </div>
      )}

      {authMode === 'api-key' && (
        <div>
          <Label>Anthropic API key</Label>
          <SecretInput
            placeholder="sk-ant-…"
            hint={cfg.apiKeyRef?.hint}
            isSet={cfg.apiKeyRef?.isSet ?? false}
            onSave={(v) => onSetSecret('anthropic', v)}
            onClear={() => onClearSecret('anthropic')}
          />
        </div>
      )}

      {authMode === 'gateway' && (
        <>
          <div>
            <Label>Gateway base URL</Label>
            <TextField
              value={cfg.baseUrl ?? ''}
              onChange={(v) =>
                onUpdateSettings({ baseUrl: v || undefined })
              }
              placeholder="https://my-proxy.example.com/v1"
            />
          </div>
          <div>
            <Label>Bearer token (ANTHROPIC_AUTH_TOKEN)</Label>
            <SecretInput
              placeholder="Bearer token…"
              hint={cfg.authTokenRef?.hint}
              isSet={cfg.authTokenRef?.isSet ?? false}
              onSave={(v) => onSetSecret('gateway-token', v)}
              onClear={() => onClearSecret('gateway-token')}
            />
          </div>
        </>
      )}

      {authMode === 'bedrock' && (
        <>
          <div>
            <Label>AWS region</Label>
            <TextField
              value={cfg.bedrock?.region ?? ''}
              onChange={(v) =>
                onUpdateSettings({ bedrock: { ...cfg.bedrock, region: v || undefined } })
              }
              placeholder="us-east-1"
            />
          </div>
          <div>
            <Label>AWS profile (optional)</Label>
            <TextField
              value={cfg.bedrock?.profile ?? ''}
              onChange={(v) =>
                onUpdateSettings({ bedrock: { ...cfg.bedrock, profile: v || undefined } })
              }
              placeholder="default"
            />
            <p className="mt-1 text-xs text-gray-500">
              Credentials come from the ambient AWS credential chain, not from Easel.
            </p>
          </div>
        </>
      )}

      {authMode === 'vertex' && (
        <>
          <div>
            <Label>GCP project id</Label>
            <TextField
              value={cfg.vertex?.project ?? ''}
              onChange={(v) =>
                onUpdateSettings({ vertex: { ...cfg.vertex, project: v || undefined } })
              }
              placeholder="my-gcp-project"
            />
          </div>
          <div>
            <Label>GCP region</Label>
            <TextField
              value={cfg.vertex?.region ?? ''}
              onChange={(v) =>
                onUpdateSettings({ vertex: { ...cfg.vertex, region: v || undefined } })
              }
              placeholder="us-central1"
            />
            <p className="mt-1 text-xs text-gray-500">
              Credentials come from Application Default Credentials (ADC), not from Easel.
            </p>
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Anthropic API section                                                     */
/* -------------------------------------------------------------------------- */

function AnthropicApiSection({
  settings,
  onSetSecret,
  onClearSecret,
}: {
  settings: AppSettings;
  onSetSecret(id: string, value: string): Promise<void>;
  onClearSecret(id: string): Promise<void>;
}): React.ReactElement {
  const cfg = settings.backends['anthropic-api'];

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Label>Anthropic API key (required)</Label>
        <SecretInput
          placeholder="sk-ant-…"
          hint={cfg.apiKeyRef?.hint}
          isSet={cfg.apiKeyRef?.isSet ?? false}
          onSave={(v) => onSetSecret('anthropic', v)}
          onClear={() => onClearSecret('anthropic')}
        />
        <p className="mt-1.5 text-xs text-amber-500/80 leading-relaxed">
          Every edit is billed against this key. Consider using the Claude Agent
          SDK backend with inherit mode if you have a Claude Pro/Max subscription.
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Local OpenAI section                                                      */
/* -------------------------------------------------------------------------- */

function LocalOpenAiSection({
  settings,
  onUpdateSettings,
  onSetSecret,
  onClearSecret,
}: {
  settings: AppSettings;
  onUpdateSettings(patch: Partial<AppSettings['backends']['local-openai']>): void;
  onSetSecret(id: string, value: string): Promise<void>;
  onClearSecret(id: string): Promise<void>;
}): React.ReactElement {
  const cfg = settings.backends['local-openai'];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-amber-950/30 border border-amber-800/40 text-amber-400 text-xs">
        <AlertTriangle className="w-3.5 h-3.5 mt-px flex-shrink-0" />
        <span>
          Local model backends have variable agentic reliability. Complex multi-step
          edits may not complete correctly. Tool-use quality depends on the model.
        </span>
      </div>

      <div>
        <Label>Base URL</Label>
        <TextField
          value={cfg.baseUrl}
          onChange={(v) => onUpdateSettings({ baseUrl: v })}
          placeholder="http://localhost:11434/v1"
        />
        <p className="mt-1 text-xs text-gray-500">
          Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1
        </p>
      </div>

      <div>
        <Label>Model name</Label>
        <TextField
          value={cfg.model}
          onChange={(v) => onUpdateSettings({ model: v })}
          placeholder="qwen2.5-coder:14b"
        />
      </div>

      <div>
        <Label>API key (optional)</Label>
        <SecretInput
          placeholder="Bearer token…"
          hint={cfg.apiKeyRef?.hint}
          isSet={cfg.apiKeyRef?.isSet ?? false}
          onSave={(v) => onSetSecret('local', v)}
          onClear={() => onClearSecret('local')}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  SettingsDialog                                                            */
/* -------------------------------------------------------------------------- */

export function SettingsDialog(): React.ReactElement | null {
  const settingsOpen = useEaselStore((s) => s.settingsOpen);
  const settings = useEaselStore((s) => s.settings);
  const setSettingsOpen = useEaselStore((s) => s.setSettingsOpen);
  const updateSettings = useEaselStore((s) => s.updateSettings);
  const setSecret = useEaselStore((s) => s.setSecret);
  const clearSecret = useEaselStore((s) => s.clearSecret);
  const validateBackend = useEaselStore((s) => s.validateBackend);

  const [validateState, setValidateState] = useState<
    'idle' | 'pending' | 'ok' | 'fail'
  >('idle');
  const [validateMsg, setValidateMsg] = useState('');

  // Local draft that mirrors settings during the dialog session.
  // We update the store on field blur / select change so we don't hammer IPC.
  const [draft, setDraft] = useState<AppSettings | null>(null);

  useEffect(() => {
    if (settingsOpen && settings) {
      setDraft(settings);
      setValidateState('idle');
      setValidateMsg('');
    }
  }, [settingsOpen, settings]);

  const handleClose = useCallback(() => {
    setSettingsOpen(false);
  }, [setSettingsOpen]);

  // Escape key closes the dialog.
  useEffect(() => {
    if (!settingsOpen) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') handleClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [settingsOpen, handleClose]);

  if (!settingsOpen || !draft) return null;

  async function handleValidate(): Promise<void> {
    setValidateState('pending');
    setValidateMsg('');
    const result = await validateBackend();
    if (result.ok) {
      setValidateState('ok');
      setValidateMsg('Connection successful');
    } else {
      setValidateState('fail');
      setValidateMsg(result.problem ?? 'Connection failed');
    }
  }

  function updateBackendCfg<K extends AgentBackendId>(
    id: K,
    patch: Partial<AppSettings['backends'][K]>,
  ): void {
    const next: AppSettings = {
      ...draft!,
      backends: {
        ...draft!.backends,
        [id]: { ...draft!.backends[id], ...patch },
      },
    };
    setDraft(next);
    // Persist to main. We cast away the secret fields as the type constraint
    // in SettingsUpdateRequest excludes them (they go via setSecret only).
    void updateSettings({
      agentBackend: next.agentBackend,
      model: next.model,
      backends: next.backends,
      featureFlags: next.featureFlags,
      theme: next.theme,
      maxRetries: next.maxRetries,
    });
  }

  function setField<K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K],
  ): void {
    const next = { ...draft!, [key]: value };
    setDraft(next);
    void updateSettings({
      agentBackend: next.agentBackend,
      model: next.model,
      backends: next.backends,
      featureFlags: next.featureFlags,
      theme: next.theme,
      maxRetries: next.maxRetries,
    });
  }

  const backend = draft.agentBackend;
  const isClaudeBackend =
    backend === 'claude-agent-sdk' || backend === 'anthropic-api';

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 z-40 animate-fade-in"
        onClick={handleClose}
        aria-hidden
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-label="Settings"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
      >
        <div className="glass-raised animate-scale-in w-full max-w-md max-h-[90vh] flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 hairline-b flex-shrink-0">
            <h2 className="text-base font-semibold text-gray-100">Settings</h2>
            <Tooltip label="Close" shortcut="Esc" side="left">
              <button
                aria-label="Close settings"
                onClick={handleClose}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-gray-400 hover:bg-white/[0.07] hover:text-gray-200 transition-all duration-150 ease-spring active:scale-90"
              >
                <X className="w-4 h-4" />
              </button>
            </Tooltip>
          </div>

          {/* Body (scrollable) */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-6">

            {/* ---- Agent backend ---- */}
            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Agent backend
              </h3>

              <div className="flex flex-col gap-4">
                <div>
                  <Label>Backend</Label>
                  <SelectField
                    value={backend}
                    onChange={(v) => setField('agentBackend', v as AgentBackendId)}
                  >
                    <option value="claude-agent-sdk">Claude Agent SDK (recommended)</option>
                    <option value="anthropic-api">Anthropic Messages API</option>
                    <option value="local-openai">Local / OpenAI-compatible</option>
                  </SelectField>
                </div>

                {backend === 'claude-agent-sdk' && (
                  <ClaudeAgentSdkSection
                    settings={draft}
                    onUpdateSettings={(patch) => updateBackendCfg('claude-agent-sdk', patch)}
                    onSetSecret={setSecret}
                    onClearSecret={clearSecret}
                  />
                )}

                {backend === 'anthropic-api' && (
                  <AnthropicApiSection
                    settings={draft}
                    onSetSecret={setSecret}
                    onClearSecret={clearSecret}
                  />
                )}

                {backend === 'local-openai' && (
                  <LocalOpenAiSection
                    settings={draft}
                    onUpdateSettings={(patch) => updateBackendCfg('local-openai', patch)}
                    onSetSecret={setSecret}
                    onClearSecret={clearSecret}
                  />
                )}
              </div>
            </section>

            {/* ---- Model (Claude backends only) ---- */}
            {isClaudeBackend && (
              <section>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Model
                </h3>
                <div>
                  <Label>Claude model</Label>
                  <SelectField
                    value={draft.model}
                    onChange={(v) => setField('model', v)}
                  >
                    {CLAUDE_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </SelectField>
                </div>
              </section>
            )}

            {/* ---- Feature flags ---- */}
            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Feature flags
              </h3>
              <div className="flex flex-col gap-3">
                {(
                  [
                    ['voiceInput', 'Voice input (Web Speech API)'],
                    ['showThinking', 'Show agent reasoning in chat'],
                    ['autoCheckpoint', 'Auto git checkpoint before edits'],
                    ['imageGeneration', 'Image generation (replace_image tool)'],
                    [
                      'selfHealVerify',
                      'Self-heal: verify edits with vision',
                      'After each edit, sends before/after screenshots of your page to the Anthropic API to judge whether it matched your request. Requires an Anthropic API key (Provider tab) — unavailable on OAuth/inherit login.',
                    ],
                  ] as const
                ).map(([key, label, description]) => (
                  <label key={key} className="flex items-start justify-between gap-3 cursor-pointer">
                    <span className="text-sm text-gray-300">
                      {label}
                      {description ? (
                        <span className="mt-0.5 block text-xs text-gray-500">{description}</span>
                      ) : null}
                    </span>
                    <input
                      type="checkbox"
                      checked={draft.featureFlags[key]}
                      onChange={(e) =>
                        setField('featureFlags', {
                          ...draft.featureFlags,
                          [key]: e.target.checked,
                        })
                      }
                      className="mt-0.5 w-4 h-4 flex-shrink-0 accent-brand-500 cursor-pointer"
                    />
                  </label>
                ))}

                {/* Self-heal auto-retry budget (issue #31). Shown only when the
                    verify flag is on; clamped to 0–5. 0 = observe-only. */}
                {draft.featureFlags.selfHealVerify && (
                  <label className="flex items-start justify-between gap-3">
                    <span className="text-sm text-gray-300">
                      Self-heal auto-retries
                      <span className="mt-0.5 block text-xs text-gray-500">
                        After a failed verify, auto-resubmit the edit this many times with the
                        reviewer&rsquo;s feedback. 0 = verify only (no retry).
                      </span>
                    </span>
                    <input
                      type="number"
                      min={0}
                      max={5}
                      step={1}
                      value={draft.maxRetries}
                      onChange={(e) => {
                        const n = Number.parseInt(e.target.value, 10);
                        const clamped = Number.isFinite(n) ? Math.max(0, Math.min(5, n)) : 0;
                        setField('maxRetries', clamped);
                      }}
                      className="mt-0.5 w-16 flex-shrink-0 rounded-lg bg-white/[0.05] px-2 py-1 text-sm text-gray-200 outline-none ring-1 ring-white/10 focus:ring-brand-500"
                    />
                  </label>
                )}
              </div>
            </section>

            {/* ---- Image generation key (shown when enabled) ---- */}
            {draft.featureFlags.imageGeneration && (
              <section>
                <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                  Image provider
                </h3>
                <Label>OpenAI API key (for image generation)</Label>
                <SecretInput
                  placeholder="sk-…"
                  hint={draft.imageApiKeyRef?.hint}
                  isSet={draft.imageApiKeyRef?.isSet ?? false}
                  onSave={(v) => setSecret('image-provider', v)}
                  onClear={() => clearSecret('image-provider')}
                />
                <p className="mt-1.5 text-xs text-gray-500">
                  Used by the agent&rsquo;s replace-image tool to generate images. Fetching an image by URL works
                  without a key.
                </p>
              </section>
            )}

            {/* ---- Theme ---- */}
            <section>
              <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-3">
                Theme
              </h3>
              <SelectField
                value={draft.theme}
                onChange={(v) => setField('theme', v as AppSettings['theme'])}
              >
                <option value="system">System</option>
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </SelectField>
            </section>
          </div>

          {/* Footer — Test connection */}
          <div className="flex-shrink-0 hairline-t px-5 py-4 flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              {validateState === 'ok' && (
                <>
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                  <span className="text-xs text-emerald-400 truncate">{validateMsg}</span>
                </>
              )}
              {validateState === 'fail' && (
                <>
                  <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
                  <span className="text-xs text-rose-400 truncate">{validateMsg}</span>
                </>
              )}
            </div>

            <button
              onClick={() => void handleValidate()}
              disabled={validateState === 'pending'}
              className="btn-secondary flex-shrink-0 text-sm px-3 py-1.5"
            >
              {validateState === 'pending' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Test connection
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
