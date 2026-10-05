// Model-generated images — the contract shared by the provider that detects
// one, the store + route that serve it, and the chat UI that renders it.
//
// A generated image travels as its own assistant transcript entry holding one
// `generated_image` content block. The block names the file, never a URL: the
// bytes live in the conversation's image store and are served by
// `GET /api/conversations/:id/images/:fileName`, so the reader builds the URL
// from the conversation it is already showing.

import type { UnifiedAssistantImageMessage } from './types.js';

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * The only file names the image store accepts or serves: one path segment,
 * no separators, a raster extension we know the MIME type of.
 */
export const GENERATED_IMAGE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}\.(png|jpe?g|webp)$/i;

/** MIME type for a generated-image file name, or null when the name is not servable. */
export function generatedImageMimeType(fileName: string): string | null {
  if (!GENERATED_IMAGE_FILE_NAME.test(fileName)) return null;
  const extension = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? null;
}

export interface GeneratedImageBlock {
  type: 'generated_image';
  file_name: string;
  media_type: string;
  /** Intrinsic pixel size — lets the UI reserve the thumbnail's box before the bytes load. */
  width?: number;
  height?: number;
}

export function generatedImageBlock(unified: UnifiedAssistantImageMessage): GeneratedImageBlock {
  return {
    type: 'generated_image',
    file_name: unified.fileName,
    media_type: unified.mimeType,
    ...(unified.width && unified.height ? { width: unified.width, height: unified.height } : {}),
  };
}

/** Narrow an untyped transcript / wire content block to a renderable generated image. */
export function asGeneratedImageBlock(block: unknown): GeneratedImageBlock | null {
  if (typeof block !== 'object' || block === null) return null;
  const candidate = block as Partial<GeneratedImageBlock>;
  if (candidate.type !== 'generated_image') return null;
  if (typeof candidate.file_name !== 'string' || !GENERATED_IMAGE_FILE_NAME.test(candidate.file_name)) {
    return null;
  }
  return candidate as GeneratedImageBlock;
}
