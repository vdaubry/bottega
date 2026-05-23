// SDK transcript types — re-exports the discriminated message union from
// `@anthropic-ai/claude-agent-sdk`. Centralizing here lets WebSocket
// `claude-response` payloads, the conversation content store, and any
// future transcript consumer narrow off `SDKMessage` without each file
// duplicating the import path.
//
// Version pin: `@anthropic-ai/claude-agent-sdk@^0.2.132` (see package.json).
// When bumping the SDK, re-run typecheck — added/removed variants of the
// `SDKMessage` union surface as compile errors at every consumer.
//
// For provider-agnostic consumers, prefer `UnifiedMessage` from
// `shared/providers/types.ts` instead — every layer above the SDK call
// has been migrated to speak that union. Direct `SDKMessage` use is now
// limited to the Anthropic provider's mapper.

export type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKSystemMessage,
  SDKPartialAssistantMessage,
  SDKCompactBoundaryMessage,
  SDKStatusMessage,
  SDKAPIRetryMessage,
  SDKLocalCommandOutputMessage,
  SDKHookStartedMessage,
  SDKHookProgressMessage,
  SDKHookResponseMessage,
  SDKPluginInstallMessage,
  SDKToolProgressMessage,
  SDKAuthStatusMessage,
  SDKTaskNotificationMessage,
  SDKTaskStartedMessage,
  SDKTaskUpdatedMessage,
  SDKTaskProgressMessage,
  SDKSessionStateChangedMessage,
  SDKNotificationMessage,
  SDKFilesPersistedEvent,
  SDKToolUseSummaryMessage,
  SDKMemoryRecallMessage,
  SDKRateLimitEvent,
  SDKElicitationCompleteMessage,
  SDKPromptSuggestionMessage,
  SDKMirrorErrorMessage,
  SDKAssistantMessageError,
  SDKMessageOrigin,
  SDKStatus,
  // Context-usage snapshot returned by `query.getContextUsage()` and
  // persisted into `conversations.context_usage_json`.
  SDKControlGetContextUsageResponse,
} from '@anthropic-ai/claude-agent-sdk';
