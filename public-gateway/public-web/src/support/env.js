function ensureGlobal(name, factory) {
  if (typeof window === 'undefined') return null;
  const current = window[name];
  if (current !== undefined && current !== null) return current;
  const next = typeof factory === 'function' ? factory() : factory;
  window[name] = next;
  return next;
}

export function installWebShims() {
  // Stub worker/electron bridge so desktop modules can run in the browser.
  ensureGlobal('electronAPI', null);
  ensureGlobal('sendWorkerCommand', async () => ({ success: false, error: 'Worker IPC unavailable in browser context' }));
}

export function summarizeBrowserSupport() {
  const support = {
    indexedDB: typeof indexedDB !== 'undefined',
    webCrypto: typeof crypto !== 'undefined' && !!crypto.subtle,
    webSockets: typeof WebSocket !== 'undefined',
    textEncoding: typeof TextEncoder !== 'undefined' && typeof TextDecoder !== 'undefined'
  };

  const warnings = [];
  if (!support.indexedDB) warnings.push('IndexedDB unavailable; offline cache disabled.');
  if (!support.webCrypto) warnings.push('WebCrypto unavailable; encryption/decryption will fail.');
  if (!support.webSockets) warnings.push('WebSocket API missing.');

  return { support, warnings };
}
