// Settings → Providers — Codex auth status + Path B (paste auth.json).
//
// The PTY-driven `codex login --device-auth` UI is Phase 10 part 3 work.
// This panel ships Path B as the primary auth path today: the user
// runs `codex login` on their workstation, pastes the resulting
// `~/.codex/auth.json` contents into the textarea, and Bottega
// persists it under the per-user CODEX_HOME (`~/.config/bottega/users/
// {userId}/codex/auth.json`).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle, CheckCircle2, Trash2, ExternalLink, Copy } from 'lucide-react';
import { api } from '../utils/api';
import { Button } from './ui/button';
import type { CodexAuthStatusResponse } from '../../shared/api/codexAuth';

export function CodexAuthPanel() {
  const [status, setStatus] = useState<CodexAuthStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pasteValue, setPasteValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [startingLogin, setStartingLogin] = useState(false);
  const pollTimer = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.codexAuth.status();
      if (!res.ok) {
        setError('Failed to read Codex auth status');
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

  // Poll status while a device-auth login is active so the panel
  // collapses the URL/code back to "Connected" the moment the
  // subprocess writes auth.json and exits.
  useEffect(() => {
    const active = status?.login?.active === true && !status.authenticated;
    if (!active) {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
      return;
    }
    if (pollTimer.current !== null) return;
    pollTimer.current = window.setInterval(() => {
      void refresh();
    }, 3000);
    return () => {
      if (pollTimer.current !== null) {
        window.clearInterval(pollTimer.current);
        pollTimer.current = null;
      }
    };
  }, [status?.login?.active, status?.authenticated, refresh]);

  const handleStartLogin = async () => {
    setStartingLogin(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.codexAuth.start();
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Failed to start Codex login');
        return;
      }
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStartingLogin(false);
    }
  };

  const handleCancelLogin = async () => {
    setStartingLogin(true);
    try {
      await api.codexAuth.cancel();
      await refresh();
    } finally {
      setStartingLogin(false);
    }
  };

  const handlePaste = async () => {
    if (!pasteValue.trim()) return;
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.codexAuth.paste(pasteValue);
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setError(body.error ?? 'Failed to persist auth.json');
        return;
      }
      setPasteValue('');
      setInfo('Codex auth.json saved.');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleClear = async () => {
    setSubmitting(true);
    setError(null);
    setInfo(null);
    try {
      const res = await api.codexAuth.clear();
      if (!res.ok) {
        setError('Failed to clear Codex auth');
        return;
      }
      const body = await res.json();
      setInfo(body.cleared ? 'Codex auth.json removed.' : 'Nothing to remove.');
      await refresh();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="codex-auth-panel">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">Codex (OpenAI)</h3>
        <p className="text-sm text-muted-foreground">
          Provision a per-user <code>auth.json</code> so agents configured
          for OpenAI can run. Bottega stores it under
          <code className="ml-1">~/.config/bottega/users/&lt;id&gt;/codex/</code>
          with mode 0600 — no other user can read it.
        </p>
      </div>

      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading…</span>
            </>
          ) : status?.authenticated ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span className="font-medium">Connected</span>
              {status.method && (
                <span className="text-muted-foreground">via {status.method}</span>
              )}
              {status.email && (
                <span className="text-muted-foreground">— {status.email}</span>
              )}
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
            data-testid="codex-auth-clear"
          >
            <Trash2 className="w-3 h-3 mr-1" /> Disconnect
          </Button>
        )}
      </div>

      {/* Device-auth flow: when a login is in flight, render the
          URL + code; otherwise show a Connect button. The poll loop
          in the useEffect above swaps state back to Connected once
          the subprocess writes auth.json. */}
      {!status?.authenticated && status?.login?.active === true && (
        <div className="space-y-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 rounded-lg p-4">
          <div className="text-sm font-medium">
            Open the authorization URL and enter the one-time code:
          </div>
          {status.login.authUrl && (
            <a
              href={status.login.authUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 dark:text-blue-400 underline inline-flex items-center gap-1 text-sm"
              data-testid="codex-auth-login-url"
            >
              {status.login.authUrl} <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {status.login.deviceCode && (
            <div className="flex items-center gap-2">
              <code className="bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded font-mono text-base">
                {status.login.deviceCode}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  navigator.clipboard.writeText(status.login!.deviceCode!);
                  setInfo('Code copied to clipboard');
                }}
              >
                <Copy className="w-3 h-3 mr-1" /> Copy
              </Button>
            </div>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handleCancelLogin}
            disabled={startingLogin}
          >
            Cancel login
          </Button>
        </div>
      )}

      {!status?.authenticated && !status?.login?.active && (
        <div>
          <Button
            onClick={handleStartLogin}
            disabled={startingLogin}
            data-testid="codex-auth-start"
          >
            {startingLogin ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Connect with codex login --device-auth
          </Button>
        </div>
      )}

      <div className="space-y-2">
        <label
          htmlFor="codex-auth-paste"
          className="block text-sm font-medium text-foreground"
        >
          Paste <code>auth.json</code> contents
        </label>
        <p className="text-xs text-muted-foreground">
          Run <code>codex login</code> on a developer machine, then paste the
          full contents of <code>~/.codex/auth.json</code> here. The JSON must
          carry <code>tokens.access_token</code>, <code>tokens.id_token</code>,
          or <code>OPENAI_API_KEY</code>.
        </p>
        <textarea
          id="codex-auth-paste"
          value={pasteValue}
          onChange={(e) => setPasteValue(e.target.value)}
          rows={6}
          placeholder='{ "tokens": { "access_token": "..." } }'
          disabled={submitting}
          data-testid="codex-auth-paste-input"
          className="w-full font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
        <Button
          onClick={handlePaste}
          disabled={submitting || !pasteValue.trim()}
          data-testid="codex-auth-paste-submit"
        >
          {submitting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
          Save auth.json
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

export default CodexAuthPanel;
