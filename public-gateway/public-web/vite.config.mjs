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
      '@shared': sharedRoot,
      // Ensure browser build resolves crypto deps from this package's node_modules
      'noble-secp256k1': resolve(__dirname, 'node_modules/noble-secp256k1'),
      'browserify-cipher': resolve(__dirname, 'node_modules/browserify-cipher'),
      bech32: resolve(__dirname, 'node_modules/bech32')
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
