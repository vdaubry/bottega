import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AgentPromptsTab from './AgentPromptsTab';

vi.mock('lucide-react', () => ({
  RotateCcw: () => <span data-testid="icon-reset" />,
  Save: () => <span data-testid="icon-save" />,
  AlertCircle: () => <span data-testid="icon-alert" />,
  Loader2: () => <span data-testid="icon-loader" />,
}));

vi.mock('./ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  } & React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button onClick={onClick} disabled={disabled} {...rest}>
      {children}
    </button>
  ),
}));

vi.mock('../utils/api', () => ({
  api: {
    settings: {
      listPrompts: vi.fn(),
      getPrompt: vi.fn(),
      savePrompt: vi.fn(),
      resetPrompt: vi.fn(),
    },
  },
}));

import { api } from '../utils/api';

function fakeRes<T>(status: number, body: T): Promise<Response & { json(): Promise<T> }> {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response & { json(): Promise<T> });
}

const samplePrompts = [
  { name: 'planification', label: 'Planification', isCustomized: false },
  { name: 'implementation', label: 'Implementation', isCustomized: true },
];

const sampleDetail = {
  name: 'planification',
  label: 'Planification',
  content: 'PLAN BODY {{taskDocPath}}',
  defaultContent: 'PLAN BODY {{taskDocPath}}',
  variables: ['taskDocPath', 'taskId'],
  isCustomized: false,
  mtime: null,
};

describe('AgentPromptsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.settings.listPrompts).mockReturnValue(fakeRes(200, samplePrompts));
    vi.mocked(api.settings.getPrompt).mockReturnValue(fakeRes(200, sampleDetail));
  });

  it('renders the prompt list and selects the first one', async () => {
    render(<AgentPromptsTab />);
    expect(await screen.findByText('Planification')).toBeInTheDocument();
    expect(screen.getByText('Implementation')).toBeInTheDocument();
    // The auto-select-first effect fires after the list renders, so the
    // getPrompt call may not have landed by the time `findByText` resolves.
    // Slow runners (CI, the deploy box) consistently lose this race.
    await waitFor(() =>
      expect(api.settings.getPrompt).toHaveBeenCalledWith('planification'),
    );
  });

  it('shows the editor with the prompt content', async () => {
    render(<AgentPromptsTab />);
    const editor = await screen.findByTestId<HTMLTextAreaElement>('prompt-editor');
    expect(editor.value).toContain('PLAN BODY');
  });

  it('shows available variables as pills', async () => {
    render(<AgentPromptsTab />);
    expect(await screen.findByText('{{taskDocPath}}')).toBeInTheDocument();
    expect(screen.getByText('{{taskId}}')).toBeInTheDocument();
  });

  it('Save button is disabled when content is unchanged', async () => {
    render(<AgentPromptsTab />);
    const saveBtn = await screen.findByTestId('prompt-save-button');
    expect(saveBtn).toBeDisabled();
  });

  it('Save button enables after editing and saves', async () => {
    vi.mocked(api.settings.savePrompt).mockReturnValue(fakeRes(200, { mtime: 12345, isCustomized: true }));

    render(<AgentPromptsTab />);
    const editor = await screen.findByTestId('prompt-editor');
    fireEvent.change(editor, { target: { value: 'NEW CONTENT {{taskId}}' } });

    const saveBtn = screen.getByTestId('prompt-save-button');
    expect(saveBtn).not.toBeDisabled();
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.settings.savePrompt).toHaveBeenCalledWith(
        'planification',
        'NEW CONTENT {{taskId}}',
        null
      );
    });
    await waitFor(() => expect(screen.getByText('Saved')).toBeInTheDocument());
  });

  it('shows server error for unknown variables', async () => {
    vi.mocked(api.settings.savePrompt).mockReturnValue(fakeRes(400, {
      error: 'Unknown template variables',
      unknownVariables: ['bogus'],
      allowedVariables: ['taskDocPath', 'taskId'],
    }));

    render(<AgentPromptsTab />);
    const editor = await screen.findByTestId('prompt-editor');
    fireEvent.change(editor, { target: { value: 'oops {{bogus}}' } });
    fireEvent.click(screen.getByTestId('prompt-save-button'));

    await waitFor(() => {
      expect(screen.getByText(/Unknown template variables: \{\{bogus\}\}/)).toBeInTheDocument();
    });
  });

  it('Reset button is disabled when prompt is not customized', async () => {
    render(<AgentPromptsTab />);
    const resetBtn = await screen.findByTestId('prompt-reset-button');
    expect(resetBtn).toBeDisabled();
  });

  it('Reset button is enabled and calls resetPrompt when customized', async () => {
    vi.mocked(api.settings.getPrompt).mockReturnValue(fakeRes(200, {
      ...sampleDetail,
      isCustomized: true,
      mtime: 9999,
      content: 'CUSTOM CONTENT',
    }));
    vi.mocked(api.settings.resetPrompt).mockReturnValue(fakeRes(204, null));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<AgentPromptsTab />);
    const resetBtn = await screen.findByTestId('prompt-reset-button');
    expect(resetBtn).not.toBeDisabled();
    fireEvent.click(resetBtn);

    await waitFor(() => {
      expect(api.settings.resetPrompt).toHaveBeenCalledWith('planification');
    });
  });

  it('shows a 409 conflict message when mtime mismatches', async () => {
    vi.mocked(api.settings.savePrompt).mockReturnValue(fakeRes(409, {
      error: 'Prompt was modified by another tab. Reload before saving.',
      currentMtime: 999,
    }));

    render(<AgentPromptsTab />);
    const editor = await screen.findByTestId('prompt-editor');
    fireEvent.change(editor, { target: { value: 'NEW' } });
    fireEvent.click(screen.getByTestId('prompt-save-button'));

    await waitFor(() => {
      expect(screen.getByText(/edited in another tab/)).toBeInTheDocument();
    });
  });
});
