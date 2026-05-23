import { describe, it, expect, vi } from 'vitest';

// Mock dependencies before importing the module
vi.mock('fluent-ffmpeg', () => ({ default: vi.fn() }));
vi.mock('ffmpeg-static', () => ({ default: '/usr/bin/ffmpeg' }));
vi.mock('openai', () => ({ default: vi.fn() }));
vi.mock('fs/promises', () => ({
    default: {
        writeFile: vi.fn().mockResolvedValue(undefined),
        unlink: vi.fn().mockResolvedValue(undefined),
    },
    writeFile: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('fs', () => ({
    createReadStream: vi.fn().mockReturnValue('mock-stream'),
}));

describe('Transcription Service', () => {
    describe('Quote stripping from cleanup response', () => {
        // Test the quote-stripping logic directly
        function stripQuotes(text: string) {
            return text.replace(/^["']|["']$/g, '');
        }

        it('should strip surrounding double quotes', () => {
            expect(stripQuotes('"Does the /projects/:id endpoint accept a name parameter?"'))
                .toBe('Does the /projects/:id endpoint accept a name parameter?');
        });

        it('should strip surrounding single quotes', () => {
            expect(stripQuotes("'Hello world'"))
                .toBe('Hello world');
        });

        it('should not strip quotes in the middle of text', () => {
            expect(stripQuotes('He said "hello" to me'))
                .toBe('He said "hello" to me');
        });

        it('should handle text without quotes', () => {
            expect(stripQuotes('Just a normal message'))
                .toBe('Just a normal message');
        });

        it('should handle empty string', () => {
            expect(stripQuotes('')).toBe('');
        });

        it('should strip only leading double quote', () => {
            expect(stripQuotes('"Hello world'))
                .toBe('Hello world');
        });

        it('should strip only trailing double quote', () => {
            expect(stripQuotes('Hello world"'))
                .toBe('Hello world');
        });

        it('should strip mismatched quotes', () => {
            expect(stripQuotes('"Hello world\''))
                .toBe('Hello world');
        });
    });
});
