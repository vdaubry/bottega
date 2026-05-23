import { useCallback, useEffect, useState } from 'react';
import { Key, Copy, Check, AlertTriangle, Trash2 } from 'lucide-react';
import { Button } from './ui/button';
import { api } from '../utils/api';
import type { ApiKeyStatusResponse } from '../../shared/api/auth';
import type { ApiError } from '../../shared/api/_common';

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function ApiKeyPanel() {
  const [status, setStatus] = useState<ApiKeyStatusResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [plaintextKey, setPlaintextKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [isMutating, setIsMutating] = useState(false);

  const loadStatus = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.account.getApiKey();
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as ApiError;
        throw new Error(data.error || 'Failed to load API key status');
      }
      const data = await response.json();
      setStatus(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load API key status';
      setError(message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const generate = useCallback(async () => {
    setIsMutating(true);
    setError(null);
    try {
      const response = await api.account.generateApiKey();
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as ApiError;
        throw new Error(data.error || 'Failed to generate API key');
      }
      const data = await response.json();
      setPlaintextKey(data.key);
      setCopied(false);
      setConfirmRegenerate(false);
      await loadStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate API key';
      setError(message);
    } finally {
      setIsMutating(false);
    }
  }, [loadStatus]);

  const revoke = useCallback(async () => {
    setIsMutating(true);
    setError(null);
    try {
      const response = await api.account.revokeApiKey();
      if (!response.ok) {
        const data = (await response.json().catch(() => ({}))) as ApiError;
        throw new Error(data.error || 'Failed to revoke API key');
      }
      setPlaintextKey(null);
      setConfirmRevoke(false);
      await loadStatus();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to revoke API key';
      setError(message);
    } finally {
      setIsMutating(false);
    }
  }, [loadStatus]);

  const handleCopy = useCallback(async () => {
    if (!plaintextKey) return;
    try {
      await navigator.clipboard.writeText(plaintextKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API can fail in non-secure contexts; ignore.
    }
  }, [plaintextKey]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Key className="w-5 h-5 text-blue-500" />
        <h3 className="text-lg font-medium text-foreground">API Key</h3>
      </div>

      <div className="bg-gray-50 dark:bg-gray-900/50 border border-gray-200 dark:border-gray-700 rounded-lg p-4 space-y-4">
        <p className="text-sm text-muted-foreground">
          Use this key to call the API as yourself. Send it as
          <code className="mx-1 px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-800 text-xs">
            Authorization: Bearer ccui_…
          </code>
          on any <code className="text-xs">/api/*</code> request. Tasks created
          with the key run on your Anthropic subscription.
        </p>

        {error && (
          <div className="text-sm text-red-600 dark:text-red-400 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {plaintextKey && (
          <div className="border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 rounded-md p-3">
            <div className="flex items-start gap-2 mb-2">
              <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-amber-900 dark:text-amber-100">
                Copy this key now — it is shown only once.
              </div>
            </div>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 break-all text-xs bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 font-mono"
                data-testid="api-key-plaintext"
              >
                {plaintextKey}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={handleCopy}
                aria-label="Copy API key"
              >
                {copied ? (
                  <Check className="w-4 h-4 text-green-600" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </Button>
            </div>
          </div>
        )}

        {isLoading ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : status?.hasKey ? (
          <div className="space-y-3">
            <div className="text-sm">
              <span className="font-medium text-foreground">Status:</span>{' '}
              <span className="text-green-600 dark:text-green-400">Active</span>
              {status.lastUsedAt && (
                <span className="text-muted-foreground">
                  {' · last used '}
                  {formatDate(status.lastUsedAt)}
                </span>
              )}
              {!status.lastUsedAt && (
                <span className="text-muted-foreground"> · never used</span>
              )}
            </div>

            <div className="flex flex-wrap gap-2">
              {confirmRegenerate ? (
                <>
                  <span className="text-sm text-amber-700 dark:text-amber-300 flex items-center">
                    Regenerate? Your previous key will stop working immediately.
                  </span>
                  <Button size="sm" variant="destructive" onClick={generate} disabled={isMutating}>
                    Yes, regenerate
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRegenerate(false)}>
                    Cancel
                  </Button>
                </>
              ) : confirmRevoke ? (
                <>
                  <span className="text-sm text-amber-700 dark:text-amber-300 flex items-center">
                    Revoke? You'll need to generate a new one to use the API.
                  </span>
                  <Button size="sm" variant="destructive" onClick={revoke} disabled={isMutating}>
                    Yes, revoke
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmRevoke(false)}>
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Button size="sm" onClick={() => setConfirmRegenerate(true)} disabled={isMutating}>
                    Regenerate
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setConfirmRevoke(true)}
                    disabled={isMutating}
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Revoke
                  </Button>
                </>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="text-sm">
              <span className="font-medium text-foreground">Status:</span>{' '}
              <span className="text-muted-foreground">No key generated</span>
            </div>
            <Button size="sm" onClick={generate} disabled={isMutating}>
              Generate API key
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default ApiKeyPanel;
