// Epic REST surface.
//
// Item routes are flat (`/epics/:id/...`); collections hang off the project
// (`/projects/:projectId/epics`). Auth follows the codebase 404-not-403
// existence-hiding convention: a missing epic and a foreign project both
// answer `404 { error }`.
//
// The create route is multipart, so `validateBody` cannot guard it — multer
// runs imperatively INSIDE the handler after the membership check (the
// routes/tasks.ts attachments pattern), and `name` + the uploaded files are
// validated manually against the shared constants in shared/schemas/epics.ts.
//
// Creating an epic starts NO agent: the user uploads the functional spec,
// then starts the architecture stage from the epic page.

import path from 'path';
import express, { type Request, type Response } from 'express';
import { conversationsDb } from '../database/db.js';
import { epicsDb, epicAgentRunsDb, epicTicketsDb } from '../database/epics.js';
import { getProject, hasProjectAccess } from '../services/projectService.js';
import {
  startEpicAgentRun,
  getRunningAgentForEpic,
  EpicQaFixConflictError,
} from '../services/epics/epicAgentRunner.js';
import { resetQaLoopState } from '../services/epics/qaLoop.js';
import { QA_SCENARIOS_FILENAME, countQaProgress, parseQaScenarios } from '@shared/schemas/qa';
import { resetBridgeCounters } from '../services/epics/orchestrator/bridge.js';
import { blockOrchestration } from '../services/epics/orchestrator/blocking.js';
import { advance, wakeOrchestrator } from '../services/epics/orchestrator/sequencing.js';
import {
  createEpicCompletionPR,
  removeEpicDeliveryWorktree,
} from '../services/epics/epicBranch.js';
import { createEpicTicket, EpicNotInProjectError } from '../services/epics/ticketService.js';
import { startConversation } from '../services/conversationAdapter.js';
import { MissingUserAgentSettingsError } from '../services/agentModelSettings.js';
import { ProviderCredentialsMissingError } from '../services/credentials/types.js';
import { purgeConversationMessages } from '../services/conversationContentStore.js';
import {
  buildEpicContextPrompt,
  deleteEpicArchive,
  deleteEpicSpecFile,
  ensureEpicDirs,
  epicQaScenariosCsvExists,
  listEpicArchitectureDocs,
  listEpicDocs,
  listEpicQaFiles,
  listEpicReviewDocs,
  listEpicSpecFiles,
  readEpicArchitectureDoc,
  readEpicDoc,
  readEpicQaFile,
  readEpicReviewDoc,
  readEpicSpecFile,
  saveEpicSpecFile,
} from '../services/epics/epicArchive.js';
import {
} from '../services/documentation.js';
import { FLAG_BY_STAGE, isStageComplete } from '../services/epics/epicStages.js';
import { broadcastEpicUpdated } from '../services/epics/epicEvents.js';
import { slugifyEpicName } from '../../shared/utils/slug.js';
import { upload } from '../middleware/upload.js';
import { createConversationHandler } from './conversationHandlers.js';
import { validateBody, validateParams } from '../middleware/validate.js';
import {
  IdParamsSchema,
  ProjectIdParamsSchema,
  type IdParams,
  type ProjectIdParams,
} from '../../shared/schemas/_common.js';
import {
  ALLOWED_SPEC_EXTENSIONS,
  CompleteEpicPRBodySchema,
  CreateEpicTicketBodySchema,
  CreateEpicAgentRunBodySchema,
  CreateEpicConversationBodySchema,
  EPIC_NAME_MAX,
  EpicFileParamsSchema,
  EpicStageParamsSchema,
  PauseOrchestrationBodySchema,
  UpdateEpicBodySchema,
  type CompleteEpicPRBody,
  type CreateEpicAgentRunBody,
  type CreateEpicTicketBody,
  type EpicFileParams,
  type EpicStageParams,
  type PauseOrchestrationBody,
  type UpdateEpicBody,
} from '../../shared/schemas/epics.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  CompleteEpicPRResponse,
  CompleteEpicStageResponse,
  CreateEpicAgentRunResponse,
  EpicCredentialsMissingResponse,
  CreateEpicResponse,
  DeleteEpicResponse,
  DeleteEpicSpecFileResponse,
  EpicAgentRunConflictResponse,
  GetEpicFileResponse,
  GetEpicResponse,
  ListEpicAgentRunsResponse,
  ListEpicArchitectureDocsResponse,
  ListEpicDocsResponse,
  ListEpicQaFilesResponse,
  ListEpicReviewDocsResponse,
  ListEpicSpecFilesResponse,
  ListEpicTasksResponse,
  ListEpicsResponse,
  OrchestrationResponse,
  UpdateEpicResponse,
  UploadEpicSpecFilesResponse,
} from '../../shared/api/epics.js';
import type { EpicRow, ProjectRow } from '../../shared/types/db.js';
import type {
  BroadcastToEpicSubscribersFn,
  ServerToClientMessage,
} from '../../shared/websocket/messages.js';

const router = express.Router();

/** Membership-scoped project lookup; answers the 404 itself when denied. */
function requireProject(req: Request, res: Response): ProjectRow | null {
  const userId = req.user!.id;
  const { projectId } = req.validated!.params as ProjectIdParams;
  const project = getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' } satisfies ApiError);
    return null;
  }
  return project;
}

/** Epic lookup + membership check; answers the 404 itself when denied. */
function requireEpic(req: Request, res: Response): EpicRow | null {
  const userId = req.user!.id;
  const { id } = req.validated!.params as
    | IdParams
    | EpicFileParams
    | EpicStageParams;
  const epic = epicsDb.getById(id);
  if (!epic || !hasProjectAccess(epic.project_id, userId)) {
    res.status(404).json({ error: 'Epic not found' } satisfies ApiError);
    return null;
  }
  return epic;
}

function getEpicBroadcast(req: Request): BroadcastToEpicSubscribersFn {
  const fn = req.app.locals.broadcastToEpicSubscribers as
    | BroadcastToEpicSubscribersFn
    | undefined;
  // No-op fallback keeps unit tests (no WS server on app.locals) working.
  return fn ?? (() => {});
}

/**
 * Announce the epic row itself on the epic channel. Anything that changes the
 * status or a stage flag goes through here, so an open epic page re-renders
 * without a refetch — the same message `mark_stage_complete` emits.
 */
function broadcastEpicRow(req: Request, epic: EpicRow): void {
  broadcastEpicUpdated(getEpicBroadcast(req), epic);
}

// ---------------------------------------------------------------------------
// Epics CRUD
// ---------------------------------------------------------------------------

router.post(
  '/projects/:projectId/epics',
  validateParams(ProjectIdParamsSchema),
  (req: Request, res: Response<CreateEpicResponse | ApiError>) => {
    const userId = req.user!.id;
    const project = requireProject(req, res);
    if (!project) return;

    upload.array('files')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        return res.status(400).json({ error: message } satisfies ApiError);
      }

      const body = (req.body ?? {}) as Record<string, unknown>;
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name) {
        return res.status(400).json({ error: 'Epic name is required' } satisfies ApiError);
      }
      if (name.length > EPIC_NAME_MAX) {
        return res.status(400).json({
          error: `Epic name must be at most ${EPIC_NAME_MAX} characters`,
        } satisfies ApiError);
      }

      const files = (req as Request & { files?: Express.Multer.File[] }).files ?? [];
      const allowed = ALLOWED_SPEC_EXTENSIONS as readonly string[];
      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowed.includes(ext)) {
          return res.status(400).json({
            error: `Unsupported spec file '${file.originalname}' - allowed: ${allowed.join(', ')}`,
          } satisfies ApiError);
        }
      }

      try {
        const epic = epicsDb.create({
          projectId: project.id,
          userId,
          name,
          slug: slugifyEpicName(name),
        });
        ensureEpicDirs(project.id, epic.id);
        for (const file of files) {
          saveEpicSpecFile(project.id, epic.id, file.originalname, file.buffer);
        }
        res.status(201).json(epic);
      } catch (error) {
        console.error('Error creating epic:', error);
        res.status(500).json({ error: 'Failed to create epic' } satisfies ApiError);
      }
    });
  },
);

router.get(
  '/projects/:projectId/epics',
  validateParams(ProjectIdParamsSchema),
  (req: Request, res: Response<ListEpicsResponse | ApiError>) => {
    try {
      const project = requireProject(req, res);
      if (!project) return;
      res.json(epicsDb.listByProject(project.id));
    } catch (error) {
      console.error('Error listing epics:', error);
      res.status(500).json({ error: 'Failed to list epics' } satisfies ApiError);
    }
  },
);

router.get(
  '/epics/:id',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<GetEpicResponse | ApiError>) => {
    try {
      const epic = requireEpic(req, res);
      if (!epic) return;
      res.json(epic);
    } catch (error) {
      console.error('Error fetching epic:', error);
      res.status(500).json({ error: 'Failed to fetch epic' } satisfies ApiError);
    }
  },
);

router.patch(
  '/epics/:id',
  validateParams(IdParamsSchema),
  validateBody(UpdateEpicBodySchema),
  (req: Request, res: Response<UpdateEpicResponse | ApiError>) => {
    try {
      const epic = requireEpic(req, res);
      if (!epic) return;
      const updates = req.validated!.body as UpdateEpicBody;
      const updated = epicsDb.update(epic.id, updates);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to update epic' } satisfies ApiError);
      }
      broadcastEpicRow(req, updated);
      res.json(updated);
    } catch (error) {
      console.error('Error updating epic:', error);
      res.status(500).json({ error: 'Failed to update epic' } satisfies ApiError);
    }
  },
);

router.delete(
  '/epics/:id',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<DeleteEpicResponse | ApiError>) => {
    try {
      const epic = requireEpic(req, res);
      if (!epic) return;
      const project = getProject(epic.project_id, req.user!.id);

      // Purge the transcripts BEFORE the rows disappear: the message store is
      // keyed by session id + project path, neither of which survives the
      // delete. Best-effort, like the task delete path.
      //
      // Explicit-delete semantics (architecture-v2 step 5): the base
      // conversation rows are infrastructure with no owner FK — deleting the
      // epic cascades only the ownership links and memberships, so the epic
      // layer removes its conversation rows itself. Tickets survive: they are
      // ordinary tasks, and only their `epic_tickets` membership goes.
      for (const conversation of conversationsDb.getByEpic(epic.id)) {
        try {
          await purgeConversationMessages(conversation, project?.repo_folder_path ?? null);
        } catch (purgeError) {
          console.error(
            `Failed to purge messages for epic conversation ${conversation.id}:`,
            purgeError,
          );
        }
        conversationsDb.delete(conversation.id);
      }

      // The delivery worktree is the epic's own checkout of its feature branch.
      // Remove it with the epic — but never the branch, which the final pull
      // request merges and which outlives the epic row. Retryable housekeeping,
      // like ticket worktree cleanup: a failure here must not leave the epic
      // half-deleted, so it is logged rather than thrown.
      if (project?.repo_folder_path) {
        const removal = await removeEpicDeliveryWorktree(project.repo_folder_path, epic.id, {
          force: true,
        });
        if (removal.error) {
          console.error(
            `Failed to remove the delivery worktree of epic ${epic.id}:`,
            removal.error,
          );
        }
      }

      epicsDb.delete(epic.id);
      deleteEpicArchive(epic.project_id, epic.id);
      res.json({ success: true });
    } catch (error) {
      console.error('Error deleting epic:', error);
      res.status(500).json({ error: 'Failed to delete epic' } satisfies ApiError);
    }
  },
);

// ---------------------------------------------------------------------------
// Stage flags — the human backstop
// ---------------------------------------------------------------------------

/**
 * Mark a stage complete by hand. Each stage's agent signs its own work off
 * through `mcp__bottega__mark_stage_complete` once the user approves in chat;
 * this is the fallback for the cases that never reach it — a stage finished
 * outside its conversation, an agent that forgot, a flag the user wants set to
 * unblock the next stage.
 *
 * Deliberately one-way: nothing here clears a flag. Stages stay re-runnable
 * (starting one again is always allowed), so un-marking has no meaning.
 */
router.post(
  '/epics/:id/stages/:stage/complete',
  validateParams(EpicStageParamsSchema),
  (req: Request, res: Response<CompleteEpicStageResponse | ApiError>) => {
    try {
      const epic = requireEpic(req, res);
      if (!epic) return;
      const { stage } = req.validated!.params as EpicStageParams;

      const flag = FLAG_BY_STAGE[stage];
      if (!flag) {
        return res.status(400).json({
          error: `The '${stage}' stage has no completion flag`,
        } satisfies ApiError);
      }
      if (isStageComplete(epic, stage)) {
        return res.status(409).json({
          error: `The '${stage}' stage is already marked complete`,
        } satisfies ApiError);
      }

      const updated = epicsDb.setStageComplete(epic.id, flag);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to update epic' } satisfies ApiError);
      }
      broadcastEpicRow(req, updated);
      res.json(updated);
    } catch (error) {
      console.error('Error marking epic stage complete:', error);
      res.status(500).json({ error: 'Failed to update epic' } satisfies ApiError);
    }
  },
);

// ---------------------------------------------------------------------------
// Spec files (the uploaded functional specification)
// ---------------------------------------------------------------------------

router.get(
  '/epics/:id/spec-files',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<ListEpicSpecFilesResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    res.json(listEpicSpecFiles(epic.project_id, epic.id));
  },
);

router.get(
  '/epics/:id/spec-files/:filename',
  validateParams(EpicFileParamsSchema),
  (req: Request, res: Response<GetEpicFileResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    const { filename } = req.validated!.params as EpicFileParams;
    const content = readEpicSpecFile(epic.project_id, epic.id, filename);
    if (content === null) {
      return res.status(404).json({ error: 'Spec file not found' } satisfies ApiError);
    }
    res.json({ filename: path.basename(filename), content });
  },
);

router.post(
  '/epics/:id/spec-files',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<UploadEpicSpecFilesResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;

    upload.array('files')(req, res, (err: unknown) => {
      if (err) {
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        return res.status(400).json({ error: message } satisfies ApiError);
      }
      const files = (req as Request & { files?: Express.Multer.File[] }).files ?? [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' } satisfies ApiError);
      }
      const allowed = ALLOWED_SPEC_EXTENSIONS as readonly string[];
      for (const file of files) {
        const ext = path.extname(file.originalname).toLowerCase();
        if (!allowed.includes(ext)) {
          return res.status(400).json({
            error: `Unsupported spec file '${file.originalname}' - allowed: ${allowed.join(', ')}`,
          } satisfies ApiError);
        }
      }
      try {
        const saved = files.map((file) =>
          saveEpicSpecFile(epic.project_id, epic.id, file.originalname, file.buffer),
        );
        res.status(201).json({ success: true, files: saved });
      } catch (error) {
        console.error('Error saving epic spec files:', error);
        res.status(500).json({ error: 'Failed to save spec files' } satisfies ApiError);
      }
    });
  },
);

router.delete(
  '/epics/:id/spec-files/:filename',
  validateParams(EpicFileParamsSchema),
  (req: Request, res: Response<DeleteEpicSpecFileResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    const { filename } = req.validated!.params as EpicFileParams;
    if (!deleteEpicSpecFile(epic.project_id, epic.id, filename)) {
      return res.status(404).json({ error: 'Spec file not found' } satisfies ApiError);
    }
    res.json({ success: true });
  },
);

// ---------------------------------------------------------------------------
// The architecture document (written by the architecture stage)
// ---------------------------------------------------------------------------

router.get(
  '/epics/:id/architecture',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<ListEpicArchitectureDocsResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    res.json(listEpicArchitectureDocs(epic.project_id, epic.id));
  },
);

router.get(
  '/epics/:id/architecture/:filename',
  validateParams(EpicFileParamsSchema),
  (req: Request, res: Response<GetEpicFileResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    const { filename } = req.validated!.params as EpicFileParams;
    // Basename-only read, like the docs route: traversal cannot escape the
    // epic's architecture directory.
    const content = readEpicArchitectureDoc(epic.project_id, epic.id, filename);
    if (content === null) {
      return res.status(404).json({ error: 'Document not found' } satisfies ApiError);
    }
    res.json({ filename: path.basename(filename), content });
  },
);

// ---------------------------------------------------------------------------
// Technical-specification documents (written by the specification stage)
// ---------------------------------------------------------------------------

router.get(
  '/epics/:id/docs',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<ListEpicDocsResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    res.json(listEpicDocs(epic.project_id, epic.id));
  },
);

router.get(
  '/epics/:id/docs/:filename',
  validateParams(EpicFileParamsSchema),
  (req: Request, res: Response<GetEpicFileResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    const { filename } = req.validated!.params as EpicFileParams;
    // `readEpicDoc` reduces the name to a basename, so '../../.env' can only
    // ever resolve inside the epic's docs directory.
    const content = readEpicDoc(epic.project_id, epic.id, filename);
    if (content === null) {
      return res.status(404).json({ error: 'Document not found' } satisfies ApiError);
    }
    res.json({ filename: path.basename(filename), content });
  },
);

// ---------------------------------------------------------------------------
// The specification review report (written by the review stage)
// ---------------------------------------------------------------------------

router.get(
  '/epics/:id/review',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<ListEpicReviewDocsResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    res.json(listEpicReviewDocs(epic.project_id, epic.id));
  },
);

router.get(
  '/epics/:id/review/:filename',
  validateParams(EpicFileParamsSchema),
  (req: Request, res: Response<GetEpicFileResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    const { filename } = req.validated!.params as EpicFileParams;
    // Basename-only read, like the two document routes above.
    const content = readEpicReviewDoc(epic.project_id, epic.id, filename);
    if (content === null) {
      return res.status(404).json({ error: 'Document not found' } satisfies ApiError);
    }
    res.json({ filename: path.basename(filename), content });
  },
);

// ---------------------------------------------------------------------------
// QA scenarios (written by the QA scenario stage; results by QA execution)
// ---------------------------------------------------------------------------

router.get(
  '/epics/:id/qa',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<ListEpicQaFilesResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    res.json(listEpicQaFiles(epic.project_id, epic.id));
  },
);

router.get(
  '/epics/:id/qa/:filename',
  validateParams(EpicFileParamsSchema),
  (req: Request, res: Response<GetEpicFileResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    const { filename } = req.validated!.params as EpicFileParams;
    // Basename-only read, like the document routes above.
    const content = readEpicQaFile(epic.project_id, epic.id, filename);
    if (content === null) {
      return res.status(404).json({ error: 'Document not found' } satisfies ApiError);
    }
    res.json({ filename: path.basename(filename), content });
  },
);

// The one raw-bytes epic route: what the artifacts tab's Download button
// links to. A plain `<a href>` cannot send the Authorization header, so the
// client appends `?token=` — which `authenticateToken` already accepts
// globally (the review-recording precedent).
router.get(
  '/epics/:id/qa/:filename/download',
  validateParams(EpicFileParamsSchema),
  (req: Request, res: Response) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    const { filename } = req.validated!.params as EpicFileParams;
    const content = readEpicQaFile(epic.project_id, epic.id, filename);
    if (content === null) {
      return res.status(404).json({ error: 'Document not found' } satisfies ApiError);
    }
    const basename = path.basename(filename).replace(/"/g, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${basename}"`);
    res.send(content);
  },
);

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------

router.get(
  '/epics/:id/tasks',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<ListEpicTasksResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    res.json(epicTicketsDb.listTickets(epic.id));
  },
);

// Create one ticket: the epic-layer service ensures the feature branch FIRST,
// creates the task with that branch as its base (through the same task
// service the human task route calls), then records membership and position.
// External callers that used to pass epic_id to POST /projects/:id/tasks use
// this route instead (architecture-v2 step 3).
router.post(
  '/epics/:id/tasks',
  validateParams(IdParamsSchema),
  validateBody(CreateEpicTicketBodySchema),
  async (req: Request, res: Response<unknown>) => {
    try {
      const userId = req.user!.id;
      const epic = requireEpic(req, res);
      if (!epic) return;

      const { title, description, epic_order } = req.validated!.body as CreateEpicTicketBody;
      const result = await createEpicTicket(
        epic.id,
        { title, description, epicOrder: epic_order },
        userId,
      );

      if (!result.success) {
        return res
          .status(500)
          .json({ error: result.error ?? 'Failed to create ticket' } satisfies ApiError);
      }

      res.status(201).json({
        ...result.task,
        ...(result.baseBranch ? { base_branch: result.baseBranch } : {}),
        ...(result.warning ? { warning: result.warning } : {}),
      });
    } catch (error) {
      if (error instanceof EpicNotInProjectError) {
        return res.status(404).json({ error: 'Epic not found' } satisfies ApiError);
      }
      console.error('Error creating epic ticket:', error);
      res.status(500).json({ error: 'Failed to create ticket' } satisfies ApiError);
    }
  },
);

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

router.get(
  '/epics/:id/conversations',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<unknown>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    res.json(conversationsDb.getByEpic(epic.id));
  },
);

const createEpicConversationHandler = createConversationHandler({
  getId: (req) => parseInt(req.params.id, 10),
  invalidIdMessage: 'Invalid epic ID',
  notFoundMessage: 'Epic not found',
  generalErrorMessage: 'Failed to create conversation',
  generalErrorLogPrefix: 'Error creating epic conversation:',
  sessionErrorLogPrefix: '[REST] Failed to create epic session:',
  precreateConversation: true,
  getEntityWithProject: (epicId) => epicsDb.getWithProject(epicId),
  createConversation: (epicId, provider, model, effort) =>
    conversationsDb.createForEpic(epicId, provider, model, effort),
  deleteConversation: (conversationId) => {
    conversationsDb.delete(conversationId);
  },
  cleanupConversationOnSessionError: true,
  getConversationById: (conversationId) =>
    conversationsDb.getById(conversationId) as unknown as { id: number; [k: string]: unknown },
  buildSystemPrompt: (_effectivePath, epicId, _projectPath, entityWithProject) =>
    buildEpicContextPrompt(entityWithProject.project_id, epicId),
  // No `getWorktreeTaskId`: epics run in the project's main checkout.
  startSession: (epicId, message, options) =>
    startConversation({ kind: 'epic', epicId }, message, options),
});

router.post(
  '/epics/:id/conversations',
  validateParams(IdParamsSchema),
  validateBody(CreateEpicConversationBodySchema),
  createEpicConversationHandler,
);

// ---------------------------------------------------------------------------
// Agent runs (the epic pipeline's stages)
// ---------------------------------------------------------------------------

router.get(
  '/epics/:id/agent-runs',
  validateParams(IdParamsSchema),
  (req: Request, res: Response<ListEpicAgentRunsResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    res.json(epicAgentRunsDb.getByEpic(epic.id));
  },
);

/**
 * Per-stage entry gates. The architecture stage only needs a spec; the later
 * stages need their predecessor's output, and their runners land in later
 * phases. Returning 409 (rather than 400) keeps "not yet" distinct from
 * "not a thing".
 */
function checkStageGate(epic: EpicRow, agentType: CreateEpicAgentRunBody['agentType']): string | null {
  switch (agentType) {
    case 'epic-architecture':
      return null;
    case 'epic-specification':
      // Set by the architecture agent's own `mark_stage_complete` (or the
      // human backstop) — i.e. "the user approved the architecture document".
      return epic.architecture_complete ? null : 'Run the architecture stage first';
    case 'epic-stories':
      // Set by the specification agent's own `mark_stage_complete` (or the
      // human backstop) — i.e. "the user approved the specification".
      return epic.specs_complete ? null : 'Complete the technical specification first';
    case 'epic-spec-review':
      // Set by the stories agent's own `mark_stage_complete` (or the human
      // backstop) — i.e. "the user approved the ticket list". The review reads
      // every stage's output, so it needs the last of them to be final.
      return epic.stories_complete ? null : 'Create and approve the epic tickets first';
    case 'epic-orchestrator':
      // The orchestrator is never started ad hoc: it runs one conversation per
      // ticket, sequenced by `epics/orchestrator/sequencing.ts`. Starting one
      // here would produce a run with no ticket to supervise.
      return 'Start orchestration with POST /epics/:id/orchestrator/start';
    case 'epic-pr-review':
      // Same: one conversation per ticket pull request, started by the
      // sequencer when the PR agent ends (or by the orchestrator's retry).
      return 'The PR reviewer is started per ticket by the orchestration, not by hand';
    case 'epic-delivery':
      // Not a stage: no predecessor flag, no sign-off, any number of runs. The
      // only precondition is somewhere to work — the feature branch, which the
      // delivery worktree checks out. A comment can land on the final pull
      // request at any point, so this deliberately does NOT require every
      // ticket to be merged.
      return epic.feature_branch
        ? null
        : 'This epic has no feature branch yet — create its first ticket to open one';
    case 'epic-qa-scenarios':
      // The scenario book is derived from the documents, so it needs the last
      // framing stage — the review — to have finalized them.
      return epic.review_complete ? null : 'Complete the specification review first';
    case 'epic-qa-execution': {
      // Not a stage (any number of runs), but heavily gated: it executes the
      // approved book against the delivered feature branch, so it needs the
      // user's sign-off on the scenarios, a branch to run, every ticket merged
      // into it (a scenario for an unmerged ticket would fail spuriously —
      // the same rule as the completion PR), and the book itself on disk
      // (the human backstop can set qa_complete without one ever existing).
      if (!epic.qa_complete) return 'Write and approve the QA scenarios first';
      if (!epic.feature_branch) {
        return 'This epic has no feature branch yet — create its first ticket to open one';
      }
      const unmerged = epicTicketsDb.listTickets(epic.id).filter((t) => t.status !== 'completed');
      if (unmerged.length > 0) {
        return `${unmerged.length} ticket(s) are not merged yet: ${unmerged
          .map((t) => `#${t.id}`)
          .join(', ')} — QA runs the complete epic`;
      }
      if (!epicQaScenariosCsvExists(epic.project_id, epic.id)) {
        return 'The QA stage was marked complete but no scenarios.csv exists — run the QA scenarios stage';
      }
      return null;
    }
    case 'epic-qa-fix': {
      // Not a stage (any number of runs): the fix mission turns the book's
      // recorded failures into one ticket on the feature branch, so it needs a
      // branch, a parseable book with at least one fail — and no active
      // orchestration: the sequencer would pick the new fix ticket up too
      // (nextTicket = first unmerged) and two supervisors would drive it.
      if (!epic.feature_branch) {
        return 'This epic has no feature branch yet — create its first ticket to open one';
      }
      if (epic.orchestration_active) {
        return 'This epic is being orchestrated — the fix mission can only start once orchestration is finished';
      }
      const content = readEpicQaFile(epic.project_id, epic.id, QA_SCENARIOS_FILENAME);
      if (content === null) return 'No QA scenario book exists — run the QA stages first';
      const parsed = parseQaScenarios(content);
      if (!parsed.ok) {
        return 'qa/scenarios.csv does not parse — repair it via the QA scenarios stage first';
      }
      if (countQaProgress(parsed.rows).fail === 0) {
        return 'The book records no failed scenario — nothing to fix';
      }
      return null;
    }
  }
}

router.post(
  '/epics/:id/agent-runs',
  validateParams(IdParamsSchema),
  validateBody(CreateEpicAgentRunBodySchema),
  async (
    req: Request,
    res: Response<
      | CreateEpicAgentRunResponse
      | ApiError
      | EpicAgentRunConflictResponse
      | EpicCredentialsMissingResponse
    >,
  ) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    const { agentType } = req.validated!.body as CreateEpicAgentRunBody;

    const gateError = checkStageGate(epic, agentType);
    if (gateError) {
      return res.status(409).json({ error: gateError } satisfies ApiError);
    }

    const running = getRunningAgentForEpic(epic.id);
    if (running) {
      return res.status(409).json({
        error: 'An agent is already running for this epic',
        runningAgent: running,
      });
    }

    // A user-initiated execution run opens a fresh continuation budget for the
    // QA loop — the auto-spawned follow-ups never pass through this route.
    if (agentType === 'epic-qa-execution') resetQaLoopState(epic.id);

    const broadcastToConversationSubscribers =
      req.app.locals.broadcastToConversationSubscribers as
        | ((convId: number, msg: ServerToClientMessage) => void)
        | undefined;

    try {
      const { agentRun } = await startEpicAgentRun(epic.id, agentType, {
        broadcastFn: (convId, msg) => broadcastToConversationSubscribers?.(convId, msg),
        broadcastToEpicSubscribersFn: getEpicBroadcast(req),
        userId: req.user!.id,
      });
      res.status(201).json(agentRun);
    } catch (error) {
      if (error instanceof MissingUserAgentSettingsError) {
        return res.status(409).json({
          error: 'Configure the epic models under Settings -> Agent Models',
        } satisfies ApiError);
      }
      if (error instanceof EpicQaFixConflictError) {
        return res.status(409).json({
          error: 'A QA fix mission is already active for this epic',
          runningAgent: error.fixRun,
        });
      }
      if (error instanceof ProviderCredentialsMissingError) {
        const providerLabel =
          error.provider === 'openai'
            ? 'OpenAI'
            : error.provider === 'opencode'
              ? 'OpenCode'
              : 'Claude';
        return res.status(403).json({
          error: `${providerLabel} credentials are not provisioned for this user. Connect ${providerLabel} in Settings → Providers.`,
          code: 'PROVIDER_CREDENTIALS_MISSING',
          provider: error.provider,
        });
      }
      console.error('Error starting epic agent run:', error);
      res.status(500).json({ error: 'Failed to start epic agent run' } satisfies ApiError);
    }
  },
);

// ---------------------------------------------------------------------------
// Orchestration — the autonomous implementation stage
// ---------------------------------------------------------------------------

/**
 * Enter autonomous implementation. From here the orchestrator drives every
 * ticket to merge on its own; the user only hears from it on escalation.
 *
 * `orchestration_active` is a durable flag rather than a running run, because
 * the orchestrator is dormant between events — there is nothing running to read
 * the state off.
 */
router.post(
  '/epics/:id/orchestrator/start',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<OrchestrationResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;

    if (!epic.stories_complete) {
      return res.status(409).json({
        error: 'Create and approve the epic tickets first',
      } satisfies ApiError);
    }
    // The specification review is the gate this endpoint exists behind: the
    // review agent sets the flag itself when it finds nothing blocking, and
    // the human backstop sets it to accept the findings as they stand. Either
    // way, autonomous implementation never starts on documents nobody checked.
    if (!epic.review_complete) {
      return res.status(409).json({
        error: 'Finish the specification review first',
      } satisfies ApiError);
    }
    const tickets = epicTicketsDb.listTickets(epic.id);
    if (tickets.length === 0) {
      return res.status(409).json({ error: 'This epic has no tickets' } satisfies ApiError);
    }
    if (epic.orchestration_active) {
      return res.status(409).json({
        error: epic.orchestration_blocked
          ? 'This epic is paused — resume orchestration instead'
          : 'This epic is already being orchestrated',
      } satisfies ApiError);
    }
    if (tickets.every((t) => t.status === 'completed')) {
      return res.status(409).json({
        error: 'Every ticket of this epic is already merged',
      } satisfies ApiError);
    }
    const runningAgent = getRunningAgentForEpic(epic.id);
    if (runningAgent) {
      return res.status(409).json({
        error: `Epic agent '${runningAgent.agent_type}' is still running. Wait for it to finish before starting orchestration.`,
      } satisfies ApiError);
    }

    try {
      const updated = epicsDb.setOrchestrationActive(epic.id, true);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to update epic' } satisfies ApiError);
      }
      resetBridgeCounters(epic.id);
      broadcastEpicRow(req, updated);
      // Fire-and-forget: starting the first ticket's run spins up an SDK
      // subprocess, and the caller only needs to know orchestration is on.
      void advance(epic.id).catch((err: unknown) => {
        console.error(`Failed to start orchestration for epic ${epic.id}:`, err);
        const message = err instanceof Error ? err.message : String(err);
        blockOrchestration(epic.id, `The orchestrator could not start: ${message}`, {
          broadcastToEpicSubscribersFn: getEpicBroadcast(req),
          userId: req.user!.id,
        });
      });
      res.json(updated);
    } catch (error) {
      console.error('Error starting epic orchestration:', error);
      res.status(500).json({ error: 'Failed to start orchestration' } satisfies ApiError);
    }
  },
);

/**
 * Halt orchestration without leaving it. Any turn currently streaming is
 * durably interrupted and then aborted, and the bridge stops injecting — but
 * `orchestration_active` stays set, so resuming continues the exact reviewer
 * or orchestrator conversation rather than starting a replacement.
 */
router.post(
  '/epics/:id/orchestrator/pause',
  validateParams(IdParamsSchema),
  validateBody(PauseOrchestrationBodySchema),
  async (req: Request, res: Response<OrchestrationResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    if (!epic.orchestration_active) {
      return res.status(409).json({
        error: 'This epic is not being orchestrated',
      } satisfies ApiError);
    }

    try {
      const { reason } = req.validated!.body as PauseOrchestrationBody;
      const updated = blockOrchestration(epic.id, reason ?? 'Paused by the user.', {
        broadcastToEpicSubscribersFn: getEpicBroadcast(req),
        userId: null,
      });
      if (!updated) {
        return res.status(500).json({ error: 'Failed to update epic' } satisfies ApiError);
      }

      // Stop the turn that is mid-flight, if any. Session control records an
      // epic run as `blocked` before aborting transport, so its completion hook
      // cannot schedule a replacement.
      //
      // `sessionControl` is loaded on demand: it reaches the provider registry
      // and, through it, the transcript store — a graph this route file has
      // deliberately stayed out of.
      const running = getRunningAgentForEpic(epic.id);
      if (running?.conversation_id != null) {
        const { abortSession, getActiveStreamingByConversation } = await import(
          '../services/conversation/sessionControl.js'
        );
        const streaming = getActiveStreamingByConversation(running.conversation_id);
        if (streaming) await abortSession(streaming.sessionId);
      }
      res.json(updated);
    } catch (error) {
      console.error('Error pausing epic orchestration:', error);
      res.status(500).json({ error: 'Failed to pause orchestration' } satisfies ApiError);
    }
  },
);

/**
 * Release a blocked epic. A user-stopped run is resumed in its exact
 * conversation (reviewer or orchestrator). An escalation block has no blocked
 * run, so it keeps the snapshot-wake recovery path.
 */
router.post(
  '/epics/:id/orchestrator/resume',
  validateParams(IdParamsSchema),
  async (req: Request, res: Response<OrchestrationResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;
    if (!epic.orchestration_active) {
      return res.status(409).json({
        error: 'This epic is not being orchestrated — start orchestration instead',
      } satisfies ApiError);
    }
    if (!epic.orchestration_blocked) {
      return res.status(409).json({
        error: 'This epic is not paused',
      } satisfies ApiError);
    }

    try {
      const interrupted = epicAgentRunsDb
        .getByEpic(epic.id)
        .find(
          (run) =>
            run.status === 'blocked' &&
            run.conversation_id != null &&
            (run.agent_type === 'epic-orchestrator' ||
              run.agent_type === 'epic-pr-review'),
        );
      if (interrupted?.conversation_id != null) {
        const conversationId = interrupted.conversation_id;
        const { getActiveStreamingByConversation } = await import(
          '../services/conversation/sessionControl.js'
        );
        if (getActiveStreamingByConversation(conversationId)) {
          return res.status(409).json({
            error: 'The interrupted turn is still stopping. Try Resume again in a moment.',
          } satisfies ApiError);
        }
        const role =
          interrupted.agent_type === 'epic-pr-review' ? 'PR reviewer' : 'orchestrator';
        const broadcastToConversationSubscribers = req.app.locals
          .broadcastToConversationSubscribers as
          | ((conversationId: number, message: ServerToClientMessage) => void)
          | undefined;
        const broadcastFn = (id: number, message: ServerToClientMessage): void => {
          broadcastToConversationSubscribers?.(id, message);
        };

        // Do not clear the durable block here. The turn-start hook does that
        // only after the provider session is registered, leaving a failed
        // startup safely resumable.
        void import('../services/conversationAdapter.js')
          .then(({ sendMessage }) =>
            sendMessage(
              conversationId,
              `[bottega-event] type=user-resumed\n\nThe user resumed this ${role}. ` +
                'Re-read the current epic and task state, then continue from where you stopped.',
              {
                broadcastFn,
                broadcastToEpicSubscribersFn: getEpicBroadcast(req),
                broadcastToTaskSubscribersFn: req.app.locals.broadcastToTaskSubscribers,
                userId: req.user!.id,
                permissionMode: 'bypassPermissions',
              },
            ),
          )
          .catch((error) => {
            console.error(
              `Failed to resume interrupted epic run ${interrupted.id} ` +
                `(conversation ${conversationId}):`,
              error,
            );
          });
        res.json(epic);
        return;
      }

      const updated = epicsDb.setOrchestrationBlocked(epic.id, false);
      if (!updated) {
        return res.status(500).json({ error: 'Failed to update epic' } satisfies ApiError);
      }
      resetBridgeCounters(epic.id);
      broadcastEpicRow(req, updated);
      wakeOrchestrator(epic.id, 'resumed');
      res.json(updated);
    } catch (error) {
      console.error('Error resuming epic orchestration:', error);
      res.status(500).json({ error: 'Failed to resume orchestration' } satisfies ApiError);
    }
  },
);

// ---------------------------------------------------------------------------
// Completion PR
// ---------------------------------------------------------------------------

/**
 * Open the epic's final pull request (feature branch -> repo default). Git
 * failures answer 200 with `{ success: false, error }`, mirroring the task PR
 * endpoint — the caller renders the git error, it is not an HTTP-level fault.
 */
router.post(
  '/epics/:id/complete-pr',
  validateParams(IdParamsSchema),
  validateBody(CompleteEpicPRBodySchema),
  async (req: Request, res: Response<CompleteEpicPRResponse | ApiError>) => {
    const epic = requireEpic(req, res);
    if (!epic) return;

    try {
      const { title, body } = req.validated!.body as CompleteEpicPRBody;
      const result = await createEpicCompletionPR(epic.id, { title, body });
      res.json(
        result.success
          ? { success: true, url: result.url ?? '' }
          : { success: false, error: result.error ?? 'Failed to create the epic pull request' },
      );
    } catch (error) {
      console.error('Error creating epic completion PR:', error);
      res
        .status(500)
        .json({ error: 'Failed to create the epic pull request' } satisfies ApiError);
    }
  },
);

export default router;
