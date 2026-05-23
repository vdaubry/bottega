import express, { type Request, type Response } from 'express';
import {
  listPromptNames,
  getPromptDefinition,
  loadDefault,
  loadPrompt,
  hasOverride,
  saveOverride,
  deleteOverride,
  getOverrideMtime,
  findUnknownVariables,
} from '../services/promptRenderer.js';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  GetPromptResponse,
  ListPromptsResponse,
  PromptConcurrentEditError,
  SavePromptRequest,
  SavePromptResponse,
  UnknownVariablesError,
} from '../../shared/api/settings.js';

const router = express.Router();

router.get(
  '/prompts',
  (_req: Request, res: Response<ListPromptsResponse | ApiError>) => {
    try {
      const prompts: ListPromptsResponse = listPromptNames().map((name) => {
        const def = getPromptDefinition(name)!;
        return {
          name,
          label: def.label,
          kind: def.kind,
          isCustomized: hasOverride(name),
        };
      });
      res.json(prompts);
    } catch (error) {
      console.error('Error listing prompts:', error);
      res.status(500).json({ error: 'Failed to list prompts' });
    }
  },
);

router.get(
  '/prompts/:name',
  (
    req: Request<{ name: string }>,
    res: Response<GetPromptResponse | ApiError>,
  ) => {
    const def = getPromptDefinition(req.params.name);
    if (!def) {
      return res.status(404).json({ error: 'Unknown prompt' });
    }
    try {
      const defaultContent = loadDefault(def.name);
      const isCustomized = hasOverride(def.name);
      const content = loadPrompt(def.name);
      const mtime = isCustomized ? getOverrideMtime(def.name) : null;
      res.json({
        name: def.name,
        label: def.label,
        kind: def.kind,
        content,
        defaultContent,
        variables: def.variables,
        isCustomized,
        mtime,
      });
    } catch (error) {
      console.error(`Error reading prompt ${def.name}:`, error);
      res.status(500).json({ error: 'Failed to read prompt' });
    }
  },
);

router.put(
  '/prompts/:name',
  (
    req: Request<
      { name: string },
      SavePromptResponse | ApiError | UnknownVariablesError | PromptConcurrentEditError,
      SavePromptRequest
    >,
    res: Response<
      SavePromptResponse | ApiError | UnknownVariablesError | PromptConcurrentEditError
    >,
  ) => {
    const def = getPromptDefinition(req.params.name);
    if (!def) {
      return res.status(404).json({ error: 'Unknown prompt' });
    }
    const { content, expectedMtime } = req.body || ({} as SavePromptRequest);
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required' });
    }

    const unknown = findUnknownVariables(def.name, content);
    if (unknown.length > 0) {
      return res.status(400).json({
        error: 'Unknown template variables',
        unknownVariables: unknown,
        allowedVariables: def.variables,
      });
    }

    if (expectedMtime != null) {
      const current = getOverrideMtime(def.name);
      if (current !== null && current !== expectedMtime) {
        return res.status(409).json({
          error: 'Prompt was modified by another tab. Reload before saving.',
          currentMtime: current,
        });
      }
    }

    try {
      const mtime = saveOverride(def.name, content);
      res.json({ name: def.name, mtime, isCustomized: true });
    } catch (error) {
      console.error(`Error saving prompt ${def.name}:`, error);
      res.status(500).json({ error: 'Failed to save prompt' });
    }
  },
);

router.delete(
  '/prompts/:name',
  (req: Request<{ name: string }>, res: Response<ApiError | undefined>) => {
    const def = getPromptDefinition(req.params.name);
    if (!def) {
      return res.status(404).json({ error: 'Unknown prompt' });
    }
    try {
      deleteOverride(def.name);
      res.status(204).send();
    } catch (error) {
      console.error(`Error deleting prompt override ${def.name}:`, error);
      res.status(500).json({ error: 'Failed to delete prompt override' });
    }
  },
);

export default router;
