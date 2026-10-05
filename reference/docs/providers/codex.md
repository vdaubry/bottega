# Codex (OpenAI) provider — spawn-per-turn Thread, device-auth, CODEX_HOME

The `openai` backend runs over the **OpenAI Codex SDK** (`@openai/codex-sdk`).
Unlike Claude (one long-lived subprocess) the Codex SDK is **spawn-per-turn**:
each turn starts (or resumes) a `Thread` and runs it to completion.

## CodexProvider

`CodexProvider` (`server/services/providers/openai/index.ts:78`) implements
`LlmProvider`. `startTurn` → `codex.startThread(opts)`; `sendTurnMessage` →
`codex.resumeThread(resumeSessionId, opts)`; both then `thread.runStreamed(prompt)`
and translate the SDK's `ThreadEvent` stream through `openai/mapEvent.ts` into
`UnifiedMessage`. Two quirks to know:

- **Synthetic user message.** The Codex SDK doesn't echo the prompt back as an
  event, so the provider yields a synthesised `user` `UnifiedMessage` first —
  otherwise the `messages` table would have no user-side row for the turn (same
  trick OpenCode uses).
- **Session id timing.** `providerSessionId$` resolves on the first
  `thread.started` event (`thread_id`); messages before that carry a null
  session id.

The live conversation path delegates here through
**`startCodexConversation.ts`** (`startConversation.ts:69` forks on
`provider === 'openai'`), which loads per-user `CODEX_HOME` credentials, calls
`codexProvider.startTurn(...)`, stamps `provider_session_id` on the conversation
row, and broadcasts every `UnifiedMessage` as `ai-response` (+ a back-compat
`claude-response`) so the frontend renders Codex turns through the same path.

## Capability surface

Codex gets Bottega's full agent control surface even though the SDK has no
`canUseTool` hook. For each turn Bottega starts a bearer-authenticated loopback
Streamable HTTP MCP endpoint and injects it through the Codex config:

- **Ask user** — the portable `ask_user` tool persists the question, aborts the
  current Codex process, and resumes the same thread with the answer. Synthetic
  tool-use/result transcript rows keep the standard wizard correct live and
  after reload. Codex also exposes a native `request_user_input` tool that is
  unavailable in Default collaboration mode and is not connected to Bottega's
  widget. When the per-turn gateway contains `ask_user`, `buildCodexOptions`
  injects developer instructions that route question requests to the deferred
  Bottega MCP tool instead of that native tool.
- **Owner tools** — task/epic catalogs are exposed through the same portable MCP
  definitions Claude adapts in-process. The allowlisted gateway uses Codex's
  `default_tools_approval_mode = "approve"` so non-interactive calls execute.
- **The operator's own MCP servers** — `~/.claude.json`'s `mcpServers`
  (Playwright, context7, …), translated into Codex `mcp_servers` by
  `shared/providers/operatorMcpServers.ts` and merged alongside the gateway. Not
  `required`: one that fails to start degrades the turn rather than aborting it.
  Until 2026-08-25 they were not passed at all, and a Codex review agent had no
  browser at all — the gateway was its entire MCP surface.
- **No incremental thinking deltas** — Codex emits whole `reasoning` items, not
  Claude-style `stream_event` partials.
- **No live per-tool context-usage breakdown** — only aggregate usage via
  `turn.completed`.
- **No image attachments** in v1 (input). Images Codex *generates* are a
  different matter — see below.

## Generated images

Codex's built-in `image_gen` tool saves each image to
`$CODEX_HOME/generated_images/<thread id>/<item id>.png`. **The SDK event stream
never mentions it**: inside Codex the image is an "extension" item
(`image_gen.generation`) that `codex exec --experimental-json` does not forward,
`ThreadItem` has no variant for it (0.159.3 and 0.160.0), and the assistant's
text only says the image "is displayed above". That folder is the only signal.

- **Detection** — `openGeneratedImageScanner` (`openai/generatedImages.ts`)
  lists the thread's folder ahead of every SDK event inside `streamUnified`, and
  yields an `assistant_image` `UnifiedMessage` per new file — so the image lands
  in the transcript *before* the message that talks about it. Files already
  there when the turn starts belong to earlier turns and are never re-reported.
  Mid-turn, a file is reported only once its bytes prove it is fully written
  (the PNG `IEND` trailer); anything else waits for the scan on
  `turn.completed` / `turn.failed`. The PNG header also yields the intrinsic
  size.
- **Adoption** — `adoptGeneratedImage` (`startCodexConversation.ts`) copies the
  file into the conversation's own image store
  (`server/services/conversationImages.ts`) before the message is broadcast or
  mirrored. `$CODEX_HOME` is per-user scratch; the store is keyed by
  conversation, so any project member can load the image. A failed copy drops
  the message.
- **Shape** — the transcript entry and the wire payload are an assistant
  message holding one `generated_image` block (`file_name`, `media_type`,
  `width`, `height`; `shared/providers/generatedImage.ts`). It names the file,
  never a path or URL. Rendering: [`../conversations/chat-ui.md`](../conversations/chat-ui.md).
- **Not covered** — a turn aborted between the save and the next event leaves
  its image unreported (the next turn treats it as pre-existing), and
  conversations that predate this are not backfilled.

## In-band usage-limit / stream errors

Codex auto-refreshes its own `auth.json`, so the Claude 401-recycle retry is
**unused** here. Instead, terminal failures (e.g. "You've hit your usage limit"
arriving as a `turn.failed`) surface as a `result` `UnifiedMessage` with
`isError: true`. `startCodexConversation.ts` calls **`failLinkedAgentRunIfRunning`**
(`conversation/agentRunLifecycle.ts:45`) on such a result so a stuck agent run is
marked `failed` rather than hanging — the non-Anthropic providers' equivalent of
`abortSession` for the agent-run lifecycle. See
[`../agents/agentic-loop.md`](../agents/agentic-loop.md).

## Device-auth (PTY) flow

`codexAuthFlow.ts` mirrors `claudeAuthFlow.ts` but follows the device-auth UX:

1. `startCodexAuthLogin(userId)` (`codexAuthFlow.ts:232`) spawns
   `codex login --device-auth` under `node-pty` with the per-user `CODEX_HOME`
   set and global `OPENAI_*`/`CODEX_*` env stripped.
2. The CLI prints **both** a constant URL (`auth.openai.com/codex/device`) **and**
   a rotating one-time **device code** — both are scraped and surfaced to the UI.
3. **No code is pasted back.** The user enters the code in their browser; the CLI
   talks to OpenAI directly and writes `$CODEX_HOME/auth.json` on success.
4. There is **no "complete" endpoint** — the frontend polls
   `/api/codex-auth/status`; success = subprocess exits 0 + `auth.json` on disk
   (`waitForCodexAuthLoginCompletion`, `codexAuthFlow.ts:383`).

## CODEX_HOME / auth.json

Per-user state lives under `~/.config/bottega/users/{userId}/codex/` (the
`CODEX_HOME` root). Bottega accepts only ChatGPT OAuth tokens
(`tokens.access_token` / `id_token`) in `auth.json`; API-key credentials are
rejected by both the paste route and the credential store. Before every login
or SDK run, Bottega also writes the root-level Codex setting
`forced_login_method = "chatgpt"` while preserving the rest of the user's
`config.toml`. `getCodexAuthStatus` decodes the `id_token` for the account email.
Env-stripping invariant:
[`credentials.md`](./credentials.md).

## Key files

- `server/services/providers/openai/index.ts:78` — `CodexProvider`.
- `server/services/providers/openai/{mapEvent,codexOptionsBuilder,messageMirror}.ts`
  — event mapping, thread options, SQLite mirroring.
- `server/services/providers/openai/generatedImages.ts` — the generated-image
  folder scanner.
- `server/services/conversation/startCodexConversation.ts:69` (forked from
  `startConversation.ts`) — the live Codex conversation branch.
- `server/services/codexCredentials.ts` — `CODEX_HOME` paths, `auth.json` I/O, status.
- `server/services/codexAuthFlow.ts:232` — `startCodexAuthLogin` (device-auth PTY).
- `server/routes/codexAuth.ts` — the `/api/codex-auth` start/status/disconnect endpoints.
