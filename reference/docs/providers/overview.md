# Providers — the LlmProvider abstraction, registry, capability matrix

Bottega began Claude-only; it now runs three backends — **`anthropic`**
(Claude Agent SDK), **`openai`** (Codex SDK), and **`opencode`** (out-of-process
HTTP). Everything above the SDK call speaks a **provider-neutral vocabulary**
defined in `shared/providers/`; no layer above a provider's own folder imports a
vendor SDK directly.

## The `LlmProvider` interface

The server-side contract is `LlmProvider` (`server/services/providers/types.ts:29`):
`getCapabilities()`, `startTurn(options)`, `sendTurnMessage({…, resumeSessionId})`,
`loadTranscript(...)`, `abortTurn(sessionId)`. `startTurn`/`sendTurnMessage`
return a `ProviderRunResult` — an **`AsyncIterable<UnifiedMessage>`** plus a
`providerSessionId$` promise (resolved when the wire session id is first seen),
an `abort()`, and the subprocess `pid` for audit logs. Each provider lives in its
own folder: `anthropic/`, `openai/`, `opencode/`.

## `UnifiedMessage` — the neutral stream

Both providers' mappers (`anthropic/mapMessage.ts`, `openai/mapEvent.ts`,
`opencode/mapEvent.ts`) funnel raw SDK events into one discriminated union,
`UnifiedMessage` (`shared/providers/types.ts:198`): `user | assistant |
assistant_thinking | tool_use | tool_result | system | result | stream_delta`.
Every variant carries `provider`, `providerSessionId`, and an untouched `raw` —
anyone reading `raw` is implicitly coupled to a provider, which is the seam we're
trying to erase. Models + efforts are per-provider opaque unions
(`shared/providers/models.ts`); there is **no common subset**.

## The capability matrix

`CAPABILITIES_BY_PROVIDER` (`shared/providers/capabilities.ts:16`) is the **one**
place that records which provider supports which feature: `supportsAskUserQuestion`,
`supportsThinkingDelta`, `supportsContextUsageBreakdown`, `supportsMcpServers`,
`supportsImages`. Ask-user and MCP are true for all three providers: Bottega
implements them above the harness. Thinking deltas, detailed context usage and
images remain provider-specific. Call sites that use a gated feature
*must* check the flag via the `featureGuards.ts` helpers
(`hasCapability` / `withCapability` / `assertCapability`) — this is what keeps
Codex/OpenCode turns from triggering Claude-only behaviour. When you add a
provider-specific feature, add a flag here rather than branching on the provider
name. The per-feature breakdown lives in
[`../conversations/features.md`](../conversations/features.md).

## The registry

`registry.ts` maps a `Provider` name → singleton instance. All three register
unconditionally at module load (`registry.ts:23`); `getProvider(name)`
(`registry.ts:39`) is the grep-able resolution point. There is a parallel
**credential** registry — see [`credentials.md`](./credentials.md).

## The inline-Claude-fork nuance (important)

The `LlmProvider` abstraction exists, but **the conversation layer has not been
fully refactored onto it.** `startConversation` (the live entry point,
`server/services/conversation/startConversation.ts:60`) **forks on provider**:

- `provider === 'openai'` → `startCodexConversation(...)` (`:69`)
- `provider === 'opencode'` → `startOpenCodeConversation(...)` (`:72`)
- otherwise → the **Anthropic path is inlined here**, calling the Claude SDK's
  `query()` directly rather than going through `anthropicProvider.startTurn()`.

So today `AnthropicProvider` is invocable and unit-tested, but the orchestrator
still calls `query()` inline for Claude; `getProvider()` is used at runtime only
for `abortTurn` (`conversation/sessionControl.ts`). The Codex/OpenCode entry
points *do* call `codexProvider`/`openCodeProvider` directly. Keep this in mind:
to change Claude streaming behaviour, edit `startConversation.ts`, not
`anthropic/index.ts`. See
[`../conversations/lifecycle-and-streaming.md`](../conversations/lifecycle-and-streaming.md).

## Per-provider deep dives

| Doc | Provider |
|---|---|
| [`claude.md`](./claude.md) | Anthropic over `query()`, the SQLite sessionStore, OAuth login, 401 recovery |
| [`codex.md`](./codex.md) | Codex spawn-per-turn `Thread`, device-auth, `CODEX_HOME` |
| [`opencode.md`](./opencode.md) | out-of-process HTTP+SSE, the per-user server pool |
| [`credentials.md`](./credentials.md) | the per-user credential-store abstraction |
| [`connection-ui.md`](./connection-ui.md) | the connect panels + model pickers |

## Key files

- `server/services/providers/types.ts` — the `LlmProvider` interface.
- `shared/providers/types.ts` — `Provider`, `UnifiedMessage`, `ProviderRunOptions`,
  `ProviderRunResult`, `ProviderCapabilities`.
- `shared/providers/capabilities.ts:16` — `CAPABILITIES_BY_PROVIDER` (the matrix).
- `shared/providers/models.ts` — per-provider model/effort lists + type guards.
- `server/services/providers/registry.ts:39` — `getProvider`.
- `server/services/providers/featureGuards.ts` — `hasCapability` / `assertCapability`.
- `server/services/conversation/startConversation.ts:60` — the live provider fork
  (Claude inlined; Codex/OpenCode delegated).
