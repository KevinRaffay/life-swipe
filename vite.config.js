import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: 'client',
  // Where the built assets will be served FROM, and the one thing a static
  // host gets wrong by default. `npm start` serves dist/ from Express at the
  // domain root, so '/' has to stay the default - but a GitHub Pages PROJECT
  // page lives under https://<user>.github.io/<repo>/, where '/assets/...'
  // resolves to the github.io root and every asset 404s.
  //
  // Env-driven rather than hardcoded precisely because both are true at once:
  // the Pages workflow sets VITE_BASE=/life-swipe/ and nothing else has to
  // know. Hardcoding the subpath here would silently break local play, which
  // is the more common case.
  base: process.env.VITE_BASE || '/',
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
