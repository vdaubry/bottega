# Claude (Anthropic) provider — query(), SQLite sessionStore, OAuth, 401 recovery

The Anthropic backend runs over the **Claude Agent SDK**
(`@anthropic-ai/claude-agent-sdk`), which spawns a `claude` CLI subprocess per
`query()` call. This is the default and most fully-featured provider — every
capability flag is `true` (see [`overview.md`](./overview.md)).

> **Where the live Claude code is.** `AnthropicProvider`
> (`server/services/providers/anthropic/index.ts`) wraps `query()` behind
> `LlmProvider`, but the **conversation orchestrator still calls `query()`
> inline** in `startConversation.ts` rather than through this class (the
> inline-fork nuance in [`overview.md`](./overview.md)). The provider class is
> unit-tested and ready, but to change live Claude streaming, edit
> `conversation/startConversation.ts`.

## SQLite as the transcript source of truth

We register a **custom `sessionStore`** with the SDK — `SqliteSessionStore`
(`server/services/sqliteSessionStore.ts`). Instead of the SDK reading/writing its
own JSONL transcript files, it calls our `append/load/listSessions/…` methods,
which persist to the `messages` / `session_summaries` tables. **SQLite is the
single source of truth for conversation messages.** The SDK still writes its
private `.jsonl` files under `CLAUDE_CONFIG_DIR`, but **runtime code never reads
them** — the only consumer of JSONL is the one-shot import migration. On
**resume** the SDK materializes `sqliteSessionStore.load()` into a temporary
`CLAUDE_CONFIG_DIR` (`/tmp/claude-resume-<uuid>/`) for the subprocess, which is
why the operator's plugins are passed explicitly on every turn — see
[`../conversations/features.md`](../conversations/features.md#operator-plugins-on-every-turn). The
cross-provider read path `anthropic/sessionStore.ts` (`loadAnthropicTranscript`)
also goes through SQLite (`sqliteSessionStore.load`), mapping each entry to
`UnifiedMessage[]`. Full schema in
[`../architecture/data-model.md`](../architecture/data-model.md).

## Per-user OAuth (the PTY login flow)

Auth is a per-user **`CLAUDE_CODE_OAUTH_TOKEN`** stored at
`~/.config/bottega/users/{userId}/oauth_token` (`claudeCredentials.ts`). There is
no global Anthropic key in play — `buildClaudeSdkEnv` (`claudeCredentials.ts:241`)
hands the SDK only `CLAUDE_CODE_OAUTH_TOKEN` + `HOME` + `PATH`, with the global
auth env keys stripped (see [`credentials.md`](./credentials.md)).

The token is minted in-app, not by pre-provisioning a key. `claudeAuthFlow.ts`
spawns `claude setup-token` under a **`node-pty`** PTY (the CLI is an Ink app that
needs raw-mode stdin), with browser-opening commands shimmed out so the CLI falls
back to the **manual code flow**:

1. `startClaudeAuthLogin(userId)` (`claudeAuthFlow.ts:228`) spawns the PTY, scrapes
   the OAuth authorize URL out of the (ANSI-noisy, soft-wrapped) terminal output,
   and returns it to the UI.
2. The user opens the URL, authorizes, pastes the code back.
3. `completeClaudeAuthLogin(userId, sessionId, code)` (`claudeAuthFlow.ts:427`)
   writes the code into the PTY, captures the emitted `sk-ant-oat…` token, and
   persists it via `writeClaudeOAuthToken`.

Login sessions are keyed per-user with a 10-min TTL; starting a new one cancels
the old. UI side is `ClaudeAuthContext` + `ClaudeAuthPanel` (see
[`connection-ui.md`](./connection-ui.md)).

## The stale-subprocess 401 recovery (non-obvious)

The CLI subprocess loads its credential **once at startup**. Because we
authenticate with a static OAuth token (the SDK strips the refresh token out of
the sandbox it copies), a long turn can age out mid-stream and every subsequent
API call returns `401 Invalid authentication credentials` — even though the
on-disk token is still valid and a *fresh* subprocess works fine.

`retryOn401.ts` handles this: `isClaudeAuthError(error)`
(`conversation/retryOn401.ts:28`) pattern-matches that specific 401, and on a
match the orchestrator tears the dead subprocess down and **resumes the
conversation once** in a new one (`MAX_AUTH_RETRIES = 1`, a short backoff). The
retry is wired in at `startConversation.ts:340` / `:623` and detected in
`runStreamingLoop.ts:60`. This is **not** a generic retry — only this auth error
recycles the subprocess; any other failure propagates.

## Models & options

Anthropic models are the `sonnet` / `opus` / `fable` family aliases (no Haiku),
resolved by the SDK's bundled CLI (today: Sonnet 5.5, Opus 5.5, Fable 5.1); efforts are
`low|medium|high|xhigh|max` (`shared/providers/models.ts:23-26`). The
options-builder (`anthropic/sdkOptionsBuilder.ts`) maps the neutral
`ProviderRunOptions` (cwd, model, effort, system prompt, permission mode,
disallowed tools, env) into the SDK's `query({ options })` shape.

## Key files

- `server/services/providers/anthropic/index.ts:53` — `AnthropicProvider`
  (wraps `query()`; not yet on the live path).
- `server/services/providers/anthropic/sessionStore.ts` — `loadAnthropicTranscript`.
- `server/services/sqliteSessionStore.ts` — the SDK `sessionStore` backend.
- `server/services/claudeCredentials.ts:241` — `buildClaudeSdkEnv`; token I/O + security checks.
- `server/services/claudeAuthFlow.ts:228` — `startClaudeAuthLogin`; `:427` `completeClaudeAuthLogin`.
- `server/services/conversation/retryOn401.ts:28` — `isClaudeAuthError` (the 401-recovery guard).
- `server/routes/claudeAuth.ts` — the `/api/claude-auth` start/complete/status/disconnect endpoints.
