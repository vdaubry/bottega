// Tracks which model providers the current user has connected, and blocks the
// app behind a non-dismissable ProvidersModal until at least one is connected.
//
// This is the first-login gate: a user can't use Bottega without credentials
// for ≥1 provider (agents/chats would have no backend to run on). Connecting a
// provider also seeds their per-agent model settings server-side (see the
// /api/*-auth connect routes), so once `hasAny` flips true the user is fully
// set up.
//
// Must be rendered INSIDE ClaudeAuthProvider — the modal's ClaudeAuthPanel
// consumes useClaudeAuth().

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
import type { Provider } from '../../shared/providers/types';

export interface ConnectedProvidersContextValue {
  connected: Provider[];
  hasAny: boolean;
  loading: boolean;
  refresh: () => Promise<void>;
}

const defaultValue: ConnectedProvidersContextValue = {
  connected: [],
  hasAny: false,
  loading: true,
  refresh: async () => {},
};

const ConnectedProvidersContext = createContext<ConnectedProvidersContextValue>(defaultValue);

export function useConnectedProviders(): ConnectedProvidersContextValue {
  return useContext(ConnectedProvidersContext);
}

export function ConnectedProvidersProvider({ children }: { children: ReactNode }) {
  const { user, isLoading: isAuthLoading } = useAuth();
  const hasAuthUser = !!user;
  const authUserKey = user?.id ?? user?.username ?? null;
  const [connected, setConnected] = useState<Provider[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (isAuthLoading || !hasAuthUser) return;
    try {
      const res = await api.userAgentModelSettings.connectedProviders();
      if (res.ok) {
        const body = await res.json();
        setConnected(body.connected);
      }
    } catch {
      // Keep the previous value on failure; non-fatal.
    } finally {
      setLoading(false);
    }
  }, [hasAuthUser, isAuthLoading]);

  useEffect(() => {
    if (!isAuthLoading && hasAuthUser) void refresh();
    // Re-fetch when the authenticated user changes.
  }, [authUserKey, hasAuthUser, isAuthLoading, refresh]);

  const hasAny = connected.length > 0;
  const showBlockingModal = hasAuthUser && !loading && !hasAny;

  // While blocked, poll so the modal dismisses as soon as the user connects a
  // provider in any of the three panels (each panel owns its own success
  // state; polling keeps this gate decoupled from them). Self-terminating once
  // a provider connects.
  useEffect(() => {
    if (!showBlockingModal) return;
    const id = setInterval(() => {
      void refresh();
    }, 2500);
    return () => clearInterval(id);
  }, [showBlockingModal, refresh]);

  const value = useMemo<ConnectedProvidersContextValue>(
    () => ({ connected, hasAny, loading, refresh }),
    [connected, hasAny, loading, refresh],
  );

  return (
    <ConnectedProvidersContext.Provider value={value}>
      {children}
      {showBlockingModal && (
        <ProvidersModal isOpen dismissable={false} onClose={() => {}} />
      )}
    </ConnectedProvidersContext.Provider>
  );
}
