import { defineConfig } from 'vite';
import { resolve } from 'node:path';

const workspaceRoot = resolve(__dirname, '../..');
const desktopRoot = resolve(__dirname, '../../hypertuna-desktop');
const sharedRoot = resolve(__dirname, '../../shared');

export default defineConfig({
  base: '/public/',
  resolve: {
    alias: {
      '@desktop': desktopRoot,
      '@shared': sharedRoot
    }
  },
  server: {
    fs: {
      allow: [
        workspaceRoot,
        desktopRoot,
        sharedRoot
      ]
    }
  },
  build: {
    outDir: resolve(__dirname, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
    target: 'esnext'
  }
});
