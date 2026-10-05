// Codex generated images.
//
// Codex's built-in `image_gen` tool saves every image it produces to
// `$CODEX_HOME/generated_images/<thread id>/<item id>.png` — and the SDK's
// event stream never mentions it. Inside Codex the image is an "extension"
// item (`image_gen.generation`), a kind `codex exec --experimental-json` does
// not forward and `ThreadItem` has no variant for (checked against
// `@openai/codex-sdk` 0.159.3 and 0.160.0). The assistant's own text only says
// the image "is displayed above". So that folder is the one signal there is:
// the provider lists it around the events it does receive and reports each new
// file as an `assistant_image` message.

import fs from 'fs/promises';
import path from 'path';

import { generatedImageMimeType } from '@shared/providers/generatedImage';
import type { UnifiedAssistantImageMessage } from '@shared/providers/types';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// The zero-length IEND chunk (length, type, CRC) every complete PNG ends with.
const PNG_TRAILER = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
// Signature + IHDR length/type + width + height.
const PNG_HEADER_BYTES = 24;

interface ProbedImage {
  mtimeMs: number;
  width?: number;
  height?: number;
  /** True only when the bytes prove the file is fully written (PNG trailer present). */
  complete: boolean;
}

async function probeImage(filePath: string): Promise<ProbedImage | null> {
  const handle = await fs.open(filePath, 'r');
  try {
    const { size, mtimeMs } = await handle.stat();
    if (size === 0) return null;
    if (size < PNG_HEADER_BYTES + PNG_TRAILER.length) return { mtimeMs, complete: false };

    const header = Buffer.alloc(PNG_HEADER_BYTES);
    await handle.read(header, 0, header.length, 0);
    if (!header.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      return { mtimeMs, complete: false };
    }
    const trailer = Buffer.alloc(PNG_TRAILER.length);
    await handle.read(trailer, 0, trailer.length, size - trailer.length);
    return {
      mtimeMs,
      width: header.readUInt32BE(16),
      height: header.readUInt32BE(20),
      complete: trailer.equals(PNG_TRAILER),
    };
  } finally {
    await handle.close();
  }
}

async function listImageFiles(dir: string): Promise<string[]> {
  try {
    const names = await fs.readdir(dir);
    return names.filter((name) => generatedImageMimeType(name) !== null);
  } catch (error) {
    // No folder is the normal case: Codex creates it with the thread's first image.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[CodexProvider] Could not list generated images in ${dir}:`, error);
    }
    return [];
  }
}

export interface GeneratedImageScanner {
  /**
   * Images that appeared since the last call, oldest first. Mid-turn
   * (`final: false`) a file is reported only once its bytes prove it is fully
   * written; anything else waits for the `final` scan at the end of the turn,
   * when Codex has stopped writing.
   */
  collect(options: { final: boolean }): Promise<UnifiedAssistantImageMessage[]>;
}

/**
 * Start watching one thread's generated-image folder. Files already there
 * belong to earlier turns — reported then — and are never reported again.
 */
export async function openGeneratedImageScanner(
  codexHome: string,
  threadId: string,
): Promise<GeneratedImageScanner> {
  const dir = path.join(codexHome, 'generated_images', threadId);
  const reported = new Set(await listImageFiles(dir));

  return {
    async collect({ final }) {
      const found: { name: string; probed: ProbedImage }[] = [];
      for (const name of await listImageFiles(dir)) {
        if (reported.has(name)) continue;
        const probed = await probeImage(path.join(dir, name)).catch(() => null);
        if (!probed || (!final && !probed.complete)) continue;
        reported.add(name);
        found.push({ name, probed });
      }
      found.sort((a, b) => a.probed.mtimeMs - b.probed.mtimeMs || a.name.localeCompare(b.name));

      return found.map(({ name, probed }) => ({
        type: 'assistant_image',
        id: `generated_image:${name}`,
        provider: 'openai',
        providerSessionId: threadId,
        raw: null,
        sourcePath: path.join(dir, name),
        fileName: name,
        mimeType: generatedImageMimeType(name) ?? 'application/octet-stream',
        ...(probed.width && probed.height ? { width: probed.width, height: probed.height } : {}),
      }));
    },
  };
}
