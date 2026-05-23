import '@testing-library/jest-dom';

// Backend auth middleware refuses to start without a real JWT_SECRET; provide
// a unique-per-process value so server-side tests can sign and verify tokens
// without the production secret being involved.
process.env.JWT_SECRET =
  process.env.JWT_SECRET ||
  'vitest-jwt-secret-not-for-production-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

// Raise login throttle so the limiter never trips during normal test runs.
// A real value (lower than the unit-test setting) belongs in production .env;
// rate-limit behavior is exercised in the end-to-end verification step.
process.env.LOGIN_RATE_LIMIT_MAX = process.env.LOGIN_RATE_LIMIT_MAX || '10000';

// Mock window.matchMedia for components that use media queries
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// Mock ResizeObserver for components that use it
globalThis.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock IntersectionObserver for components that use it
globalThis.IntersectionObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));
