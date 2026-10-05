// CodexProvider — implements `LlmProvider` for the OpenAI Codex SDK.
//
// Phase 9 ships the provider; Phase 10 plugs in per-user `CODEX_HOME`
// credentials. Until Phase 10 lands, `startTurn` uses whatever
// auth.json the calling user's shell has under their home (matching
// `claudecodeui`'s single-tenant default). The orchestrator does not
// route Codex turns through here yet — Phase 11's settings wire-up
// flips the switch.

import { Codex } from '@openai/codex-sdk';
import type { CodexOptions, Thread } from '@openai/codex-sdk';

import { mapEvent } from './mapEvent.js';
import { openGeneratedImageScanner, type GeneratedImageScanner } from './generatedImages.js';
import { buildCodexThreadOptions } from './codexOptionsBuilder.js';
import {
  toCodexMcpServers,
  type CodexConfigValue,
  type OperatorMcpServer,
} from '@shared/providers/operatorMcpServers';
import { getCapabilities } from '@shared/providers/capabilities';
import type {
  ProviderCapabilities,
  ProviderRunOptions,
  ProviderRunResult,
  UnifiedMessage,
  UnifiedUserMessage,
} from '@shared/providers/types';
import type { LlmProvider, LoadTranscriptOptions } from '../types.js';

interface ActiveCodexSession {
  thread: Thread;
  abortController: AbortController;
}

const ACTIVE_SESSIONS = new Map<string, ActiveCodexSession>();

/**
 * Codex exposes its own `request_user_input` tool even when that tool cannot
 * run in the active collaboration mode. Bottega's durable question widget is
 * a separate, deferred MCP tool, so tell the model how to select it instead
 * of letting the native tool's stronger name win the semantic match.
 */
export const CODEX_BOTTEGA_QUESTION_INSTRUCTIONS =
  'Bottega provides its durable question widget through the MCP tool named `ask_user` ' +
  '(its fully qualified name ends with `__ask_user`). Whenever you need to ask the user ' +
  'a blocking question, or the user asks you to exercise the question widget, use that ' +
  'MCP tool. Codex may defer MCP tools behind the programmatic tool-call executor; if ' +
  '`ask_user` is not directly listed, find the tool whose name ends with `__ask_user` ' +
  'in `ALL_TOOLS` and invoke it through the `tools` object. Never use Codex\'s native ' +
  '`request_user_input` tool in Bottega: it is collaboration-mode-gated and is not wired ' +
  'to Bottega\'s widget. After calling `ask_user`, stop; Bottega ends the current turn ' +
  'and resumes the conversation with the user\'s answers.';

export function buildCodexOptions(options: ProviderRunOptions): CodexOptions {
  const env = Object.fromEntries(
    Object.entries(options.env ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
  const gateway = options.extras?.mcpGateway as
    | { name: string; url: string; token: string; toolNames: string[] }
    | undefined;
  const operatorServers = (options.extras?.operatorMcpServers ?? []) as OperatorMcpServer[];
  const hasPortableQuestionTool = gateway?.toolNames.includes('ask_user') ?? false;
  const denied = new Set(options.disallowedTools ?? []);

  // The operator's own servers first, Bottega's gateway last: a name collision
  // must never cost the turn its `ask_user`/owner tools.
  const mcpServers: Record<string, { [key: string]: CodexConfigValue }> = {
    ...toCodexMcpServers(operatorServers),
    ...(gateway
      ? {
          [gateway.name]: {
            url: gateway.url,
            http_headers: { Authorization: `Bearer ${gateway.token}` },
            enabled_tools: gateway.toolNames,
            // This bearer-authenticated gateway already exposes only the
            // tools allowed for this turn. Without an explicit approval
            // mode, non-interactive Codex runs reject MCP calls before they
            // reach Bottega as "user cancelled MCP tool call".
            default_tools_approval_mode: 'approve',
            required: true,
          },
        }
      : {}),
  };

  const config: NonNullable<CodexOptions['config']> = {
    ...(hasPortableQuestionTool
      ? { developer_instructions: CODEX_BOTTEGA_QUESTION_INSTRUCTIONS }
      : {}),
    ...(denied.has('Bash') ? { features: { shell_tool: false } } : {}),
    ...(denied.has('Agent') || denied.has('Task') ? { agents: { enabled: false } } : {}),
    // The operator's servers are deliberately NOT `required`: a Playwright or
    // context7 that fails to start must degrade the turn, not abort it — the
    // agent notices and the epic orchestrator is woken to repair it.
    ...(Object.keys(mcpServers).length > 0 ? { mcp_servers: mcpServers } : {}),
  };
  return {
    ...(Object.keys(env).length > 0 ? { env } : {}),
    ...(Object.keys(config).length > 0 ? { config } : {}),
  };
}

function buildSyntheticUser(
  prompt: string,
  providerSessionId: string | null,
): UnifiedUserMessage {
  return {
    type: 'user',
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    provider: 'openai',
    providerSessionId,
    raw: { type: 'user', content: prompt },
    content: prompt,
  };
}

async function* streamUnified(
  thread: Thread,
  prompt: string,
  signal: AbortSignal,
  resolveSessionId: (id: string) => void,
  capturePid: (pid: number | null) => void,
  codexHome: string | undefined,
  resumeSessionId: string | null,
): AsyncGenerator<UnifiedMessage, void, unknown> {
  // 1. Synthetic user message — the Codex SDK doesn't emit the user
  //    prompt back as an event. Without this the messages table would
  //    have no user-side row for the turn.
  let providerSessionId: string | null = null;
  yield buildSyntheticUser(prompt, providerSessionId);

  // 2. The stream itself. Resolve `providerSessionId$` on the first
  //    `thread.started` event; before then, downstream messages carry
  //    a null session id (Phase 9 messageMirror buffers until the id
  //    is known — out of scope for the minimum-viable provider).
  //
  //    Generated images never appear in that stream (see generatedImages.ts),
  //    so the thread's image folder is scanned ahead of each event: an image
  //    then lands in the transcript before the message that talks about it.
  //    A resumed thread's folder is opened before the turn runs, so the files
  //    earlier turns left there are not reported twice.
  let imageScanner: GeneratedImageScanner | null =
    codexHome && resumeSessionId
      ? await openGeneratedImageScanner(codexHome, resumeSessionId)
      : null;

  const streamed = await thread.runStreamed(prompt, { signal });
  capturePid((streamed as unknown as { pid?: number }).pid ?? null);

  for await (const event of streamed.events) {
    const e = event;
    if (e.type === 'thread.started' && providerSessionId === null) {
      providerSessionId = e.thread_id;
      resolveSessionId(e.thread_id);
    }
    if (!imageScanner && codexHome && providerSessionId) {
      imageScanner = await openGeneratedImageScanner(codexHome, providerSessionId);
    }
    if (imageScanner) {
      // The turn's closing event is the last chance, and Codex has stopped
      // writing by then — take whatever is left.
      const final = e.type === 'turn.completed' || e.type === 'turn.failed';
      yield* await imageScanner.collect({ final });
    }
    for (const unified of mapEvent(e, providerSessionId)) {
      yield unified;
    }
  }
}

export class CodexProvider implements LlmProvider {
  readonly name = 'openai' as const;

  constructor(private readonly injectedCodex?: Codex) {}

  private codexFor(options: ProviderRunOptions): Codex {
    if (this.injectedCodex) return this.injectedCodex;
    return new Codex(buildCodexOptions(options));
  }

  getCapabilities(): ProviderCapabilities {
    return getCapabilities('openai');
  }

  async startTurn(options: ProviderRunOptions): Promise<ProviderRunResult> {
    const threadOptions = buildCodexThreadOptions(options);
    const thread = this.codexFor(options).startThread(threadOptions);
    return this.runOnThread(thread, options);
  }

  async sendTurnMessage(
    options: ProviderRunOptions & { resumeSessionId: string },
  ): Promise<ProviderRunResult> {
    const threadOptions = buildCodexThreadOptions(options);
    const thread = this.codexFor(options).resumeThread(options.resumeSessionId, threadOptions);
    return this.runOnThread(thread, options);
  }

  private async runOnThread(
    thread: Thread,
    options: ProviderRunOptions,
  ): Promise<ProviderRunResult> {
    const abortController = options.abortController ?? new AbortController();
    let resolveSessionId!: (id: string) => void;
    const providerSessionId$ = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });
    void providerSessionId$.then((id) => {
      ACTIVE_SESSIONS.set(id, { thread, abortController });
    });

    let pid: number | null = null;
    const capturePid = (p: number | null) => {
      pid = p;
    };

    const prompt = options.prompt ?? '';

    return {
      events: streamUnified(
        thread,
        prompt,
        abortController.signal,
        resolveSessionId,
        capturePid,
        options.env?.['CODEX_HOME'],
        options.resumeSessionId ?? null,
      ),
      providerSessionId$,
      abort: () => abortController.abort(),
      get pid() {
        return pid;
      },
    };
  }

  async loadTranscript(options: LoadTranscriptOptions): Promise<UnifiedMessage[]> {
    // Codex events are mirrored into the same `messages` SQLite table
    // that Anthropic uses (D4). The on-disk shape matches Claude's
    // transcript shape closely enough that the existing reader returns
    // useful rows; we adapt back to UnifiedMessage on the way out.
    const { loadAnthropicTranscript } = await import('../anthropic/sessionStore.js');
    const entries = await loadAnthropicTranscript(options);
    // Stamp the provider so downstream consumers don't see 'anthropic'
    // on rows that are actually Codex.
    return entries.map((e) => ({ ...e, provider: 'openai' }));
  }

  abortTurn(providerSessionId: string): boolean {
    const active = ACTIVE_SESSIONS.get(providerSessionId);
    if (!active) return false;
    active.abortController.abort();
    ACTIVE_SESSIONS.delete(providerSessionId);
    return true;
  }
}

export const codexProvider = new CodexProvider();
