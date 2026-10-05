# Conversation lifecycle & streaming (server)

How a turn runs end-to-end: start vs resume, the unified SDK iterator loop, the
in-memory session maps, the composed completion hooks, and who marks a turn
failed. Provider dispatch and the inline-Claude nuance are in
[`../providers/overview.md`](../providers/overview.md).

## The facade

`conversationAdapter.ts` is a thin re-export — the implementation lives in
`server/services/conversation/*`. Callers (routes, `agentRunner`, the WS
dispatcher, tests) import `startConversation` / `sendMessage` / `abortSession` /
`resolveAskUserQuestion` from the adapter and never reach into submodules.

## start vs resume

- **`startConversation(target, message, options)`**
  (`conversation/startConversation.ts`) — new conversation. `target` is a
  `ConversationTarget`: `{kind:'task', taskId}` or `{kind:'epic', epicId}` —
  `resolveConversationScope` (`conversation/conversationScope.ts:44`) turns it
  into the owner ids, the project and the cwd (a task's worktree when one
  exists; an epic always runs in the project's main checkout). Forks on
  `options.provider` to Codex/OpenCode for either owner kind; the Anthropic path is inlined and calls
  the SDK `query()` directly. Creates the `conversations` row, builds the SDK
  env, and returns `{ conversationId, claudeSessionId }` only after the **first
  session_id** is observed (the `onSessionId` hook).
- **`sendMessage(conversationId, message, options)`** — resume. Derives the
  target from the row (task or epic) and forks on
  the **conversation row's `provider`** (NOT NULL; the source of truth on resume),
  re-resolves model/effort from the resuming user's settings
  (`resolveResumeModelEffort`), and resumes via `claude_conversation_id`.
  Transcripts load from `sqliteSessionStore`; the SDK then materializes them
  into a **temporary `CLAUDE_CONFIG_DIR`** (`/tmp/claude-resume-<uuid>/`) for
  the subprocess, which is why the operator's plugins are passed explicitly on
  every turn (see [`features.md`](./features.md#operator-plugins-on-every-turn)).

Both share one model invariant: **every turn runs on an explicit model** resolved
by the caller — there is no SDK default (`:91` throws if absent).

## Deferred prompt + MCP readiness

Both paths use an async generator (`deferredPrompt`) that **parks on an
`mcpReady` promise** before yielding the user message: the SDK subprocess starts
first so MCP servers begin connecting, `waitForMcpServers()` polls them ready
(`conversation/mcpReadiness.ts`), then the message is delivered — so Claude's
first turn has every MCP tool available. On resume with an
`askUserQuestionToolResult`, the generator yields a `tool_result` block instead
of plain text (Anthropic requires it when the prior assistant turn ended on an
unanswered `tool_use`).

## `runStreamingLoop` — the one iterator consumer

`conversation/runStreamingLoop.ts:90` is the single `for await` over the SDK
iterator, shared by start and resume. It owns: `stream_event` → thinking
accumulator, `mirror_error` filtering, assistant patching + context-usage
tracking, the `claude-response`/`ai-response` dual-emit broadcast, the one-shot
`session-created` broadcast, `claude-status` tokens (start-only), and first
`session_id` capture via `onSessionId`. It does **not** own session creation, DB
writes, `claude-complete`/`claude-error`, or `onComplete` dispatch — those differ
between start and resume and live at the call sites.

Two non-obvious behaviours:

- **`onResult` abort-after-result** (`:206`): once the SDK emits `result`, the
  caller aborts the subprocess so a leftover `assistantAutoBackgrounded` Bash
  can't pin the iterator open forever. An iterator error *after* `result` is
  swallowed (`:218`) and the loop returns cleanly so the success-path lifecycle
  still runs; errors *before* `result` propagate.
  - **Corollary — background tasks don't survive a turn.** Because this abort
    fires at every `result`, a backgrounded shell (`Bash` `run_in_background`)
    or a `Monitor` until-loop is killed at turn end and never delivers its
    cross-turn `<task-notification>`; the conversation would deadlock waiting
    for a completion that can't arrive. SDK 2.1.198's "amber sentinel" actively
    steers the agent toward that pattern (it blocks inline `sleep >= 25s`), so
    we disable it two ways: (1) `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` on the
    SDK query env (`buildClaudeSdkEnv`, `claudeCredentials.ts`), and (2) a
    version-proof `PreToolUse` **hook** (`conversation/backgroundTaskGate.ts`,
    wired in `sdkOptions.ts`) that forces `Bash` `run_in_background` to the
    foreground and denies `Monitor`. Note the gate is a PreToolUse **hook**, not
    `canUseTool`: under `permissionMode: 'bypassPermissions'` (every turn) the
    SDK auto-approves tool calls **without** consulting `canUseTool` (it emits a
    `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning), whereas PreToolUse hooks fire
    for every tool. `buildCanUseTool` also carries the same normalization as a
    belt-and-suspenders for any future non-bypass mode. Long commands run in the
    foreground and complete inside a single turn.
- **In-band 401** (`isInBandAuthError`, `:55`): newer SDKs deliver a 401 as data
  (synthetic assistant + `SDKResultError`) instead of throwing. The loop returns
  `authError: true`; the caller synthesises the equivalent throw so the one 401
  recovery path runs uniformly (`startConversation.ts:292`). Recovery =
  recycle the dead subprocess and resume **once** (`retryOn401.ts`, gated by
  `isAuthRetry`), kept transparent (no `claude-error` broadcast).

## In-memory session state

`conversation/sessionState.ts` holds module-level singleton Maps — **never wrap
them in factories**, the cross-module closures depend on stable identities:

- `activeSessions` (sessionId → instance, abortController, ownership metadata) —
  drives WS auth (`abort-session`, `check-session-status`) and `/api/streaming-sessions`.
- `activeStreamingSessions` (sessionId → {taskId, conversationId}) — the live-badge
  source; populated on `streaming-started`, emptied on `streaming-ended`.
- `pendingAskUserQuestions` (conversationId → parked callback) — see
  [`features.md`](./features.md).

## Completion hooks & the failure rule

`composeOnComplete(ctx)` (`startConversation.ts:50`) chains two handlers via
`composeAsync` (each awaited, a throw is logged not propagated): `handleStreamingComplete`
(broadcast `streaming-ended` on both channels + map cleanup,
`streamingLifecycle.ts`) then `buildAgentRunCompletionHandler` (agent-run status
/ chaining / push — see [`../agents/agentic-loop.md`](../agents/agentic-loop.md)).

`abortSession` records **user intent before transport is aborted**, through the
conversation's owner adapter. Task runs retain their terminal `failed` Stop
behavior. Epic runs become `blocked`; their completion hook is inert, and the
next message marks that same run `running` and releases its orchestration block.
Technical provider failures remain separate: terminal in-band errors are
pre-marked `failed`, while the established SDK-error recovery path is unchanged.
For OpenCode, Stop also dispatches `getProvider(...).abortTurn()` to issue the
out-of-process `session.abort()`.

## Key files

- `server/services/conversationAdapter.ts` — public facade (re-exports only).
- `server/services/conversation/startConversation.ts:60` — `startConversation`; `:376` `sendMessage`.
- `server/services/conversation/runStreamingLoop.ts:90` — the unified iterator consumer.
- `server/services/conversation/streamingLifecycle.ts` — `streaming-started/ended` + `composeAsync`.
- `server/services/conversation/sessionControl.ts` — `abortSession` (owner-specific user interruption).
- `server/services/conversation/agentRunLifecycle.ts` — turn-start and turn-end owner dispatch; technical-error failure marking.
- `server/services/conversation/sessionState.ts` — the three singleton Maps.
- `server/services/conversation/retryOn401.ts` — `isClaudeAuthError`, the 1-retry backoff.
- `server/routes/conversations.ts` — the REST surface (POST start, the `202` message bridge).
