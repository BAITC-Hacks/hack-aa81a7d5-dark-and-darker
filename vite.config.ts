import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'frontend',
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': process.env.HACKALEM_API_TARGET || 'http://127.0.0.1:8000',
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      '/api': process.env.HACKALEM_API_TARGET || 'http://127.0.0.1:8000',
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
