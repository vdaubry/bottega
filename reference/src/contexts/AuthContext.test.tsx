import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../utils/api';
import { AuthProvider, useAuth } from './AuthContext';

vi.mock('../utils/api', () => ({
  api: {
    auth: {
      status: vi.fn(),
      user: vi.fn(),
      logout: vi.fn(),
    },
  },
}));

vi.mock('../utils/nativeBridge', () => ({
  loginUserToNative: vi.fn(),
  logoutUserFromNative: vi.fn(),
}));

// Only `ok`, `status` and `json()` are read by the provider.
const response = (status: number, json: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(json) }) as never;

function Probe() {
  const { user, isLoading, error, logout } = useAuth();
  return (
    <div>
      <button onClick={logout}>logout</button>
      <span data-testid="loading">{String(isLoading)}</span>
      <span data-testid="user">{user ? user.username : 'none'}</span>
      <span data-testid="error">{error ?? ''}</span>
    </div>
  );
}

const renderProvider = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );

const settled = () =>
  waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));

describe('AuthProvider boot-time session check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    localStorage.setItem('auth-token', 'ccui_test');
    vi.mocked(api.auth.status).mockResolvedValue(
      response(200, { needsSetup: false, isAuthenticated: false }),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('signs the user in on a 200', async () => {
    vi.mocked(api.auth.user).mockResolvedValue(
      response(200, { user: { id: 1, username: 'alice' } }),
    );
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('alice'));
    expect(localStorage.getItem('auth-token')).toBe('ccui_test');
  });

  it('drops the stored token on a 401 — the credential itself was rejected', async () => {
    vi.mocked(api.auth.user).mockResolvedValue(
      response(401, { error: 'Invalid or expired credentials.' }),
    );
    renderProvider();
    await settled();
    expect(localStorage.getItem('auth-token')).toBeNull();
    expect(screen.getByTestId('user').textContent).toBe('none');
  });

  it('keeps the stored token when the server answers 503 (database busy)', async () => {
    vi.mocked(api.auth.user).mockResolvedValue(
      response(503, { error: 'Database is busy, retry shortly.' }),
    );
    renderProvider();
    await settled();
    expect(localStorage.getItem('auth-token')).toBe('ccui_test');
    expect(screen.getByTestId('user').textContent).toBe('none');
    expect(screen.getByTestId('error').textContent).toMatch(/503/);
  });

  it('keeps the stored token when the server cannot be reached at all', async () => {
    vi.mocked(api.auth.user).mockRejectedValue(new TypeError('Failed to fetch'));
    renderProvider();
    await settled();
    expect(localStorage.getItem('auth-token')).toBe('ccui_test');
    expect(screen.getByTestId('error').textContent).not.toBe('');
  });
});

describe('AuthProvider logout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('auth-token', 'jwt_test');
    vi.mocked(api.auth.status).mockResolvedValue(
      response(200, { needsSetup: false, isAuthenticated: true }),
    );
    vi.mocked(api.auth.user).mockResolvedValue(
      response(200, { user: { id: 1, username: 'alice' } }),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('calls the endpoint while the token is still stored, then drops it', async () => {
    // authenticatedFetch reads the token from localStorage at call time, so
    // the endpoint must fire before it is removed or the server-side
    // revocation 401s.
    let tokenAtCall: string | null = 'unset';
    vi.mocked(api.auth.logout).mockImplementation(() => {
      tokenAtCall = localStorage.getItem('auth-token');
      return Promise.resolve(response(200, { success: true }));
    });
    renderProvider();
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('alice'));

    fireEvent.click(screen.getByText('logout'));

    expect(api.auth.logout).toHaveBeenCalledTimes(1);
    expect(tokenAtCall).toBe('jwt_test');
    expect(localStorage.getItem('auth-token')).toBeNull();
    expect(screen.getByTestId('user').textContent).toBe('none');
  });
});
