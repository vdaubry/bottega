import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => mockNavigate };
});

// The mock must return a STABLE value: the page's project-resolution effect
// depends on `projects`, and a fresh array per render would loop it forever.
const stableTaskContext = {
  projects: [{ id: 7, name: 'Test Project', repo_folder_path: '/tmp/repo' }],
  loadProjects: vi.fn(),
  isLoadingProjects: false,
};
vi.mock('../contexts/TaskContext', () => ({
  useTaskContext: () => stableTaskContext,
}));

vi.mock('../components/Breadcrumb', () => ({
  default: () => <nav data-testid="breadcrumb" />,
}));

vi.mock('../utils/api', () => ({
  api: {
    epics: {
      create: vi.fn(),
    },
  },
}));

import EpicNewPage from './EpicNewPage';
import { api } from '../utils/api';

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as never;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/7/epics/new']}>
      <Routes>
        <Route path="/projects/:projectId/epics/new" element={<EpicNewPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

function pickFile(name: string, content = '# Spec') {
  const input = document.querySelector('input[type="file"]')!;
  const file = new File([content], name, { type: 'text/markdown' });
  fireEvent.change(input, { target: { files: [file] } });
}

describe('EpicNewPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('disables Create epic until both a name and at least one file are set', async () => {
    renderPage();
    const explore = await screen.findByRole('button', { name: /create epic/i });
    expect(explore).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Epic name'), { target: { value: 'Company Quests' } });
    expect(explore).toBeDisabled();

    pickFile('spec.md');
    await waitFor(() => expect(explore).not.toBeDisabled());
  });

  it('rejects files with a disallowed extension', async () => {
    renderPage();
    await screen.findByRole('button', { name: /create epic/i });

    pickFile('spec.pdf');

    expect(await screen.findByText(/Unsupported file type/)).toBeInTheDocument();
    expect(screen.queryByText('spec.pdf', { exact: false })).toBeInTheDocument();
  });

  it('posts the FormData and navigates to the new epic page', async () => {
    vi.mocked(api.epics.create).mockResolvedValue(jsonResponse({ id: 42, project_id: 7 }, 201));
    renderPage();
    await screen.findByRole('button', { name: /create epic/i });

    fireEvent.change(screen.getByLabelText('Epic name'), { target: { value: 'Company Quests' } });
    pickFile('spec.md');
    fireEvent.click(screen.getByRole('button', { name: /create epic/i }));

    await waitFor(() => {
      expect(api.epics.create).toHaveBeenCalledTimes(1);
    });
    const [projectId, formData] = vi.mocked(api.epics.create).mock.calls[0]!;
    expect(projectId).toBe(7);
    expect((formData).get('name')).toBe('Company Quests');
    expect(((formData).getAll('files')[0] as File).name).toBe('spec.md');
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/projects/7/epics/42');
    });
  });

  it('surfaces the server validation error on a failed create', async () => {
    vi.mocked(api.epics.create).mockResolvedValue(
      jsonResponse({ error: 'Epic name is required' }, 400),
    );
    renderPage();
    await screen.findByRole('button', { name: /create epic/i });

    fireEvent.change(screen.getByLabelText('Epic name'), { target: { value: 'X' } });
    pickFile('spec.md');
    fireEvent.click(screen.getByRole('button', { name: /create epic/i }));

    expect(await screen.findByText('Epic name is required')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

});
