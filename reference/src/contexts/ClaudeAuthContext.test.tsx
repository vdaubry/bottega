import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../utils/api';
import { ClaudeAuthProvider, useClaudeAuth } from './ClaudeAuthContext';

// Build a minimal mocked TypedResponse for tests — only `ok` and `json()` are
// read by the consumer, so the rest of the Response surface is left off.
const mockResponse = <T,>(json: T) =>
  ({ ok: true, json: async () => json }) as unknown as Response & { json(): Promise<T> };

vi.mock('../utils/api', () => ({
  api: {
    claudeAuth: {
      status: vi.fn(),
      start: vi.fn(),
      complete: vi.fn(),
      cancel: vi.fn(),
      clear: vi.fn(),
    },
    // Picker modal also renders CodexAuthPanel, which hits /api/codex-auth/status
    // on mount. Stub it so the modal can render without exploding.
    codexAuth: {
      status: vi.fn(),
      start: vi.fn(),
      cancel: vi.fn(),
      paste: vi.fn(),
      clear: vi.fn(),
    },
  },
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => ({
    user: { id: 42, username: 'testuser' },
    isLoading: false,
  }),
}));

function Probe() {
  const { requireClaudeAuth } = useClaudeAuth();
  return (
    <button type="button" onClick={() => requireClaudeAuth()}>
      Require Claude
    </button>
  );
}

function DisconnectProbe() {
  const { authenticated, disconnect } = useClaudeAuth();
  return (
    <div>
      <span data-testid="auth-state">{authenticated ? 'connected' : 'disconnected'}</span>
      <button type="button" onClick={() => void disconnect()}>
        Disconnect Claude
      </button>
    </div>
  );
}

describe('ClaudeAuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.claudeAuth.status).mockResolvedValue(
      mockResponse({ authenticated: false, status: 'missing' } as never),
    );
    vi.mocked(api.claudeAuth.start).mockResolvedValue(
      mockResponse({
        loginSessionId: 'login-123',
        authUrl: 'https://claude.com/cai/oauth/authorize?state=abc',
        expiresAt: '2026-05-06T00:10:00.000Z',
      } as never),
    );
    vi.mocked(api.claudeAuth.complete).mockResolvedValue(
      mockResponse({
        authenticated: true,
        status: 'authenticated',
      } as never),
    );
    vi.mocked(api.claudeAuth.cancel).mockResolvedValue(
      mockResponse({ cancelled: true } as never),
    );
    vi.mocked(api.codexAuth.status).mockResolvedValue(
      mockResponse({ authenticated: false, status: 'missing' } as never),
    );
  });

  it('does not auto-open on mount, but opens via requireClaudeAuth when Claude is missing', async () => {
    render(
      <ClaudeAuthProvider>
        <Probe />
      </ClaudeAuthProvider>,
    );

    // First-login gating now lives in ConnectedProvidersProvider — the Claude
    // context no longer auto-pops its picker on mount.
    await waitFor(() => expect(api.claudeAuth.status).toHaveBeenCalled());
    expect(screen.queryByText('Connect a provider')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Require Claude/i }));

    expect(await screen.findByText('Connect a provider')).toBeInTheDocument();
    // Both panels render in the picker.
    expect(screen.getByTestId('claude-auth-panel')).toBeInTheDocument();
    expect(screen.getByTestId('codex-auth-panel')).toBeInTheDocument();
  });

  it('starts and completes the Claude auth flow from the picker', async () => {
    render(
      <ClaudeAuthProvider>
        <Probe />
      </ClaudeAuthProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Require Claude/i }));
    const connectButton = await screen.findByTestId('claude-auth-start');
    await waitFor(() => {
      expect(connectButton).not.toBeDisabled();
    });
    fireEvent.click(connectButton);

    expect(await screen.findByTestId('claude-auth-login-url')).toHaveAttribute(
      'href',
      'https://claude.com/cai/oauth/authorize?state=abc',
    );

    fireEvent.change(screen.getByTestId('claude-auth-code-input'), {
      target: { value: 'oauth-code' },
    });
    fireEvent.click(screen.getByTestId('claude-auth-code-submit'));

    await waitFor(() => {
      expect(api.claudeAuth.complete).toHaveBeenCalledWith('login-123', 'oauth-code');
    });
    await waitFor(() => {
      expect(screen.queryByText('Connect a provider')).not.toBeInTheDocument();
    });
  });

  it('disconnect() clears the token and flips authenticated to false', async () => {
    vi.mocked(api.claudeAuth.status).mockResolvedValue(
      mockResponse({ authenticated: true, status: 'authenticated' } as never),
    );
    vi.mocked(api.claudeAuth.clear).mockResolvedValue(
      mockResponse({ cleared: true } as never),
    );

    render(
      <ClaudeAuthProvider>
        <DisconnectProbe />
      </ClaudeAuthProvider>,
    );

    await waitFor(() =>
      expect(screen.getByTestId('auth-state')).toHaveTextContent('connected'),
    );

    fireEvent.click(screen.getByRole('button', { name: /Disconnect Claude/i }));

    await waitFor(() => expect(api.claudeAuth.clear).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('auth-state')).toHaveTextContent('disconnected'),
    );
  });

  it('reopens the picker when requireClaudeAuth is called after dismissal', async () => {
    render(
      <ClaudeAuthProvider>
        <Probe />
      </ClaudeAuthProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Require Claude/i }));
    expect(await screen.findByText('Connect a provider')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('providers-modal-close'));

    await waitFor(() => {
      expect(screen.queryByText('Connect a provider')).not.toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /Require Claude/i }));

    expect(screen.getByText('Connect a provider')).toBeInTheDocument();
  });
});
