import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ApiKeyPanel from './ApiKeyPanel';
import { api } from '../utils/api';
import { mockTypedResponse } from '../test/typedResponse';

vi.mock('../utils/api', () => ({
  api: {
    account: {
      getApiKey: vi.fn(),
      generateApiKey: vi.fn(),
      revokeApiKey: vi.fn()
    }
  }
}));

const ok = <T,>(body: T) => mockTypedResponse(body);

describe('ApiKeyPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    });
  });

  it('renders Generate button when no key exists', async () => {
    vi.mocked(api.account.getApiKey).mockResolvedValue(ok({ hasKey: false, lastUsedAt: null }));
    render(<ApiKeyPanel />);
    expect(await screen.findByRole('button', { name: /generate api key/i })).toBeInTheDocument();
    expect(screen.getByText(/no key generated/i)).toBeInTheDocument();
  });

  it('shows the plaintext key once on generate, then never again', async () => {
    vi.mocked(api.account.getApiKey).mockResolvedValueOnce(ok({ hasKey: false, lastUsedAt: null }));
    vi.mocked(api.account.generateApiKey).mockResolvedValue(ok({ key: 'ccui_secret123' }));
    vi.mocked(api.account.getApiKey).mockResolvedValueOnce(ok({ hasKey: true, lastUsedAt: null }));

    render(<ApiKeyPanel />);

    const generateBtn = await screen.findByRole('button', { name: /generate api key/i });
    fireEvent.click(generateBtn);

    expect(await screen.findByTestId('api-key-plaintext')).toHaveTextContent('ccui_secret123');
    expect(api.account.generateApiKey).toHaveBeenCalledTimes(1);
    // Status now shows Active.
    await waitFor(() => expect(screen.getByText(/active/i)).toBeInTheDocument());
  });

  it('shows Active status with last-used timestamp when a key exists', async () => {
    vi.mocked(api.account.getApiKey).mockResolvedValue(
      ok({ hasKey: true, lastUsedAt: '2026-05-08T03:00:00Z' })
    );
    render(<ApiKeyPanel />);
    expect(await screen.findByText(/active/i)).toBeInTheDocument();
    expect(screen.getByText(/last used/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /revoke/i })).toBeInTheDocument();
  });

  it('asks for confirmation before regenerating', async () => {
    vi.mocked(api.account.getApiKey).mockResolvedValue(ok({ hasKey: true, lastUsedAt: null }));
    render(<ApiKeyPanel />);

    const regenerate = await screen.findByRole('button', { name: /regenerate/i });
    fireEvent.click(regenerate);

    expect(screen.getByText(/previous key will stop working/i)).toBeInTheDocument();
    expect(api.account.generateApiKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /yes, regenerate/i }));
    await waitFor(() => expect(api.account.generateApiKey).toHaveBeenCalled());
  });

  it('asks for confirmation before revoking', async () => {
    vi.mocked(api.account.getApiKey).mockResolvedValue(ok({ hasKey: true, lastUsedAt: null }));
    vi.mocked(api.account.revokeApiKey).mockResolvedValue(ok({ success: true }));
    render(<ApiKeyPanel />);

    fireEvent.click(await screen.findByRole('button', { name: /revoke/i }));
    expect(screen.getByText(/you'll need to generate a new one/i)).toBeInTheDocument();
    expect(api.account.revokeApiKey).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /yes, revoke/i }));
    await waitFor(() => expect(api.account.revokeApiKey).toHaveBeenCalled());
  });

  it('surfaces server errors', async () => {
    vi.mocked(api.account.getApiKey).mockResolvedValue(
      mockTypedResponse({ error: 'boom' } as never, { ok: false, status: 500 }),
    );
    render(<ApiKeyPanel />);
    expect(await screen.findByText(/boom/i)).toBeInTheDocument();
  });
});
