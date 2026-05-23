# Core — The harness contract

This is the most important extension seam in the project. Implement this
interface for a new coding tool and the entire pipeline — planning, the
implementation/review loop, the PR agent — works against it unchanged.

## Why it is core

The orchestration loop and the agents are useless without *something* that
actually runs a coding-agent turn — a **harness** (Claude Code, OpenAI Codex,
OpenCode, or your own). But the loop must not know or care which one. So **core
owns the contract** every harness implements, and the **runtime** that drives
it; the concrete integrations live in [`extra/harnesses/`](../extra/harnesses/overview.md).

One hard rule makes the seam real: **nothing above this interface ever imports a
concrete agent SDK.** Provider-specific shapes stay behind the interface. Two
files state this contract in code and are worth reading first —
[`reference/server/services/providers/types.ts`](../reference/server/services/providers/types.ts)
(the server-side interface) and
[`reference/shared/providers/types.ts`](../reference/shared/providers/types.ts)
(the shared vocabulary).

The contract has three pieces: the **provider interface**, the **unified
vocabulary** it speaks, and the **runtime** that consumes it.

## 1. The provider interface

`LlmProvider` (see `reference/server/services/providers/types.ts`). Every harness
implements:

- `name` — the provider's identifier.
- `getCapabilities()` → `ProviderCapabilities` — a static feature matrix (below).
- `startTurn(options)` → `ProviderRunResult` — begin a new session/turn.
- `sendTurnMessage(options & { resumeSessionId })` → `ProviderRunResult` — resume
  an existing session with a follow-up message.
- `loadTranscript({ providerSessionId, projectFolderPath })` →
  `UnifiedMessage[]` — the conversation history, already normalized; callers
  never see raw SDK shapes.
- `abortTurn(providerSessionId)` → `boolean` — cancel the live turn.

Providers register themselves in a **registry** keyed by name; the orchestrator
calls `getProvider(name)` and drives everything through this surface only.
Registration is explicit, not auto-discovered, so the resolution path stays
greppable. See
[`reference/server/services/providers/registry.ts`](../reference/server/services/providers/registry.ts).

## 2. The unified vocabulary

Provider-neutral types every layer above the SDK speaks
(`reference/shared/providers/types.ts`):

- **`ProviderRunOptions`** — per-turn input: `cwd`, `model`, `effort` (or
  `null`), `customSystemPrompt`, `permissionMode`, `disallowedTools`, `env`
  (per-user credentials are injected here), `abortController`, `resumeSessionId`,
  `prompt`, and an opaque `extras` passthrough.
  - **`model` is always explicit.** The orchestrator resolves a concrete model —
    from the chosen settings on start, or from the stored conversation row on
    resume — *before* any provider is reached. A turn never runs on a defaulted
    or inferred model; mismatches (e.g. feeding an OpenAI model name to the
    Claude SDK) must fail loud, not silently fall back.
  - `prompt` is `null` only when re-driving a tool result (e.g. an
    `AskUserQuestion` answer); otherwise it carries the turn's input.
- **`ProviderRunResult`** — `{ events, providerSessionId$, abort(), pid }`. The
  caller iterates `events` (an `AsyncIterable<UnifiedMessage>`) and awaits
  `providerSessionId$` to learn the wire session id the moment it is known.
- **`UnifiedMessage`** — the discriminated union the stream emits: `user`,
  `assistant`, `assistant_thinking`, `tool_use`, `tool_result`, `system`,
  `result`, `stream_delta`. Each variant carries `id`, `provider`,
  `providerSessionId`, a server-assigned `seq`, and `raw` (the untouched SDK
  payload, for forensics). Each provider ships a **mapper** that funnels its
  native events into this union; downstream consumers (UI, context tracker,
  agent lifecycle) read only the unified fields.
- **`ProviderCapabilities`** — the feature matrix: `supportsAskUserQuestion`,
  `supportsThinkingDelta`, `supportsContextUsageBreakdown`, `supportsMcpServers`,
  `supportsImages`. **Any call site that uses a provider-specific feature must
  check the flag first.** This is what stops Claude-only paths (thinking deltas,
  `AskUserQuestion`, the live context-usage breakdown) from leaking onto a
  provider that can't do them. See
  [`reference/server/services/providers/featureGuards.ts`](../reference/server/services/providers/featureGuards.ts).

## 3. The runtime

Two entry points feed one shared event consumer
([`reference/server/services/conversation/startConversation.ts`](../reference/server/services/conversation/startConversation.ts),
re-exported via `conversationAdapter.ts`):

- **start** — own a conversation row, resolve the provider, call `startTurn`,
  then consume the event stream.
- **resume** — read the stored `(provider, model, effort)` off the conversation
  row (deterministic, never inferred), call `sendTurnMessage` with the
  `resumeSessionId`, then consume.

The shared consumer iterates the `UnifiedMessage` stream and, per event:

- forwards thinking deltas to the thinking accumulator,
- **broadcasts the event to subscribed WebSocket clients** so the UI streams
  live,
- updates the context-usage tracker,
- captures the provider session id on first sight and fires `onSessionId`
  (persist it on the conversation row, broadcast `session-created`),
- on the terminal `result` event, fires `onResult`.

When the stream ends the caller fires the **`onComplete` lifecycle hook**. This
is the seam the orchestration loop plugs into for agent-run completion and
chaining — `buildAgentRunCompletionHandler` is wired in here (see
[`orchestration-loop.md`](./orchestration-loop.md)). The lifecycle hook
interface is in
[`reference/server/services/conversation/types.ts`](../reference/server/services/conversation/types.ts)
(`LifecycleHooks`); the composed hooks live in `streamingLifecycle.ts` +
`agentRunLifecycle.ts`.

**Abort and resume:**

- *Abort* marks any linked agent run `failed` synchronously (so the completion
  handler won't chain — see [`orchestration-loop.md`](./orchestration-loop.md))
  and aborts the provider turn. Active sessions are tracked in-memory in
  [`reference/server/services/conversation/sessionControl.ts`](../reference/server/services/conversation/sessionControl.ts).
- *Resume* can continue any conversation by id; the provider session id and
  model come from the stored row.

> **Reading the reference runtime:** the shared consumer
> ([`runStreamingLoop.ts`](../reference/server/services/conversation/runStreamingLoop.ts))
> predates full provider routing and is still Claude-shaped in spots — it
> references the Claude SDK message type and dual-emits a legacy `claude-response`
> alongside the provider-tagged `ai-response`. Build to the
> `LlmProvider`/`UnifiedMessage` contract as the target; treat the reference loop
> as a guide to the *responsibilities*, not a shape to copy verbatim.

## Transcript persistence — the single source of truth

The unified transcript is the canonical record of every conversation, and it
lives in the database, not in SDK files.

- **Two tables** (`reference/server/database/init.sql`): `messages` — one row per
  transcript entry, idempotent on `uuid`, with a monotonic `seq` per session;
  and `session_summaries` — a folded summary sidecar per session.
- **How entries get there:** the Claude SDK accepts a custom `sessionStore`, so
  the reference registers `SqliteSessionStore`
  ([`reference/server/services/sqliteSessionStore.ts`](../reference/server/services/sqliteSessionStore.ts))
  and the SDK writes through to SQLite. Providers without such a hook (Codex,
  OpenCode) **mirror** their events into the same tables explicitly. Either way
  the tables are authoritative; any JSONL the SDK writes on disk is private
  scratch the app never reads.
- **`loadTranscript`** reads these tables back into `UnifiedMessage[]` for
  history loads and resume; `project_key` is derived from the conversation's
  working directory.
- **For your build:** use whatever persistence you like, but keep the rule —
  *one normalized transcript store that is the single source of truth*, written
  as events stream and read on history load and resume.

## What to build

- [ ] The `LlmProvider` interface and a registry (explicit registration,
      resolve-by-name).
- [ ] The unified vocabulary: `ProviderRunOptions`, `ProviderRunResult`,
      `UnifiedMessage`, `ProviderCapabilities`.
- [ ] At least one concrete provider implementing the interface (three worked
      examples + the common-patterns guide are in
      [`extra/harnesses/`](../extra/harnesses/overview.md)).
- [ ] A streaming runtime: `start` + `resume` entry points feeding one event
      consumer that broadcasts live, persists the transcript, captures the
      session id, and fires `onComplete`.
- [ ] An in-memory active-session registry supporting abort.
- [ ] A transcript store (`messages` + `session_summaries`) as the single source
      of truth, with `loadTranscript`.
- [ ] Capability guards at every provider-specific call site.

## Reference map

| Concern | File |
|---|---|
| Provider interface | `reference/server/services/providers/types.ts` |
| Unified types + capabilities | `reference/shared/providers/types.ts` |
| Registry | `reference/server/services/providers/registry.ts` |
| Capability guards | `reference/server/services/providers/featureGuards.ts` |
| Start / resume + facade | `reference/server/services/conversation/startConversation.ts`, `conversationAdapter.ts` |
| Shared event consumer | `reference/server/services/conversation/runStreamingLoop.ts` |
| Lifecycle hooks (the `onComplete` seam) | `reference/server/services/conversation/{types.ts, streamingLifecycle.ts, agentRunLifecycle.ts}` |
| Abort / active sessions | `reference/server/services/conversation/sessionControl.ts` |
| Transcript store | `reference/server/services/sqliteSessionStore.ts` + `reference/server/database/init.sql` |

## Boundaries (not in this spec)

- Concrete harness integrations — auth, native event mapping, subprocess/server
  pooling, transcript mirroring → [`extra/harnesses/`](../extra/harnesses/overview.md).
- Which provider/model an agent uses, and where per-user credentials come from →
  [`prompt-and-model-customization.md`](../extra/prompt-and-model-customization.md)
  and [`auth-and-multi-user.md`](../extra/auth-and-multi-user.md). Core can
  hardcode a single provider.
- How a finished turn drives the next agent →
  [`orchestration-loop.md`](./orchestration-loop.md).
- Chat-only conveniences (slash commands, attachments, voice, title generation,
  the context-usage meter) → [`chat-ux.md`](../extra/chat-ux.md).
