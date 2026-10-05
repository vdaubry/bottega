import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, configure, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { EpicEventHandlers } from '../hooks/useEpicEvents';
import type { EpicRow } from '@shared/types/db';

// The page's first render pulls the whole stage rail plus react-markdown's
// remark pipeline through a cold worker; under a full-suite run that alone
// runs past RTL's 1 s default for findBy*/waitFor, so give it room.
configure({ asyncUtilTimeout: 5000 });

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
  isTaskLive: () => false,
};
vi.mock('../contexts/TaskContext', () => ({
  useTaskContext: () => stableTaskContext,
}));

vi.mock('../components/Breadcrumb', () => ({
  default: () => <nav data-testid="breadcrumb" />,
}));

// The epic channel is captured, not connected: a test fires the handlers the
// page registered. `onSubscribed` is never fired here, so the mount fetch is
// the only one until a test triggers another.
const epicEvents: { handlers: EpicEventHandlers } = { handlers: {} };
vi.mock('../hooks/useEpicEvents', () => ({
  useEpicEvents: (_epicId: number | null, handlers: EpicEventHandlers) => {
    epicEvents.handlers = handlers;
  },
}));
vi.mock('../hooks/useTasksLiveSubscriptions', () => ({
  useTasksLiveSubscriptions: () => undefined,
}));

vi.mock('../components/epic/EpicImplementationSection', () => ({
  default: () => <div data-testid="implementation" />,
}));

vi.mock('../components/epic/EpicDeliverySection', () => ({
  default: () => <div data-testid="delivery" />,
}));

// A mermaid fence renders as the affordance; stubbing it (not MermaidDiagram)
// keeps "the fence became a diagram" meaningful and keeps `mermaid` out of
// the page test.
vi.mock('../components/epic/ExpandableMermaidDiagram', () => ({
  default: ({ source }: { source: string }) => <div data-testid="mermaid">{source}</div>,
}));

vi.mock('../utils/api', () => ({
  api: {
    epics: {
      get: vi.fn(),
      listArchitectureDocs: vi.fn(),
      getArchitectureDoc: vi.fn(),
      listAgentRuns: vi.fn(),
      listConversations: vi.fn(),
      listDocs: vi.fn(),
      getDoc: vi.fn(),
      listReviewDocs: vi.fn(),
      getReviewDoc: vi.fn(),
      listQaFiles: vi.fn(),
      getQaFile: vi.fn(),
      qaFileDownloadUrl: vi.fn(() => '/download-url'),
      listSpecFiles: vi.fn(),
      getSpecFile: vi.fn(),
      listTasks: vi.fn(),
    },
  },
}));

import EpicDetailPage from './EpicDetailPage';
import { api } from '../utils/api';

const EPIC = {
  id: 42,
  project_id: 7,
  name: 'Company Quests',
  slug: 'company-quests',
  status: 'active',
  architecture_complete: 0,
  specs_complete: 0,
  stories_complete: 0,
  review_complete: 0,
  qa_complete: 0,
  feature_branch: null,
  orchestration_active: 0,
  orchestration_blocked: 0,
  orchestration_blocked_reason: null,
} as EpicRow;

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  } as never;
}

function file(name: string) {
  return { name, size: 10, mimeType: 'text/markdown', modifiedAtMs: 1 };
}

function contentResponse(content: string) {
  return jsonResponse({ filename: 'x', content });
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/projects/7/epics/42']}>
      <Routes>
        <Route path="/projects/:projectId/epics/:epicId" element={<EpicDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  epicEvents.handlers = {};
  vi.mocked(api.epics.get).mockResolvedValue(jsonResponse(EPIC));
  vi.mocked(api.epics.listArchitectureDocs).mockResolvedValue(jsonResponse([]));
  vi.mocked(api.epics.listAgentRuns).mockResolvedValue(jsonResponse([]));
  vi.mocked(api.epics.listConversations).mockResolvedValue(jsonResponse([]));
  vi.mocked(api.epics.listDocs).mockResolvedValue(jsonResponse([]));
  vi.mocked(api.epics.listReviewDocs).mockResolvedValue(jsonResponse([]));
  vi.mocked(api.epics.listQaFiles).mockResolvedValue(jsonResponse([]));
  // No scenario book by default — the 404 the page treats as a normal state.
  vi.mocked(api.epics.getQaFile).mockResolvedValue(jsonResponse({ error: 'not found' }, 404));
  vi.mocked(api.epics.listSpecFiles).mockResolvedValue(jsonResponse([]));
  vi.mocked(api.epics.listTasks).mockResolvedValue(jsonResponse([]));
});

/**
 * Switch to the Artifacts tab and unfold one of its sections. The page must
 * already be past its loading state (await something first).
 */
function openArtifact(sectionTitle: RegExp) {
  fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));
  fireEvent.click(screen.getByRole('button', { name: sectionTitle }));
}

describe('EpicDetailPage — the two tabs', () => {
  it('opens on Main: the framing rail then the implementation section — no artifact fetched', async () => {
    vi.mocked(api.epics.listArchitectureDocs).mockResolvedValue(
      jsonResponse([file('architecture.md')]),
    );

    renderPage();

    // The framing rail's four rows, under their section title; implementation
    // (orchestration + tickets) is its own titled section below, and the QA
    // section (its two agents) closes the tab.
    expect(await screen.findByRole('heading', { name: 'Architecture' })).toBeInTheDocument();
    const rows = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(rows).toEqual([
      'Architecture',
      'Technical specification',
      'Stories',
      'Specification review',
      'QA scenarios',
      'QA execution',
      'QA fixes',
    ]);
    expect(screen.getByRole('heading', { name: 'Framing' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Implementation' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Delivery' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'QA' })).toBeInTheDocument();

    expect(screen.getByTestId('implementation')).toBeInTheDocument();
    expect(screen.getByTestId('delivery')).toBeInTheDocument();

    // The artifact browsers are on the other tab — no document bytes yet,
    // even though the file listing said one exists.
    expect(screen.queryByText(/No architecture document yet/)).not.toBeInTheDocument();
    expect(api.epics.getArchitectureDoc).not.toHaveBeenCalled();
  });

  it('lists the four artifact sections folded — expanding one is what fetches its file', async () => {
    vi.mocked(api.epics.listArchitectureDocs).mockResolvedValue(
      jsonResponse([file('architecture.md')]),
    );
    vi.mocked(api.epics.getArchitectureDoc).mockResolvedValue(contentResponse('# Topics'));

    renderPage();
    await screen.findByRole('heading', { name: 'Architecture' });
    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));

    for (const section of [
      /Functional specification/,
      /Architecture document/,
      /Technical specification.*1 file|Technical specification/,
      /Specification review report/,
    ]) {
      expect(screen.getByRole('button', { name: section })).toBeInTheDocument();
    }
    expect(api.epics.getArchitectureDoc).not.toHaveBeenCalled();
    expect(api.epics.getSpecFile).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Architecture document/ }));

    expect(await screen.findByRole('heading', { name: 'Topics' })).toBeInTheDocument();
    expect(api.epics.getArchitectureDoc).toHaveBeenCalledWith(42, 'architecture.md');
  });

  it('keeps the work sections off the artifacts tab', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Architecture' });
    fireEvent.click(screen.getByRole('button', { name: 'Artifacts' }));

    expect(screen.queryByTestId('implementation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('delivery')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Main' }));
    expect(screen.getByTestId('implementation')).toBeInTheDocument();
    expect(screen.getByTestId('delivery')).toBeInTheDocument();
  });
});

describe('EpicDetailPage — the artifact documents', () => {
  it('shows the architecture document once expanded, diagrams drawn', async () => {
    vi.mocked(api.epics.listArchitectureDocs).mockResolvedValue(
      jsonResponse([file('architecture.md')]),
    );
    vi.mocked(api.epics.getArchitectureDoc).mockResolvedValue(
      contentResponse('# Topics\n\n```mermaid\nflowchart LR\n  Importer --> Queue\n```'),
    );

    renderPage();
    await screen.findByRole('heading', { name: 'Architecture' });
    openArtifact(/Architecture document/);

    expect(await screen.findByRole('heading', { name: 'Topics' })).toBeInTheDocument();
    expect(api.epics.getArchitectureDoc).toHaveBeenCalledWith(42, 'architecture.md');
    expect(screen.getByTestId('mermaid')).toHaveTextContent('flowchart LR');
  });

  it('points at the architecture stage while nothing has been written', async () => {
    renderPage();
    await screen.findByRole('heading', { name: 'Architecture' });
    openArtifact(/Architecture document/);

    expect(await screen.findByText(/No architecture document yet/)).toBeInTheDocument();
    expect(api.epics.getArchitectureDoc).not.toHaveBeenCalled();
  });

  it('loads the specification documents through getDoc, not the architecture route', async () => {
    vi.mocked(api.epics.listDocs).mockResolvedValue(jsonResponse([file('00-master.md')]));
    vi.mocked(api.epics.getDoc).mockResolvedValue(contentResponse('# Master'));

    renderPage();
    await screen.findByRole('heading', { name: 'Architecture' });
    openArtifact(/Technical specification/);

    expect(await screen.findByRole('heading', { name: 'Master' })).toBeInTheDocument();
    expect(api.epics.getDoc).toHaveBeenCalledWith(42, '00-master.md');
    expect(api.epics.getArchitectureDoc).not.toHaveBeenCalled();
  });

  it('loads the review report through getReviewDoc, in its own section', async () => {
    vi.mocked(api.epics.listReviewDocs).mockResolvedValue(jsonResponse([file('review.md')]));
    vi.mocked(api.epics.getReviewDoc).mockResolvedValue(
      contentResponse('# Findings\n\n**Verdict: NOT READY**'),
    );

    renderPage();
    await screen.findByRole('heading', { name: 'Architecture' });
    openArtifact(/Specification review report/);

    expect(await screen.findByRole('heading', { name: 'Findings', level: 1 })).toBeInTheDocument();
    expect(api.epics.getReviewDoc).toHaveBeenCalledWith(42, 'review.md');
    expect(api.epics.getDoc).not.toHaveBeenCalled();
    expect(api.epics.getArchitectureDoc).not.toHaveBeenCalled();
  });

  it.each(['onEpicUpdated', 'onStreamingEnded'] as const)(
    'refetches on %s and shows the file the stage just wrote in the expanded section',
    async (event) => {
      renderPage();
      await screen.findByRole('heading', { name: 'Architecture' });
      openArtifact(/Architecture document/);
      await screen.findByText(/No architecture document yet/);
      expect(api.epics.listArchitectureDocs).toHaveBeenCalledTimes(1);

      vi.mocked(api.epics.listArchitectureDocs).mockResolvedValue(
        jsonResponse([file('architecture.md')]),
      );
      vi.mocked(api.epics.getArchitectureDoc).mockResolvedValue(contentResponse('# Topics'));

      act(() => {
        epicEvents.handlers[event]?.({ epicId: 42 } as never);
      });

      expect(await screen.findByRole('heading', { name: 'Topics' })).toBeInTheDocument();
      expect(api.epics.listArchitectureDocs).toHaveBeenCalledTimes(2);
      expect(api.epics.getArchitectureDoc).toHaveBeenCalledWith(42, 'architecture.md');
    },
  );
});
