import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import matter from 'gray-matter';

/**
 * Resolve a slash command message to its expanded content.
 * Looks up custom command .md files in project and user command directories.
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
