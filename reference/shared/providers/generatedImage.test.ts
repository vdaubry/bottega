import { describe, it, expect } from 'vitest';
import {
  asGeneratedImageBlock,
  generatedImageBlock,
  generatedImageMimeType,
} from './generatedImage.js';
import type { UnifiedAssistantImageMessage } from './types.js';

describe('generatedImageMimeType', () => {
  it('maps the raster extensions the store serves', () => {
    expect(generatedImageMimeType('exec-2473b581.png')).toBe('image/png');
    expect(generatedImageMimeType('photo.JPG')).toBe('image/jpeg');
    expect(generatedImageMimeType('photo.jpeg')).toBe('image/jpeg');
    expect(generatedImageMimeType('cutout.webp')).toBe('image/webp');
  });

  it('rejects names that are not a single safe path segment', () => {
    expect(generatedImageMimeType('../auth.png')).toBeNull();
    expect(generatedImageMimeType('a/b.png')).toBeNull();
    expect(generatedImageMimeType('.hidden.png')).toBeNull();
    expect(generatedImageMimeType('notes.svg')).toBeNull();
    expect(generatedImageMimeType('png')).toBeNull();
  });
});

describe('generatedImageBlock', () => {
  const base: UnifiedAssistantImageMessage = {
    type: 'assistant_image',
    id: 'generated_image:a.png',
    provider: 'openai',
    providerSessionId: 'thread-1',
    raw: null,
    sourcePath: '/codex/generated_images/thread-1/a.png',
    fileName: 'a.png',
    mimeType: 'image/png',
  };

  it('names the file and never leaks the server path', () => {
    expect(generatedImageBlock({ ...base, width: 1536, height: 1024 })).toEqual({
      type: 'generated_image',
      file_name: 'a.png',
      media_type: 'image/png',
      width: 1536,
      height: 1024,
    });
  });

  it('omits the size when the file header did not give one', () => {
    expect(generatedImageBlock(base)).toEqual({
      type: 'generated_image',
      file_name: 'a.png',
      media_type: 'image/png',
    });
  });
});

describe('asGeneratedImageBlock', () => {
  it('accepts a well-formed block', () => {
    const block = { type: 'generated_image', file_name: 'a.png', media_type: 'image/png' };
    expect(asGeneratedImageBlock(block)).toBe(block);
  });

  it('rejects other blocks and unsafe file names', () => {
    expect(asGeneratedImageBlock({ type: 'text', text: 'hi' })).toBeNull();
    expect(asGeneratedImageBlock({ type: 'generated_image' })).toBeNull();
    expect(asGeneratedImageBlock({ type: 'generated_image', file_name: '../../x.png' })).toBeNull();
    expect(asGeneratedImageBlock(null)).toBeNull();
  });
});
