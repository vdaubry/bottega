# Harnesses — Shared implementation patterns

The core spec defines the [`harness-contract`](../../core/harness-contract.md):
the `LlmProvider` interface, the unified vocabulary, and the runtime that
consumes them. This file is about the other side of that seam — the patterns
**every** concrete provider repeats when wrapping a real coding tool. It is
deliberately more technical than core: these are the integration problems the
reference solved, written down so you don't rediscover them per provider.

Three providers ship in the reference and are worked through in their own files:

| Provider | SDK shape | File |
|---|---|---|
| Claude Agent SDK | subprocess per `query()` | [`claude-code.md`](./claude-code.md) |
| OpenAI Codex | subprocess per turn | [`codex.md`](./codex.md) |
| OpenCode | long-lived `opencode serve` over HTTP | [`opencode.md`](./opencode.md) |

Read this for the shared spine; read a sibling for one tool's specifics.

## What it adds

Nothing user-visible. A harness is pure plumbing behind `LlmProvider`. The
"feature" is that the orchestration loop, the agents, the UI, and the transcript
store keep working **unchanged** when you add a tool — because each tool is
forced through six shared patterns:

1. Explicit registration in the provider registry.
2. A mapper that turns native SDK events into `UnifiedMessage`.
3. Transcript mirroring into the one canonical store.
4. A per-provider credential store behind the credential registry.
5. A subprocess/server lifecycle the provider owns and can abort.
6. A capability matrix + guards that gate provider-specific features.

Get these six right and the contract is satisfied.

## 1. Registration — explicit, greppable

A provider is a singleton implementing `LlmProvider`; it registers itself by
name in a `Map`. The reference wires all three in *one* place at module load —
[`reference/server/services/providers/registry.ts`](../../reference/server/services/providers/registry.ts)
— rather than auto-discovering from the filesystem. The payoff is that
`getProvider(name)` has a finite, grep-able import graph: the provider modules
never reach back into the registry. `registerProvider` throws on a duplicate
name and on a `provider.name` that disagrees with its key, so a copy-paste
mistake fails at boot, not mid-turn. The `Provider` union
(`'anthropic' | 'openai' | 'opencode'` in
[`reference/shared/providers/types.ts`](../../reference/shared/providers/types.ts))
is the closed set of names.

The credential registry mirrors this exactly — same shape, separate map — see
[`reference/server/services/credentials/registry.ts`](../../reference/server/services/credentials/registry.ts).

## 2. The mapper layer — native events → `UnifiedMessage`

This is the heart of a provider and the only place in the codebase allowed to
know an SDK's wire shape. Everything above it reads the unified discriminated
union; anyone who must reach a provider-specific field reads `.raw`.

- **One function, exhaustive switch.** Map the native event's discriminator to
  one *or more* `UnifiedMessage`s. Claude's `mapMessage`
  ([`anthropic/mapMessage.ts`](../../reference/server/services/providers/anthropic/mapMessage.ts))
  fans a single SDK `assistant` message into an `assistant` plus child
  `tool_use`/`assistant_thinking` messages, and a `user` whose content is purely
  tool-results into `tool_result`s. Codex and OpenCode keep mapper *factories*
  (`createOpenCodeEventMapper(sessionId)`,
  [`opencode/mapEvent.ts`](../../reference/server/services/providers/opencode/mapEvent.ts))
  because their per-event SSE shapes need the session id threaded in.
- **Default branch never drops.** Unknown variants map to a `system` message
  with `subtype: 'unknown'` so the stream keeps flowing when an SDK adds a
  variant you haven't handled yet. Add it explicitly once its shape is known.
- **Stable ids.** Derive `id` from the SDK's own id when present; synthesise a
  deterministic one (e.g. `${parentId}:tool:${toolUseId}`) for child blocks so
  the mirror's `uuid` upsert stays idempotent across re-emits.
- **Thread `providerSessionId` in.** The mapper takes it as an argument and
  stamps every message with it; the provider captures the wire id off the first
  event and resolves `providerSessionId$`.

Each variant carries `provider`, `id`, `providerSessionId`, `raw`, and (set by
the writer, not the mapper) `seq`. The full union is documented in core —
don't redefine it per provider.

## 3. Transcript mirroring — one source of truth, two roads to it

Core's rule: a **single normalized transcript store** is authoritative; any
JSONL the SDK leaves on disk is private scratch the app never reads. There are
two ways a provider gets its events into that store, and both land in the same
`messages` / `session_summaries` tables behind
[`reference/server/services/sqliteSessionStore.ts`](../../reference/server/services/sqliteSessionStore.ts).

- **Write-through (Claude).** The Claude SDK accepts a custom `sessionStore`
  option, so the reference hands it `SqliteSessionStore` and the SDK *itself*
  appends every entry to SQLite as the turn streams. No separate mirror code —
  see [`claude-code.md`](./claude-code.md).
- **Explicit mirror (Codex, OpenCode).** These SDKs have no such hook, so the
  provider mirrors each emitted `UnifiedMessage` into the same tables by hand.
  The mirror converts the unified message back into the on-the-wire entry shape
  the reader expects, then calls `sqliteSessionStore.append(...)` — idempotent
  on `uuid`. See
  [`openai/messageMirror.ts`](../../reference/server/services/providers/openai/messageMirror.ts)
  and [`opencode/messageMirror.ts`](../../reference/server/services/providers/opencode/messageMirror.ts).

`loadTranscript` reads back from the same tables and maps to `UnifiedMessage[]`.
Claude maps each stored entry through `mapMessage`
([`anthropic/sessionStore.ts`](../../reference/server/services/providers/anthropic/sessionStore.ts));
OpenCode reuses that same reader and just re-stamps `provider: 'opencode'` on
the way out (the rows are stored in Claude's entry shape, so the reader is
shared). The `projectKey` is derived from the conversation's working directory.

> Two store-side subtleties worth copying: `append` computes a monotonic `seq`
> per `(project_key, session_id, subpath)` and upserts on `uuid`, and it folds a
> session summary **only for Anthropic main-transcript entries** — Codex/OpenCode
> entries skip the fold because the SDK's `foldSessionSummary` is typed for the
> Claude entry shape. The `provider` tag on the append key is what gates this.

## 4. Credential storage — per provider, behind the registry

Every provider implements `ProviderCredentialStore`
([`reference/server/services/credentials/types.ts`](../../reference/server/services/credentials/types.ts)):
`read` / `write` / `clear` / `getStatus` / `buildSdkEnv`, all keyed by
`userId`. Credentials are **per user**, not global — there is no shared key.
The contract draws one important line: the store **persists and reads** a token
but never spawns a login subprocess; minting a credential is the auth-flow
module's job (`claudeAuthFlow.ts`, `codexAuthFlow.ts`).

The load-bearing method is `buildSdkEnv(userId)`: it returns the env the SDK
invocation inherits, and it **must strip the provider's global auth env keys**
so the per-user credential wins over anything in `process.env`. The orchestrator
injects that env into `ProviderRunOptions.env`; from there each provider reads
what it needs (Claude reads `CLAUDE_CODE_OAUTH_TOKEN`; OpenCode reads a
`BOTTEGA_USER_ID` tag the store adds so it can resolve the user inside an HTTP
provider). A missing credential surfaces as the typed
`ProviderCredentialsMissingError`, which the route layer catches to render a
"Connect <provider>" affordance (HTTP 403) rather than a 500. Auth UX details
live in [`auth-and-multi-user.md`](../auth-and-multi-user.md).

## 5. Subprocess / server lifecycle

This is where the SDKs diverge most, and where `ProviderRunResult`'s
`{ abort(), pid }` earn their keep.

- **Subprocess per turn (Claude, Codex).** Each `startTurn`/`sendTurnMessage`
  spawns a fresh CLI subprocess; the provider hands back its `pid` for audit and
  an `abort()` that flips the turn's `AbortController`. The subprocess dies when
  the turn ends. Claude's `AnthropicProvider`
  ([`anthropic/index.ts`](../../reference/server/services/providers/anthropic/index.ts))
  is the model: wrap `query()`, stream-map its iterator, resolve
  `providerSessionId$` on first `session_id`. Because each subprocess loads its
  credential once at startup, long turns can hit a stale-credential 401 — the
  Claude file documents the automatic fresh-subprocess recovery.
- **Long-lived server pool (OpenCode).** OpenCode talks to a per-user
  `opencode serve` process kept alive in a pool; turns are HTTP calls
  (`session.create` once, `session.prompt` per turn) and output streams over an
  SSE subscription rather than a subprocess stdout. `abort()` must stop both the
  local SSE listener **and** call the server's workspace-scoped abort endpoint,
  or the out-of-process turn keeps running. See
  [`opencode/index.ts`](../../reference/server/services/providers/opencode/index.ts).

Either way the provider tracks its own live turns in an in-memory map so
`abortTurn(providerSessionId)` can find and cancel one — and `abortTurn` writes
the linked agent-run row to `failed` **synchronously** before aborting, so the
orchestrator's completion handler won't chain (core's
[`orchestration-loop`](../../core/orchestration-loop.md) depends on this).

## 6. The capability matrix + guards

A provider advertises a static `ProviderCapabilities` matrix
([`reference/shared/providers/capabilities.ts`](../../reference/shared/providers/capabilities.ts)):
`supportsAskUserQuestion`, `supportsThinkingDelta`,
`supportsContextUsageBreakdown`, `supportsMcpServers`, `supportsImages`. Claude
sets all five `true`; in the reference's first cut Codex and OpenCode set all
five `false` (they ask in plain text, emit reasoning whole rather than as
deltas, report only aggregate usage, and ship MCP layers Bottega doesn't wire
in yet).

The matrix is only useful if call sites honour it. Three tiny helpers in
[`reference/server/services/providers/featureGuards.ts`](../../reference/server/services/providers/featureGuards.ts)
make that ergonomic: `hasCapability`, `withCapability` (run-or-skip), and
`assertCapability` (throw at sites that must never reach an unsupported
provider, e.g. the `AskUserQuestion` tool callback). **Any Claude-only path —
thinking deltas, `AskUserQuestion`, the live context-usage breakdown — must be
behind one of these.** This is the single mechanism that stops a Codex or
OpenCode turn from tripping behaviour its SDK can't do.

## What to build

- [ ] A second `Map`-based registry for credential stores, alongside the
      provider registry, both with explicit boot-time registration.
- [ ] For each provider: a mapper (exhaustive switch, non-dropping default,
      stable ids, threaded session id) that emits `UnifiedMessage`.
- [ ] Transcript persistence into one canonical store — via the SDK's
      `sessionStore` hook if it has one, else an explicit mirror that reuses the
      same tables and `loadTranscript` reader.
- [ ] A `ProviderCredentialStore` per provider whose `buildSdkEnv` strips global
      auth keys; throw `ProviderCredentialsMissingError` when none is configured.
- [ ] A subprocess-or-server lifecycle the provider owns, with `pid`, `abort()`,
      an in-memory active-turn map, and a synchronous agent-run `failed` write on
      abort.
- [ ] A `ProviderCapabilities` matrix and guards (`hasCapability` /
      `withCapability` / `assertCapability`) at every provider-specific call site.

## Reference map

| Concern | File |
|---|---|
| Provider registry | `reference/server/services/providers/registry.ts` |
| Provider interface | `reference/server/services/providers/types.ts` |
| Unified vocabulary + capability matrix | `reference/shared/providers/{types.ts,capabilities.ts}` |
| Capability guards | `reference/server/services/providers/featureGuards.ts` |
| Credential registry + contract | `reference/server/services/credentials/{registry.ts,types.ts}` |
| Mapper (write-through example) | `reference/server/services/providers/anthropic/mapMessage.ts` |
| Mapper (factory + mirror examples) | `reference/server/services/providers/{openai,opencode}/{mapEvent.ts,messageMirror.ts}` |
| Transcript store | `reference/server/services/sqliteSessionStore.ts` |
| Subprocess lifecycle | `reference/server/services/providers/anthropic/index.ts` |
| Server-pool lifecycle | `reference/server/services/providers/opencode/index.ts` |

## Boundaries (not in this spec)

- The `LlmProvider` interface, the unified types, the runtime, and the
  single-source-of-truth rule themselves → [`harness-contract.md`](../../core/harness-contract.md).
- One tool's specifics (auth flow, native event quirks, recovery paths) → the
  per-provider files [`claude-code.md`](./claude-code.md),
  [`codex.md`](./codex.md), [`opencode.md`](./opencode.md).
- Which provider/model an agent uses and where the env-injected credential comes
  from → [`prompt-and-model-customization.md`](../prompt-and-model-customization.md)
  and [`auth-and-multi-user.md`](../auth-and-multi-user.md).
</content>
</invoke>
