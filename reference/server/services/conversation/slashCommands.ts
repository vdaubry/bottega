import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import matter from 'gray-matter';

// Bottega's own .claude/commands/ ships with the repo and applies to every
// project. Kept in sync with BUILTIN_COMMANDS_DIR in
// `server/routes/commands.ts`. See that file for the path math.
const __filename = fileURLToPath(import.meta.url);
const BOTTEGA_INSTALL_ROOT = path.resolve(
  path.dirname(__filename),
  '..',
  '..',
  '..',
  '..',
);
const BUILTIN_COMMANDS_DIR = path.join(BOTTEGA_INSTALL_ROOT, '.claude', 'commands');

/**
 * Resolve a slash command message to its expanded content.
 * Looks up custom command .md files in project, user, and Bottega built-in
 * command directories.
 */
export async function resolveSlashCommand(
  message: string | null,
  projectPath: string | null | undefined,
): Promise<string | null> {
  if (!message || !message.startsWith('/')) return message;

  const parts = message.trim().split(/\s+/);
  const commandName = parts[0] ?? '';
  const args = parts.slice(1);
  const bareCommandName = commandName.slice(1);

  if (!bareCommandName) return message;

  const searchDirs: string[] = [];
  if (projectPath) {
    searchDirs.push(path.join(projectPath, '.claude', 'commands'));
  }
  searchDirs.push(path.join(os.homedir(), '.claude', 'commands'));
  searchDirs.push(BUILTIN_COMMANDS_DIR);

  for (const dir of searchDirs) {
    const candidates = [
      path.join(dir, `${bareCommandName}.md`),
      path.join(dir, bareCommandName, 'index.md'),
    ];

    for (const filePath of candidates) {
      try {
        const content = await fs.readFile(filePath, 'utf8');
        const { content: commandContent } = matter(content);

        let processed = commandContent;
        const argsString = args.join(' ');
        processed = processed.replace(/\$ARGUMENTS/g, argsString);
        args.forEach((arg, index) => {
          const placeholder = `$${index + 1}`;
          processed = processed.replace(new RegExp(`\\${placeholder}\\b`, 'g'), arg);
        });

        console.log(`[ConversationAdapter] Resolved slash command ${commandName} from ${filePath}`);
        return processed.trim();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code !== 'ENOENT') {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[ConversationAdapter] Error reading command file ${filePath}:`, message);
        }
      }
    }
  }

  return message;
}
