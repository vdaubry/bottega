import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  deleteConversationImages,
  getConversationImagePath,
  storeConversationImage,
} from './conversationImages.js';

describe('conversationImages', () => {
  let archiveRoot: string;
  let source: string;
  let previousRoot: string | undefined;

  beforeEach(async () => {
    archiveRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'bottega-archive-'));
    previousRoot = process.env.BOTTEGA_ARCHIVE_ROOT;
    process.env.BOTTEGA_ARCHIVE_ROOT = archiveRoot;
    source = path.join(archiveRoot, 'source.png');
    await fs.writeFile(source, 'png-bytes');
  });

  afterEach(async () => {
    if (previousRoot === undefined) delete process.env.BOTTEGA_ARCHIVE_ROOT;
    else process.env.BOTTEGA_ARCHIVE_ROOT = previousRoot;
    await fs.rm(archiveRoot, { recursive: true, force: true });
  });

  it('copies an image into the conversation folder and resolves it by name', async () => {
    await storeConversationImage(42, source, 'exec-1.png');

    const stored = getConversationImagePath(42, 'exec-1.png');
    expect(stored).toBe(path.join(archiveRoot, 'conversations', '42', 'images', 'exec-1.png'));
    expect(await fs.readFile(stored!, 'utf8')).toBe('png-bytes');
    // The provider's own copy is left alone.
    expect(await fs.readFile(source, 'utf8')).toBe('png-bytes');
  });

  it('refuses names that could leave the conversation folder', async () => {
    expect(getConversationImagePath(42, '../../etc/passwd')).toBeNull();
    expect(getConversationImagePath(42, 'a/b.png')).toBeNull();
    expect(getConversationImagePath(42, '.env')).toBeNull();
    await expect(storeConversationImage(42, source, '../escape.png')).rejects.toThrow(
      'Not a storable image file name',
    );
  });

  it('deletes one conversation\'s images and leaves the others', async () => {
    await storeConversationImage(42, source, 'a.png');
    await storeConversationImage(43, source, 'b.png');

    await deleteConversationImages(42);

    await expect(fs.access(getConversationImagePath(42, 'a.png')!)).rejects.toThrow();
    await expect(fs.access(getConversationImagePath(43, 'b.png')!)).resolves.toBeUndefined();
  });

  it('deleting a conversation that never had images is a no-op', async () => {
    await expect(deleteConversationImages(999)).resolves.toBeUndefined();
  });
});
