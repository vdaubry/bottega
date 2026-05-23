import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ReviewRecording from './ReviewRecording';

// Mock the api module
vi.mock('../utils/api', () => ({
  api: {
    tasks: {
      checkReviewRecording: vi.fn()
    }
  }
}));

// Mock lucide-react icons
vi.mock('lucide-react', () => ({
  Video: () => <span data-testid="icon-video" />,
  ChevronDown: () => <span data-testid="icon-chevron-down" />,
  ChevronUp: () => <span data-testid="icon-chevron-up" />,
}));

import { api } from '../utils/api';

describe('ReviewRecording Component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Mock localStorage
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: vi.fn().mockReturnValue('test-token'),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
      writable: true,
    });
  });

  it('should render nothing when no recording exists', async () => {
    vi.mocked(api.tasks.checkReviewRecording).mockResolvedValue({ ok: false } as Response);

    const { container } = render(<ReviewRecording taskId={1} />);

    await waitFor(() => {
      expect(api.tasks.checkReviewRecording).toHaveBeenCalledWith(1);
    });

    expect(container.firstChild).toBeNull();
  });

  it('should render nothing when taskId is not provided', () => {
    // Component tolerates a missing taskId at runtime; cast to bypass the
    // strict prop type which marks taskId as required.
    const { container } = render(<ReviewRecording {...({} as { taskId: number })} />);
    expect(container.firstChild).toBeNull();
  });

  it('should render toggle button when recording exists', async () => {
    vi.mocked(api.tasks.checkReviewRecording).mockResolvedValue({ ok: true } as Response);

    render(<ReviewRecording taskId={1} />);

    await waitFor(() => {
      expect(screen.getByTestId('review-recording-toggle')).toBeInTheDocument();
    });

    expect(screen.getByText('Review Recording')).toBeInTheDocument();
  });

  it('should expand to show video player when toggle is clicked', async () => {
    vi.mocked(api.tasks.checkReviewRecording).mockResolvedValue({ ok: true } as Response);

    render(<ReviewRecording taskId={1} />);

    await waitFor(() => {
      expect(screen.getByTestId('review-recording-toggle')).toBeInTheDocument();
    });

    // Click to expand
    fireEvent.click(screen.getByTestId('review-recording-toggle'));

    expect(screen.getByTestId('review-recording-player')).toBeInTheDocument();
    const video = screen.getByTestId('review-recording-player').querySelector('video');
    expect(video).toBeInTheDocument();
    expect(video?.src).toContain('/api/tasks/1/review-recording');
    expect(video?.src).toContain('token=test-token');
  });

  it('should collapse video player when toggle is clicked again', async () => {
    vi.mocked(api.tasks.checkReviewRecording).mockResolvedValue({ ok: true } as Response);

    render(<ReviewRecording taskId={1} />);

    await waitFor(() => {
      expect(screen.getByTestId('review-recording-toggle')).toBeInTheDocument();
    });

    // Expand
    fireEvent.click(screen.getByTestId('review-recording-toggle'));
    expect(screen.getByTestId('review-recording-player')).toBeInTheDocument();

    // Collapse
    fireEvent.click(screen.getByTestId('review-recording-toggle'));
    expect(screen.queryByTestId('review-recording-player')).not.toBeInTheDocument();
  });

  it('should re-check when taskId changes', async () => {
    vi.mocked(api.tasks.checkReviewRecording)
      .mockResolvedValueOnce({ ok: true } as Response)
      .mockResolvedValueOnce({ ok: false } as Response);

    const { rerender } = render(<ReviewRecording taskId={1} />);

    await waitFor(() => {
      expect(api.tasks.checkReviewRecording).toHaveBeenCalledWith(1);
    });

    rerender(<ReviewRecording taskId={2} />);

    await waitFor(() => {
      expect(api.tasks.checkReviewRecording).toHaveBeenCalledWith(2);
    });
  });

  it('should handle API errors gracefully', async () => {
    vi.mocked(api.tasks.checkReviewRecording).mockRejectedValue(new Error('Network error'));

    const { container } = render(<ReviewRecording taskId={1} />);

    await waitFor(() => {
      expect(api.tasks.checkReviewRecording).toHaveBeenCalledWith(1);
    });

    expect(container.firstChild).toBeNull();
  });
});
