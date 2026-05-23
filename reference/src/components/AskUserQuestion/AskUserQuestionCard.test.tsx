import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AskUserQuestionCard from './AskUserQuestionCard';
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
      { label: 'PostgreSQL', description: 'Already used' },
      { label: 'MongoDB', description: 'Document storage' },
    ],
    multiSelect: false,
  },
  {
    question: 'Which auth method?',
    header: 'Auth',
    options: [
      { label: 'JWT', description: 'Stateless' },
      { label: 'Session', description: 'Server-side' },
    ],
    multiSelect: false,
  },
];

describe('AskUserQuestionCard', () => {
  it('returns null for empty questions', () => {
    const { container } = render(<AskUserQuestionCard questions={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders unanswered state with question count and header badges', () => {
    const onOpenPanel = vi.fn();
    render(
      <AskUserQuestionCard
        questions={sampleQuestions}
        isAnswered={false}
        onOpenPanel={onOpenPanel}
      />,
    );

    expect(screen.getByText('Claude has 2 questions for you')).toBeTruthy();
    expect(screen.getByText('Database')).toBeTruthy();
    expect(screen.getByText('Auth')).toBeTruthy();
    expect(screen.getByText('Answer')).toBeTruthy();
  });

  it('calls onOpenPanel when Answer button is clicked', () => {
    const onOpenPanel = vi.fn();
    render(
      <AskUserQuestionCard
        questions={sampleQuestions}
        isAnswered={false}
        onOpenPanel={onOpenPanel}
      />,
    );

    fireEvent.click(screen.getByText('Answer'));
    expect(onOpenPanel).toHaveBeenCalledTimes(1);
  });

  it('renders answered state with answers (Bug 3: keyed by question text, not index)', () => {
    render(
      <AskUserQuestionCard
        questions={sampleQuestions}
        isAnswered={true}
        answers={{
          'Which database should we use?': 'PostgreSQL',
          'Which auth method?': 'JWT',
        }}
      />,
    );

    expect(screen.getByText('Questions answered')).toBeTruthy();
    expect(screen.getByText('PostgreSQL')).toBeTruthy();
    expect(screen.getByText('JWT')).toBeTruthy();
    expect(screen.queryByText('Answer')).toBeNull();
  });

  it('renders singular "question" for single question', () => {
    render(
      <AskUserQuestionCard
        questions={[sampleQuestions[0]!]}
        isAnswered={false}
        onOpenPanel={() => {}}
      />,
    );

    expect(screen.getByText('Claude has 1 question for you')).toBeTruthy();
  });

  it('Bug 2: parses answers from a successful tool_result on reload (no local state)', () => {
    const toolResult =
      'User has answered your questions: "Which database should we use?"="PostgreSQL", "Which auth method?"="JWT". You can now continue with the user\'s answers in mind.';
    render(
      <AskUserQuestionCard
        questions={sampleQuestions}
        isAnswered={false}
        answers={null}
        toolResult={toolResult}
      />,
    );

    expect(screen.getByText('Questions answered')).toBeTruthy();
    expect(screen.getByText('PostgreSQL')).toBeTruthy();
    expect(screen.getByText('JWT')).toBeTruthy();
    expect(screen.queryByText('Answer')).toBeNull();
  });

  it('Bug 1: errored tool_result (>4 questions) renders failed state with no Answer button', () => {
    const toolResult =
      '<tool_use_error>InputValidationError: [\n  {\n    "code": "too_big",\n    "maximum": 4,\n    "message": "Too big: expected array to have <=4 items"\n  }\n]</tool_use_error>';
    render(
      <AskUserQuestionCard
        questions={sampleQuestions}
        isAnswered={false}
        toolResult={toolResult}
        onOpenPanel={() => {}}
      />,
    );

    expect(screen.getByText('Question failed')).toBeTruthy();
    expect(screen.getByText(/more than 4/i)).toBeTruthy();
    expect(screen.queryByText('Answer')).toBeNull();
  });

  it('renders dismissed state when tool_result is "User dismissed the question"', () => {
    render(
      <AskUserQuestionCard
        questions={sampleQuestions}
        isAnswered={false}
        toolResult="User dismissed the question"
        onOpenPanel={() => {}}
      />,
    );

    expect(screen.getByText('Question dismissed')).toBeTruthy();
    expect(screen.getByText('Database')).toBeTruthy();
    expect(screen.getByText('Auth')).toBeTruthy();
    expect(screen.queryByText('Answer')).toBeNull();
  });

  it('errored tool_result wins over local "answered" state', () => {
    render(
      <AskUserQuestionCard
        questions={sampleQuestions}
        isAnswered={true}
        answers={{ 'Which database should we use?': 'PostgreSQL' }}
        toolResult="<tool_use_error>InputValidationError: too_big maximum:4</tool_use_error>"
      />,
    );

    expect(screen.getByText('Question failed')).toBeTruthy();
    expect(screen.queryByText('Questions answered')).toBeNull();
  });
});
