// Settings → Providers — OpenCode (Zen & Go) auth status + single-key paste.
//
// Per docs/opencode/00-context-decisions.md § R15: OpenCode auth in v1
// is a single API key (issued at https://opencode.ai/zen for Zen, and
// https://opencode.ai/go for Go). One key unlocks the entire Zen or Go
// catalog — Qwen, Kimi, DeepSeek, Claude, GPT, GLM, MiniMax, … on Zen,
// and the Go equivalent model set on Go. No OAuth, no device-auth, 
// no per-vendor sub-keys.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Trash2, ExternalLink } from 'lucide-react';
import { api } from '../utils/api';
import { Button } from './ui/button';
import type { OpenCodeAuthStatusResponse } from '../../shared/api/openCodeAuth';

const MIN_KEY_LENGTH = 20;

export function OpenCodeAuthPanel() {
  const [status, setStatus] = useState<OpenCodeAuthStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyValue, setKeyValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.openCodeAuth.status();
      if (!res.ok) {
        setError('Failed to read OpenCode auth status');
        setStatus(null);
        return;
      }
      const body = await res.json();
      setStatus(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleSave = async (): Promise<void> => {
    const trimmed = keyValue.trim();
    if (trimmed.length < MIN_KEY_LENGTH) {
      setError(`API key looks too short — paste the full key from opencode.ai/zen.`);
      return;
    }
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.openCodeAuth.setKey(trimmed);
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `Save failed (HTTP ${res.status})`);
        return;
      }
      setKeyValue('');
      setInfo('OpenCode key saved.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleClear = async (): Promise<void> => {
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.openCodeAuth.clear();
      if (!res.ok) {
        setError('Failed to clear OpenCode auth');
        return;
      }
      const body = await res.json();
      setInfo(body.cleared ? 'OpenCode key removed.' : 'Nothing to remove.');
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="opencode-auth-panel">
      <div className="space-y-1">
         <h3 className="text-lg font-semibold text-foreground">OpenCode (Zen & Go)</h3>
         <p className="text-sm text-muted-foreground">
           Paste your OpenCode API key. One key unlocks every model in either the
           Zen catalog (Qwen, Kimi, DeepSeek, Claude, GPT, GLM, MiniMax, …) or the
           Go catalog, depending on how your account is configured on{' '}
           <a
             href="https://opencode.ai"
             target="_blank"
             rel="noopener noreferrer"
             className="text-blue-600 dark:text-blue-400 underline inline-flex items-center gap-1"
           >
             opencode.ai <ExternalLink className="w-3 h-3" />
           </a>
           . The key is stored per-user under
           <code className="ml-1">~/.config/bottega/users/&lt;id&gt;/opencode-data/opencode/auth.json</code>
           {' '}with mode 0600 — no other user can read it.
         </p>
       </div>

      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm" data-testid="opencode-auth-row">
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading…</span>
            </>
          ) : status?.authenticated ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span className="font-medium">Connected</span>
              {status.tokenFingerprint && (
                <code className="text-muted-foreground">…{status.tokenFingerprint}</code>
              )}
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-amber-600" />
              <span>Not connected</span>
              {status?.reason && (
                <span className="text-muted-foreground">— {status.reason}</span>
              )}
            </>
          )}
        </div>

        {status?.authenticated && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleClear}
            disabled={submitting}
            data-testid="opencode-auth-clear"
          >
            <Trash2 className="w-3 h-3 mr-1" /> Disconnect
          </Button>
        )}
      </div>

      <div className="space-y-2">
        <label
          htmlFor="opencode-auth-key"
          className="block text-sm font-medium text-foreground"
        >
          {status?.authenticated ? 'Replace API key' : 'API key'}
        </label>
        <input
          id="opencode-auth-key"
          type="password"
          value={keyValue}
          onChange={(e) => setKeyValue(e.target.value)}
          autoComplete="off"
          placeholder="sk-…"
          disabled={submitting}
          data-testid="opencode-auth-key-input"
          className="w-full font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <Button
          onClick={handleSave}
          disabled={submitting || keyValue.trim().length < MIN_KEY_LENGTH}
          data-testid="opencode-auth-save"
        >
          {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
          {status?.authenticated ? 'Replace key' : 'Save key'}
        </Button>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {info && !error && (
        <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded text-sm text-emerald-700 dark:text-emerald-300">
          {info}
        </div>
      )}
    </div>
  );
}

export default OpenCodeAuthPanel;
