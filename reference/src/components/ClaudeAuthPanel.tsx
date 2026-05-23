// Settings → Providers — Claude / Anthropic auth status + device-auth flow.
//
// Mirrors CodexAuthPanel visually so first-time users see both providers at
// the same level. State and actions come from useClaudeAuth() — the same
// hook the picker modal consumes, so the modal and the Settings panel share
// one source of truth.

import { useState, type FormEvent } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useClaudeAuth } from '../contexts/ClaudeAuthContext';
import { Button } from './ui/button';

export function ClaudeAuthPanel() {
  const {
    authenticated,
    status,
    isChecking,
    isStarting,
    isCompleting,
    authUrl,
    expiresAt,
    error,
    startAuthentication,
    completeAuthentication,
    cancelAuthentication,
    disconnect,
  } = useClaudeAuth();

  const [code, setCode] = useState('');
  const [info, setInfo] = useState<string | null>(null);
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const loading = isChecking && status === 'unknown';

  const expiryText = (() => {
    if (!expiresAt) return null;
    const t = new Date(expiresAt);
    if (Number.isNaN(t.getTime())) return null;
    return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  })();

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!code.trim()) return;
    const ok = await completeAuthentication(code);
    if (ok) setCode('');
  };

  const handleDisconnect = async () => {
    setIsDisconnecting(true);
    setInfo(null);
    const ok = await disconnect();
    if (ok) setInfo('Claude credentials removed.');
    setIsDisconnecting(false);
  };

  return (
    <div className="space-y-4" data-testid="claude-auth-panel">
      <div className="space-y-1">
        <h3 className="text-lg font-semibold text-foreground">Claude (Anthropic)</h3>
        <p className="text-sm text-muted-foreground">
          Sign in with your Claude subscription so chats and Anthropic-backed
          agents can run. Bottega stores the OAuth token under
          <code className="ml-1">~/.config/bottega/users/&lt;id&gt;/oauth_token</code>
          with mode 0600.
        </p>
      </div>

      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-center gap-2 text-sm">
          {loading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Loading…</span>
            </>
          ) : authenticated ? (
            <>
              <CheckCircle2 className="w-4 h-4 text-emerald-600" />
              <span className="font-medium">Connected</span>
              <span className="text-muted-foreground">— {status}</span>
            </>
          ) : (
            <>
              <AlertCircle className="w-4 h-4 text-amber-600" />
              <span>Not connected</span>
              {status && status !== 'missing' && (
                <span className="text-muted-foreground">— {status}</span>
              )}
            </>
          )}
        </div>

        {authenticated && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleDisconnect}
            disabled={isDisconnecting}
            data-testid="claude-auth-clear"
          >
            <Trash2 className="w-3 h-3 mr-1" /> Disconnect
          </Button>
        )}
      </div>

      {!authenticated && authUrl && (
        <div className="space-y-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-900 rounded-lg p-4">
          <div className="text-sm font-medium">
            Open the authorization URL, sign in, then paste the returned code:
          </div>
          <a
            href={authUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-600 dark:text-blue-400 underline inline-flex items-center gap-1 text-sm break-all"
            data-testid="claude-auth-login-url"
          >
            {authUrl} <ExternalLink className="w-3 h-3 flex-shrink-0" />
          </a>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard?.writeText(authUrl);
                setInfo('URL copied to clipboard');
              }}
            >
              <Copy className="w-3 h-3 mr-1" /> Copy URL
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={cancelAuthentication}
              disabled={isCompleting}
            >
              Cancel login
            </Button>
          </div>
          {expiryText && (
            <p className="text-xs text-muted-foreground">
              This link expires around {expiryText}. Click Connect again to
              generate a fresh one if it stops working.
            </p>
          )}
          <form onSubmit={handleSubmit} className="space-y-2">
            <label htmlFor="claude-auth-code" className="block text-sm font-medium text-foreground">
              Authentication code
            </label>
            <textarea
              id="claude-auth-code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              rows={4}
              disabled={isCompleting}
              placeholder="Paste the code from Claude"
              data-testid="claude-auth-code-input"
              className="w-full font-mono text-xs bg-background border border-border rounded-md px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <Button
              type="submit"
              disabled={!code.trim() || isCompleting}
              data-testid="claude-auth-code-submit"
            >
              {isCompleting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
              Submit code
            </Button>
          </form>
        </div>
      )}

      {!authenticated && !authUrl && (
        <div>
          <Button
            onClick={() => void startAuthentication()}
            disabled={isStarting}
            data-testid="claude-auth-start"
          >
            {isStarting ? <Loader2 className="w-4 h-4 mr-1 animate-spin" /> : null}
            Connect with Claude subscription
          </Button>
        </div>
      )}

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

export default ClaudeAuthPanel;
