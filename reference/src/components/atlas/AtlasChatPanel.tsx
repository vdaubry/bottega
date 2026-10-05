/**
 * Collapsible conversation panel docked at the bottom of the Explore view —
 * the Bottega-native take on CodeAtlas's terminal pane. Embeds the existing
 * ChatInterface bound to a task conversation: schema generation binds the
 * panel to its conversation automatically, and the picker can switch to any
 * other conversation of the task (atlas-flagged ones keep the code-atlas
 * tools across turns; plain ones just chat).
 */

import React from 'react';
import { ChevronDown, ChevronUp, MessageSquare, Plus } from 'lucide-react';
import ChatInterface from '../ChatInterface';
import ErrorBoundary from '../ErrorBoundary';
import { Button } from '../ui/button';
import { cn } from '../../lib/utils';
import useLocalStorage from '../../hooks/useLocalStorage';
import type { ProjectRow, TaskRow, ConversationRow } from '../../../shared/types/db';

interface AtlasChatPanelProps {
  project: ProjectRow;
  task: TaskRow;
  conversations: ConversationRow[];
  activeConversation: ConversationRow | null;
  onSelectConversation: (conversation: ConversationRow | null) => void;
  onNewConversation: () => void;
  isCreating: boolean;
}

const conversationLabel = (c: ConversationRow): string => c.name || `Conversation #${c.id}`;

function AtlasChatPanel({
  project,
  task,
  conversations,
  activeConversation,
  onSelectConversation,
  onNewConversation,
  isCreating,
}: AtlasChatPanelProps) {
  const [collapsed, setCollapsed] = useLocalStorage<boolean>('atlasChatCollapsed', false);
  const [autoExpandTools] = useLocalStorage<boolean>('autoExpandTools', false);
  const [showRawParameters] = useLocalStorage<boolean>('showRawParameters', false);
  const [showThinking] = useLocalStorage<boolean>('showThinking', true);

  return (
    <div
      className={cn(
        'flex flex-shrink-0 flex-col border-t border-border bg-background',
        collapsed ? '' : 'h-[488px] md:h-[520px]',
      )}
    >
      {/* Panel header */}
      <div className="flex flex-shrink-0 items-center gap-2 px-3 py-1.5">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Conversation
        </span>
        <select
          className="h-7 max-w-64 truncate rounded-md border border-input bg-background px-1.5 text-xs"
          value={activeConversation?.id ?? ''}
          onChange={(e) => {
            const id = parseInt(e.target.value, 10);
            onSelectConversation(conversations.find((c) => c.id === id) ?? null);
          }}
          aria-label="Active conversation"
        >
          <option value="" disabled>
            {conversations.length === 0 ? 'No conversations yet' : 'Pick a conversation…'}
          </option>
          {conversations.map((c) => (
            <option key={c.id} value={c.id}>
              {conversationLabel(c)}
            </option>
          ))}
        </select>
        <Button
          variant="outline"
          size="sm"
          className="h-7 px-2 text-xs"
          onClick={onNewConversation}
          disabled={isCreating}
        >
          <Plus className="mr-1 h-3 w-3" />
          New
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto h-7 w-7 p-0"
          onClick={() => setCollapsed(!collapsed)}
          aria-label={collapsed ? 'Expand conversation panel' : 'Collapse conversation panel'}
        >
          {collapsed ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </Button>
      </div>

      {/* Panel body */}
      {!collapsed && (
        <div className="min-h-0 flex-1 border-t border-border">
          {activeConversation ? (
            <ErrorBoundary showDetails={true}>
              <ChatInterface
                key={activeConversation.id}
                selectedProject={project}
                selectedTask={task}
                activeConversation={activeConversation}
                autoExpandTools={autoExpandTools}
                showRawParameters={showRawParameters}
                showThinking={showThinking}
              />
            </ErrorBoundary>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Generate a schema or pick a conversation to talk to the agent here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default AtlasChatPanel;
