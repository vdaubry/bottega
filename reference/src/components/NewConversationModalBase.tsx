/*
 * NewConversationModalBase.tsx - Shared modal for creating new conversations
 *
 * Uses adapter pattern to handle task vs agent specifics (API call + copy).
 */

import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
  type FormEvent,
} from 'react';
import { useWebSocket } from '../contexts/WebSocketContext';
import { useClaudeAuth } from '../contexts/ClaudeAuthContext';
import { useSlashCommands, type SlashCommand } from '../hooks/useSlashCommands';
import { useProviderModelSelection } from '../hooks/useProviderModelSelection';
import { ProviderModelPicker } from './ProviderModelPicker';
import MessageInput from './MessageInput';
import CommandMenu from './CommandMenu';
import type { ProjectRow } from '../../shared/types/db';
import type { TypedResponse } from '../../shared/api/_common';
import type { PermissionMode } from '../../shared/websocket/messages';
import type { Provider } from '../../shared/providers/types';

export interface ConversationAdapter<TEntity = unknown> {
  title?: string;
  subtitle?: (ctx: { project: ProjectRow | null | undefined; entity: TEntity | null }) => ReactNode;
  logTag?: string;
  submitLabel?: string;
  submitLabelLoading?: string;
  isReady?: (ctx: { entity: TEntity | null; entityId: number | string | null | undefined }) => boolean;
  getProjectPath?: (project: ProjectRow | null | undefined) => string | undefined;
  createConversation: (input: {
    entityId: number | string | null | undefined;
    message: string;
    projectPath: string | undefined;
    permissionMode: PermissionMode;
    provider: Provider;
    model: string;
  }) => Promise<TypedResponse<unknown>> | Promise<Response>;
}

interface NewConversationModalBaseProps<TEntity = unknown> {
  isOpen: boolean;
  onClose: () => void;
  project: ProjectRow | null | undefined;
  entity: TEntity | null;
  entityId: number | string | null | undefined;
  onConversationCreated: (conversation: Record<string, unknown> & { __initialMessage?: string }) => void;
  adapter: ConversationAdapter<TEntity>;
}

export default function NewConversationModalBase<TEntity = unknown>({
  isOpen,
  onClose,
  project,
  entity,
  entityId,
  onConversationCreated,
  adapter
}: NewConversationModalBaseProps<TEntity>) {
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>(
    'bypassPermissions',
  );
  // Provider/model selection — the user always picks an explicit pair.
  const {
    provider,
    model,
    setModel,
    handleProviderChange,
    modelOptions,
    loadingOpenCodeModels,
    reset: resetProviderModel,
  } = useProviderModelSelection();
  const { isConnected } = useWebSocket();
  const { requireClaudeAuth } = useClaudeAuth();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const logTag = adapter?.logTag || 'NewConversationModal';
  const title = adapter?.title || 'New Conversation';
  const subtitle = adapter?.subtitle?.({ project, entity }) || null;
  const submitLabel = adapter?.submitLabel || 'Start Conversation';
  const submitLabelLoading = adapter?.submitLabelLoading || 'Creating...';

  // Get the project path for slash commands
  const projectPath = adapter?.getProjectPath
    ? adapter.getProjectPath(project)
    : (project?.repo_folder_path ?? undefined);

  // Use the slash commands hook
  const {
    slashCommands,
    showCommandMenu,
    filteredCommands,
    selectedCommandIndex,
    handleSlashDetected,
    handleCommandSelect: hookCommandSelect,
    handleCloseCommandMenu,
    handleToggleCommandMenu,
  } = useSlashCommands(projectPath);

  // Wrapper for command selection that includes input/setInput
  const handleCommandSelect = useCallback((command: SlashCommand, index: number, isHover: boolean) => {
    hookCommandSelect(command, index, isHover, input, setInput);
  }, [hookCommandSelect, input, setInput]);

  useEffect(() => {
    if (!isOpen) {
      // Reset state when modal closes
      setIsSending(false);
      setInput('');
      setError(null);
      setPermissionMode('bypassPermissions');
      resetProviderModel();
      return;
    }

    // Focus textarea when modal opens
    setTimeout(() => {
      textareaRef.current?.focus();
    }, 100);
  }, [isOpen, resetProviderModel]);

  const handleSubmit = useCallback(async (e: FormEvent | { preventDefault: () => void }) => {
    e.preventDefault();
    if (!input.trim() || isSending) return;

    const isReady = adapter?.isReady ? adapter.isReady({ entity, entityId }) : !!entityId;
    if (!isReady) return;

    if (!adapter?.createConversation) {
      setError('Missing conversation adapter');
      return;
    }

    // The Claude-connection gate only applies to the Anthropic backend.
    // OpenAI/OpenCode have their own credentials (validated server-side).
    if (provider === 'anthropic' && !requireClaudeAuth()) {
      return;
    }

    if (provider === 'opencode' && !model) {
      setError(
        'Select an OpenCode model. If the list is empty, connect an OpenCode key in Settings → Providers.',
      );
      return;
    }

    setIsSending(true);
    setError(null);

    try {
      // Single REST call that creates the conversation AND starts the LLM
      // session. Returns the conversation with a real provider session id.
      const response = await adapter.createConversation({
        entityId,
        message: input.trim(),
        projectPath,
        permissionMode,
        provider,
        model
      });

      if (!response.ok) {
        const errorData = await response.json() as { error?: string };
        throw new Error(errorData.error || 'Failed to create conversation');
      }

      const conversation = await response.json() as Record<string, unknown>;

      // conversation.claude_conversation_id is GUARANTEED to be set
      // Claude is already streaming in the background
      // Attach the initial message for immediate display in ChatInterface
      onConversationCreated({
        ...conversation,
        __initialMessage: input.trim()
      });

    } catch (err) {
      console.error(`[${logTag}] Error:`, err);
      setError((err as Error).message);
      setIsSending(false);
    }
  }, [adapter, entity, entityId, input, isSending, logTag, onConversationCreated, permissionMode, projectPath, provider, model, requireClaudeAuth]);

  // Calculate command menu position relative to modal
  const getCommandMenuPosition = useCallback(() => {
    if (!textareaRef.current) return { top: 0, left: 0, bottom: 90 };
    const rect = textareaRef.current.getBoundingClientRect();
    return {
      top: Math.max(16, rect.top - 316),
      left: rect.left,
      bottom: window.innerHeight - rect.top + 8
    };
  }, []);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm"
        onClick={!isSending ? onClose : undefined}
      />

      {/* Modal */}
      <div className="relative bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 w-full max-w-2xl mx-4 p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h2>
          <button
            onClick={onClose}
            disabled={isSending}
            className="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {subtitle && (
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            {subtitle}
          </p>
        )}

        {/* Provider + model picker */}
        <div className="mb-4">
          <ProviderModelPicker
            provider={provider}
            model={model}
            setModel={setModel}
            handleProviderChange={handleProviderChange}
            modelOptions={modelOptions}
            loadingOpenCodeModels={loadingOpenCodeModels}
            disabled={isSending}
            testIdPrefix="new-conversation"
          />
        </div>

        {/* Error display */}
        {error && (
          <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
            <p className="text-sm text-red-700 dark:text-red-400">{error}</p>
          </div>
        )}

        {/* Command Menu - positioned above input */}
        <CommandMenu
          commands={filteredCommands}
          selectedIndex={selectedCommandIndex}
          onSelect={handleCommandSelect}
          onClose={handleCloseCommandMenu}
          position={getCommandMenuPosition()}
          isOpen={showCommandMenu}
        />

        {/* Reusable MessageInput component */}
        <MessageInput
          input={input}
          setInput={setInput}
          handleSubmit={handleSubmit}
          isConnected={isConnected}
          isSending={isSending}
          isStreaming={false}
          selectedProject={project}
          permissionMode={permissionMode}
          onModeChange={setPermissionMode}
          contextUsage={null}
          slashCommands={slashCommands}
          showCommandMenu={showCommandMenu}
          onToggleCommandMenu={handleToggleCommandMenu}
          isUserScrolledUp={false}
          onScrollToBottom={null}
          onSlashDetected={handleSlashDetected}
          textareaRef={textareaRef}
          selectedCommandIndex={selectedCommandIndex}
          filteredCommands={filteredCommands}
          onCommandSelect={handleCommandSelect}
          onCloseCommandMenu={handleCloseCommandMenu}
          // Surface file upload errors in the modal's own (non-clipped) error banner
          onFileUploadError={setError}
          // Modal-specific props
          showTokenUsage={false}
          showConnectionWarning={false}
          submitLabel={submitLabel}
          submitLabelLoading={submitLabelLoading}
          rows={4}
          variant="modal"
        />

        {/* Connection warning */}
        {!isConnected && (
          <div className="mt-4 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <p className="text-sm text-yellow-700 dark:text-yellow-400">
              Waiting for connection to server...
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
