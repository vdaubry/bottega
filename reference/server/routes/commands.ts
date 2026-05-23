import express, { type Request, type Response } from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';
import type { ApiError } from '../../shared/api/_common.js';
import type {
  ListCommandsRequest,
  ListCommandsResponse,
  SlashCommand,
  SlashCommandFrontmatter,
} from '../../shared/api/settings.js';

const router = express.Router();

async function scanCommandsDirectory(
  dir: string,
  baseDir: string,
  namespace: 'project' | 'user',
): Promise<SlashCommand[]> {
  const commands: SlashCommand[] = [];

  try {
    await fs.access(dir);

    const entries = await fs.readdir(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        const subCommands = await scanCommandsDirectory(fullPath, baseDir, namespace);
        commands.push(...subCommands);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        try {
          const content = await fs.readFile(fullPath, 'utf8');
          const parsed = matter(content);
          const frontmatter = parsed.data as SlashCommandFrontmatter;
          const commandContent = parsed.content;

          const relativePath = path.relative(baseDir, fullPath);
          const commandName = '/' + relativePath.replace(/\.md$/, '').replace(/\\/g, '/');

          let description =
            typeof frontmatter.description === 'string' ? frontmatter.description : '';
          if (!description) {
            const firstLine = commandContent.trim().split('\n')[0] ?? '';
            description = firstLine.replace(/^#+\s*/, '').trim();
          }

          commands.push({
            name: commandName,
            path: fullPath,
            relativePath,
            description,
            namespace,
            metadata: frontmatter,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`Error parsing command file ${fullPath}:`, message);
        }
      }
    }
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT' && code !== 'EACCES') {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error scanning directory ${dir}:`, message);
    }
  }

  return commands;
}

interface CommandsErrorBody extends ApiError {
  message?: string;
}

router.post(
  '/list',
  async (
    req: Request<unknown, ListCommandsResponse | CommandsErrorBody, ListCommandsRequest>,
    res: Response<ListCommandsResponse | CommandsErrorBody>,
  ) => {
    try {
      const { projectPath } = req.body;
      const allCommands: SlashCommand[] = [];

      if (projectPath) {
        const projectCommandsDir = path.join(projectPath, '.claude', 'commands');
        const projectCommands = await scanCommandsDirectory(
          projectCommandsDir,
          projectCommandsDir,
          'project',
        );
        allCommands.push(...projectCommands);
      }

      const homeDir = os.homedir();
      const userCommandsDir = path.join(homeDir, '.claude', 'commands');
      const userCommands = await scanCommandsDirectory(
        userCommandsDir,
        userCommandsDir,
        'user',
      );
      allCommands.push(...userCommands);

      allCommands.sort((a, b) => a.name.localeCompare(b.name));

      res.json({
        builtIn: [],
        custom: allCommands,
        count: allCommands.length,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('Error listing commands:', error);
      res.status(500).json({
        error: 'Failed to list commands',
        message,
      });
    }
  },
);

export default router;
