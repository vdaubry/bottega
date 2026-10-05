# Conversation features and portable harness support

The per-turn capabilities layered onto the streaming loop. Each is a small
submodule under `server/services/conversation/`. Question deferral and Bottega
MCP tools are portable; media and stream-detail features remain capability-gated.

## What's gated (the matrix)

`CAPABILITIES_BY_PROVIDER` (`shared/providers/capabilities.ts:16`) records the
gates:

| Capability | Feature below | Codex / OpenCode |
|---|---|---|
| `supportsAskUserQuestion` | the AskUserQuestion wizard | portable `ask_user` tool |
| `supportsThinkingDelta` | streamed thinking | reasoning, but no deltas |
| `supportsContextUsageBreakdown` | the context-usage popup | aggregate usage only |
| `supportsMcpServers` | Bottega MCP tools | authenticated loopback HTTP MCP |
| `supportsImages` | image attachments | deferred |

## AskUserQuestion (durable stop + resume)

The portable `ask_user` tool writes `conversation_questions` before aborting
the current provider turn. The owner run remains `running`, the UI renders the
same wizard for native and portable tool names, and an answer resumes the same
provider session as a new turn. Pending questions survive browser and server
restarts; orphan sweeps deliberately preserve their linked runs. Codex and
OpenCode do not emit a completed tool event when that request is aborted, so
Bottega also writes and broadcasts a synthetic `ask_user` tool-use/result pair.
That gives the live UI and a reloaded transcript the same answer card.

An answer (`resolveAskUserQuestion`, `conversation/askUserQuestion.ts`) moves
the row `pending → answered`, waits for the parked turn to unwind
(`waitForConversationTurnToQuiesce`), writes the synthetic `tool_result`, and
resumes with the answers as an ordinary user message. The row is marked
`resolved` as soon as that continuation turn is **accepted** — its streaming
lifecycle has registered the conversation (`waitForContinuationTurnToStart`
polls `activeStreamingSessions`, the map the quiesce wait drains) — not when
the turn's promise settles minutes later. From acceptance on, the provider
holds the answers and the transcript carries them, so a later failure of that
turn is reported by the streaming path and never reopens the question.
`reopen` (back to `pending`, answers cleared) is reserved for a genuine failure
to deliver: the quiesce wait timed out, or the resume was rejected before any
turn was accepted. The boot sweep in `initializeDatabase` (`database/db.ts`)
applies the same rule after a restart — an `answered` row with no surviving
turn is reopened so it can be submitted again.

`createOrGet` (`database/conversationQuestions.ts`) reuses a pending row only
for the identical ask. A *different* question arriving while an older one is
still pending — the user replied in the chat composer instead of the widget —
cancels the stale row (`status='cancelled'`, with a warning in the log) and
inserts a fresh one; `parkPortableQuestion` closes the superseded card with a
dismissed `tool_result` so the chat stops offering to answer it.

Claude also retains its legacy native `AskUserQuestion` path for task prompts:

`buildCanUseTool` (`conversation/askUserQuestion.ts:53`) returns a `canUseTool`
callback: non-AskUserQuestion tools pass through (`allow`); for `AskUserQuestion`
it **parks on a Promise**, stores the entry in `pendingAskUserQuestions` (keyed by
**conversationId** — the session id isn't captured yet on the first callback),
and broadcasts `awaiting-user-answer`. The SDK pauses the turn until we resolve.

`resolveAskUserQuestion(conversationId, answers)` (`:248`) has two paths:
- **Happy path** — the in-memory callback is present: re-key answers by question
  text, re-emit `streaming-started`, and `resolve({ behavior: 'allow', … })`.
- **Restart fallback** (`:308`) — the callback is gone (process restarted while
  waiting): walk SQLite messages in reverse for the orphan `tool_use`
  (`findOrphanAskUserQuestion`) and `sendMessage(..., { askUserQuestionToolResult })`
  to resume with a synthetic `tool_result` (Anthropic requires the match).

`rejectPendingAskUserQuestion` (`:133`) clears the parked promise in the streaming
loop's `finally` so it can't leak on abort/crash.

## Thinking deltas

The SDK ships final assistant messages with **empty** `thinking` fields — only
the encrypted signature survives; plaintext arrives only as `thinking_delta`
stream events. `ThinkingAccumulator` (`conversation/thinkingPatcher.ts`) collects
those deltas per `(messageId, blockIndex)` and **patches** both the broadcast
message and the SQLite transcript (`patchThinking`), so reloaded history shows
thinking too.

## Media (video / image)

`conversation/media.ts` + `mcpReadiness.ts`: `handleImages` extracts inline
images into temp files and rewrites the prompt; `injectVideoRecording` pushes
`--caps=devtools` / `--output-dir` flags into the Playwright MCP server args (used
by the review agent). `handleVideoRecording` moves the largest recorded `.webm`
into the task's `.bottega` dir after the turn. Temp files are cleaned in every
exit path (`cleanupTempFiles`).

## Generated images (model output)

Not gated by `supportsImages` (that flag is about *attaching* images to a user
message). When a model produces an image natively — Codex's `image_gen` today,
see [`../providers/codex.md`](../providers/codex.md) — the provider emits an
`assistant_image` `UnifiedMessage` pointing at the file in its scratch space.
The conversation layer copies it into the conversation image store
(`server/services/conversationImages.ts`:
`{archive root}/conversations/{conversationId}/images/{fileName}`) and only then
broadcasts and mirrors it, as an assistant entry holding one `generated_image`
block that names the file.

`GET /api/conversations/:id/images/:fileName` serves it: conversation access
decides (404 otherwise), the name must match `GENERATED_IMAGE_FILE_NAME` (one
path segment, `png`/`jpg`/`jpeg`/`webp`), and the response is cached privately
and immutably. `purgeConversationMessages` removes the folder with the
conversation. A provider that reports generated images only needs to emit
`assistant_image` and call the same store.

## MCP readiness wait

`waitForMcpServers(queryInstance, timeout=30s)` (`conversation/mcpReadiness.ts:61`)
polls `mcpServerStatus()` until all servers are connected (reconnecting failed
ones), then releases the deferred prompt. See
[`lifecycle-and-streaming.md`](./lifecycle-and-streaming.md). It only logs
servers that are `pending` or `failed` — a server that is absent, or in
`needs-auth`, leaves no trace in the journal.

## Operator plugins on every turn

`loadEnabledPlugins()` (`conversation/pluginConfig.ts`) reads the operator's
`~/.claude/settings.json` (`enabledPlugins`) and
`~/.claude/plugins/installed_plugins.json` (install paths) and hands the result
to the SDK as `plugins: [{ type: 'local', path }]` at both SDK assembly sites
in `startConversation.ts`. A **fresh** turn would find those plugins through
`settingSources` on its own; a **resumed** turn would not: with
`resume` + `sessionStore` the SDK loads the transcript from SQLite into a
temporary `CLAUDE_CONFIG_DIR` (`/tmp/claude-resume-<uuid>/` — transcript,
`.claude.json`, a copy of `.credentials.json`, and on SDK ≥ 0.3.240
`settings.json`) that holds no `plugins/`, so every plugin MCP server (the
Figma one) silently disappears after a conversation's first turn. Transcript
fingerprint: a `deferred_tools_delta` whose `removedNames` are every
`mcp__plugin_figma_*` tool, on the first resumed turn. Explicit `plugins` is
what keeps the Figma MCP connected on turn two and later; the plugin's OAuth
state rides along in the copied `.credentials.json`. Like `loadMcpConfig`, it
re-reads the files on every turn and fails open to "no plugins".

Known leftover of the same mechanism: the SDK deletes its temp dir when the
subprocess exits normally, but a subprocess killed mid-turn (a deploy restart,
an abort) leaves `/tmp/claude-resume-*` behind — including that credentials
copy (mode 0600).

## Slash-command expansion

`resolveSlashCommand(message, projectPath)` (`conversation/slashCommands.ts`)
expands a leading `/cmd` by reading a `.md` from, in order: the project's
`.claude/commands/`, the user's `~/.claude/commands/`, then Bottega's bundled
`.claude/commands/`. Substitutes `$ARGUMENTS` and positional `$1…$n`. A
non-command message returns unchanged.

## Context-usage tracking

`createContextUsageTracker` (`server/services/contextUsageTracker.ts:98`) folds
SDK iterator messages into a context-window snapshot: `onAssistant` captures the
**master** agent's usage (skips sub-agents via `parent_tool_use_id`, `:122`);
`onResult` builds the baseline + breakdown, persists it
(`conversationsDb.updateContextUsage`), and broadcasts `context-usage`. The popup
that renders it is `ContextDetailModal` (see [`chat-ui.md`](./chat-ui.md)).

## Title generation

Fire-and-forget after the first session id: `generateConversationTitle`
(`server/services/titleGenerator.ts`) runs a one-shot Haiku turn to name the
conversation, then **dual-emits** the rename on the conversation channel (chat
header) and the task channel (the task viewer's conversation list).

## Key files

- `server/services/conversation/askUserQuestion.ts:53` — `buildCanUseTool`; `:248` `resolveAskUserQuestion`.
- `server/services/conversation/thinkingPatcher.ts` — `ThinkingAccumulator` + `patchThinking`.
- `server/services/conversation/media.ts` + `mcpReadiness.ts` — image/video + MCP wait.
- `server/services/conversationImages.ts` + `shared/providers/generatedImage.ts` — the generated-image store and its block contract.
- `server/services/conversation/slashCommands.ts` — `resolveSlashCommand`.
- `server/services/contextUsageTracker.ts:98` — `createContextUsageTracker`.
- `server/services/titleGenerator.ts` — `generateConversationTitle`.
- `shared/providers/capabilities.ts:16` — the gating matrix.
