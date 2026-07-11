import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const vitestTmpDir = path.resolve(__dirname, '.vitest-tmp');

// Ensure the temp directory exists before any tests run
if (!fs.existsSync(vitestTmpDir)) {
  fs.mkdirSync(vitestTmpDir, { recursive: true });
}

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Mirror the aliases declared in vite.config.ts so vitest can resolve
    // value imports through them. Type-only imports get elided by the TS
    // transformer and don't go through the resolver, which is why this
    // worked-by-accident for years even without the aliases here — but
    // any real value import (e.g. `import { getCapabilities } from
    // '@shared/providers/capabilities'`) needs them.
    alias: {
      '@shared': path.resolve(__dirname, 'shared'),
      '@': path.resolve(__dirname, 'src'),
      '@server': path.resolve(__dirname, 'server'),
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    include: ['**/*.test.{ts,tsx}'],
    exclude: ['node_modules', 'dist', 'tmp/**'],
    setupFiles: ['./src/test-setup.ts'],
    // Workaround for Node 26 V8 code caching issue with better-sqlite3@12.x.
    // V8 creates temporary module caches in the system temp directory that are
    // deleted before code can use them, causing ENOENT errors. Setting TMPDIR
    // to project-local directory keeps caches persistent across test runs.
    // See: https://github.com/vdaubry/bottega/issues/XXX
    env: {
      TMPDIR: vitestTmpDir,
    },
  },
});
