import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite is used only for building the frontend bundle into `public/`.
// At dev time the same Vite dev server proxies /api and /rooms to the
// Workers dev server (wrangler dev on :8787).
export default defineConfig({
  plugins: [react()],
  root: 'web',
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8787',
      '/rooms': {
        target: 'ws://localhost:8787',
        ws: true,
      },
    },
  },
});
