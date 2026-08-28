// The admin build, kept deliberately separate from the player build.
//
// Separate root, separate output. `npm run build` reads vite.config.js and
// never sees admin/, so the admin cannot end up in the mobile-facing bundle by
// accident - not by configuration, but because it is not an input to that build
// at all. dist-admin/ is gitignored alongside dist/ and served only by the
// loopback-bound /admin routes.

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  root: 'admin',
  base: '/admin/',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./shared'),
      '@data': r('./data'),
    },
  },
  server: {
    port: 5174,
    fs: { allow: ['..'] },
    proxy: { '/admin/api': 'http://127.0.0.1:8787' },
  },
  build: {
    outDir: '../dist-admin',
    emptyOutDir: true,
  },
});
