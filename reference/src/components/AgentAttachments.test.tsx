import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AgentAttachments from './AgentAttachments';

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Paperclip: () => <span data-testid="icon-paperclip" />,
  Trash2: () => <span data-testid="icon-trash" />,
  Upload: () => <span data-testid="icon-upload" />,
  File: () => <span data-testid="icon-file" />,
  Image: () => <span data-testid="icon-image" />,
  FileText: () => <span data-testid="icon-filetext" />,
  Code: () => <span data-testid="icon-code" />,
  AlertCircle: () => <span data-testid="icon-alert" />,
}));

// Mock UI components
vi.mock('./ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    className,
    variant,
    size,
    title,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    className?: string;
    variant?: string;
    size?: string;
    title?: string;
  }) => (
    <button
      onClick={onClick}
      disabled={disabled}
      className={className}
      title={title}
      data-variant={variant}
      data-size={size}
    >
      {children}
    </button>
  ),
}));

vi.mock('../lib/utils', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}));

describe('AgentAttachments', () => {
  const defaultProps = {
    attachments: [],
    isLoading: false,
    onUpload: vi.fn(),
    onDelete: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Rendering', () => {
    it('should render the component with header', () => {
      render(<AgentAttachments {...defaultProps} />);

      expect(screen.getByText('Attachments')).toBeInTheDocument();
    });

    it('should show description text', () => {
      render(<AgentAttachments {...defaultProps} />);

      expect(screen.getByText(/Files uploaded here will be automatically read by Claude/)).toBeInTheDocument();
    });

    it('should show paperclip icon in header', () => {
      render(<AgentAttachments {...defaultProps} />);

      // There are two paperclip icons - one in header, one in empty state
      const icons = screen.getAllByTestId('icon-paperclip');
      expect(icons.length).toBeGreaterThanOrEqual(1);
    });

    it('should show Add Attachment button', () => {
      render(<AgentAttachments {...defaultProps} />);

      expect(screen.getByText('Add Attachment')).toBeInTheDocument();
    });

    it('should show attachment helper text', () => {
      render(<AgentAttachments {...defaultProps} />);

      expect(
        screen.getByText(/Files are read by Claude at the start of each conversation/i)
      ).toBeInTheDocument();
    });
  });

  describe('Empty State', () => {
    it('should show empty state when no attachments', () => {
      render(<AgentAttachments {...defaultProps} attachments={[]} />);

      expect(screen.getByText('No attachments yet')).toBeInTheDocument();
    });

    it('should not show attachment count when empty', () => {
      render(<AgentAttachments {...defaultProps} attachments={[]} />);

      expect(screen.queryByText('(0)')).not.toBeInTheDocument();
    });
  });

  describe('Loading State', () => {
    it('should show loading skeleton when isLoading is true', () => {
      render(<AgentAttachments {...defaultProps} isLoading={true} />);

      // Loading state should show skeleton, not the normal content
      expect(screen.queryByText('Attachments')).not.toBeInTheDocument();
      expect(screen.queryByText('Add Attachment')).not.toBeInTheDocument();
    });
  });

  describe('Displaying Attachments', () => {
    const attachments = [
      { name: 'document.txt', size: 1024, mimeType: 'text/plain' },
      { name: 'image.png', size: 204800, mimeType: 'image/png' },
      { name: 'script.js', size: 5242880, mimeType: 'text/javascript' },
    ];

    it('should display all attachments', () => {
      render(<AgentAttachments {...defaultProps} attachments={attachments} />);

      expect(screen.getByText('document.txt')).toBeInTheDocument();
      expect(screen.getByText('image.png')).toBeInTheDocument();
      expect(screen.getByText('script.js')).toBeInTheDocument();
    });

    it('should show attachment count in header', () => {
      render(<AgentAttachments {...defaultProps} attachments={attachments} />);

      expect(screen.getByText('(3)')).toBeInTheDocument();
    });

    it('should display file sizes in correct format', () => {
      render(<AgentAttachments {...defaultProps} attachments={attachments} />);

      expect(screen.getByText('1.0 KB')).toBeInTheDocument(); // 1024 bytes
      expect(screen.getByText('200.0 KB')).toBeInTheDocument(); // 204800 bytes
      expect(screen.getByText('5.00 MB')).toBeInTheDocument(); // 5242880 bytes
    });

    it('should show correct icon for text files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'doc.txt', size: 100, mimeType: 'text/plain' }]} />);

      expect(screen.getByTestId('icon-filetext')).toBeInTheDocument();
    });

    it('should show correct icon for image files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'photo.png', size: 100, mimeType: 'image/png' }]} />);

      expect(screen.getByTestId('icon-image')).toBeInTheDocument();
    });

    it('should show correct icon for code files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'app.js', size: 100, mimeType: 'text/javascript' }]} />);

      expect(screen.getByTestId('icon-code')).toBeInTheDocument();
    });

    it('should show generic file icon for unknown types', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'data.xyz', size: 100, mimeType: 'application/octet-stream' }]} />);

      expect(screen.getByTestId('icon-file')).toBeInTheDocument();
    });

    it('should show delete button for each attachment', () => {
      render(<AgentAttachments {...defaultProps} attachments={attachments} />);

      const deleteButtons = screen.getAllByTitle('Delete attachment');
      expect(deleteButtons).toHaveLength(3);
    });
  });

  describe('Uploading Files', () => {
    it('should call onUpload when file is selected', async () => {
      const onUpload = vi.fn().mockResolvedValue({ success: true });
      render(<AgentAttachments {...defaultProps} onUpload={onUpload} />);

      const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      Object.defineProperty(input, 'files', { value: [file] });
      fireEvent.change(input);

      await waitFor(() => {
        expect(onUpload).toHaveBeenCalledWith(file);
      });
    });

    it('should show uploading state during upload', async () => {
      let resolveUpload: ((value: { success: boolean }) => void) | undefined;
      const uploadPromise = new Promise(resolve => { resolveUpload = resolve; });
      const onUpload = vi.fn().mockReturnValue(uploadPromise);

      render(<AgentAttachments {...defaultProps} onUpload={onUpload} />);

      const file = new File(['test content'], 'test.txt', { type: 'text/plain' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      Object.defineProperty(input, 'files', { value: [file] });
      fireEvent.change(input);

      await waitFor(() => {
        expect(screen.getByText('Uploading...')).toBeInTheDocument();
      });

      // Cleanup
      resolveUpload!({ success: true });
    });

    it('should upload large files without a client-side size limit', async () => {
      const onUpload = vi.fn().mockResolvedValue({ success: true });
      render(<AgentAttachments {...defaultProps} onUpload={onUpload} />);

      // A file larger than the old 5 MB limit should still be forwarded
      const largeContent = new Array(6 * 1024 * 1024).fill('a').join('');
      const file = new File([largeContent], 'large.txt', { type: 'text/plain' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      Object.defineProperty(input, 'files', { value: [file] });
      fireEvent.change(input);

      await waitFor(() => {
        expect(onUpload).toHaveBeenCalledWith(file);
      });
    });

    it('should show error from upload response', async () => {
      const onUpload = vi.fn().mockResolvedValue({ success: false, error: 'Invalid file type' });
      render(<AgentAttachments {...defaultProps} onUpload={onUpload} />);

      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      Object.defineProperty(input, 'files', { value: [file] });
      fireEvent.change(input);

      await waitFor(() => {
        expect(screen.getByText('Invalid file type')).toBeInTheDocument();
      });
    });

    it('should reset file input after upload', async () => {
      const onUpload = vi.fn().mockResolvedValue({ success: true });
      render(<AgentAttachments {...defaultProps} onUpload={onUpload} />);

      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      Object.defineProperty(input, 'files', { value: [file] });
      fireEvent.change(input);

      await waitFor(() => {
        expect(input.value).toBe('');
      });
    });

    it('should not call onUpload when no file is selected', () => {
      const onUpload = vi.fn();
      render(<AgentAttachments {...defaultProps} onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      Object.defineProperty(input, 'files', { value: [] });
      fireEvent.change(input);

      expect(onUpload).not.toHaveBeenCalled();
    });
  });

  describe('Deleting Files', () => {
    const attachments = [
      { name: 'file1.txt', size: 100, mimeType: 'text/plain' },
      { name: 'file2.txt', size: 200, mimeType: 'text/plain' },
    ];

    it('should call onDelete when delete button is clicked', async () => {
      const onDelete = vi.fn().mockResolvedValue({ success: true });
      render(<AgentAttachments {...defaultProps} attachments={attachments} onDelete={onDelete} />);

      const deleteButtons = screen.getAllByTitle('Delete attachment');
      fireEvent.click(deleteButtons[0]!);

      await waitFor(() => {
        expect(onDelete).toHaveBeenCalledWith('file1.txt');
      });
    });

    it('should show deleting state for specific file', async () => {
      let resolveDelete: ((value: { success: boolean }) => void) | undefined;
      const deletePromise = new Promise<{ success: boolean }>(resolve => { resolveDelete = resolve; });
      const onDelete = vi.fn().mockReturnValue(deletePromise);

      render(<AgentAttachments {...defaultProps} attachments={attachments} onDelete={onDelete} />);

      const deleteButtons = screen.getAllByTitle('Delete attachment');
      fireEvent.click(deleteButtons[0]!);

      // First delete button should be disabled
      await waitFor(() => {
        expect(deleteButtons[0]).toBeDisabled();
      });

      // Second delete button should still be enabled
      expect(deleteButtons[1]).not.toBeDisabled();

      // Cleanup
      resolveDelete!({ success: true });
    });

    it('should show error from delete response', async () => {
      const onDelete = vi.fn().mockResolvedValue({ success: false, error: 'Delete failed' });
      render(<AgentAttachments {...defaultProps} attachments={attachments} onDelete={onDelete} />);

      const deleteButtons = screen.getAllByTitle('Delete attachment');
      fireEvent.click(deleteButtons[0]!);

      await waitFor(() => {
        expect(screen.getByText('Delete failed')).toBeInTheDocument();
      });
    });
  });

  describe('Error Display', () => {
    it('should show error message', async () => {
      const onUpload = vi.fn().mockResolvedValue({ success: false, error: 'Something went wrong' });
      render(<AgentAttachments {...defaultProps} onUpload={onUpload} />);

      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      Object.defineProperty(input, 'files', { value: [file] });
      fireEvent.change(input);

      await waitFor(() => {
        expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      });
    });

    it('should allow dismissing error message', async () => {
      const onUpload = vi.fn().mockResolvedValue({ success: false, error: 'Error message' });
      render(<AgentAttachments {...defaultProps} onUpload={onUpload} />);

      const file = new File(['test'], 'test.txt', { type: 'text/plain' });
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      Object.defineProperty(input, 'files', { value: [file] });
      fireEvent.change(input);

      await waitFor(() => {
        expect(screen.getByText('Error message')).toBeInTheDocument();
      });

      // Click the dismiss button (×)
      const dismissButton = screen.getByText('×');
      fireEvent.click(dismissButton);

      await waitFor(() => {
        expect(screen.queryByText('Error message')).not.toBeInTheDocument();
      });
    });

    it('should clear error when starting new upload', async () => {
      const onUpload = vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'First error' })
        .mockResolvedValueOnce({ success: true });

      render(<AgentAttachments {...defaultProps} onUpload={onUpload} />);

      const input = document.querySelector('input[type="file"]') as HTMLInputElement;

      // First upload fails
      const file1 = new File(['test'], 'test1.txt', { type: 'text/plain' });
      Object.defineProperty(input, 'files', { value: [file1], configurable: true });
      fireEvent.change(input);

      await waitFor(() => {
        expect(screen.getByText('First error')).toBeInTheDocument();
      });

      // Second upload - error should be cleared when starting
      const file2 = new File(['test'], 'test2.txt', { type: 'text/plain' });
      Object.defineProperty(input, 'files', { value: [file2], configurable: true });
      fireEvent.change(input);

      // During the upload, the old error should be cleared
      await waitFor(() => {
        expect(screen.queryByText('First error')).not.toBeInTheDocument();
      });
    });
  });

  describe('File Type Icons', () => {
    it('should show image icon for jpg files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'photo.jpg', size: 100, mimeType: 'image/jpeg' }]} />);

      expect(screen.getByTestId('icon-image')).toBeInTheDocument();
    });

    it('should show image icon for gif files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'anim.gif', size: 100, mimeType: 'image/gif' }]} />);

      expect(screen.getByTestId('icon-image')).toBeInTheDocument();
    });

    it('should show filetext icon for md files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'readme.md', size: 100, mimeType: 'text/markdown' }]} />);

      expect(screen.getByTestId('icon-filetext')).toBeInTheDocument();
    });

    it('should show filetext icon for pdf files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'doc.pdf', size: 100, mimeType: 'application/pdf' }]} />);

      expect(screen.getByTestId('icon-filetext')).toBeInTheDocument();
    });

    it('should show code icon for ts files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'app.ts', size: 100, mimeType: 'text/typescript' }]} />);

      expect(screen.getByTestId('icon-code')).toBeInTheDocument();
    });

    it('should show code icon for py files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'script.py', size: 100, mimeType: 'text/x-python' }]} />);

      expect(screen.getByTestId('icon-code')).toBeInTheDocument();
    });

    it('should show code icon for css files', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'styles.css', size: 100, mimeType: 'text/css' }]} />);

      expect(screen.getByTestId('icon-code')).toBeInTheDocument();
    });
  });

  describe('File Size Formatting', () => {
    it('should format bytes correctly', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'tiny.txt', size: 500, mimeType: 'text/plain' }]} />);

      expect(screen.getByText('500 B')).toBeInTheDocument();
    });

    it('should format kilobytes correctly', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'small.txt', size: 2048, mimeType: 'text/plain' }]} />);

      expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    });

    it('should format megabytes correctly', () => {
      render(<AgentAttachments {...defaultProps} attachments={[{ name: 'large.txt', size: 3145728, mimeType: 'text/plain' }]} />);

      expect(screen.getByText('3.00 MB')).toBeInTheDocument();
    });
  });

  describe('className Prop', () => {
    it('should apply custom className', () => {
      const { container } = render(<AgentAttachments {...defaultProps} className="custom-class" />);

      expect(container.firstChild).toHaveClass('custom-class');
    });
  });
});
