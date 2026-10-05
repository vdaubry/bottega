# Chat UI — ChatInterface, streaming hook, message & input components

The frontend of a conversation: rendering the transcript, the live streaming
overlay, the composer affordances, and the modals that start/recover a turn. The
server side is [`lifecycle-and-streaming.md`](./lifecycle-and-streaming.md).

## ChatInterface — the host

`src/components/ChatInterface.tsx` owns one active conversation: it loads
historical messages via `api.conversations.getMessages`, subscribes the socket to
the conversation channel through `useConversationSubscription`
(claude-response / -status / -complete / -error, context-usage, awaiting-user-answer
— with reconnect re-subscribe), and renders historical `MessageComponent`s plus
the live `streamingMessages` overlay. Sends go over **WebSocket**
(`sendMessage('claude-command', …)`), not REST. Stick-to-bottom is delegated to
`use-stick-to-bottom` (pins to the latest message unless the user scrolled up).

## useSessionStreaming — the live-turn hook

`src/hooks/useSessionStreaming.ts` extracts the streaming state machine:
`{ streamingMessages, isStreaming, isSending, claudeStatus, handleAbortSession }`.

- **Content-block parsing** — `transformStreamingMessage` (`:114`) splits an
  assistant message's content array into `assistant` / `thinking` / `tool` display
  rows; tool_result user messages are skipped (rendered by the matching tool_use).
- **Dual-emit dedup** — the server emits both `claude-response` (legacy) and
  `ai-response` (provider-tagged); the hook dedups by `uuid`/`message.id` so each
  payload renders once (`:306`).
- **conversation-busy** (`:249`) — a send rejected because a turn is already in
  flight: revert the optimistic echo, force `isStreaming` true (don't tear down —
  a turn *is* running), surface via `onBusy`.
- **abort** — `handleAbortSession` sends `abort-session` with the provider tag;
  `Escape` triggers it; disconnect clears all streaming state.

## Message rendering

`MessageComponent.tsx` renders one transcript row — markdown text, thinking blocks
(toggled by `showThinking`), tool_use/tool_result cards, and generated images.
A `generated_image` block (history: `convertSessionMessages`; live:
`transformStreamingMessage`) becomes an `image` row rendered by
`GeneratedImage.tsx`, loaded from `api.conversations.imageUrl` (`?token=` auth —
an `<img>` cannot send a header). No provider recommends a display size, so the
thumbnail size is ours: fitted inside 640×480 CSS px, never upscaled, never
wider than the message column (hence smaller on a phone), with the box reserved
from the block's intrinsic `width`/`height` so the chat does not jump. Clicking
opens the full-size viewer: fitted to the screen, click to toggle actual pixels,
Esc / backdrop / ✕ to close. `ClaudeStatus.tsx` is
the "Claude is responding… (N tokens)" bar driven by `claude-status`.
`ConversationList.tsx` (hosted in `TaskDetailView`) lists a task's conversations
with live badges and is where you pick/rename/delete one.

## Composer affordances

`MessageInput.tsx` is the textarea + send button, plus:
- **`CommandMenu.tsx`** — the slash-command palette; `useSlashCommands(projectPath)`
  fetches available commands and drives the menu (open on `/`, filter, select).
- **`MicButton.tsx`** — push-to-talk transcription into the textarea.
- **`FileUploadButton.tsx`** — attach images (Anthropic-only; see
  [`features.md`](./features.md)).
- **`AgentAttachments.tsx`** — render attachments carried by an agent run.

A `permissionMode` (default `bypassPermissions`) is held in ChatInterface and sent
with each turn.

## Context-usage popup

`ContextDetailModal.tsx` renders the `context-usage` snapshot the server
broadcasts (`contextUsageTracker`) — the gauge above the input opens it. The wire
payload is forwarded verbatim (`unknown`), so the modal owns its own parsing.

## AskUserQuestion widget

`src/components/AskUserQuestion/*` is the wizard panel that answers an
`awaiting-user-answer` event: `AskUserQuestionPanel` (multi-step), `QuestionStep`
/ `OptionButton` / `SummaryStep`, plus `answerUtils.ts` (`parseAnsweredToolResult`
recognises the exact server-built text) and `derivedState.ts`. Submitting sends
`ask-user-question-answer` → server `resolveAskUserQuestion`.

## Start / recover modals

- **`NewConversationModal.tsx`** — a task adapter over `NewConversationModalBase`;
  starts a conversation with a provider/model pick (the shared `ProviderModelPicker`)
  and an initial message via `api.conversations.createWithMessage`. Hosted in
  `TaskDetailView` / `ChatPage`.
- **`PRFixModal.tsx`** — pick a provider+model before a "Fix CI" or "Fix
  conflicts" conversation (`kind`; neither hard-codes Claude); drives
  `useProviderModelSelection`.

## Key files

- `src/components/ChatInterface.tsx` — the conversation host.
- `src/hooks/useSessionStreaming.ts:114` — `transformStreamingMessage`; `:249` busy handling.
- `src/components/{MessageComponent,ClaudeStatus,ConversationList}.tsx` — transcript, status bar, list.
- `src/components/GeneratedImage.tsx` — generated-image thumbnail + full-size viewer.
- `src/components/{MessageInput,CommandMenu,MicButton,FileUploadButton,AgentAttachments}.tsx` — the composer.
- `src/components/ContextDetailModal.tsx` — the context-usage popup.
- `src/components/AskUserQuestion/AskUserQuestionPanel.tsx` (+ `answerUtils.ts`) — the answer wizard.
- `src/components/{NewConversationModal,PRFixModal}.tsx` — start / PR-repair modals.
- `src/hooks/useSlashCommands.ts` — the slash-command palette state.
