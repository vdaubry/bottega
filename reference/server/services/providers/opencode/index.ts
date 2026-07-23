// OpenCodeProvider — implements `LlmProvider` for the OpenCode SDK.
//
// Mirrors the structure of `CodexProvider` (server/services/providers/openai/index.ts).
// Differences vs. Codex:
//   - The SDK is not a "spawn-per-turn" SDK. We talk to a per-user
//     `opencode serve` (managed by `openCodeServerPool`) over HTTP.
//   - The session is a first-class resource: `session.create` is called
//     once on `startTurn`, then `session.prompt` for every turn on the
//     same session id. `sendTurnMessage` skips `session.create`.
//   - Output is streamed via the SSE `client.event.subscribe()` long-poll,
//     filtered to events matching this session id, then translated by
//     `createOpenCodeEventMapper`.
//
// The orchestrator passes the user id via the env (BOTTEGA_USER_ID, tagged
// in by the credential adapter's `buildSdkEnv`) so we can leave the
// shared `ProviderRunOptions` shape bit-identical (R4).

import { getCapabilities } from '@shared/providers/capabilities';
import type {
  ProviderCapabilities,
  ProviderRunOptions,
  ProviderRunResult,
  UnifiedMessage,
  UnifiedUserMessage,
} from '@shared/providers/types';
import type { LlmProvider, LoadTranscriptOptions } from '../types.js';

import {
  getOrSpawnOpenCodeServer,
  type OpenCodeServerHandle,
} from '../../openCodeServerPool.js';
import { createOpenCodeEventMapper } from './mapEvent.js';

export class InvalidOpenCodeModelError extends Error {
  constructor(received: string | undefined) {
    super(
      `Invalid OpenCode model identifier: ${
        received === undefined || received === ''
          ? '<empty>'
          : JSON.stringify(received)
      }. Expected the canonical persisted form 'opencode/<modelID>'.`,
    );
    this.name = 'InvalidOpenCodeModelError';
  }
}

export type OpenCodeProviderName = 'opencode' | 'opencode-go';

export interface ParsedOpenCodeModel {
  providerID: OpenCodeProviderName;
  modelID: string;
}

const OPENCODE_PREFIXES: ReadonlySet<string> = new Set(['opencode', 'opencode-go']);

/**
 * Parse the canonical persisted form `'opencode/<modelID>'` or
 * `'opencode-go/<modelID>'` into the `{ providerID, modelID }` shape the
 * OpenCode SDK requires for `session.prompt`. Multi-segment modelIDs
 * (e.g. `'opencode/claude-opus-4-7'`) keep the full tail; only the first
 * segment is consumed as the providerID prefix.
 *
 * `parseOpenCodeModel('opencode/kimi-k2.6')` → `{ providerID: 'opencode', modelID: 'kimi-k2.6' }`.
 * `parseOpenCodeModel('opencode-go/kimi-k2.6')` → `{ providerID: 'opencode-go', modelID: 'kimi-k2.6' }`.
 *
 * @throws InvalidOpenCodeModelError if `model` is empty or does not start
 *  with the `'opencode/'` or `'opencode-go/'` prefix.
 */
export function parseOpenCodeModel(model: string): ParsedOpenCodeModel {
  if (!model) {
    throw new InvalidOpenCodeModelError(model);
  }
  const idx = model.indexOf('/');
  if (idx < 0) throw new InvalidOpenCodeModelError(model);
  const prefix = model.slice(0, idx);
  const tail = model.slice(idx + 1);
  if (!OPENCODE_PREFIXES.has(prefix) || tail.length === 0) {
    throw new InvalidOpenCodeModelError(model);
  }
  return { providerID: prefix as OpenCodeProviderName, modelID: tail };
}

function extractUserIdFromEnv(
  env: Record<string, string | undefined> | undefined,
): number {
  const raw = env?.['BOTTEGA_USER_ID'];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(
      `OpenCodeProvider could not resolve user id from env (BOTTEGA_USER_ID=${
        raw === undefined ? '<unset>' : JSON.stringify(raw)
      }). The credential store's buildSdkEnv tags this in; routes that pass options.env must use it.`,
    );
  }
  return n;
}

function buildSyntheticUser(
  prompt: string,
  providerSessionId: string | null,
  providerName: OpenCodeProviderName,
): UnifiedUserMessage {
  return {
    type: 'user',
    id: `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    provider: providerName,
    providerSessionId,
    raw: { type: 'user', content: prompt },
    content: prompt,
  };
}

interface ActiveOpenCodeSession {
  handle: OpenCodeServerHandle;
  abortController: AbortController;
  /**
   * The workspace `cwd` the turn ran in. REQUIRED on the server-side
   * `session.abort` call: OpenCode's `/session/:id/abort` endpoint is
   * workspace-scoped by the same WorkspaceRoutingMiddleware that gates
   * `promptAsync` and `event.subscribe`. The handler resolves the
   * per-workspace prompt service from `query.directory` (falling back to
   * the serve-time `process.cwd()` — the Bottega worktree) and calls
   * `promptSvc.cancel(sessionID)` on it. Without the matching directory the
   * cancel lands on the wrong workspace's prompt service and the turn — which
   * runs in the task worktree's prompt service — is never stopped (it counts
   * to the end and writes its file). Found live: the abort E2E probe.
   */
  directory: string | undefined;
}

const ACTIVE_SESSIONS = new Map<string, ActiveOpenCodeSession>();

// We use a structural typed alias of the parts of the OpencodeClient
// we touch. Lets tests pass narrow fakes without re-deriving the full
// generated SDK type, and keeps this module from leaking SDK types out
// of the `opencode/` directory.
interface MinimalSessionApi {
  create(options: {
    body?: { title?: string };
    query?: { directory?: string };
  }): Promise<{ data?: { id?: string } } | unknown>;
  /**
   * Fire-and-forget message create — returns immediately while the
   * model streams via the SSE `/event` endpoint. We use this instead of
   * the synchronous `prompt` to avoid Node's 5-minute fetch headers
   * timeout (UND_ERR_HEADERS_TIMEOUT) on long turns (tool use,
   * thinking, large context).
   */
  promptAsync(options: {
    path: { id: string };
    body: {
      // Optional: omitted on resume so OpenCode reuses the session's stored model.
      model?: { providerID: string; modelID: string };
      agent: string;
      system?: string;
      tools?: Record<string, boolean>;
      parts: Array<{ type: 'text'; text: string }>;
    };
    query?: { directory?: string };
    signal?: AbortSignal;
  }): Promise<unknown>;
  /** Legacy synchronous prompt — kept for tests that mock it. */
  prompt?: (options: {
    path: { id: string };
    body: {
      // Optional: omitted on resume so OpenCode reuses the session's stored model.
      model?: { providerID: string; modelID: string };
      agent: string;
      system?: string;
      tools?: Record<string, boolean>;
      parts: Array<{ type: 'text'; text: string }>;
    };
    signal?: AbortSignal;
  }) => Promise<unknown>;
  abort(options: {
    path: { id: string };
    query?: { directory?: string };
  }): Promise<unknown>;
}

interface MinimalEventApi {
  subscribe(options: {
    query?: { directory?: string };
    signal?: AbortSignal;
    sseMaxRetryAttempts?: number;
    onSseError?: (error: unknown) => void;
  }): Promise<{ stream: AsyncIterable<{ data?: unknown }> }>;
}

interface OpenCodeModelInfo {
  id: string;
  name?: string;
  status?: 'alpha' | 'beta' | 'deprecated' | 'active' | string;
  limit?: { context?: number; output?: number };
  cost?: { input?: number; output?: number };
}

interface OpenCodeProviderInfo {
  id: string;
  name: string;
  models: Record<string, OpenCodeModelInfo>;
}

interface MinimalConfigApi {
  providers(options?: {
    signal?: AbortSignal;
  }): Promise<
    | { data?: { providers?: OpenCodeProviderInfo[] } }
    | { providers?: OpenCodeProviderInfo[] }
  >;
}

interface MinimalOpencodeClient {
  session: MinimalSessionApi;
  event: MinimalEventApi;
  config: MinimalConfigApi;
}

function clientOf(handle: OpenCodeServerHandle): MinimalOpencodeClient {
  return handle.client as unknown as MinimalOpencodeClient;
}

interface RunOnSessionContext {
  handle: OpenCodeServerHandle;
  sessionId: string;
  options: ProviderRunOptions;
}

async function* streamUnified(
  ctx: RunOnSessionContext,
  resolveSessionId: (id: string) => void,
  capturePid: (pid: number | null) => void,
  providerName: OpenCodeProviderName,
): AsyncGenerator<UnifiedMessage, void, unknown> {
  const { handle, sessionId, options } = ctx;
  const abortController = options.abortController ?? new AbortController();

  // 1. Synthetic user event — OpenCode never echoes the outgoing prompt
  //    as an SSE event, so without this the messages table has no
  //    user-side row for the turn (matches Codex's strategy).
  resolveSessionId(sessionId);
  yield buildSyntheticUser(options.prompt ?? '', sessionId, providerName);
  capturePid(handle.pid);

  // Every turn — start or resume — carries an explicit model. On resume the
  // orchestrator reads it back off the conversation row (it is no longer
  // omitted and silently reused from `SessionTable.model`), so the model is
  // always deterministic and `parseOpenCodeModel` always has a value.
  const parsed = parseOpenCodeModel(options.model);
  const client = clientOf(handle);
  const mapper = createOpenCodeEventMapper(sessionId, providerName);

  // 2. Subscribe to the SSE stream BEFORE firing the prompt so events
  //    emitted between the prompt response and the session.idle aren't
  //    missed. Both calls share the same abort signal.
  //
  //    Pass `query.directory` on the subscribe call too — OpenCode's
  //    `/event` endpoint is workspace-scoped (same WorkspaceRoutingMiddleware
  //    that gates `promptAsync`). Without it the subscription lands on the
  //    server's default bus (Bottega's worktree), while `promptAsync`
  //    publishes the turn on the task-worktree bus — leaving Bottega
  //    listening forever to a different bus and never seeing `session.idle`.
  //    `sseMaxRetryAttempts: 1` keeps the retry loop in
  //    `node_modules/.../core/serverSentEvents.gen.js` from silently
  //    reconnecting forever on transient errors so the `finally` below can
  //    fire and yield the synthetic stream-closed `result`.
  const subscription = await client.event.subscribe({
    ...(options.cwd ? { query: { directory: options.cwd } } : {}),
    signal: abortController.signal,
    sseMaxRetryAttempts: 1,
    onSseError: (err) => {
      console.warn('[OpenCodeProvider] SSE error', err);
    },
  });

  // 3. Send the prompt via `promptAsync` — fire-and-forget at the HTTP
  //    layer. The synchronous `session.prompt` is also exposed by the
  //    SDK but it blocks until end-of-turn, and Node's `fetch` headers
  //    timeout (default 5 min) trips long turns with tool use or large
  //    context (observed live: UND_ERR_HEADERS_TIMEOUT on opencode/
  //    kimi-k2.6 planification). With `promptAsync` the HTTP call
  //    returns immediately and the turn's events flow exclusively
  //    through the SSE subscription opened above.
  //
  // Always disable OpenCode's built-in `question` tool. It parks the
  // turn at `tool: running` waiting for an answer through OpenCode's
  // question API, which Bottega has no UI for (capability
  // `supportsAskUserQuestion = false`, D8). Models like qwen3.6-plus
  // reach for it on their own when they see "ask clarifying questions"
  // in a system prompt; without this line the turn hangs until the
  // idle reaper kills the server.
  const disabledTools: Record<string, false> = { question: false };
  for (const t of options.disallowedTools ?? []) {
    disabledTools[t] = false;
  }

  // Re-assert the workspace directory on every prompt call. OpenCode's
  // WorkspaceRoutingMiddleware resolves `directory` per-call (its
  // fallback is the *server's* `process.cwd()` — i.e. the Bottega
  // worktree, not the task worktree). Without this, the agent
  // explores/edits the wrong filesystem even though `session.create`
  // passed the right directory upstream. Found live in Phase 12.3:
  // an implementation run wrote `hello.txt` into the bottega worktree
  // and a planning run explored the bottega codebase instead of the
  // hello_world project. See `packages/opencode/src/server/routes/instance/
  // httpapi/middleware/workspace-routing.ts` (`extractDirectory`) in
  // the OpenCode source.
  const promptPromise = client.session
    .promptAsync({
      path: { id: sessionId },
      body: {
        model: { providerID: parsed.providerID, modelID: parsed.modelID },
        agent: 'build',
        ...(options.customSystemPrompt ? { system: options.customSystemPrompt } : {}),
        tools: disabledTools,
        parts: [{ type: 'text', text: options.prompt ?? '' }],
      },
      ...(options.cwd ? { query: { directory: options.cwd } } : {}),
      signal: abortController.signal,
    })
    .catch((err: unknown) => {
      // Surface as a synthetic error event the mapper will translate;
      // the SSE loop below catches end-of-stream and propagates.
      const e = err as Error;
      console.error('[OpenCodeProvider] session.promptAsync rejected', e);
    });

  let sawTerminator = false;
  try {
    // The SDK's `ServerSentEventsResult<EventSubscribeResponses>.stream`
    // is typed `AsyncGenerator<EventSubscribeResponses[keyof
    // EventSubscribeResponses]>` — i.e. it yields the bare `Event`
    // object, not a `{ data: Event }` envelope. Filter to the current
    // session so a shared `opencode serve` (multiple in-flight
    // conversations on the same user) doesn't cross-contaminate.
    for await (const event of subscription.stream as AsyncIterable<{
      type?: string;
      properties?: {
        sessionID?: string;
        info?: { sessionID?: string };
        part?: { sessionID?: string };
      };
    }>) {
      if (!event || typeof event !== 'object') continue;
      // `message.part.updated` carries the session id under `part.sessionID`,
      // not the top-level `sessionID` field — without this fallback,
      // tool-part events from a sub-agent's session sneak through the
      // session filter (the parent `message.updated` still gets filtered,
      // but downstream consumers see orphaned `tool_use` rows).
      const eventSessionId =
        event.properties?.sessionID ??
        event.properties?.info?.sessionID ??
        event.properties?.part?.sessionID;
      // Server-instance lifecycle events have no sessionID and the
      // mapper drops them via its default case.
      if (eventSessionId && eventSessionId !== sessionId) continue;
      for (const unified of mapper.map(event as never)) {
        yield unified;
      }
      if (
        event.type === 'session.idle' &&
        eventSessionId === sessionId
      ) {
        sawTerminator = true;
        break;
      }
      if (event.type === 'session.error' && eventSessionId === sessionId) {
        sawTerminator = true;
        break;
      }
    }
  } finally {
    // Best-effort: cancel the SSE long-poll on the way out.
    try {
      abortController.abort();
    } catch {
      // ignore
    }
    await promptPromise.catch(() => {});
    if (!sawTerminator) {
      // The stream ended without an explicit terminator (network drop,
      // server crash) — emit a synthetic error result so the
      // orchestrator's failed-streaming path fires.
      yield {
        type: 'result',
        id: `opencode_stream_closed:${sessionId}:${Math.random()}`,
        provider: providerName,
        providerSessionId: sessionId,
        raw: { type: 'session.closed' },
        isError: true,
        errors: [{ message: 'OpenCode SSE stream closed before session.idle' }],
      };
    }
  }
}

export class OpenCodeProvider implements LlmProvider {
  readonly name: OpenCodeProviderName;

  constructor(name: OpenCodeProviderName) {
    this.name = name;
  }

  getCapabilities(): ProviderCapabilities {
    return getCapabilities(this.name);
  }

  async startTurn(options: ProviderRunOptions): Promise<ProviderRunResult> {
    const userId = extractUserIdFromEnv(options.env);
    const handle = await getOrSpawnOpenCodeServer(userId);
    const client = clientOf(handle);
    const result = (await client.session.create({
      body: { title: '' },
      query: { directory: options.cwd },
    })) as { data?: { id?: string } } | { id?: string };
    const sessionId =
      (result as { data?: { id?: string } }).data?.id ??
      (result as { id?: string }).id;
    if (!sessionId) {
      throw new Error('OpenCode session.create returned no session id');
    }
    return this.runOnSession({ handle, sessionId, options });
  }

  async sendTurnMessage(
    options: ProviderRunOptions & { resumeSessionId: string },
  ): Promise<ProviderRunResult> {
    const userId = extractUserIdFromEnv(options.env);
    const handle = await getOrSpawnOpenCodeServer(userId);
    return this.runOnSession({ handle, sessionId: options.resumeSessionId, options });
  }

  private runOnSession(ctx: RunOnSessionContext): ProviderRunResult {
    const abortController = ctx.options.abortController ?? new AbortController();
    let resolveSessionId!: (id: string) => void;
    const providerSessionId$ = new Promise<string>((resolve) => {
      resolveSessionId = resolve;
    });
    providerSessionId$.then((id) => {
      ACTIVE_SESSIONS.set(id, {
        handle: ctx.handle,
        abortController,
        directory: ctx.options.cwd,
      });
    });

    let pid: number | null = null;
    const capturePid = (p: number | null): void => {
      pid = p;
    };

    // The generator returned in `events` re-runs the prompt-and-subscribe
    // logic. We hand abortController in via the options so the consumer
    // can flip it.
    const optionsWithController: ProviderRunOptions = {
      ...ctx.options,
      abortController,
    };

    return {
      events: streamUnified(
        { ...ctx, options: optionsWithController },
        resolveSessionId,
        capturePid,
        this.name,
      ),
      providerSessionId$,
      abort: () => abortController.abort(),
      get pid() {
        return pid;
      },
    } as ProviderRunResult;
  }

  abortTurn(providerSessionId: string): boolean {
    const active = ACTIVE_SESSIONS.get(providerSessionId);
    if (!active) return false;
    active.abortController.abort();
    // Tell the OpenCode server to abort server-side too — the SDK call
    // is fire-and-forget; if the network already closed it's fine.
    //
    // Pass `query.directory` so the abort routes to the *same* workspace the
    // turn runs in. The endpoint is workspace-scoped (see ActiveOpenCodeSession
    // .directory); without this the cancel hits the serve-time default
    // workspace and the real turn keeps running. The abortController above
    // only stops Bottega's SSE listener, not the out-of-process turn.
    console.log(
      `[OpenCodeProvider] Server-side abort: session.abort id=${providerSessionId} directory=${active.directory ?? '<default>'}`,
    );
    clientOf(active.handle)
      .session.abort({
        path: { id: providerSessionId },
        ...(active.directory ? { query: { directory: active.directory } } : {}),
      })
      .catch(() => {
        // The session may already be aborted, or the server may be
        // unreachable. The abortController above already short-circuited
        // the stream, so the orchestrator's cleanup is unaffected.
      });
    ACTIVE_SESSIONS.delete(providerSessionId);
    return true;
  }

  async loadTranscript(options: LoadTranscriptOptions): Promise<UnifiedMessage[]> {
    // OpenCode events are mirrored into the same `messages` SQLite table
    // that Anthropic and Codex use (D3). Reuse the existing reader and
    // re-stamp the provider on the way out so downstream consumers don't
    // see 'anthropic' on rows that are actually OpenCode.
    const { loadAnthropicTranscript } = await import('../anthropic/sessionStore.js');
    const entries = await loadAnthropicTranscript(options);
    return entries.map((e) => ({ ...e, provider: this.name }));
  }
}

/**
 * Factory function to create an OpenCode provider instance for either
 * 'opencode' (Zen) or 'opencode-go' (Go).
 */
export function createOpenCodeProvider(name: OpenCodeProviderName): OpenCodeProvider {
  return new OpenCodeProvider(name);
}

export const openCodeProvider = createOpenCodeProvider('opencode');
export const openCodeGoProvider = createOpenCodeProvider('opencode-go');

/**
 * Bottega-facing model record. Mirrors the subset of OpenCode's `Model`
 * type the settings UI needs (id, label, status, context window). The
 * `id` field is the *Bottega-persisted* shape `opencode/<bareModelID>`
 * or `opencode-go/<bareModelID>` — drop it straight into an
 * agent_model_settings row.
 */
export interface OpenCodeModelListEntry {
  /** Persistence form: `opencode/<bareModelID>` or `opencode-go/<bareModelID>`. */
  id: string;
  /** Raw model ID without the provider prefix — what the SDK consumes. */
  bareModelId: string;
  /** Human label as returned by OpenCode (e.g. "Kimi K2.6"). */
  name: string;
  /** Upstream lifecycle marker. `'deprecated'` rows are kept so existing
   * settings still resolve, but the UI can grey them out. */
  status: 'alpha' | 'beta' | 'deprecated' | 'active' | 'unknown';
  /** Context window in tokens, or `null` if OpenCode didn't report one. */
  contextWindow: number | null;
}

/**
 * Fetch the live catalog for the given user by spawning (or reusing)
 * their OpenCode server and calling `GET /config/providers`. Returns the
 * models for the specified provider (`'opencode'` for Zen, `'opencode-go'`
 * for Go).
 *
 * Throws the same errors `getOrSpawnOpenCodeServer` does (missing
 * key → typed error from the credential store); callers should surface
 * them as 401-ish responses rather than 5xx.
 */
export async function listOpenCodeModels(
  userId: number,
  providerName: OpenCodeProviderName = 'opencode',
): Promise<OpenCodeModelListEntry[]> {
  const handle = await getOrSpawnOpenCodeServer(userId);
  const client = clientOf(handle);
  const result = await client.config.providers();
  // The SDK has flipped between `result.data.providers` and bare
  // `result.providers` shapes across versions — accept both.
  const providers =
    (result as { data?: { providers?: OpenCodeProviderInfo[] } }).data?.providers ??
    (result as { providers?: OpenCodeProviderInfo[] }).providers ??
    [];
  const provider = providers.find((p) => p.id === providerName);
  if (!provider) return [];
  const entries: OpenCodeModelListEntry[] = [];
  for (const [bareModelId, m] of Object.entries(provider.models ?? {})) {
    const status = (m.status ?? 'unknown') as OpenCodeModelListEntry['status'];
    entries.push({
      id: `${providerName}/${bareModelId}`,
      bareModelId,
      name: m.name ?? bareModelId,
      status,
      contextWindow: m.limit?.context ?? null,
    });
  }
  // Stable, alpha-sorted output so the UI dropdown is deterministic and
  // tests don't have to chase OpenCode's internal order.
  entries.sort((a, b) => a.bareModelId.localeCompare(b.bareModelId));
  return entries;
}
