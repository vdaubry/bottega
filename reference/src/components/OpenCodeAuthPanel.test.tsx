import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../utils/api', () => ({
  api: {
    openCodeAuth: {
      status: vi.fn(),
      setKey: vi.fn(),
      clear: vi.fn(),
    },
  },
}));

vi.mock('lucide-react', () => ({
  Loader2: () => <span data-testid="icon-loader" />,
  AlertCircle: () => <span data-testid="icon-alert" />,
  CheckCircle2: () => <span data-testid="icon-check" />,
  Trash2: () => <span data-testid="icon-trash" />,
  ExternalLink: () => <span data-testid="icon-external" />,
}));

import OpenCodeAuthPanel from './OpenCodeAuthPanel';
import { api } from '../utils/api';

function mockOkJson<T>(body: T): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function mockErrJson<T>(body: T, status = 400): Response {
  return {
    ok: false,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('OpenCodeAuthPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders "Not connected" when no key is set', async () => {
    vi.mocked(api.openCodeAuth.status).mockResolvedValueOnce(
      mockOkJson({
        authenticated: false,
        status: 'missing',
        authPath: '/x/auth.json',
        tokenFingerprint: null,
        reason: 'not provisioned',
      }) as never,
    );
    render(<OpenCodeAuthPanel />);
    await waitFor(() => expect(screen.getByText(/Not connected/)).toBeInTheDocument());
    expect(screen.queryByText(/Disconnect/)).not.toBeInTheDocument();
  });

  it('renders Connected + fingerprint when authenticated', async () => {
    vi.mocked(api.openCodeAuth.status).mockResolvedValueOnce(
      mockOkJson({
        authenticated: true,
        status: 'authenticated',
        authPath: '/x/auth.json',
        tokenFingerprint: 'xyz123',
        reason: null,
      }) as never,
    );
    render(<OpenCodeAuthPanel />);
    await waitFor(() => expect(screen.getByText(/Connected/)).toBeInTheDocument());
    expect(screen.getByText(/xyz123/)).toBeInTheDocument();
    expect(screen.getByTestId('opencode-auth-clear')).toBeInTheDocument();
  });

  it('disables Save until the key reaches 20 characters', async () => {
    vi.mocked(api.openCodeAuth.status).mockResolvedValueOnce(
      mockOkJson({
        authenticated: false,
        status: 'missing',
        authPath: '/x/auth.json',
        tokenFingerprint: null,
        reason: null,
      }) as never,
    );
    render(<OpenCodeAuthPanel />);
    await waitFor(() => expect(screen.getByText(/Not connected/)).toBeInTheDocument());

    const input = screen.getByTestId('opencode-auth-key-input');
    const save = screen.getByTestId('opencode-auth-save');
    expect(save).toBeDisabled();

    fireEvent.change(input, { target: { value: 'short' } });
    expect(save).toBeDisabled();

    fireEvent.change(input, { target: { value: 'x'.repeat(25) } });
    expect(save).not.toBeDisabled();
  });

  it('saves a key, refreshes, and shows success message', async () => {
    vi.mocked(api.openCodeAuth.status)
      .mockResolvedValueOnce(
        mockOkJson({
          authenticated: false,
          status: 'missing',
          authPath: '/x/auth.json',
          tokenFingerprint: null,
          reason: null,
        }) as never,
      )
      .mockResolvedValueOnce(
        mockOkJson({
          authenticated: true,
          status: 'authenticated',
          authPath: '/x/auth.json',
          tokenFingerprint: 'last66',
          reason: null,
        }) as never,
      );
    vi.mocked(api.openCodeAuth.setKey).mockResolvedValueOnce(
      mockOkJson({
        authenticated: true,
        status: 'authenticated',
        tokenFingerprint: 'last66',
      }) as never,
    );
    render(<OpenCodeAuthPanel />);
    await waitFor(() => expect(screen.getByText(/Not connected/)).toBeInTheDocument());

    fireEvent.change(screen.getByTestId('opencode-auth-key-input'), {
      target: { value: 'sk-zen-' + 'x'.repeat(40) },
    });
    fireEvent.click(screen.getByTestId('opencode-auth-save'));

    await waitFor(() => expect(api.openCodeAuth.setKey).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/OpenCode key saved/)).toBeInTheDocument());
    expect(screen.getByText(/Connected/)).toBeInTheDocument();
  });

  it('surfaces backend error message on save failure', async () => {
    vi.mocked(api.openCodeAuth.status).mockResolvedValueOnce(
      mockOkJson({
        authenticated: false,
        status: 'missing',
        authPath: '/x/auth.json',
        tokenFingerprint: null,
        reason: null,
      }) as never,
    );
    vi.mocked(api.openCodeAuth.setKey).mockResolvedValueOnce(
      mockErrJson({ error: 'Invalid key', code: 'OPENCODE_AUTH_STORAGE_ERROR' }, 400) as never,
    );
    render(<OpenCodeAuthPanel />);
    await waitFor(() => expect(screen.getByText(/Not connected/)).toBeInTheDocument());
    fireEvent.change(screen.getByTestId('opencode-auth-key-input'), {
      target: { value: 'x'.repeat(40) },
    });
    fireEvent.click(screen.getByTestId('opencode-auth-save'));
    await waitFor(() => expect(screen.getByText(/Invalid key/)).toBeInTheDocument());
  });

  it('Disconnect triggers api.openCodeAuth.clear and shows removal message', async () => {
    vi.mocked(api.openCodeAuth.status)
      .mockResolvedValueOnce(
        mockOkJson({
          authenticated: true,
          status: 'authenticated',
          authPath: '/x/auth.json',
          tokenFingerprint: 'abc123',
          reason: null,
        }) as never,
      )
      .mockResolvedValueOnce(
        mockOkJson({
          authenticated: false,
          status: 'missing',
          authPath: '/x/auth.json',
          tokenFingerprint: null,
          reason: 'cleared',
        }) as never,
      );
    vi.mocked(api.openCodeAuth.clear).mockResolvedValueOnce(
      mockOkJson({ cleared: true }) as never,
    );
    render(<OpenCodeAuthPanel />);
    await waitFor(() => expect(screen.getByText(/Connected/)).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('opencode-auth-clear'));
    await waitFor(() => expect(api.openCodeAuth.clear).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/OpenCode key removed/)).toBeInTheDocument());
  });
});
