import { describe, expect, it } from 'vitest';
import type {
  Event,
  EventMessagePartUpdated,
  EventMessageUpdated,
  EventSessionError,
  EventSessionIdle,
  AssistantMessage,
  ToolPart,
  TextPart,
  ReasoningPart,
  FilePart,
  StepFinishPart,
} from '@opencode-ai/sdk';

import { createOpenCodeEventMapper, mapOpenCodeEvent } from './mapEvent.js';

const SESSION_ID = 'ses_test_42';
const MSG_ID = 'msg_assist_1';

function textPart(id: string, messageID: string, text: string): EventMessagePartUpdated {
  const part: TextPart = {
    id,
    sessionID: SESSION_ID,
    messageID,
    type: 'text',
    text,
  };
  return { type: 'message.part.updated', properties: { part, delta: text } };
}

function reasoningPart(id: string, messageID: string, text: string): EventMessagePartUpdated {
  const part: ReasoningPart = {
    id,
    sessionID: SESSION_ID,
    messageID,
    type: 'reasoning',
    text,
    time: { start: 0 },
  };
  return { type: 'message.part.updated', properties: { part, delta: text } };
}

function toolPart(
  id: string,
  messageID: string,
  callID: string,
  tool: string,
  state: ToolPart['state'],
): EventMessagePartUpdated {
  const part: ToolPart = {
    id,
    sessionID: SESSION_ID,
    messageID,
    type: 'tool',
    callID,
    tool,
    state,
  };
  return { type: 'message.part.updated', properties: { part } };
}

function filePart(
  id: string,
  messageID: string,
  mime: string,
  filename: string | undefined,
  url: string,
): EventMessagePartUpdated {
  const part: FilePart = {
    id,
    sessionID: SESSION_ID,
    messageID,
    type: 'file',
    mime,
    ...(filename !== undefined ? { filename } : {}),
    url,
  };
  return { type: 'message.part.updated', properties: { part } };
}

function stepFinish(
  id: string,
  messageID: string,
  input: number,
  output: number,
): EventMessagePartUpdated {
  const part: StepFinishPart = {
    id,
    sessionID: SESSION_ID,
    messageID,
    type: 'step-finish',
    reason: 'stop',
    cost: 0,
    tokens: {
      input,
      output,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
  return { type: 'message.part.updated', properties: { part } };
}

function assistantMessageUpdated(
  id: string,
  finish: string | undefined,
  tokens: { input: number; output: number } = { input: 100, output: 50 },
  modelID = 'kimi-k2.6',
): EventMessageUpdated {
  const info: AssistantMessage = {
    id,
    sessionID: SESSION_ID,
    role: 'assistant',
    time: { created: 0, ...(finish ? { completed: 1 } : {}) },
    parentID: 'parent_root',
    modelID,
    providerID: 'opencode',
    mode: 'build',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
    ...(finish ? { finish } : {}),
  };
  return { type: 'message.updated', properties: { info } };
}

function sessionIdle(): EventSessionIdle {
  return { type: 'session.idle', properties: { sessionID: SESSION_ID } };
}

function sessionError(message: string): EventSessionError {
  return {
    type: 'session.error',
    properties: {
      sessionID: SESSION_ID,
      error: { name: 'UnknownError', data: { message } },
    },
  };
}

describe('opencode mapEvent', () => {
  it('text-only assistant: 3 text parts + final message.updated → 1 assistant with concatenated text', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    expect(m.map(textPart('p1', MSG_ID, 'Hello '))).toEqual([]);
    expect(m.map(textPart('p2', MSG_ID, 'world'))).toEqual([]);
    expect(m.map(textPart('p3', MSG_ID, '!'))).toEqual([]);
    const out = m.map(assistantMessageUpdated(MSG_ID, 'stop'));
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('assistant');
    expect(out[0]?.id).toBe(MSG_ID);
    expect(out[0]?.provider).toBe('opencode');
    expect(out[0]?.providerSessionId).toBe(SESSION_ID);
    if (out[0]?.type === 'assistant') {
      expect(out[0].text).toBe('Hello world!');
      expect(out[0].usage).toEqual({ input_tokens: 100, output_tokens: 50 });
      expect(out[0].model).toBe('kimi-k2.6');
      expect(out[0].isSubAgent).toBe(false);
    }
  });

  it('does not flush before message.updated arrives with finish', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    m.map(textPart('p1', MSG_ID, 'hello'));
    // message.updated without finish does not flush.
    const interim = m.map(assistantMessageUpdated(MSG_ID, undefined));
    expect(interim).toEqual([]);
    const final = m.map(assistantMessageUpdated(MSG_ID, 'stop'));
    expect(final).toHaveLength(1);
    expect(final[0]?.type).toBe('assistant');
  });

  it('mixed text + reasoning collapses into one assistant + one assistant_thinking', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    m.map(reasoningPart('rp1', MSG_ID, 'Thinking step 1. '));
    m.map(textPart('tp1', MSG_ID, 'Answer: '));
    m.map(reasoningPart('rp2', MSG_ID, 'Thinking step 2.'));
    m.map(textPart('tp2', MSG_ID, '42'));
    const out = m.map(assistantMessageUpdated(MSG_ID, 'stop'));
    expect(out).toHaveLength(2);
    const assistant = out.find((e) => e.type === 'assistant');
    const thinking = out.find((e) => e.type === 'assistant_thinking');
    expect(assistant).toBeDefined();
    expect(thinking).toBeDefined();
    if (assistant?.type === 'assistant') expect(assistant.text).toBe('Answer: 42');
    if (thinking?.type === 'assistant_thinking')
      expect(thinking.text).toBe('Thinking step 1. Thinking step 2.');
  });

  it('tool lifecycle: running → completed produces tool_use + tool_result with matching toolUseId', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    const running = m.map(
      toolPart('tp_tool_1', MSG_ID, 'call_abc', 'Bash', {
        status: 'running',
        input: { command: 'ls' },
        time: { start: 0 },
      }),
    );
    expect(running).toHaveLength(1);
    expect(running[0]?.type).toBe('tool_use');
    if (running[0]?.type === 'tool_use') {
      expect(running[0].toolName).toBe('Bash');
      expect(running[0].toolUseId).toBe('call_abc');
      expect(running[0].toolInput).toEqual({ command: 'ls' });
    }

    const completed = m.map(
      toolPart('tp_tool_1', MSG_ID, 'call_abc', 'Bash', {
        status: 'completed',
        input: { command: 'ls' },
        output: 'README.md\npackage.json',
        title: 'ls',
        metadata: {},
        time: { start: 0, end: 1 },
      }),
    );
    // On the second call with the same part ID but 'completed' status,
    // only emit tool_result (tool_use was already emitted when status was 'running').
    expect(completed).toHaveLength(1);
    expect(completed[0]?.type).toBe('tool_result');
    if (completed[0]?.type === 'tool_result') {
      expect(completed[0].toolUseId).toBe('call_abc');
      expect(completed[0].content).toBe('README.md\npackage.json');
      expect(completed[0].isError).toBeUndefined();
    }
  });

  it('tool lifecycle: error state surfaces isError + content message', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    const out = m.map(
      toolPart('tp_err', MSG_ID, 'call_err', 'Edit', {
        status: 'error',
        input: { file: 'foo.ts' },
        error: 'File not found',
        time: { start: 0, end: 1 },
      }),
    );
    expect(out).toHaveLength(2);
    expect(out[1]?.type).toBe('tool_result');
    if (out[1]?.type === 'tool_result') {
      expect(out[1].isError).toBe(true);
      expect(out[1].content).toBe('File not found');
    }
  });

  it('pending tool state emits only tool_use (no tool_result)', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    const out = m.map(
      toolPart('tp_pending', MSG_ID, 'call_p', 'Bash', {
        status: 'pending',
        input: { command: 'pwd' },
        raw: '{"command":"pwd"}',
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('tool_use');
  });

  it('file part emits a tool_result with file metadata', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    const out = m.map(
      filePart('fp_1', MSG_ID, 'image/png', 'shot.png', 'opencode://attachments/abc'),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('tool_result');
    if (out[0]?.type === 'tool_result') {
      expect(out[0].content).toEqual({
        kind: 'file',
        mime: 'image/png',
        filename: 'shot.png',
        url: 'opencode://attachments/abc',
      });
    }
  });

  it('step-finish part yields a result with token totals', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    const out = m.map(stepFinish('sf_1', MSG_ID, 7702, 41));
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('result');
    if (out[0]?.type === 'result') {
      expect(out[0].isError).toBe(false);
      expect(out[0].usage).toEqual({ input_tokens: 7702, output_tokens: 41 });
    }
  });

  it('session.idle emits a result with isError=false', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    const out = m.map(sessionIdle());
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('result');
    if (out[0]?.type === 'result') expect(out[0].isError).toBe(false);
  });

  it('session.error emits a result with isError=true and the underlying error attached', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    const out = m.map(sessionError('Provider auth failed'));
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('result');
    if (out[0]?.type === 'result') {
      expect(out[0].isError).toBe(true);
      expect(out[0].errors).toBeDefined();
      expect(out[0].errors?.length).toBe(1);
    }
  });

  it('user message.updated does not produce a user UnifiedMessage (orchestrator emits the synthetic user)', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    const userEvent: EventMessageUpdated = {
      type: 'message.updated',
      properties: {
        info: {
          id: 'msg_user_1',
          sessionID: SESSION_ID,
          role: 'user',
          time: { created: 0 },
          agent: 'build',
          model: { providerID: 'opencode', modelID: 'kimi-k2.6' },
        },
      },
    };
    expect(m.map(userEvent)).toEqual([]);
  });

  it('flush is idempotent across duplicate message.updated finals', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    m.map(textPart('p1', MSG_ID, 'Hello'));
    const first = m.map(assistantMessageUpdated(MSG_ID, 'stop'));
    expect(first).toHaveLength(1);
    const second = m.map(assistantMessageUpdated(MSG_ID, 'stop'));
    expect(second).toEqual([]);
  });

  it('does not leak state across messageIDs in the same conversation', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    m.map(textPart('p1', 'msg_A', 'A1 '));
    m.map(textPart('p2', 'msg_B', 'B1 '));
    m.map(textPart('p3', 'msg_A', 'A2'));
    m.map(textPart('p4', 'msg_B', 'B2'));
    const outA = m.map(assistantMessageUpdated('msg_A', 'stop'));
    const outB = m.map(assistantMessageUpdated('msg_B', 'stop'));
    if (outA[0]?.type === 'assistant') expect(outA[0].text).toBe('A1 A2');
    if (outB[0]?.type === 'assistant') expect(outB[0].text).toBe('B1 B2');
  });

  it('unknown / unsupported event types return empty arrays (forward-compatible)', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    const unknown = {
      type: 'session.compacted',
      properties: { sessionID: SESSION_ID },
    } as Event;
    expect(m.map(unknown)).toEqual([]);
  });

  it('text part that arrives after final flush is ignored for that messageID (idempotent flush)', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode');
    m.map(textPart('p1', MSG_ID, 'first'));
    m.map(assistantMessageUpdated(MSG_ID, 'stop'));
    m.map(textPart('p2', MSG_ID, 'late'));
    // No second flush triggers; subsequent message.updated stays a no-op.
    expect(m.map(assistantMessageUpdated(MSG_ID, 'stop'))).toEqual([]);
  });

  it('one-shot mapOpenCodeEvent helper handles a single event correctly', () => {
    expect(mapOpenCodeEvent(sessionIdle(), SESSION_ID)).toHaveLength(1);
  });

  // OpenCode Go provider tests
  it('opencode-go provider stamps correct provider name on emitted messages', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode-go');
    expect(m.map(textPart('p1', MSG_ID, 'Hello from Go'))).toEqual([]);
    const out = m.map(assistantMessageUpdated(MSG_ID, 'stop'));
    expect(out).toHaveLength(1);
    expect(out[0]?.provider).toBe('opencode-go');
    expect(out[0]?.providerSessionId).toBe(SESSION_ID);
    if (out[0]?.type === 'assistant') {
      expect(out[0].text).toBe('Hello from Go');
    }
  });

  it('opencode-go provider emits correct provider on tool_use and tool_result', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode-go');
    const tool1 = m.map(
      toolPart('tool_p1', MSG_ID, 'call_bash_1', 'bash', {
        status: 'running',
        input: { command: 'ls' },
      }),
    );
    expect(tool1).toHaveLength(1);
    expect(tool1[0]?.type).toBe('tool_use');
    expect(tool1[0]?.provider).toBe('opencode-go');
    
    const tool2 = m.map(
      toolPart('tool_p1', MSG_ID, 'call_bash_1', 'bash', {
        status: 'completed',
        input: { command: 'ls' },
        output: 'file1.txt',
      }),
    );
    expect(tool2).toHaveLength(1);
    expect(tool2[0]?.type).toBe('tool_result');
    expect(tool2[0]?.provider).toBe('opencode-go');
  });

  it('opencode-go provider emits result event with correct provider', () => {
    const m = createOpenCodeEventMapper(SESSION_ID, 'opencode-go');
    const out = m.map(sessionIdle());
    expect(out).toHaveLength(1);
    expect(out[0]?.type).toBe('result');
    expect(out[0]?.provider).toBe('opencode-go');
  });
});
