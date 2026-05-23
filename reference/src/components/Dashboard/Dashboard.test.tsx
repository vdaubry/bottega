import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import { useTaskContext, type TaskContextValue } from '../../contexts/TaskContext';
import { api } from '../../utils/api';
import { mockTypedResponse } from '../../test/typedResponse';

// Mock the TaskContext
vi.mock('../../contexts/TaskContext', () => ({
  useTaskContext: vi.fn(),
}));

// Dashboard subscribes its visible tasks to the WS for live badges; stub
// the hook so this component test doesn't need a WebSocketProvider.
vi.mock('../../hooks/useTasksLiveSubscriptions', () => ({
  useTasksLiveSubscriptions: vi.fn(),
}));

// Mock AppSettingsContext so the dashboard can read internalToolName
// without spinning up the full provider/network fetch.
vi.mock('../../contexts/AppSettingsContext', () => ({
  useAppSettings: () => ({
    isLoaded: true,
    internalToolName: 'Bottega',
    githubPrTrigger: 'bottega',
    refresh: vi.fn(),
  }),
}));

// Mock the API
vi.mock('../../utils/api', () => ({
  api: {
    tasks: {
      list: vi.fn(),
      listAll: vi.fn(),
    },
    conversations: {
      list: vi.fn(),
    },
  },
}));

// Mock lucide-react icons - return simple span elements
vi.mock('lucide-react', () => {
  const createIcon = (name: string) => {
    const Icon = (props: React.HTMLAttributes<HTMLSpanElement>) => (
      <span data-testid={`icon-${name.toLowerCase()}`} {...props} />
    );
    Icon.displayName = name;
    return Icon;
  };

  return {
    FolderPlus: createIcon('FolderPlus'),
    Settings: createIcon('Settings'),
    MessageSquare: createIcon('MessageSquare'),
    LayoutGrid: createIcon('LayoutGrid'),
    Clock: createIcon('Clock'),
    Folder: createIcon('Folder'),
    Pencil: createIcon('Pencil'),
    Trash2: createIcon('Trash2'),
    FileText: createIcon('FileText'),
    RefreshCw: createIcon('RefreshCw'),
    CheckCircle: createIcon('CheckCircle'),
    CheckCircle2: createIcon('CheckCircle2'),
    ExternalLink: createIcon('ExternalLink'),
    ChevronRight: createIcon('ChevronRight'),
    ChevronDown: createIcon('ChevronDown'),
    Circle: createIcon('Circle'),
    AlertCircle: createIcon('AlertCircle'),
    Play: createIcon('Play'),
    X: createIcon('X'),
  };
});

// Helper to render with Router
const renderWithRouter = (ui: React.ReactElement, { route = '/' } = {}) => {
  return render(
    <MemoryRouter initialEntries={[route]}>
      {ui}
    </MemoryRouter>
  );
};

describe('Dashboard Component', () => {
  const mockProjects = [
    { id: 'p1', name: 'Project Alpha', repo_folder_path: '/path/to/alpha' },
    { id: 'p2', name: 'Project Beta', repo_folder_path: '/path/to/beta' },
  ];

  const mockInProgressTasks = [
    { id: 't1', title: 'Task 1', status: 'in_progress', project_id: 'p1' },
    { id: 't2', title: 'Task 2', status: 'in_progress', project_id: 'p2' },
  ];

  const defaultContextValue = {
    projects: mockProjects,
    tasks: [],
    isLoadingProjects: false,
    isLoadingTasks: false,
    selectedProject: null,
    selectProject: vi.fn(),
    selectTask: vi.fn(),
    selectConversation: vi.fn(),
    deleteProject: vi.fn(),
    deleteTask: vi.fn(),
    updateTask: vi.fn(),
    createTask: vi.fn(),
    loadProjects: vi.fn(),
    navigateToBoard: vi.fn(),
    navigateToProjectEdit: vi.fn(),
    isTaskLive: vi.fn(() => false),
    liveTaskIds: new Set<number>(),
  } as unknown as TaskContextValue;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useTaskContext).mockReturnValue(defaultContextValue);

    // Default API mock responses
    vi.mocked(api.tasks.list).mockResolvedValue(mockTypedResponse({ tasks: [] } as never));
    vi.mocked(api.tasks.listAll).mockResolvedValue(mockTypedResponse({ tasks: mockInProgressTasks } as never));
  });

  describe('Rendering', () => {
    it('should render the dashboard header with title', () => {
      renderWithRouter(<Dashboard />);

      expect(screen.getByText('Bottega')).toBeInTheDocument();
      expect(screen.getByText('Task-driven workflow')).toBeInTheDocument();
    });

    it('should render the New Project button', () => {
      renderWithRouter(<Dashboard />);

      expect(screen.getByRole('button', { name: /new project/i })).toBeInTheDocument();
    });

    it('should render the Settings button', () => {
      renderWithRouter(<Dashboard />);

      expect(screen.getByTestId('icon-settings')).toBeInTheDocument();
    });

    it('should render project cards when projects exist', async () => {
      renderWithRouter(<Dashboard />);

      await waitFor(() => {
        expect(screen.getByText('Project Alpha')).toBeInTheDocument();
        expect(screen.getByText('Project Beta')).toBeInTheDocument();
      });
    });

    it('should render empty state when no projects exist', () => {
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        projects: [],
      });

      renderWithRouter(<Dashboard />);

      expect(screen.getByText('No Projects Yet')).toBeInTheDocument();
      expect(screen.getByText(/create your first project/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /create project/i })).toBeInTheDocument();
    });

    it('should render loading state when loading projects', () => {
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        projects: [],
        isLoadingProjects: true,
      });

      renderWithRouter(<Dashboard />);

      expect(screen.getByText('Loading Dashboard')).toBeInTheDocument();
      expect(screen.getByText('Fetching your projects...')).toBeInTheDocument();
    });
  });

  describe('View Toggle', () => {
    it('should render view toggle when projects exist', () => {
      renderWithRouter(<Dashboard />);

      expect(screen.getByRole('button', { name: /by project/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /in progress/i })).toBeInTheDocument();
    });

    it('should not render view toggle when no projects exist', () => {
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        projects: [],
      });

      renderWithRouter(<Dashboard />);

      expect(screen.queryByRole('button', { name: /by project/i })).not.toBeInTheDocument();
    });

    it('should switch to In Progress view when clicking the toggle', async () => {
      renderWithRouter(<Dashboard />);

      const inProgressButton = screen.getByRole('button', { name: /in progress/i });
      fireEvent.click(inProgressButton);

      // Verify API was called to fetch in-progress tasks
      await waitFor(() => {
        expect(api.tasks.listAll).toHaveBeenCalledWith('in_progress');
      });
    });

    it('should show in-progress count badge when tasks exist', async () => {
      renderWithRouter(<Dashboard />);

      await waitFor(() => {
        // The in-progress badge should show count of 2
        expect(screen.getByText('2')).toBeInTheDocument();
      });
    });
  });

  describe('User Interactions', () => {
    it('should call onShowSettings when Settings button is clicked', () => {
      const mockShowSettings = vi.fn();
      renderWithRouter(<Dashboard onShowSettings={mockShowSettings} />);

      const settingsIcon = screen.getByTestId('icon-settings');
      const settingsButton = settingsIcon.closest('button')!;
      fireEvent.click(settingsButton);

      expect(mockShowSettings).toHaveBeenCalledTimes(1);
    });

    it('should call onShowProjectForm when New Project button is clicked', () => {
      const mockShowProjectForm = vi.fn();
      renderWithRouter(<Dashboard onShowProjectForm={mockShowProjectForm} />);

      fireEvent.click(screen.getByRole('button', { name: /new project/i }));

      expect(mockShowProjectForm).toHaveBeenCalledTimes(1);
    });

    it('should call onShowProjectForm from empty state Create Project button', () => {
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        projects: [],
      });

      const mockShowProjectForm = vi.fn();
      renderWithRouter(<Dashboard onShowProjectForm={mockShowProjectForm} />);

      fireEvent.click(screen.getByRole('button', { name: /create project/i }));

      expect(mockShowProjectForm).toHaveBeenCalledTimes(1);
    });

    it('should navigate to board when a project card is clicked', async () => {
      renderWithRouter(<Dashboard />);

      await waitFor(() => {
        expect(screen.getByText('Project Alpha')).toBeInTheDocument();
      });

      // Click on the project card - it should navigate to the project's board view
      const projectCard = screen.getByTestId('project-card-grid-project-alpha');
      fireEvent.click(projectCard);

      // The navigation happens via react-router, which is tested by the router wrapper
      // We just verify the card is clickable and doesn't throw
      expect(projectCard).toBeInTheDocument();
    });
  });

  describe('API Integration', () => {
    it('should load in-progress tasks on mount', async () => {
      renderWithRouter(<Dashboard />);

      await waitFor(() => {
        expect(api.tasks.listAll).toHaveBeenCalledWith('in_progress');
      });
    });

    it('should reload in-progress tasks when switching to that view', async () => {
      renderWithRouter(<Dashboard />);

      // Wait for initial load
      await waitFor(() => {
        expect(api.tasks.listAll).toHaveBeenCalled();
      });

      // Clear the mock and switch views
      vi.mocked(api.tasks.listAll).mockClear();

      const inProgressButton = screen.getByRole('button', { name: /in progress/i });
      fireEvent.click(inProgressButton);

      await waitFor(() => {
        expect(api.tasks.listAll).toHaveBeenCalledWith('in_progress');
      });
    });

    it('should load tasks for all projects', async () => {
      renderWithRouter(<Dashboard />);

      await waitFor(() => {
        // Should fetch tasks for each project
        expect(api.tasks.list).toHaveBeenCalledWith('p1');
        expect(api.tasks.list).toHaveBeenCalledWith('p2');
      });
    });

    it('should handle API errors gracefully', async () => {
      vi.mocked(api.tasks.listAll).mockResolvedValue(
        mockTypedResponse({ error: 'Failed to load' } as never, { ok: false, status: 500 }),
      );

      // Should not throw
      renderWithRouter(<Dashboard />);

      await waitFor(() => {
        expect(api.tasks.listAll).toHaveBeenCalled();
      });

      // Dashboard should still render
      expect(screen.getByText('Bottega')).toBeInTheDocument();
    });
  });

  describe('Live Task Indicator', () => {
    it('should check if tasks are live when loading project data', async () => {
      const mockIsTaskLive = vi.fn((taskId) => taskId === 't1');
      vi.mocked(useTaskContext).mockReturnValue({
        ...defaultContextValue,
        isTaskLive: mockIsTaskLive,
      });

      vi.mocked(api.tasks.list).mockResolvedValue(
        mockTypedResponse({
          tasks: [{ id: 't1', title: 'Task 1', status: 'pending' }],
        } as never),
      );

      renderWithRouter(<Dashboard />);

      await waitFor(() => {
        expect(mockIsTaskLive).toHaveBeenCalled();
      });
    });
  });
});
