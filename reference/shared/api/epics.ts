// Typed HTTP contracts for the epic routes (`server/routes/epics.ts` <->
// `api.epics` in `src/utils/api.ts`).
//
// Responses are bare rows (no envelope), matching the codebase-wide
// convention. Errors are `ApiError` from `_common.ts`.

import type { EpicAgentRunRow, EpicRow, EpicTicketWithTask } from '../types/db.js';

// POST /api/projects/:projectId/epics — multipart: `name` field + `files`
// entries (.md/.txt/.html). 201 with the created epic; no agent is started.
export type CreateEpicResponse = EpicRow;

// GET /api/projects/:projectId/epics — created_at DESC.
export type ListEpicsResponse = EpicRow[];

// GET /api/epics/:id
export type GetEpicResponse = EpicRow;

// PATCH /api/epics/:id
export interface UpdateEpicRequest {
  name?: string;
  status?: EpicRow['status'];
}
export type UpdateEpicResponse = EpicRow;

// DELETE /api/epics/:id — cascades conversations and agent runs, detaches
// tickets, removes the epic's archive directory.
export interface DeleteEpicResponse {
  success: true;
}

// POST /api/epics/:id/stages/:stage/complete — the human backstop for a stage
// whose agent never signed it off. 200 with the updated row; 409 when the flag
// is already set; 400 for a stage that has no flag (implementation).
export type CompleteEpicStageResponse = EpicRow;

// ---- Spec files + architecture + technical-spec documents -----------------

export interface EpicFileInfo {
  name: string;
  size: number;
  mimeType: string;
  /** Cache version for files that agents revise in place. */
  modifiedAtMs: number;
}

export type ListEpicSpecFilesResponse = EpicFileInfo[];
// GET /api/epics/:id/architecture — the architecture stage's markdown file(s),
// sorted by name so a split document reads in order.
export type ListEpicArchitectureDocsResponse = EpicFileInfo[];
export type ListEpicDocsResponse = EpicFileInfo[];
// GET /api/epics/:id/review — the specification review stage's report file(s).
export type ListEpicReviewDocsResponse = EpicFileInfo[];
// GET /api/epics/:id/qa — the QA stage's file(s) (scenarios.csv). The single-file
// route answers `GetEpicFileResponse`; `/qa/:filename/download` answers raw CSV
// bytes with a Content-Disposition attachment header.
export type ListEpicQaFilesResponse = EpicFileInfo[];

export interface GetEpicFileResponse {
  filename: string;
  content: string;
}

export interface UploadEpicSpecFilesResponse {
  success: true;
  files: EpicFileInfo[];
}

export interface DeleteEpicSpecFileResponse {
  success: true;
}

// ---- Tickets --------------------------------------------------------------

// GET /api/epics/:id/tasks — the epic's tickets in execution order.
export type ListEpicTasksResponse = EpicTicketWithTask[];

// ---- Agent runs -----------------------------------------------------------

export type ListEpicAgentRunsResponse = EpicAgentRunRow[];

export interface CreateEpicAgentRunRequest {
  agentType:
    | 'epic-architecture'
    | 'epic-specification'
    | 'epic-stories'
    | 'epic-spec-review'
    | 'epic-orchestrator'
    | 'epic-pr-review'
    | 'epic-delivery'
    | 'epic-qa-scenarios'
    | 'epic-qa-execution'
    | 'epic-qa-fix';
}
export type CreateEpicAgentRunResponse = EpicAgentRunRow;

// 409 body when a stage is already running for this epic.
export interface EpicAgentRunConflictResponse {
  error: string;
  runningAgent: EpicAgentRunRow;
}

// 403 body when the acting user has no configured-provider credentials. Mirrors the
// task agent-run route so the frontend can open Settings -> Providers.
export interface EpicCredentialsMissingResponse {
  error: string;
  code: 'PROVIDER_CREDENTIALS_MISSING';
  provider: string;
}

// ---- Completion PR --------------------------------------------------------

// POST /api/epics/:id/complete-pr — opens the epic's feature branch -> default
// branch pull request from the project's main checkout. Merging it stays a
// human act; the epic's status is not touched here.
export interface CompleteEpicPRRequest {
  title?: string;
  body?: string;
}

export type CompleteEpicPRResponse =
  | { success: true; url: string }
  | { success: false; error: string };

// ---- Orchestration --------------------------------------------------------
//
// `POST /api/epics/:id/orchestrator/{start,pause,resume}`. All three answer the
// updated epic row, so the caller re-renders from one shape; 409 carries why an
// epic cannot enter or leave orchestration.
export interface PauseOrchestrationRequest {
  reason?: string;
}

export type OrchestrationResponse = EpicRow;
