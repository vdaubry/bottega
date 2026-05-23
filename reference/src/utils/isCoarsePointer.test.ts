import { describe, it, expect, vi, afterEach } from 'vitest';
import { isCoarsePointer } from './isCoarsePointer';

const realMatchMedia = window.matchMedia;

const stubMatchMedia = (matches: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: typeof query === 'string' && query.includes('coarse') ? matches : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
};

describe('isCoarsePointer', () => {
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  it('returns true when the primary pointer is coarse (touch device)', () => {
    stubMatchMedia(true);
    expect(isCoarsePointer()).toBe(true);
  });

  it('returns false when the primary pointer is fine (mouse/trackpad)', () => {
    stubMatchMedia(false);
    expect(isCoarsePointer()).toBe(false);
  });

  it('returns false when matchMedia is unavailable', () => {
    // @ts-expect-error simulate an environment without matchMedia (e.g. SSR)
    window.matchMedia = undefined;
    expect(isCoarsePointer()).toBe(false);
  });
});
