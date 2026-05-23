import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import Settings from './Settings';

// Mock ThemeContext
vi.mock('../contexts/ThemeContext', () => ({
  useTheme: vi.fn(() => ({
    isDarkMode: false,
    toggleDarkMode: vi.fn(),
  })),
}));

// Mock AppSettingsContext (Settings component reads internalToolName/githubPrTrigger)
vi.mock('../contexts/AppSettingsContext', () => ({
  useAppSettings: vi.fn(() => ({
    isLoaded: true,
    internalToolName: 'Bottega',
    githubPrTrigger: 'bottega',
    refresh: vi.fn(),
  })),
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  X: () => <span data-testid="icon-x" />,
  Plus: () => <span data-testid="icon-plus" />,
  Settings: () => <span data-testid="icon-settings" />,
  Shield: () => <span data-testid="icon-shield" />,
  AlertTriangle: () => <span data-testid="icon-alert" />,
  Moon: () => <span data-testid="icon-moon" />,
  Sun: () => <span data-testid="icon-sun" />,
}));

import { useTheme } from '../contexts/ThemeContext';

describe('Settings Component', () => {
  const mockToggleDarkMode = vi.fn();

  // Mock localStorage
  const localStorageMock = (() => {
    let store: Record<string, string> = {};
    return {
      getItem: vi.fn((key: string) => store[key] || null),
      setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
      removeItem: vi.fn((key: string) => { delete store[key]; }),
      clear: vi.fn(() => { store = {}; }),
    };
  })();

  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();
    Object.defineProperty(window, 'localStorage', { value: localStorageMock });

    // Default mock for useTheme
    vi.mocked(useTheme).mockReturnValue({
      isDarkMode: false,
      toggleDarkMode: mockToggleDarkMode,
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should return null when not open', () => {
      const { container } = render(
        <Settings isOpen={false} onClose={vi.fn()} />
      );

      expect(container.firstChild).toBeNull();
    });

    it('should render modal when open', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText('Settings')).toBeInTheDocument();
    });

    it('should display Settings title with icon', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText('Settings')).toBeInTheDocument();
      expect(screen.getByTestId('icon-settings')).toBeInTheDocument();
    });
  });

  describe('Tab Navigation', () => {
    it('should render both tabs', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText('Tools')).toBeInTheDocument();
      expect(screen.getByText('Appearance')).toBeInTheDocument();
    });

    it('should show Tools tab by default', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText('Allowed Tools')).toBeInTheDocument();
    });

    it('should switch to Appearance tab when clicked', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      fireEvent.click(screen.getByText('Appearance'));

      expect(screen.getByText('Dark Mode')).toBeInTheDocument();
    });

    it('should respect initialTab prop', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} initialTab="appearance" />);

      expect(screen.getByText('Dark Mode')).toBeInTheDocument();
    });
  });

  describe('Tools Tab', () => {
    it('should display skip permissions checkbox', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText('Permission Settings')).toBeInTheDocument();
      expect(screen.getByText(/Skip permission prompts/)).toBeInTheDocument();
    });

    it('should toggle skip permissions when checkbox clicked', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).not.toBeChecked();

      fireEvent.click(checkbox);

      expect(checkbox).toBeChecked();
    });

    it('should display allowed tools section', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText('Allowed Tools')).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/e.g., "Bash\(git log:\*\)"/)).toBeInTheDocument();
    });

    it('should display disallowed tools section', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText('Disallowed Tools')).toBeInTheDocument();
    });

    it('should add tool to allowed list when entered', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      const input = screen.getByPlaceholderText(/e.g., "Bash\(git log:\*\)"/);
      fireEvent.change(input, { target: { value: 'Write' } });
      fireEvent.keyPress(input, { key: 'Enter', code: 'Enter' });

      expect(screen.getByText('Write')).toBeInTheDocument();
    });

    it('should add common tools when quick add button clicked', async () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      await waitFor(() => {
        // Find the quick add section
        const quickAddSection = screen.getByText('Quick add common tools:').parentElement!;
        const readButton = within(quickAddSection).getByRole('button', { name: 'Read' });
        fireEvent.click(readButton);
      });

      // The button should now be disabled (tool was added)
      await waitFor(() => {
        const quickAddSection = screen.getByText('Quick add common tools:').parentElement!;
        const readButton = within(quickAddSection).getByRole('button', { name: 'Read' });
        expect(readButton).toBeDisabled();
      });
    });

    it('should remove tool from allowed list when X clicked', async () => {
      // Pre-populate with a tool via localStorage
      const savedSettings = {
        allowedTools: ['ToolToRemove'],
        disallowedTools: [],
        skipPermissions: false,
      };
      localStorageMock.getItem.mockReturnValue(JSON.stringify(savedSettings));

      render(<Settings isOpen={true} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('ToolToRemove')).toBeInTheDocument();
      });

      // Find the remove button within the tool badge
      const toolBadge = screen.getByText('ToolToRemove').closest('div')!;
      const removeButton = within(toolBadge).getByRole('button');
      fireEvent.click(removeButton);

      await waitFor(() => {
        expect(screen.queryByText('ToolToRemove')).not.toBeInTheDocument();
      });
    });
  });

  describe('Appearance Tab', () => {
    it('should display dark mode toggle', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} initialTab="appearance" />);

      expect(screen.getByText('Dark Mode')).toBeInTheDocument();
      expect(screen.getByLabelText('Toggle dark mode')).toBeInTheDocument();
    });

    it('should call toggleDarkMode when toggle clicked', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} initialTab="appearance" />);

      const toggle = screen.getByLabelText('Toggle dark mode');
      fireEvent.click(toggle);

      expect(mockToggleDarkMode).toHaveBeenCalled();
    });

    it('should display project sorting option', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} initialTab="appearance" />);

      expect(screen.getByText('Project Sorting')).toBeInTheDocument();
    });

    it('should display code editor settings', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} initialTab="appearance" />);

      expect(screen.getByText('Code Editor')).toBeInTheDocument();
      expect(screen.getByText('Editor Theme')).toBeInTheDocument();
      expect(screen.getByText('Word Wrap')).toBeInTheDocument();
      expect(screen.getByText('Show Minimap')).toBeInTheDocument();
      expect(screen.getByText('Show Line Numbers')).toBeInTheDocument();
      expect(screen.getByText('Font Size')).toBeInTheDocument();
    });
  });

  describe('Modal Actions', () => {
    it('should call onClose when X button clicked', async () => {
      const onClose = vi.fn();
      render(<Settings isOpen={true} onClose={onClose} />);

      await waitFor(() => {
        // Find the close button in the header (first X icon)
        const xIcons = screen.getAllByTestId('icon-x');
        const closeButton = xIcons[0]!.closest('button')!;
        expect(closeButton).not.toBeNull();
        fireEvent.click(closeButton);
      });

      expect(onClose).toHaveBeenCalled();
    });

    it('should call onClose when Cancel button clicked', () => {
      const onClose = vi.fn();
      render(<Settings isOpen={true} onClose={onClose} />);

      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onClose).toHaveBeenCalled();
    });

    it('should save settings and show success message when Save clicked', async () => {
      const onClose = vi.fn();
      render(<Settings isOpen={true} onClose={onClose} />);

      fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

      await waitFor(() => {
        expect(screen.getByText('Settings saved successfully!')).toBeInTheDocument();
      });
    });
  });

  describe('Settings Persistence', () => {
    it('should load settings from localStorage on open', async () => {
      const savedSettings = {
        allowedTools: ['UniqueWrite', 'UniqueRead'],
        disallowedTools: ['Bash(rm:*)'],
        skipPermissions: true,
        projectSortOrder: 'date',
      };
      localStorageMock.getItem.mockReturnValue(JSON.stringify(savedSettings));

      render(<Settings isOpen={true} onClose={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByText('UniqueWrite')).toBeInTheDocument();
        expect(screen.getByText('UniqueRead')).toBeInTheDocument();
        expect(screen.getByRole('checkbox')).toBeChecked();
      });
    });

    it('should save settings to localStorage on save', async () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      // Save settings
      fireEvent.click(screen.getByRole('button', { name: 'Save Settings' }));

      await waitFor(() => {
        expect(localStorageMock.setItem).toHaveBeenCalledWith(
          'claude-settings',
          expect.any(String)
        );
      });
    });
  });

  describe('Code Editor Settings Persistence', () => {
    it('should save editor theme to localStorage', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} initialTab="appearance" />);

      const editorThemeToggle = screen.getByLabelText('Toggle editor theme');
      fireEvent.click(editorThemeToggle);

      expect(localStorageMock.setItem).toHaveBeenCalledWith('codeEditorTheme', expect.any(String));
    });

    it('should dispatch codeEditorSettingsChanged event on theme change', () => {
      const dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');

      render(<Settings isOpen={true} onClose={vi.fn()} initialTab="appearance" />);

      const editorThemeToggle = screen.getByLabelText('Toggle editor theme');
      fireEvent.click(editorThemeToggle);

      expect(dispatchEventSpy).toHaveBeenCalledWith(expect.any(Event));
    });
  });

  describe('Tool Pattern Help Section', () => {
    it('should display tool pattern examples', () => {
      render(<Settings isOpen={true} onClose={vi.fn()} />);

      expect(screen.getByText('Tool Pattern Examples:')).toBeInTheDocument();
      expect(screen.getByText(/"Bash\(git log:\*\)"/)).toBeInTheDocument();
    });
  });
});
