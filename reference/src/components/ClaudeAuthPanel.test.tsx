import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { api } from '../utils/api';
import { ClaudeAuthProvider } from '../contexts/ClaudeAuthContext';
import ClaudeAuthPanel from './ClaudeAuthPanel';

// Only `ok` and `json()` are read by the consumer, so the rest of the Response
// surface is left off.
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
  },
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 42, username: 'testuser' },
    isLoading: false,
  }),
}));

function renderPanel() {
  return render(
    <ClaudeAuthProvider>
      <ClaudeAuthPanel />
    </ClaudeAuthProvider>,
  );
}

describe('ClaudeAuthPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.claudeAuth.clear).mockResolvedValue(
      mockResponse({ cleared: true } as never),
    );
  });

  it('shows a Disconnect button when Claude is connected', async () => {
    vi.mocked(api.claudeAuth.status).mockResolvedValue(
      mockResponse({ authenticated: true, status: 'authenticated' } as never),
    );

    renderPanel();

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByTestId('claude-auth-clear')).toBeInTheDocument();
  });

  it('does not show a Disconnect button when Claude is not connected', async () => {
    vi.mocked(api.claudeAuth.status).mockResolvedValue(
      mockResponse({ authenticated: false, status: 'missing' } as never),
    );

    renderPanel();

    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByTestId('claude-auth-clear')).not.toBeInTheDocument();
    // The connect affordance shows instead.
    expect(screen.getByTestId('claude-auth-start')).toBeInTheDocument();
  });

  it('clears the token and collapses back to Not connected when disconnected', async () => {
    vi.mocked(api.claudeAuth.status).mockResolvedValue(
      mockResponse({ authenticated: true, status: 'authenticated' } as never),
    );

    renderPanel();

    fireEvent.click(await screen.findByTestId('claude-auth-clear'));

    await waitFor(() => expect(api.claudeAuth.clear).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByTestId('claude-auth-clear')).not.toBeInTheDocument();
    expect(screen.getByText('Claude credentials removed.')).toBeInTheDocument();
  });
});
