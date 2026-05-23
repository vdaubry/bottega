/**
 * AgentSection.tsx - Agent Workflow Section
 *
 * Displays automated agent workflows for a task.
 * Backend handles agent execution and auto-chaining (implementation <-> review loop).
 */

import React, { useState, type ComponentType } from 'react';
import { Play, Check, Loader2, FileText, Code, CheckCircle, MessageCircle, AlertCircle, GitPullRequest, Sparkles, Zap } from 'lucide-react';
import { Button } from './ui/button';
import { cn } from '../lib/utils';
import type { AgentRunRow, AgentType } from '../../shared/types/db';

type IconComponent = ComponentType<{ className?: string | undefined }>;

interface AgentConfig {
  type: AgentType;
  label: string;
  description: string;
  icon: IconComponent;
}

// Agent type configurations
// Message generation is now handled on the backend
const AGENT_TYPES: AgentConfig[] = [
  {
    type: 'planification',
    label: 'Planification',
    description: 'Create a detailed implementation plan',
    icon: FileText
  },
  {
    type: 'implementation',
    label: 'Implementation',
    description: 'Implement the next phase from the plan',
    icon: Code
  },
  {
    type: 'review',
    label: 'Review',
    description: 'Review implementation and run tests',
    icon: CheckCircle
  },
  {
    type: 'refinement',
    label: 'Refinement',
    description: 'Simplify code and fix security issues',
    icon: Sparkles
  },
  {
    type: 'pr',
    label: 'PR',
    description: 'Create PR, monitor CI, fix failures',
    icon: GitPullRequest
  },
  {
    type: 'yolo',
    label: 'YOLO',
    description: 'Plan, implement, test, and open PR in one pass',
    icon: Zap
  }
];

interface AgentSectionProps {
  agentRuns?: AgentRunRow[] | undefined;
  isLoading?: boolean | undefined;
  onRunAgent: (agentType: AgentType) => void | Promise<void>;
  onResumeAgent?: ((conversationId: number) => void) | undefined;
  yoloMode?: boolean | undefined;
  className?: string | undefined;
}

function AgentSection({
  agentRuns = [],
  isLoading = false,
  onRunAgent,
  onResumeAgent,
  yoloMode = false,
  className
}: AgentSectionProps) {
  const visibleAgents = AGENT_TYPES.filter(a =>
    yoloMode ? a.type === 'yolo' : a.type !== 'yolo'
  );
  const [runningType, setRunningType] = useState<AgentType | null>(null);

  const handleRunAgent = async (agentConfig: AgentConfig) => {
    if (runningType) return; // Prevent double-click

    setRunningType(agentConfig.type);
    try {
      // Backend handles message generation and streaming
      await onRunAgent(agentConfig.type);
    } finally {
      setRunningType(null);
    }
  };

  // Pick the LATEST run of a given type. The implementation↔review loop can
  // produce several runs of the same type, and WS updates append new runs to
  // the end of the array (while the REST load is newest-first), so neither
  // "first in the array" nor array order is reliable. The agent run id is a
  // monotonically increasing autoincrement, so the highest id is the most
  // recent run — that's the one whose status reflects the current step.
  const getAgentRun = (agentType: AgentType): AgentRunRow | undefined => {
    return agentRuns
      .filter(r => r.agent_type === agentType)
      .reduce<AgentRunRow | undefined>(
        (latest, r) => (!latest || r.id > latest.id ? r : latest),
        undefined,
      );
  };

  const getAgentStatus = (agentType: AgentType) => {
    return getAgentRun(agentType)?.status ?? null;
  };

  const handleResumeAgent = (agentRun: AgentRunRow | undefined) => {
    if (agentRun?.conversation_id && onResumeAgent) {
      onResumeAgent(agentRun.conversation_id);
    }
  };

  if (isLoading) {
    return (
      <div className={cn('p-4 border-t border-border', className)}>
        <h3 className="text-sm font-medium text-foreground mb-3">Agents</h3>
        <div className="animate-pulse space-y-2">
          <div className="h-16 bg-muted rounded-lg" />
        </div>
      </div>
    );
  }

  return (
    <div className={cn('p-4 border-t border-border min-w-0', className)}>
      <h3 className="text-sm font-medium text-foreground mb-3">Agents</h3>
      <div className="space-y-2">
        {visibleAgents.map((agent) => {
          const status = getAgentStatus(agent.type);
          const agentRun = getAgentRun(agent.type);
          const isRunning = runningType === agent.type;

          // Every step's indicator reflects its OWN latest agent-run status,
          // which the backend broadcasts live (`running` on start, `completed`
          // on finish). This gives the mechanical blue→green flow: each step
          // turns blue while running and green the moment its run completes,
          // independent of any later step. (We deliberately do NOT gate this
          // on the task-level workflow_complete/refinement_complete/
          // pr_agent_complete flags — those are never pushed over the
          // WebSocket, so depending on them left finished steps stuck until a
          // manual refresh.)
          const isCompleted = status === 'completed';
          const isFailed = status === 'failed';
          const isInProgress = status === 'running' || status === 'pending';
          const hasConversation = !!agentRun?.conversation_id;
          const Icon = agent.icon;

          return (
            <div
              key={agent.type}
              className={cn(
                'flex items-center justify-between p-3 rounded-lg border transition-colors min-w-0',
                isCompleted
                  ? 'border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-900/20'
                  : isFailed
                  ? 'border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-900/20'
                  : isInProgress
                  ? 'border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-900/20'
                  : 'border-border hover:border-primary/50'
              )}
            >
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className={cn(
                  'w-8 h-8 rounded-lg flex items-center justify-center',
                  isCompleted
                    ? 'bg-green-100 dark:bg-green-800'
                    : isFailed
                    ? 'bg-red-100 dark:bg-red-800'
                    : isInProgress
                    ? 'bg-blue-100 dark:bg-blue-800'
                    : 'bg-muted'
                )}>
                  <Icon className={cn(
                    'w-4 h-4',
                    isCompleted
                      ? 'text-green-600 dark:text-green-400'
                      : isFailed
                      ? 'text-red-600 dark:text-red-400'
                      : isInProgress
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-muted-foreground'
                  )} />
                </div>
                <div>
                  <p className="text-sm font-medium">{agent.label}</p>
                  <p className="text-xs text-muted-foreground">{agent.description}</p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Conversation info button - only shown when there's a conversation */}
                {hasConversation && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleResumeAgent(agentRun)}
                    className="text-muted-foreground hover:text-foreground"
                    title="View conversation"
                  >
                    <MessageCircle className="w-4 h-4" />
                  </Button>
                )}

                {/* Main action button - always starts a new agent run */}
                <Button
                  variant={isCompleted ? 'ghost' : isFailed ? 'ghost' : 'outline'}
                  size="sm"
                  onClick={() => handleRunAgent(agent)}
                  disabled={isRunning || isInProgress}
                  className={cn(
                    'gap-2',
                    isCompleted && 'text-green-600 dark:text-green-400',
                    isFailed && 'text-red-600 dark:text-red-400'
                  )}
                >
                  {isRunning ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Starting...
                    </>
                  ) : isCompleted ? (
                    <>
                      <Check className="w-4 h-4" />
                      Completed
                    </>
                  ) : isFailed ? (
                    <>
                      <AlertCircle className="w-4 h-4" />
                      Failed
                    </>
                  ) : isInProgress ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Running
                    </>
                  ) : (
                    <>
                      <Play className="w-4 h-4" />
                      Run
                    </>
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default AgentSection;
