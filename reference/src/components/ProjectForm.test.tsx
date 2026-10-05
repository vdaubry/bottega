import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ProjectForm from './ProjectForm';

function fillRequired() {
  fireEvent.change(screen.getByLabelText('Project Name'), { target: { value: 'Shop' } });
  fireEvent.change(screen.getByLabelText('Repository Folder Path'), {
    target: { value: '/repo/shop' },
  });
}

describe('ProjectForm — sensitive areas', () => {
  it('submits the trimmed list alongside the name and path', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    render(<ProjectForm isOpen onClose={vi.fn()} onSubmit={onSubmit} />);

    fillRequired();
    fireEvent.change(screen.getByTestId('sensitive-areas-input'), {
      target: { value: '  - the orders tables\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        name: 'Shop',
        repoFolderPath: '/repo/shop',
        sensitiveAreas: '- the orders tables',
      }),
    );
  });

  it('omits the list when it is blank', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    render(<ProjectForm isOpen onClose={vi.fn()} onSubmit={onSubmit} />);

    fillRequired();
    fireEvent.change(screen.getByTestId('sensitive-areas-input'), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Project' }));

    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({ name: 'Shop', repoFolderPath: '/repo/shop' }),
    );
  });
});
