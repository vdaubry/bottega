// Conversation image store — images a model generated during a conversation.
//
// A provider leaves a generated image in its own scratch space (Codex:
// `$CODEX_HOME/generated_images/<thread>/`), which is per-user and nothing
// Bottega controls the lifetime of. The conversation layer copies each one
// here, under the archive root and keyed by conversation id, so the transcript
// can reference it by file name alone and any project member can load it
// whichever user's credentials the turn ran on.

import fs from 'fs/promises';
import path from 'path';

import { GENERATED_IMAGE_FILE_NAME } from '../../shared/providers/generatedImage.js';
import { getArchiveRoot } from './documentation.js';

function conversationFolder(conversationId: number): string {
  return path.join(getArchiveRoot(), 'conversations', String(conversationId));
}

/**
 * Where a conversation's image lives, or null for a name the store never
 * holds — the gate that keeps a request-supplied name inside the folder.
 */
export function getConversationImagePath(conversationId: number, fileName: string): string | null {
  if (!GENERATED_IMAGE_FILE_NAME.test(fileName)) return null;
  return path.join(conversationFolder(conversationId), 'images', fileName);
}

export async function storeConversationImage(
  conversationId: number,
  sourcePath: string,
  fileName: string,
): Promise<void> {
  const target = getConversationImagePath(conversationId, fileName);
  if (!target) throw new Error(`Not a storable image file name: ${fileName}`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(sourcePath, target);
}

export async function deleteConversationImages(conversationId: number): Promise<void> {
  await fs.rm(conversationFolder(conversationId), { recursive: true, force: true });
}
