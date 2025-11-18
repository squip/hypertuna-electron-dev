// Ensure a minimal Node-like process global for browserified deps
const nodeProcess = typeof process !== 'undefined' ? process : undefined;
const nodeRequire = typeof require === 'function' ? require : null;

function getProcess() {
  if (nodeProcess) return nodeProcess;
  if (nodeRequire) {
    try {
      return nodeRequire('process');
    } catch (_) {
      // ignore
    }
  }
  return { env: {}, browser: true, nextTick: (cb, ...args) => setTimeout(cb, 0, ...args) };
}

if (!globalThis.process) {
  globalThis.process = getProcess();
}
