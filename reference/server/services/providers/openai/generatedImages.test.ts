import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { openGeneratedImageScanner } from './generatedImages.js';

const THREAD = 'thread-abc';

/** A structurally complete PNG: signature, IHDR carrying the size, IEND trailer. */
function pngBytes(width: number, height: number): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write('IHDR', 12, 'ascii');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  const body = Buffer.alloc(32, 7);
  const trailer = Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
  return Buffer.concat([header, body, trailer]);
}

describe('openGeneratedImageScanner', () => {
  let codexHome: string;
  let dir: string;

  beforeEach(async () => {
    codexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-home-'));
    dir = path.join(codexHome, 'generated_images', THREAD);
  });

  afterEach(async () => {
    await fs.rm(codexHome, { recursive: true, force: true });
  });

  it('reports nothing while the thread has no image folder', async () => {
    const scanner = await openGeneratedImageScanner(codexHome, THREAD);
    expect(await scanner.collect({ final: false })).toEqual([]);
    expect(await scanner.collect({ final: true })).toEqual([]);
  });

  it('reports a new image once, with its intrinsic size', async () => {
    const scanner = await openGeneratedImageScanner(codexHome, THREAD);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'exec-1.png'), pngBytes(1536, 1024));

    expect(await scanner.collect({ final: false })).toEqual([
      {
        type: 'assistant_image',
        id: 'generated_image:exec-1.png',
        provider: 'openai',
        providerSessionId: THREAD,
        raw: null,
        sourcePath: path.join(dir, 'exec-1.png'),
        fileName: 'exec-1.png',
        mimeType: 'image/png',
        width: 1536,
        height: 1024,
      },
    ]);
    expect(await scanner.collect({ final: true })).toEqual([]);
  });

  it('never reports the images earlier turns left in the folder', async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'earlier.png'), pngBytes(10, 10));

    const scanner = await openGeneratedImageScanner(codexHome, THREAD);
    await fs.writeFile(path.join(dir, 'new.png'), pngBytes(10, 10));

    const found = await scanner.collect({ final: false });
    expect(found.map((m) => m.fileName)).toEqual(['new.png']);
  });

  it('holds back a half-written PNG until it is complete', async () => {
    const scanner = await openGeneratedImageScanner(codexHome, THREAD);
    await fs.mkdir(dir, { recursive: true });
    const bytes = pngBytes(64, 64);
    const file = path.join(dir, 'slow.png');

    await fs.writeFile(file, bytes.subarray(0, bytes.length - 6));
    expect(await scanner.collect({ final: false })).toEqual([]);

    await fs.writeFile(file, bytes);
    expect((await scanner.collect({ final: false })).map((m) => m.fileName)).toEqual(['slow.png']);
  });

  it('reports formats it cannot verify only on the final scan, without a size', async () => {
    const scanner = await openGeneratedImageScanner(codexHome, THREAD);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'photo.jpg'), Buffer.alloc(64, 1));

    expect(await scanner.collect({ final: false })).toEqual([]);

    const found = await scanner.collect({ final: true });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ fileName: 'photo.jpg', mimeType: 'image/jpeg' });
    expect(found[0]).not.toHaveProperty('width');
  });

  it('ignores empty files and anything that is not an image', async () => {
    const scanner = await openGeneratedImageScanner(codexHome, THREAD);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'empty.png'), Buffer.alloc(0));
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello');

    expect(await scanner.collect({ final: true })).toEqual([]);
  });

  it('orders several new images oldest first', async () => {
    const scanner = await openGeneratedImageScanner(codexHome, THREAD);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'b.png'), pngBytes(1, 1));
    await fs.writeFile(path.join(dir, 'a.png'), pngBytes(1, 1));
    await fs.utimes(path.join(dir, 'b.png'), new Date(1000), new Date(1000));
    await fs.utimes(path.join(dir, 'a.png'), new Date(2000), new Date(2000));

    const found = await scanner.collect({ final: false });
    expect(found.map((m) => m.fileName)).toEqual(['b.png', 'a.png']);
  });
});
