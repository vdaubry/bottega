/*
 * NewConversationModal.tsx - Task conversation modal
 *
 * Wrapper around NewConversationModalBase with task-specific adapter.
 */

import React, { useMemo } from 'react';
import { api } from '../utils/api';
import NewConversationModalBase, { type ConversationAdapter } from './NewConversationModalBase';
import type { ProjectRow } from '../../shared/types/db';

interface NewConversationModalProps {
  isOpen: boolean;
  onClose: () => void;
  project: ProjectRow | null | undefined;
  taskId: number | null | undefined;
  onConversationCreated: (conversation: Record<string, unknown> & { __initialMessage?: string }) => void;
}

export default function NewConversationModal({
  isOpen,
  onClose,
  project,
  taskId,
  onConversationCreated
}: NewConversationModalProps) {
  const adapter = useMemo<ConversationAdapter<null>>(() => ({
    title: 'New Conversation',
    subtitle: ({ project: currentProject }) => (
      <>Start a new conversation in <span className="font-medium text-gray-700 dark:text-gray-300">{currentProject?.name || 'this project'}</span></>
    ),
    logTag: 'NewConversationModal',
    submitLabel: 'Start Conversation',
    submitLabelLoading: 'Creating...',
    isReady: ({ entityId }) => !!entityId,
    createConversation: ({ entityId, message, projectPath, permissionMode, provider, model }) =>
      api.conversations.createWithMessage(entityId as number, { message, projectPath, permissionMode, provider, model })
  }), []);

  return (
    <NewConversationModalBase
      isOpen={isOpen}
      onClose={onClose}
      project={project}
      entity={null}
      entityId={taskId}
      onConversationCreated={onConversationCreated}
      adapter={adapter}
    />
  );
}
