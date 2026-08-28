import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: 'client',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./shared'),
      '@data': r('./data'),
      '@library': r('./server/situation-library.json'),
    },
  },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': 'http://localhost:8787' },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
});
