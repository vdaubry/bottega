import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import ProvidersModal from '../components/ProvidersModal';
import { api } from '../utils/api';
import { useAuth } from './AuthContext';
import type { ApiError } from '../../shared/api/_common';

export interface ClaudeAuthContextValue {
  authenticated: boolean;
  status: string;
  isChecking: boolean;
  isStarting: boolean;
  isCompleting: boolean;
  authUrl: string | null;
  expiresAt: string | null;
  error: string | null;
  openAuthModal: () => void;
  refreshStatus: (options?: { showModalOnMissing?: boolean }) => Promise<boolean>;
  requireClaudeAuth: () => boolean;
  startAuthentication: () => Promise<void>;
  completeAuthentication: (code: string) => Promise<boolean>;
  cancelAuthentication: () => void;
  disconnect: () => Promise<boolean>;
}

const defaultContext: ClaudeAuthContextValue = {
  authenticated: false,
  status: 'unknown',
  isChecking: false,
  isStarting: false,
  isCompleting: false,
  authUrl: null,
  expiresAt: null,
  error: null,
  openAuthModal: () => {},
  refreshStatus: async () => false,
  requireClaudeAuth: () => true,
  startAuthentication: async () => {},
  completeAuthentication: async () => false,
  cancelAuthentication: () => {},
  disconnect: async () => false,
};

const ClaudeAuthContext = createContext<ClaudeAuthContextValue>(defaultContext);

export function useClaudeAuth(): ClaudeAuthContextValue {
  return useContext(ClaudeAuthContext) || defaultContext;
}

function logClaudeAuth(message: string, details: Record<string, unknown> = {}): void {
  console.log('[ClaudeAuthUI]', {
    message,
    ...details,
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function ClaudeAuthProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const hasAuthUser = !!user;
  const authUserKey = user?.id ?? user?.username ?? null;
  const [authenticated, setAuthenticated] = useState(false);
  const [status, setStatus] = useState('unknown');
  const [isChecking, setIsChecking] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [loginSessionId, setLoginSessionId] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isCompleting, setIsCompleting] = useState(false);

  const resetLoginState = useCallback(() => {
    setAuthUrl(null);
    setLoginSessionId(null);
    setExpiresAt(null);
  }, []);

  const refreshStatus = useCallback(
    async ({ showModalOnMissing = false }: { showModalOnMissing?: boolean } = {}): Promise<boolean> => {
      if (isAuthLoading || !hasAuthUser) {
        logClaudeAuth('status-skip', {
          isAuthLoading,
          hasAuthUser,
        });
        return false;
      }

      logClaudeAuth('status-request', {
        showModalOnMissing,
        authUserKey,
      });
      setIsChecking(true);
      setError(null);

      try {
        const response = await api.claudeAuth.status();
        const data = await readJson(response);

        if (!response.ok) {
          throw new Error((data as unknown as ApiError).error || 'Failed to check Claude authentication');
        }

        const isAuthenticated = data.authenticated === true;
        const login = data.login as
          | {
              active?: boolean;
              loginSessionId?: string;
              authUrl?: string;
              expiresAt?: string;
            }
          | undefined;
        logClaudeAuth('status-response', {
          authenticated: isAuthenticated,
          status: data.status,
          hasActiveLogin: Boolean(login?.active),
          hasAuthUrl: Boolean(login?.authUrl),
        });
        setAuthenticated(isAuthenticated);
        setStatus(
          (data.status as string) || (isAuthenticated ? 'authenticated' : 'missing'),
        );

        if (login?.active) {
          logClaudeAuth('restoring-active-login', {
            loginSessionId: login.loginSessionId,
            expiresAt: login.expiresAt,
            hasAuthUrl: Boolean(login.authUrl),
          });
          setLoginSessionId(login.loginSessionId ?? null);
          setAuthUrl(login.authUrl ?? null);
          setExpiresAt(login.expiresAt ?? null);
        } else if (isAuthenticated) {
          resetLoginState();
        }

        if (!isAuthenticated && showModalOnMissing) {
          logClaudeAuth('opening-modal-from-status');
          setIsModalOpen(true);
        }

        return isAuthenticated;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[ClaudeAuth] Status check failed:', err);
        logClaudeAuth('status-error', {
          error: message,
        });
        setAuthenticated(false);
        setStatus('unknown');
        setError(message || 'Failed to check Claude authentication');
        if (showModalOnMissing) {
          logClaudeAuth('opening-modal-after-status-error');
          setIsModalOpen(true);
        }
        return false;
      } finally {
        setIsChecking(false);
      }
    },
    [authUserKey, hasAuthUser, isAuthLoading, resetLoginState],
  );

  useEffect(() => {
    if (!isAuthLoading && hasAuthUser) {
      logClaudeAuth('initial-status-check', { authUserKey });
      // Don't auto-pop the Claude modal on first login — the app-wide
      // ConnectedProvidersProvider owns the blocking "connect any provider"
      // gate. This still refreshes Claude status; the modal opens only via
      // explicit requireClaudeAuth()/openAuthModal() calls.
      void refreshStatus({ showModalOnMissing: false });
    }
  }, [authUserKey, hasAuthUser, isAuthLoading, refreshStatus]);

  const openAuthModal = useCallback(() => {
    logClaudeAuth('open-modal-request');
    setError(null);
    setIsModalOpen(true);
  }, []);

  const requireClaudeAuth = useCallback((): boolean => {
    logClaudeAuth('require-auth-check', {
      authenticated,
      status,
    });
    if (authenticated) return true;
    logClaudeAuth('require-auth-opening-modal');
    setIsModalOpen(true);
    return false;
  }, [authenticated, status]);

  const startAuthentication = useCallback(async () => {
    logClaudeAuth('start-request');
    setIsStarting(true);
    setError(null);

    try {
      const response = await api.claudeAuth.start();
      const data = await readJson(response);

      if (!response.ok) {
        throw new Error((data as unknown as ApiError).error || 'Failed to start Claude authentication');
      }

      logClaudeAuth('start-response', {
        loginSessionId: data.loginSessionId,
        hasAuthUrl: Boolean(data.authUrl),
        expiresAt: data.expiresAt,
      });
      setLoginSessionId((data.loginSessionId as string | undefined) ?? null);
      setAuthUrl((data.authUrl as string | undefined) ?? null);
      setExpiresAt((data.expiresAt as string | undefined) ?? null);
      setAuthenticated(false);
      setStatus('login_pending');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ClaudeAuth] Start failed:', err);
      logClaudeAuth('start-error', {
        error: message,
      });
      setError(message || 'Failed to start Claude authentication');
    } finally {
      setIsStarting(false);
    }
  }, []);

  const completeAuthentication = useCallback(
    async (code: string): Promise<boolean> => {
      if (!loginSessionId) {
        logClaudeAuth('complete-no-login-session');
        setError('Start Claude authentication first');
        return false;
      }

      logClaudeAuth('complete-request', {
        loginSessionId,
        codeLength: typeof code === 'string' ? code.trim().length : 0,
      });
      setIsCompleting(true);
      setError(null);

      try {
        const response = await api.claudeAuth.complete(loginSessionId, code);
        const data = await readJson(response);

        if (!response.ok) {
          throw new Error((data as unknown as ApiError).error || 'Claude authentication failed');
        }

        logClaudeAuth('complete-response', {
          authenticated: true,
          status: data.status,
        });
        setAuthenticated(true);
        setStatus((data.status as string) || 'authenticated');
        setIsModalOpen(false);
        resetLoginState();
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[ClaudeAuth] Complete failed:', err);
        logClaudeAuth('complete-error', {
          error: message,
        });
        setError(message || 'Claude authentication failed');
        return false;
      } finally {
        setIsCompleting(false);
      }
    },
    [loginSessionId, resetLoginState],
  );

  const closeAuthModal = useCallback(() => {
    logClaudeAuth('close-modal-request', {
      hasLoginSession: Boolean(loginSessionId),
      authenticated,
    });
    setIsModalOpen(false);
    setError(null);

    if (loginSessionId) {
      api.claudeAuth.cancel().catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[ClaudeAuth] Cancel failed:', err);
        logClaudeAuth('cancel-error', {
          error: message,
        });
      });
      logClaudeAuth('cancel-requested-from-close', {
        loginSessionId,
      });
      resetLoginState();
      if (!authenticated) {
        setStatus('missing');
      }
    }
  }, [authenticated, loginSessionId, resetLoginState]);

  const cancelAuthentication = useCallback(() => {
    if (!loginSessionId) return;
    api.claudeAuth.cancel().catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ClaudeAuth] Cancel failed:', err);
      logClaudeAuth('cancel-error', { error: message });
    });
    logClaudeAuth('cancel-requested', { loginSessionId });
    resetLoginState();
    if (!authenticated) setStatus('missing');
  }, [authenticated, loginSessionId, resetLoginState]);

  const disconnect = useCallback(async (): Promise<boolean> => {
    logClaudeAuth('disconnect-request');
    setError(null);
    try {
      const response = await api.claudeAuth.clear();
      const data = await readJson(response);
      if (!response.ok) {
        throw new Error(
          (data as unknown as ApiError).error || 'Failed to disconnect Claude',
        );
      }
      logClaudeAuth('disconnect-response', { cleared: data.cleared });
      setAuthenticated(false);
      setStatus('missing');
      resetLoginState();
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[ClaudeAuth] Disconnect failed:', err);
      logClaudeAuth('disconnect-error', { error: message });
      setError(message || 'Failed to disconnect Claude');
      return false;
    }
  }, [resetLoginState]);

  const value = useMemo<ClaudeAuthContextValue>(
    () => ({
      authenticated,
      status,
      isChecking,
      isStarting,
      isCompleting,
      authUrl,
      expiresAt,
      error,
      openAuthModal,
      refreshStatus,
      requireClaudeAuth,
      startAuthentication,
      completeAuthentication,
      cancelAuthentication,
      disconnect,
    }),
    [
      authenticated,
      status,
      isChecking,
      isStarting,
      isCompleting,
      authUrl,
      expiresAt,
      error,
      openAuthModal,
      refreshStatus,
      requireClaudeAuth,
      startAuthentication,
      completeAuthentication,
      cancelAuthentication,
      disconnect,
    ],
  );

  return (
    <ClaudeAuthContext.Provider value={value}>
      {children}
      <ProvidersModal isOpen={isModalOpen} onClose={closeAuthModal} />
    </ClaudeAuthContext.Provider>
  );
}
