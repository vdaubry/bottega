import { describe, it, expect } from 'vitest';
import {
  parseAnsweredToolResult,
  classifyAskUserToolResult,
} from './answerUtils';

describe('parseAnsweredToolResult', () => {
  it('parses a typical SDK answered string', () => {
    const content =
      'User has answered your questions: "Which database?"="PostgreSQL", "Auth method?"="JWT". You can now continue with the user\'s answers in mind.';
    expect(parseAnsweredToolResult(content)).toEqual({
      'Which database?': 'PostgreSQL',
      'Auth method?': 'JWT',
    });
  });

  it('handles a single answer', () => {
    const content =
      'User has answered your questions: "Approach?"="Recommended". You can now continue with the user\'s answers in mind.';
    expect(parseAnsweredToolResult(content)).toEqual({
      'Approach?': 'Recommended',
    });
  });

  it('handles answers and questions containing commas, parens and dashes', () => {
    const content =
      'User has answered your questions: "How wide should the fix go?"="Filter fix only (Recommended)", "Test plan?"="Yes — unit + Playwright (Recommended)". You can now continue with the user\'s answers in mind.';
    expect(parseAnsweredToolResult(content)).toEqual({
      'How wide should the fix go?': 'Filter fix only (Recommended)',
      'Test plan?': 'Yes — unit + Playwright (Recommended)',
    });
  });

  it('handles questions containing newlines and bullet markers', () => {
    const content =
      'User has answered your questions: "Recommended testing approach for this bug:\n• Unit\n• Playwright\nOK with this?"="Yes". You can now continue with the user\'s answers in mind.';
    expect(parseAnsweredToolResult(content)).toEqual({
      'Recommended testing approach for this bug:\n• Unit\n• Playwright\nOK with this?':
        'Yes',
    });
  });

  it('accepts an array-of-{text} content shape', () => {
    const content = [
      {
        text: 'User has answered your questions: "Q"="A". You can now continue with the user\'s answers in mind.',
      },
    ];
    expect(parseAnsweredToolResult(content)).toEqual({ Q: 'A' });
  });

  it('returns null for unrelated content', () => {
    expect(parseAnsweredToolResult('Some other tool output')).toBeNull();
    expect(parseAnsweredToolResult('User dismissed the question')).toBeNull();
    expect(parseAnsweredToolResult(undefined)).toBeNull();
    expect(parseAnsweredToolResult(null)).toBeNull();
  });

  it('returns null when prefix matches but no pairs are present', () => {
    expect(
      parseAnsweredToolResult(
        "User has answered your questions: . You can now continue with the user's answers in mind.",
      ),
    ).toBeNull();
  });
});

describe('classifyAskUserToolResult', () => {
  it('returns null for a missing toolResult (still pending)', () => {
    expect(classifyAskUserToolResult(undefined)).toBeNull();
    expect(classifyAskUserToolResult(null)).toBeNull();
    expect(classifyAskUserToolResult('')).toBeNull();
  });

  it('classifies the >4 questions InputValidationError as errored with a specific message', () => {
    const content =
      '<tool_use_error>InputValidationError: [\n  {\n    "origin": "array",\n    "code": "too_big",\n    "maximum": 4,\n    "inclusive": true,\n    "path": [\n      "questions"\n    ],\n    "message": "Too big: expected array to have <=4 items"\n  }\n]';
    const result = classifyAskUserToolResult(content);
    expect(result?.kind).toBe('errored');
    if (result?.kind === 'errored') {
      expect(result.message).toMatch(/more than 4/);
    }
  });

  it('classifies a generic tool_use_error as errored with a fallback message', () => {
    const result = classifyAskUserToolResult(
      '<tool_use_error>Some other error</tool_use_error>',
    );
    expect(result?.kind).toBe('errored');
    if (result?.kind === 'errored') {
      expect(result.message).toBeTruthy();
    }
  });

  it('classifies "User dismissed the question" as dismissed', () => {
    expect(classifyAskUserToolResult('User dismissed the question')).toEqual({
      kind: 'dismissed',
    });
  });

  it('classifies the answered string as answered with parsed answers', () => {
    const content =
      'User has answered your questions: "Which DB?"="PostgreSQL". You can now continue with the user\'s answers in mind.';
    const result = classifyAskUserToolResult(content);
    expect(result?.kind).toBe('answered');
    if (result?.kind === 'answered') {
      expect(result.answers).toEqual({ 'Which DB?': 'PostgreSQL' });
    }
  });
});
