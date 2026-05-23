import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  type ReactNode,
} from 'react';
import { api } from '../utils/api';
import type {
  AppSettings,
  GetAppSettingsResponse,
} from '../../shared/api/settings';

// Defaults mirror the server side. Used while the initial fetch is in flight
// and as a fallback if the request fails (login screen still needs to render).
const DEFAULTS: AppSettings = {
  internal_tool_name: 'Bottega',
  github_pr_trigger: 'bottega',
};

export interface AppSettingsContextValue {
  isLoaded: boolean;
  internalToolName: string;
  githubPrTrigger: string;
  refresh: () => Promise<void>;
}

const AppSettingsContext = createContext<AppSettingsContextValue | null>(null);

export const useAppSettings = (): AppSettingsContextValue => {
  const ctx = useContext(AppSettingsContext);
  if (!ctx) {
    throw new Error('useAppSettings must be used within AppSettingsProvider');
  }
  return ctx;
};

export const AppSettingsProvider = ({ children }: { children: ReactNode }) => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULTS);
  const [isLoaded, setIsLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await api.appSettings.get();
      if (!res.ok) throw new Error(`Settings request failed: ${res.status}`);
      const data: GetAppSettingsResponse = await res.json();
      setSettings({ ...DEFAULTS, ...data });
    } catch (err) {
      // Keep defaults on failure — don't block the login screen.
      const message = err instanceof Error ? err.message : String(err);
      console.warn('Failed to load app settings, using defaults:', message);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Keep the browser tab title in sync with the configured tool name.
  useEffect(() => {
    if (settings.internal_tool_name) {
      document.title = settings.internal_tool_name;
    }
  }, [settings.internal_tool_name]);

  const value: AppSettingsContextValue = {
    isLoaded,
    internalToolName: settings.internal_tool_name,
    githubPrTrigger: settings.github_pr_trigger,
    refresh,
  };

  return (
    <AppSettingsContext.Provider value={value}>
      {children}
    </AppSettingsContext.Provider>
  );
};
