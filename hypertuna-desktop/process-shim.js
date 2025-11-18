// Ensure a minimal Node-like process global for browserified deps
import process from 'process';
if (!globalThis.process) {
  globalThis.process = process || { env: {}, browser: true, nextTick: (cb, ...args) => setTimeout(cb, 0, ...args) };
}
