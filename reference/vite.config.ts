import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Load env file based on `mode` in the current working directory.
  const env = loadEnv(mode, process.cwd(), '');

  // Hosts other than localhost that Vite should accept (used when running
  // behind nginx/Cloudflare on a custom domain). Comma-separated list:
  //   VITE_ALLOWED_HOSTS=app.example.com,staging.example.com
  const allowedHosts = (env.VITE_ALLOWED_HOSTS || '')
    .split(',')
    .map(h => h.trim())
    .filter(Boolean);

  return {
    plugins: [react()],
    css: {
      // PostCSS plugins are configured here so we can drop the standalone
      // postcss.config.js (PostCSS's own loader doesn't read .ts).
      postcss: {
        plugins: [tailwindcss(), autoprefixer()],
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'shared'),
        '@': path.resolve(__dirname, 'src'),
        '@server': path.resolve(__dirname, 'server'),
      },
    },
    server: {
      port: parseInt(env.VITE_PORT ?? '') || 5173,
      allowedHosts,
      proxy: {
        '/api': `http://localhost:${env.PORT || 3002}`,
        '/ws': {
          target: `ws://localhost:${env.PORT || 3002}`,
          ws: true,
        },
      },
    },
  };
});