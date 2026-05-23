import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AskUserQuestionPanel from './AskUserQuestionPanel';
import type { Question } from './answerUtils';

vi.mock('../ui/badge', () => ({
  Badge: ({
    children,
    className,
  }: {
    children?: React.ReactNode;
    className?: string;
  }) => (
    <span data-testid="badge" className={className}>
      {children}
    </span>
  ),
}));

const sampleQuestions: Question[] = [
  {
    question: 'Which database should we use?',
    header: 'Database',
    options: [
      {
        label: 'PostgreSQL (Recommended)',
        description: 'Already used in codebase',
      },
      { label: 'MongoDB', description: 'Better for document storage' },
    ],
    multiSelect: false,
  },
  {
    question: 'Which auth method?',
    header: 'Auth',
    options: [
      { label: 'JWT', description: 'Stateless tokens' },
      { label: 'Session', description: 'Server-side sessions' },
    ],
    multiSelect: false,
  },
];

describe('AskUserQuestionPanel', () => {
  it('renders first question step', () => {
    render(
      <AskUserQuestionPanel
        questions={sampleQuestions}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByText('Which database should we use?')).toBeTruthy();
    expect(screen.getByText('PostgreSQL (Recommended)')).toBeTruthy();
    expect(screen.getByText('MongoDB')).toBeTruthy();
    expect(screen.getByText('Step 1 of 2')).toBeTruthy();
  });

  it('Next button is disabled until an option is selected', () => {
    render(
      <AskUserQuestionPanel
        questions={sampleQuestions}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );

    const nextBtn = screen.getByText('Next') as unknown as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
  });

  it('enables Next after selecting an option and advances to next question', () => {
    render(
      <AskUserQuestionPanel
        questions={sampleQuestions}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('PostgreSQL (Recommended)'));

    const nextBtn = screen.getByText('Next') as unknown as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(false);

    fireEvent.click(nextBtn);

    expect(screen.getByText('Which auth method?')).toBeTruthy();
    expect(screen.getByText('Step 2 of 2')).toBeTruthy();
  });

  it('Previous button goes back to previous step', () => {
    render(
      <AskUserQuestionPanel
        questions={sampleQuestions}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('PostgreSQL (Recommended)'));
    fireEvent.click(screen.getByText('Next'));

    fireEvent.click(screen.getByText('Previous'));

    expect(screen.getByText('Which database should we use?')).toBeTruthy();
  });

  it('shows Review button on last question step', () => {
    render(
      <AskUserQuestionPanel
        questions={sampleQuestions}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('PostgreSQL (Recommended)'));
    fireEvent.click(screen.getByText('Next'));

    expect(screen.getByText('Review')).toBeTruthy();
  });

  it('shows summary step and submits formatted answers', () => {
    const onSubmit = vi.fn();
    render(
      <AskUserQuestionPanel
        questions={sampleQuestions}
        onSubmit={onSubmit}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('PostgreSQL (Recommended)'));
    fireEvent.click(screen.getByText('Next'));

    fireEvent.click(screen.getByText('JWT'));
    fireEvent.click(screen.getByText('Review'));

    expect(screen.getByText('Review Your Answers')).toBeTruthy();
    expect(screen.getByText('Submit')).toBeTruthy();

    fireEvent.click(screen.getByText('Submit'));
    expect(onSubmit).toHaveBeenCalledWith(
      '**Database:** PostgreSQL (Recommended)\n**Auth:** JWT',
      {
        'Which database should we use?': 'PostgreSQL (Recommended)',
        'Which auth method?': 'JWT',
      },
    );
  });

  it('calls onDismiss when dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <AskUserQuestionPanel
        questions={sampleQuestions}
        onSubmit={() => {}}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('Edit Answers goes back to first step from summary', () => {
    render(
      <AskUserQuestionPanel
        questions={sampleQuestions}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('PostgreSQL (Recommended)'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('JWT'));
    fireEvent.click(screen.getByText('Review'));

    fireEvent.click(screen.getByText('Edit Answers'));

    expect(screen.getByText('Which database should we use?')).toBeTruthy();
  });

  it('skips step indicator for single question', () => {
    const singleQuestion = [sampleQuestions[0]!];
    render(
      <AskUserQuestionPanel
        questions={singleQuestion}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.queryByText(/Step \d of \d/)).toBeNull();
  });

  it('renders markdown in question text', () => {
    const markdownQuestions: Question[] = [
      {
        question:
          'Choose a **database** for the `users` table:\n- Option A\n- Option B',
        header: 'Database',
        options: [{ label: 'PostgreSQL', description: 'Standard' }],
        multiSelect: false,
      },
    ];

    const { container } = render(
      <AskUserQuestionPanel
        questions={markdownQuestions}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(container.querySelector('strong')).toBeTruthy();
    expect(container.querySelector('strong')?.textContent).toBe('database');

    expect(container.querySelector('code')).toBeTruthy();
    expect(container.querySelector('code')?.textContent).toBe('users');

    const listItems = container.querySelectorAll('li');
    expect(listItems.length).toBe(2);
  });

  it('handles Other option with text input', () => {
    const onSubmit = vi.fn();
    const singleQuestion: Question[] = [
      {
        question: 'Which database?',
        header: 'Database',
        options: [{ label: 'PostgreSQL', description: 'Standard' }],
        multiSelect: false,
      },
    ];

    render(
      <AskUserQuestionPanel
        questions={singleQuestion}
        onSubmit={onSubmit}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByText('Other...'));

    const input = screen.getByPlaceholderText('Type your answer...');
    fireEvent.change(input, { target: { value: 'CockroachDB' } });

    fireEvent.click(screen.getByText('Review'));

    fireEvent.click(screen.getByText('Submit'));
    expect(onSubmit).toHaveBeenCalledWith('**Database:** CockroachDB', {
      'Which database?': 'CockroachDB',
    });
  });
});
