import { describe, it, expect } from 'vitest';
import { getAskWidgetState, indexAskWidgets } from './derivedState';
import type { AskWidgetDisplayMessage } from './derivedState';
import type { Question } from './answerUtils';

function askMsg(
  toolId: string,
  questions: Question[],
  toolResult?: unknown,
): AskWidgetDisplayMessage {
  const msg: AskWidgetDisplayMessage = {
    type: 'tool',
    isToolUse: true,
    toolName: 'AskUserQuestion',
    toolId,
    toolInput: JSON.stringify({ questions }),
  };
  if (toolResult !== undefined) {
    msg.toolResult = toolResult;
  }
  return msg;
}

function answeredResult(pairs: Record<string, string>): string {
  const body = Object.entries(pairs)
    .map(([q, a]) => `"${q}"="${a}"`)
    .join(', ');
  return `User has answered your questions: ${body}. You can now continue with the user's answers in mind.`;
}

const Q_DIRECTION: Question = {
  question: 'Which direction?',
  header: 'Direction',
  multiSelect: false,
  options: [],
};
const Q_LIB: Question = {
  question: 'Which library?',
  header: 'Library',
  multiSelect: false,
  options: [],
};

describe('getAskWidgetState', () => {
  it('returns unanswered when the tool_use has no tool_result', () => {
    const messages: AskWidgetDisplayMessage[] = [
      { type: 'assistant', content: 'Let me ask.' },
      askMsg('t1', [Q_DIRECTION]),
    ];
    expect(getAskWidgetState('t1', [Q_DIRECTION], messages)).toEqual({
      isAnswered: false,
      answers: null,
      isDuplicate: false,
    });
  });

  it('returns answered with parsed answers when tool_result matches the SDK format', () => {
    const messages: AskWidgetDisplayMessage[] = [
      askMsg(
        't1',
        [Q_DIRECTION, Q_LIB],
        answeredResult({
          'Which direction?': 'Forward',
          'Which library?': 'date-fns',
        }),
      ),
    ];
    expect(getAskWidgetState('t1', [Q_DIRECTION, Q_LIB], messages)).toEqual({
      isAnswered: true,
      answers: {
        'Which direction?': 'Forward',
        'Which library?': 'date-fns',
      },
      isDuplicate: false,
    });
  });

  it('accepts tool_result content as a [{text}] array (SDK transcript shape)', () => {
    const messages: AskWidgetDisplayMessage[] = [
      askMsg('t1', [Q_DIRECTION], [
        {
          type: 'text',
          text: answeredResult({ 'Which direction?': 'Forward' }),
        },
      ]),
    ];
    const result = getAskWidgetState('t1', [Q_DIRECTION], messages);
    expect(result.isAnswered).toBe(true);
    expect(result.answers).toEqual({ 'Which direction?': 'Forward' });
  });

  it('ignores subsequent user-text messages — answered is only derived from tool_result', () => {
    const messages: AskWidgetDisplayMessage[] = [
      askMsg('t1', [Q_DIRECTION]),
      { type: 'user', content: '**Direction:** Forward' },
    ];
    expect(getAskWidgetState('t1', [Q_DIRECTION], messages).isAnswered).toBe(
      false,
    );
  });

  it('flags earlier widgets with the same fingerprint as duplicates', () => {
    const messages: AskWidgetDisplayMessage[] = [
      askMsg(
        't1',
        [Q_DIRECTION],
        answeredResult({ 'Which direction?': 'Forward' }),
      ),
      askMsg('t2', [Q_DIRECTION]),
    ];
    const idx = indexAskWidgets(messages);
    expect(idx.get('t1')?.isDuplicate).toBe(true);
    expect(idx.get('t2')?.isDuplicate).toBe(false);
    expect(getAskWidgetState('t1', [Q_DIRECTION], messages, idx)).toMatchObject(
      { isDuplicate: true },
    );
    expect(getAskWidgetState('t2', [Q_DIRECTION], messages, idx)).toMatchObject(
      { isDuplicate: false, isAnswered: false },
    );
  });

  it('handles tool input passed as parsed object (streaming path)', () => {
    const msg: AskWidgetDisplayMessage = {
      type: 'tool',
      isToolUse: true,
      toolName: 'AskUserQuestion',
      toolId: 't1',
      toolInput: { questions: [Q_DIRECTION] },
      toolResult: answeredResult({ 'Which direction?': 'Forward' }),
    };
    const messages = [msg];
    expect(getAskWidgetState('t1', [Q_DIRECTION], messages).isAnswered).toBe(
      true,
    );
  });

  it('returns sensible defaults for unknown toolId', () => {
    const messages = [askMsg('t1', [Q_DIRECTION])];
    expect(getAskWidgetState('does-not-exist', [], messages)).toEqual({
      isAnswered: false,
      answers: null,
      isDuplicate: false,
    });
  });

  it('treats errored or dismissed tool_results as unanswered (card handles those terminal states itself)', () => {
    const errored = [
      askMsg(
        't1',
        [Q_DIRECTION],
        '<tool_use_error>InputValidationError: Too big</tool_use_error>',
      ),
    ];
    expect(getAskWidgetState('t1', [Q_DIRECTION], errored).isAnswered).toBe(
      false,
    );

    const dismissed = [
      askMsg('t2', [Q_DIRECTION], 'User declined to answer'),
    ];
    expect(getAskWidgetState('t2', [Q_DIRECTION], dismissed).isAnswered).toBe(
      false,
    );
  });
});
