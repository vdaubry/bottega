import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
  },
});
