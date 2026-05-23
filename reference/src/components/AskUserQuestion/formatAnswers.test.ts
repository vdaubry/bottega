import { describe, it, expect } from 'vitest';
import { formatAnswers } from './formatAnswers';
import type { Question, AnswersMap } from './answerUtils';

describe('formatAnswers', () => {
  it('returns empty string for null/undefined questions', () => {
    expect(formatAnswers(null, {})).toBe('');
    expect(formatAnswers(undefined, {})).toBe('');
  });

  it('returns empty string for empty questions array', () => {
    expect(formatAnswers([], {})).toBe('');
  });

  it('formats single-select answers', () => {
    const questions: Question[] = [
      {
        header: 'Database',
        question: 'Which database?',
        options: [],
        multiSelect: false,
      },
    ];
    const answers: AnswersMap = { 0: 'PostgreSQL' };

    expect(formatAnswers(questions, answers)).toBe('**Database:** PostgreSQL');
  });

  it('formats multiple questions', () => {
    const questions: Question[] = [
      {
        header: 'Database',
        question: 'Which database?',
        options: [],
        multiSelect: false,
      },
      {
        header: 'Auth',
        question: 'Which auth?',
        options: [],
        multiSelect: false,
      },
    ];
    const answers: AnswersMap = { 0: 'PostgreSQL', 1: 'JWT' };

    expect(formatAnswers(questions, answers)).toBe(
      '**Database:** PostgreSQL\n**Auth:** JWT',
    );
  });

  it('formats multi-select answers', () => {
    const questions: Question[] = [
      {
        header: 'Features',
        question: 'Which features?',
        options: [],
        multiSelect: true,
      },
    ];
    const answers: AnswersMap = { 0: ['Auth', 'Logging', 'Caching'] };

    expect(formatAnswers(questions, answers)).toBe(
      '**Features:** Auth, Logging, Caching',
    );
  });

  it('formats "Other" free-text answer', () => {
    const questions: Question[] = [
      {
        header: 'Deploy',
        question: 'Where to deploy?',
        options: [],
        multiSelect: false,
      },
    ];
    const answers: AnswersMap = { 0: { other: 'Our own Kubernetes cluster' } };

    expect(formatAnswers(questions, answers)).toBe(
      '**Deploy:** Our own Kubernetes cluster',
    );
  });

  it('formats multi-select with "Other" entry', () => {
    const questions: Question[] = [
      {
        header: 'Tools',
        question: 'Which tools?',
        options: [],
        multiSelect: true,
      },
    ];
    const answers: AnswersMap = {
      0: ['ESLint', { other: 'Custom linter' }],
    };

    expect(formatAnswers(questions, answers)).toBe(
      '**Tools:** ESLint, Custom linter',
    );
  });

  it('skips unanswered questions', () => {
    const questions: Question[] = [
      {
        header: 'Database',
        question: 'Which database?',
        options: [],
        multiSelect: false,
      },
      {
        header: 'Auth',
        question: 'Which auth?',
        options: [],
        multiSelect: false,
      },
    ];
    const answers: AnswersMap = { 0: 'PostgreSQL' };

    expect(formatAnswers(questions, answers)).toBe('**Database:** PostgreSQL');
  });

  it('uses fallback header when header is missing', () => {
    const questions: Question[] = [
      { question: 'Which database?', options: [], multiSelect: false },
    ];
    const answers: AnswersMap = { 0: 'PostgreSQL' };

    expect(formatAnswers(questions, answers)).toBe(
      '**Question 1:** PostgreSQL',
    );
  });
});
