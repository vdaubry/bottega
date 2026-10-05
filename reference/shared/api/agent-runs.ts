// Request/response shapes for the agent-run endpoints:
//  - /api/tasks/:taskId/agent-runs   (list, create)
//  - /api/agent-runs/:id*            (get, complete, link-conversation, delete)

import type { TaskAgentRunRow, AgentType } from '../types/db';
import { expectType } from './_common';

// `AgentType` is the same string-literal union the route validates against
// (see `tasks.js` and `agent-runs.js`'s `validAgentTypes` list — the values
// are kept in sync via the CHECK constraint on `task_agent_runs.agent_type`).

export type ListAgentRunsResponse = TaskAgentRunRow[];

export interface CreateAgentRunRequest {
  agentType: AgentType;
}

export type CreateAgentRunResponse = TaskAgentRunRow;

// `409 Conflict` body when another agent is already running for this task.
export interface AgentRunConflictResponse {
  error: 'An agent is already running for this task';
  runningAgent: TaskAgentRunRow;
}

export type GetAgentRunResponse = TaskAgentRunRow;

// `PUT /api/agent-runs/:id/complete` returns the updated row.
export type CompleteAgentRunResponse = TaskAgentRunRow;

export interface LinkConversationRequest {
  conversationId: number;
}

export type LinkConversationResponse = TaskAgentRunRow;

export interface DeleteAgentRunResponse {
  success: true;
}

// ---- Type-level smoke checks ---------------------------------------------

expectType<CreateAgentRunRequest['agentType']>('implementation');
