import express, { type Request, type Response } from 'express';
import { db, projectsDb, tasksDb, conversationsDb } from '../database/db.js';
import { resolveProjectKey } from '../services/conversationContentStore.js';
import type { ApiError } from '../../shared/api/_common.js';
import type { ExportCorpusResponse, ExportConversation } from '../../shared/api/export.js';

const router = express.Router();

interface MessageRow {
  seq: number;
  entry_json: Buffer;
}

router.get(
  '/corpus',
  (
    req: Request,
    res: Response<ExportCorpusResponse | ApiError>,
  ) => {
    try {
      const userId = req.user!.id;
      const username = req.user!.username;

      const rawInclude = req.query.includeMessageProjects as string | undefined;
      const includeSet = new Set<number>();
      if (rawInclude) {
        for (const part of rawInclude.split(',')) {
          const id = parseInt(part.trim(), 10);
          if (!isNaN(id)) includeSet.add(id);
        }
      }

      const rawProjectIds = req.query.projectIds as string | undefined;
      let projectIdFilter: Set<number> | null = null;
      if (rawProjectIds) {
        projectIdFilter = new Set<number>();
        for (const part of rawProjectIds.split(',')) {
          const id = parseInt(part.trim(), 10);
          if (!isNaN(id)) projectIdFilter.add(id);
        }
      }

      let projects = projectsDb.getAll(userId);
      if (projectIdFilter) {
        projects = projects.filter((p) => projectIdFilter!.has(p.id));
      }
      const exportProjects = projects.map((project) => {
        const projectKey = resolveProjectKey(project.repo_folder_path);
        const tasks = tasksDb.getByProject(project.id);
        const includeMessages = includeSet.has(project.id);

        const exportTasks = tasks.map((task) => {
          const conversations = conversationsDb.getByTask(task.id);

          const exportConversations = conversations.map((conv) => {
            const base: ExportConversation = {
              id: conv.id,
              name: conv.name,
              provider: conv.provider,
              model: conv.model,
              effort: conv.effort,
              created_at: conv.created_at,
            };

            if (includeMessages && conv.claude_conversation_id) {
              const rows = db
                .prepare(
                  `SELECT seq, entry_json
                   FROM messages
                   WHERE session_id = ? AND project_key = ?
                   ORDER BY seq`,
                )
                .all(conv.claude_conversation_id, projectKey) as MessageRow[];
              base.messages = rows.map((r) =>
                JSON.parse(r.entry_json.toString('utf-8')),
              );
            }

            return base;
          });

          return {
            id: task.id,
            title: task.title,
            status: task.status,
            completed_at: task.completed_at,
            created_at: task.created_at,
            updated_at: task.updated_at,
            conversations: exportConversations,
          };
        });

        return {
          id: project.id,
          name: project.name,
          repo_folder_path: project.repo_folder_path,
          created_at: project.created_at,
          updated_at: project.updated_at,
          tasks: exportTasks,
        };
      });

      const payload: ExportCorpusResponse = {
        exported_at: new Date().toISOString(),
        exported_by: { id: userId, username },
        projects: exportProjects,
      };

      res.json(payload);
    } catch (error) {
      console.error('Error exporting corpus:', error);
      res.status(500).json({ error: 'Failed to export corpus' });
    }
  },
);

export default router;
