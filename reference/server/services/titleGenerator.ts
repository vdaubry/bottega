/**
 * Title Generator Service
 *
 * Generates short AI-summarized titles for conversations using Claude CLI.
 * Fire-and-forget pattern: doesn't block the conversation flow.
 */

import { spawn, type ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { conversationsDb } from '../database/db.js';
import {
  auditClaudeLaunch,
  buildClaudeSpawnEnv,
} from './claudeCredentials.js';
import type {
  BroadcastFn,
  BroadcastToTaskSubscribersFn,
  ConversationId,
  TaskId,
} from '@shared/websocket/messages';

const TIMEOUT_MS = 20000;
const MAX_MESSAGE_LENGTH = 500;
const MAX_TITLE_LENGTH = 50;

function sanitizeTitle(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') {
    return null;
  }

  let title = raw.trim().replace(/^["']|["']$/g, '').trim();
  title = title.replace(/[.!?]+$/, '').trim();

  if (title.length > MAX_TITLE_LENGTH) {
    title = title.substring(0, MAX_TITLE_LENGTH - 3) + '...';
  }

  if (title.length < 2) {
    return null;
  }

  return title;
}

/**
 * Generate a conversation title using Claude CLI with Haiku model.
 * Fire-and-forget — does not block the conversation.
 *
 * When the title lands we dual-emit `conversation-name-updated`:
 * - on the conversation channel via `broadcastFn` (chat header updates)
 * - on the task channel via `broadcastToTaskSubscribersFn` (task viewer's
 *   conversation list updates) — only when `taskId` is provided.
 */
export function generateConversationTitle(
  conversationId: ConversationId,
  message: string,
  broadcastFn?: BroadcastFn,
  userId?: number,
  taskId?: TaskId,
  broadcastToTaskSubscribersFn?: BroadcastToTaskSubscribersFn,
): void {
  if (!conversationId || !message) {
    console.warn('[TitleGenerator] Missing conversationId or message');
    return;
  }

  let env: NodeJS.ProcessEnv;
  try {
    env = buildClaudeSpawnEnv(userId);
  } catch (err) {
    console.warn(
      `[TitleGenerator] Cannot generate title for conversation ${conversationId}:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  const truncatedMessage =
    message.length > MAX_MESSAGE_LENGTH
      ? message.substring(0, MAX_MESSAGE_LENGTH) + '...'
      : message;

  const prompt = `Generate a 1-3 word title summarizing this message. Output ONLY the title, nothing else:

${truncatedMessage}`;

  const args = [
    '-p',
    prompt,
    '--model',
    'haiku',
    '--output-format',
    'text',
    '--max-turns',
    '1',
  ];

  console.log(
    `[TitleGenerator] Starting title generation for conversation ${conversationId}`,
  );

  let claude: ChildProcessByStdio<null, Readable, Readable>;
  try {
    claude = spawn('claude', args, {
      timeout: TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (err) {
    console.warn(
      `[TitleGenerator] Failed to spawn claude CLI:`,
      err instanceof Error ? err.message : String(err),
    );
    return;
  }

  auditClaudeLaunch({
    source: 'title-generator',
    userId,
    pid: claude.pid,
    conversationId,
    claudeSessionId: null,
    cwd: null,
  });

  let stdout = '';
  let stderr = '';
  let killed = false;

  const timeoutId = setTimeout(() => {
    if (!killed) {
      killed = true;
      claude.kill('SIGTERM');
      console.warn(`[TitleGenerator] Timeout for conversation ${conversationId}`);
    }
  }, TIMEOUT_MS);

  claude.stdout.on('data', (data: Buffer) => {
    stdout += data.toString();
  });

  claude.stderr.on('data', (data: Buffer) => {
    stderr += data.toString();
  });

  claude.on('close', (code: number | null) => {
    clearTimeout(timeoutId);

    if (killed) {
      return;
    }

    if (code !== 0) {
      console.warn(
        `[TitleGenerator] CLI exited with code ${code} for conversation ${conversationId}`,
      );
      if (stderr) {
        console.warn(`[TitleGenerator] stderr: ${stderr.substring(0, 200)}`);
      }
      return;
    }

    const title = sanitizeTitle(stdout);
    if (!title) {
      console.warn(
        `[TitleGenerator] Invalid title output for conversation ${conversationId}`,
      );
      return;
    }

    try {
      const updated = conversationsDb.updateName(conversationId, title);
      if (!updated) {
        console.warn(
          `[TitleGenerator] Failed to update conversation ${conversationId} (not found)`,
        );
        return;
      }

      console.log(
        `[TitleGenerator] Updated conversation ${conversationId} with title: "${title}"`,
      );

      if (broadcastFn && taskId !== undefined) {
        broadcastFn(conversationId, {
          type: 'conversation-name-updated',
          conversationId,
          taskId,
          name: title,
        });
      }
      if (broadcastToTaskSubscribersFn && taskId !== undefined) {
        // `taskId` is spliced in by the helper itself.
        broadcastToTaskSubscribersFn(taskId, {
          type: 'conversation-name-updated',
          conversationId,
          name: title,
        });
      }
    } catch (err) {
      console.error(
        `[TitleGenerator] Database error for conversation ${conversationId}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  });

  claude.on('error', (err: Error) => {
    clearTimeout(timeoutId);
    console.warn(
      `[TitleGenerator] Process error for conversation ${conversationId}:`,
      err.message,
    );
  });
}

export default { generateConversationTitle };
