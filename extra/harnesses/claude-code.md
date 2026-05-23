# Harnesses — Claude Agent SDK

The Claude Code integration: a `LlmProvider` wrapping the
`@anthropic-ai/claude-agent-sdk` `query()` call. It is the richest of the three
harnesses — it is the only one in the reference that sets every
`ProviderCapabilities` flag `true` — so most of the genuinely hard integration
problems were solved here first. Read [`overview.md`](./overview.md) for the
six shared patterns; this file is the Claude-specific substance.

`ProviderCapabilities` for `anthropic`: `supportsAskUserQuestion`,
`supportsThinkingDelta`, `supportsContextUsageBreakdown`, `supportsMcpServers`,
`supportsImages` — all `true`
([`capabilities.ts`](../../reference/shared/providers/capabilities.ts)).

## What it adds

A working Claude harness, plus the solutions to the problems that only show up
once you run the SDK against a long-lived multi-user server:

- Per-user OAuth credentials and an in-app browser-less login flow.
- SQLite (not the SDK's JSONL) as the single source of truth, via the SDK's
  `sessionStore` hook.
- A clean translation from `ProviderRunOptions` to `query()` options.
- A mid-turn `AskUserQuestion` tool that parks the SDK until the user answers.
- Automatic recovery from the stale-subprocess **401**.
- Thinking-delta accumulation (the final message ships empty thinking).
- MCP readiness gating and video-flag injection.

> The reference still calls `query()` from the conversation runtime
> (`startConversation.ts`) rather than fully through `AnthropicProvider`; the
> provider wrapper
> ([`anthropic/index.ts`](../../reference/server/services/providers/anthropic/index.ts))
> is the target shape. Build to the provider; treat the runtime as the catalogue
> of responsibilities the provider must own.

## Credentials: per-user OAuth + in-app login

Auth is a per-user **OAuth token** (a subscription credential, scoped to
inference), not an API key. The store is
[`reference/server/services/claudeCredentials.ts`](../../reference/server/services/claudeCredentials.ts),
fronted for the registry by
[`credentials/anthropic.ts`](../../reference/server/services/credentials/anthropic.ts).

- **On-disk layout.** One token file per user at
  `~/.config/bottega/users/<userId>/oauth_token`, written `0600` in a `0700`
  dir. `read` validates ownership and mode before trusting the file — group/other
  access throws. `getStatus` returns authenticated/missing plus a fingerprint
  (last 6 chars) for the settings UI.
- **`buildSdkEnv` is the load-bearing bit.** It returns a *sparse* env —
  `CLAUDE_CODE_OAUTH_TOKEN` set to the user's token, `HOME`/`PATH` passed
  through, and `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` explicitly set to
  `undefined`. Stripping those is mandatory: per Claude's auth precedence they
  outrank `CLAUDE_CODE_OAUTH_TOKEN`, so an inherited key in `process.env` would
  silently win over the per-user token. The orchestrator injects this env into
  `ProviderRunOptions.env`.
- **Login flow** ([`claudeAuthFlow.ts`](../../reference/server/services/claudeAuthFlow.ts),
  routes in [`routes/claudeAuth.ts`](../../reference/server/routes/claudeAuth.ts)).
  There is no API-key paste box; the user runs `claude setup-token` *through the
  server*. The flow spawns the CLI under a real PTY (`node-pty`) so the Ink app
  runs, then:
  - forces the manual code flow by **shimming `open`/`xdg-open` to no-ops** on
    the subprocess `PATH`, so the CLI can't open a browser and instead prints a
    paste-the-code URL (`redirect_uri=platform.claude.com`);
  - forces `COLUMNS=1000` so the OAuth URL isn't hard-wrapped, then scrapes it
    from PTY output — stripping ANSI, re-splicing soft wraps, and refusing a URL
    that lacks a `state=` param (it isn't complete yet);
  - on `/complete`, writes the submitted code to the PTY, scrapes the
    `sk-ant-oat…` token from output, and persists it via the store.
  - Routes: `POST /start` → `{ loginSessionId, authUrl }`, `POST /complete`
    `{ loginSessionId, code }`, `POST /cancel`, `GET /status`, `DELETE /`. Login
    sessions are per-user, single-flight (a new start replaces the old), and TTL'd.

## SQLite as the SDK's `sessionStore`

The single biggest reason Claude was easy to make authoritative: the SDK accepts
a custom `sessionStore`, so the reference registers `SqliteSessionStore`
([`sqliteSessionStore.ts`](../../reference/server/services/sqliteSessionStore.ts))
in the `query()` options and the SDK **writes through to SQLite itself** —
`append`/`load`/`listSessions`/`delete`/etc. for every transcript entry. No
mirror code, unlike Codex/OpenCode. The SDK still drops its own `.jsonl` under
`CLAUDE_CONFIG_DIR`, but that is private scratch the app never reads (the only
file aware of JSONL is the one-shot import migration).

Two options make this correct rather than merely wired:

- `sessionStoreFlush: 'eager'` — without it the SDK's mirror batcher buffers up
  to ~500 entries / 1 MiB before draining, so a mid-turn reload of
  `/api/conversations/:id/messages` returns empty history even though the WS
  stream is live. Eager flush keeps SQLite in lock-step with the stream.
- `sessionStore` is set in
  [`conversation/sdkOptions.ts`](../../reference/server/services/conversation/sdkOptions.ts)
  (`mapOptionsToSDK`), the same place `resume`, `model`, system prompt, etc. are
  assembled.

## Building `query()` options from `ProviderRunOptions`

`mapOptionsToSDK`
([`sdkOptions.ts`](../../reference/server/services/conversation/sdkOptions.ts),
re-exported via
[`anthropic/sdkOptionsBuilder.ts`](../../reference/server/services/providers/anthropic/sdkOptionsBuilder.ts))
is the one translation point. Notable choices:

| Unified option | → SDK | Note |
|---|---|---|
| `model` | `model` | always set; never defaulted (core requires explicit model) |
| `effort` | `effort` | only when present |
| `permissionMode` | `permissionMode` | default `bypassPermissions` (write files without prompting); omitted when `'default'` |
| `customSystemPrompt` | `systemPrompt` (string) | full override; else `{ type: 'preset', preset: 'claude_code', append: … }` |
| `disallowedTools` | `disallowedTools` | only when non-empty |
| `env` | `env` | the per-user sparse env from `buildSdkEnv` |
| `resumeSessionId` | `resume` | resume an existing Claude session |

Two always-on flags exist purely to make thinking work: `includePartialMessages:
true` and `thinking: { type: 'adaptive', display: 'summarized' }` — see the
thinking section. The system prompt always gets an appended note capping
`AskUserQuestion` at 4 questions, because the SDK hard-validates
`min(1).max(4)` and a 5th question fails *before* `canUseTool` runs, leaving a
broken widget. The prompt itself is passed as a single-message async generator;
`prompt: null` is only used when re-driving an `AskUserQuestion` tool result.

## `AskUserQuestion` — the mid-turn human gate

The one tool that pauses an agent and waits for a person. Implemented via the
SDK's `canUseTool` callback
([`conversation/askUserQuestion.ts`](../../reference/server/services/conversation/askUserQuestion.ts)):

- `buildCanUseTool({ conversationId, broadcastFn })` returns a callback. Non-
  `AskUserQuestion` tools pass straight through (`{ behavior: 'allow' }`) so
  `bypassPermissions` semantics survive.
- For `AskUserQuestion` the callback returns a **Promise that never resolves on
  its own** — the SDK's contract is that it may stay pending indefinitely, which
  pauses the turn. The pending `{ resolve, reject, questions, toolUseId }` is
  parked in an in-memory `pendingAskUserQuestions` map keyed by conversation, and
  an `awaiting-user-answer` WS message is broadcast so the UI shows the wizard.
- When the user answers (over WS), `resolveAskUserQuestion` re-keys the answers
  by question text, re-broadcasts `streaming-started`, and resolves the parked
  promise with `{ behavior: 'allow', updatedInput: { questions, answers } }` —
  the SDK resumes the same turn.
- **Restart fallback.** If the server restarted while parked, the in-memory
  callback is gone. The code then walks SQLite for the most recent
  `AskUserQuestion` `tool_use` with no matching `tool_result`, and **resumes the
  session injecting a synthetic `tool_result`** as the first prompt block —
  because Anthropic's API requires every `tool_use` to be answered by a
  `tool_result` in the next user turn (a plain text message would error). The
  synthetic content matches the exact string the SDK writes so the frontend
  parser recognises it.
- This whole path is gated on `supportsAskUserQuestion`; `assertCapability` is
  the guard that keeps it off non-Claude turns.

## The stale-subprocess 401 recovery

The sharpest Claude-specific bug, and worth understanding before reimplementing
([`conversation/retryOn401.ts`](../../reference/server/services/conversation/retryOn401.ts),
recovery in
[`conversation/startConversation.ts`](../../reference/server/services/conversation/startConversation.ts)).

The SDK spawns a `claude` subprocess per `query()` and that subprocess loads its
credential **once, at startup**. Because we authenticate with a static
`CLAUDE_CODE_OAUTH_TOKEN` (and the SDK strips the refresh token from the sandbox
it copies), a long turn whose derived credential ages out mid-stream has no
in-process refresh path — every later API call returns `401 Invalid
authentication credentials`. The on-disk token is still valid; a *fresh*
subprocess just works. So:

1. The 401 arrives in **two shapes** and both must be caught: an SDK *throw*
   (`Failed to authenticate. API Error: 401 …`), and an **in-band** `result`
   message with `is_error: true` and a 401 in `errors[]` (newer SDK versions).
   `isClaudeAuthError` matches both message forms.
2. The in-band case is **normalised into a throw** — the streaming loop detects
   the 401 result and synthesises the equivalent error — so a single catch-block
   recovery path handles both representations uniformly.
3. On catch: tear down the dead subprocess, wait `AUTH_RETRY_BACKOFF_MS`, and
   resume the conversation **once** in a fresh subprocess (`isAuthRetry: true`
   guards against a loop; `MAX_AUTH_RETRIES = 1`). It is transparent — no
   `claude-error` is broadcast.
4. Skip the retry for `AskUserQuestion`-resume turns (a tool-result re-drive),
   and only retry once a session id exists (a pre-session failure is a genuine
   auth problem, surfaced normally).

## Thinking-delta accumulation

Since SDK 0.2.x the final `assistant` message ships **empty** `thinking` blocks
— only the encrypted signature survives — and the plaintext arrives solely as
raw `thinking_delta` stream events. So the two always-on options above are
required, and a `ThinkingAccumulator`
([`conversation/thinkingPatcher.ts`](../../reference/server/services/conversation/thinkingPatcher.ts))
collects deltas per `(messageId, blockIndex)` as they stream, then **patches**:
the assembled message before broadcast (so the live widget renders), and the
SQLite transcript after the turn (so reloaded history shows thinking too). This
is the mechanism behind `supportsThinkingDelta: true`; the unified
`stream_delta` message is what the accumulator unwraps.

## MCP readiness + video-flag injection

[`conversation/mcpReadiness.ts`](../../reference/server/services/conversation/mcpReadiness.ts),
config loader in `sdkOptions.ts` (`loadMcpConfig`):

- `loadMcpConfig` reads MCP servers from `~/.claude.json` (global + per-cwd
  project entries) and sets them as the SDK's `mcpServers`.
- `injectVideoRecording` mutates the Playwright MCP server's args to enable the
  `devtools` capability and an output dir when a video config is present —
  that's how the browser-recording tools become available.
- `waitForMcpServers` polls `queryInstance.mcpServerStatus()` with backing-off
  delays until no server is `pending`, then tries to `reconnectMcpServer` any
  that `failed`. Run it fire-and-forget so a slow MCP server doesn't block the
  turn from streaming. This is all behind `supportsMcpServers: true`.

## What to build

- [ ] An `AnthropicProvider` implementing `LlmProvider`: wrap `query()`,
      stream-map its iterator through `mapMessage`, resolve `providerSessionId$`
      off the first `session_id`, expose `pid` and `abort()`.
- [ ] A per-user OAuth credential store (`0600` token, ownership/mode checks)
      whose `buildSdkEnv` sets `CLAUDE_CODE_OAUTH_TOKEN` and nulls the global
      `ANTHROPIC_*` keys.
- [ ] The PTY-driven `setup-token` login flow (browser shim, `COLUMNS=1000`, URL
      scrape, code submit, token persist) and its `start/complete/cancel/status`
      routes.
- [ ] `SqliteSessionStore` registered as the SDK `sessionStore`, with
      `sessionStoreFlush: 'eager'`.
- [ ] `mapOptionsToSDK` translating `ProviderRunOptions` → `query()` options,
      with the preset/override system prompt and the 4-question cap note.
- [ ] `canUseTool`-based `AskUserQuestion` parking + WS resolve + restart-time
      synthetic `tool_result` fallback.
- [ ] The 401 recovery: catch both thrown and in-band 401s, one transparent
      fresh-subprocess retry.
- [ ] `ThinkingAccumulator` with `includePartialMessages` + summarized thinking,
      patching live broadcast and stored transcript.
- [ ] MCP config load, video-flag injection, and `waitForMcpServers` readiness.

## Reference map

| Concern | File |
|---|---|
| Provider wrapper | `reference/server/services/providers/anthropic/index.ts` |
| Mapper | `reference/server/services/providers/anthropic/mapMessage.ts` |
| `query()` options builder | `reference/server/services/conversation/sdkOptions.ts` (+ `anthropic/sdkOptionsBuilder.ts`) |
| Transcript via sessionStore | `reference/server/services/sqliteSessionStore.ts`, `anthropic/sessionStore.ts` |
| Credentials | `reference/server/services/claudeCredentials.ts`, `credentials/anthropic.ts` |
| Login flow + routes | `reference/server/services/claudeAuthFlow.ts`, `reference/server/routes/claudeAuth.ts` |
| AskUserQuestion | `reference/server/services/conversation/askUserQuestion.ts` |
| 401 recovery | `reference/server/services/conversation/retryOn401.ts` + `startConversation.ts` |
| Thinking deltas | `reference/server/services/conversation/thinkingPatcher.ts` |
| MCP readiness / video | `reference/server/services/conversation/mcpReadiness.ts` |

## Boundaries (not in this spec)

- The `LlmProvider` contract, unified vocabulary, runtime, and transcript rule →
  [`harness-contract.md`](../../core/harness-contract.md).
- The six patterns shared with the other harnesses → [`overview.md`](./overview.md);
  the contrasting integrations → [`codex.md`](./codex.md),
  [`opencode.md`](./opencode.md).
- App-level auth (JWT / API keys), and how a model/effort is chosen per agent →
  [`auth-and-multi-user.md`](../auth-and-multi-user.md) and
  [`prompt-and-model-customization.md`](../prompt-and-model-customization.md).
- The chat-side rendering of thinking, AskUserQuestion, and the context meter →
  [`chat-ux.md`](../chat-ux.md).
</content>
