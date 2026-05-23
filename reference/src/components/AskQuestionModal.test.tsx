import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AskQuestionModal from './AskQuestionModal';

vi.mock('./MicButton', () => ({
  MicButton: () => <button data-testid="mic-button" type="button">Mic</button>,
}));

vi.mock('lucide-react', () => ({
  X: () => <span data-testid="icon-x" />,
  MessageCircleQuestion: () => <span data-testid="icon-question" />,
}));

describe('AskQuestionModal', () => {
  const defaultProps = {
    isOpen: true,
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    projectName: 'Test Project',
    isSubmitting: false,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when closed', () => {
    const { container } = render(<AskQuestionModal {...defaultProps} isOpen={false} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders title, fields, and project name when open', () => {
    render(<AskQuestionModal {...defaultProps} />);
    expect(screen.getByText('Ask a Question')).toBeInTheDocument();
    expect(screen.getByText('Test Project')).toBeInTheDocument();
    expect(screen.getByLabelText('Task Title')).toBeInTheDocument();
    expect(screen.getByLabelText('Question')).toBeInTheDocument();
  });

  it('disables submit when either field is empty', () => {
    render(<AskQuestionModal {...defaultProps} />);
    const submit = screen.getByRole('button', { name: 'Ask Question' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Task Title'), { target: { value: 'T' } });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Q' } });
    expect(submit).not.toBeDisabled();
  });

  it('calls onSubmit with trimmed title and question', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: true });
    render(<AskQuestionModal {...defaultProps} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Task Title'), { target: { value: '  Architecture  ' } });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: '  What rails version?  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask Question' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith({
        title: 'Architecture',
        question: 'What rails version?',
        // Picker defaults to Claude + the first Claude model (Sonnet).
        provider: 'anthropic',
        model: 'sonnet',
      });
    });
  });

  it('shows error when onSubmit returns failure', async () => {
    const onSubmit = vi.fn().mockResolvedValue({ success: false, error: 'Network error' });
    render(<AskQuestionModal {...defaultProps} onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('Task Title'), { target: { value: 'T' } });
    fireEvent.change(screen.getByLabelText('Question'), { target: { value: 'Q' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask Question' }));

    await waitFor(() => {
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('shows loading state when isSubmitting', () => {
    render(<AskQuestionModal {...defaultProps} isSubmitting={true} />);
    expect(screen.getByText('Asking...')).toBeInTheDocument();
  });

  it('calls onClose when Cancel clicked', () => {
    const onClose = vi.fn();
    render(<AskQuestionModal {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });
});
