import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { api } from '../utils/api';
import { loginUserToNative, logoutUserFromNative } from '../utils/nativeBridge';
import type {
  AuthenticatedUser,
  GetCurrentUserResponse,
  UpdateProfileRequest,
} from '../../shared/api/auth';
import type { ApiError } from '../../shared/api/_common';

export interface AuthActionResult {
  success: boolean;
  error?: string;
  user?: AuthenticatedUser;
}

export interface AuthContextValue {
  user: AuthenticatedUser | null;
  token: string | null;
  login: (username: string, password: string) => Promise<AuthActionResult>;
  register: (username: string, password: string) => Promise<AuthActionResult>;
  logout: () => void;
  updateProfile: (updates: UpdateProfileRequest) => Promise<AuthActionResult>;
  isLoading: boolean;
  needsSetup: boolean;
  error: string | null;
}

const defaultContext: AuthContextValue = {
  user: null,
  token: null,
  login: async () => ({ success: false }),
  register: async () => ({ success: false }),
  logout: () => {},
  updateProfile: async () => ({ success: false }),
  isLoading: true,
  needsSetup: false,
  error: null,
};

const AuthContext = createContext<AuthContextValue>(defaultContext);

export const useAuth = (): AuthContextValue => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [token, setToken] = useState<string | null>(localStorage.getItem('auth-token'));
  const [isLoading, setIsLoading] = useState(true);
  const [needsSetup, setNeedsSetup] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Check for URL token authentication (for testing)
    const urlParams = new URLSearchParams(window.location.search);
    const urlToken = urlParams.get('token');
    if (urlToken) {
      localStorage.setItem('auth-token', urlToken);
      setToken(urlToken);
    }

    void checkAuthStatus();
  }, []);

  const checkAuthStatus = async () => {
    try {
      setIsLoading(true);
      setError(null);

      const statusResponse = await api.auth.status();
      const statusData = await statusResponse.json();

      if (statusData.needsSetup) {
        setNeedsSetup(true);
        setIsLoading(false);
        return;
      }

      // Read token from localStorage directly (not from state) to avoid race
      // condition when token is set from URL params and checkAuthStatus is
      // called immediately.
      const currentToken = localStorage.getItem('auth-token');

      if (currentToken) {
        try {
          const userResponse = await api.auth.user();

          if (userResponse.ok) {
            const userData: GetCurrentUserResponse = await userResponse.json();
            setUser(userData.user);
            setNeedsSetup(false);
            if (userData.user?.id) {
              loginUserToNative(userData.user.id);
            }
          } else if (userResponse.status === 401) {
            // Only a 401 says the credential itself was rejected. Anything
            // else — a 503 while the database is locked, any 5xx — is the
            // server's problem for the moment; dropping the token there would
            // log the user out over a hiccup that a reload fixes.
            localStorage.removeItem('auth-token');
            setToken(null);
            setUser(null);
          } else {
            setUser(null);
            setError(
              `Could not verify your session (HTTP ${userResponse.status}). Please reload.`,
            );
          }
        } catch (err) {
          console.error('Token verification failed:', err);
          setUser(null);
          setError('Could not reach the server to verify your session. Please reload.');
        }
      }
    } catch (err) {
      console.error('[AuthContext] Auth status check failed:', err);
      setError('Failed to check authentication status');
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (username: string, password: string): Promise<AuthActionResult> => {
    try {
      setError(null);
      const response = await api.auth.login(username, password);

      const data = await response.json();

      if (response.ok) {
        const success = data;
        setToken(success.token);
        setUser(success.user);
        localStorage.setItem('auth-token', success.token);
        if (success.user?.id) {
          loginUserToNative(success.user.id);
        }
        return { success: true };
      } else {
        const errBody = data as unknown as ApiError;
        setError(errBody.error || 'Login failed');
        return { success: false, error: errBody.error || 'Login failed' };
      }
    } catch (err) {
      console.error('Login error:', err);
      const errorMessage = 'Network error. Please try again.';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  const register = async (username: string, password: string): Promise<AuthActionResult> => {
    try {
      setError(null);
      const response = await api.auth.register(username, password);

      const data = await response.json();

      if (response.ok) {
        const success = data;
        setToken(success.token);
        setUser(success.user);
        setNeedsSetup(false);
        localStorage.setItem('auth-token', success.token);
        if (success.user?.id) {
          loginUserToNative(success.user.id);
        }
        return { success: true };
      } else {
        const errBody = data as unknown as ApiError;
        setError(errBody.error || 'Registration failed');
        return { success: false, error: errBody.error || 'Registration failed' };
      }
    } catch (err) {
      console.error('Registration error:', err);
      const errorMessage = 'Network error. Please try again.';
      setError(errorMessage);
      return { success: false, error: errorMessage };
    }
  };

  const updateProfile = async (updates: UpdateProfileRequest): Promise<AuthActionResult> => {
    try {
      setError(null);
      const response = await api.auth.updateProfile(updates);
      const data = await response.json();
      if (response.ok) {
        setUser(data.user);
        return { success: true, user: data.user };
      }
      const errBody = data as unknown as ApiError;
      const message = errBody.error || 'Failed to update profile';
      setError(message);
      return { success: false, error: message };
    } catch (err) {
      console.error('Update profile error:', err);
      const message = 'Network error. Please try again.';
      setError(message);
      return { success: false, error: message };
    }
  };

  const logout = () => {
    // Fire the endpoint BEFORE dropping the stored token: authenticatedFetch
    // reads it from localStorage when called, and the server-side
    // token_version bump is what actually revokes the JWT.
    if (token) {
      api.auth.logout().catch((err) => {
        console.error('Logout endpoint error:', err);
      });
    }

    setToken(null);
    setUser(null);
    localStorage.removeItem('auth-token');

    logoutUserFromNative();
  };

  const value: AuthContextValue = {
    user,
    token,
    login,
    register,
    logout,
    updateProfile,
    isLoading,
    needsSetup,
    error,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
