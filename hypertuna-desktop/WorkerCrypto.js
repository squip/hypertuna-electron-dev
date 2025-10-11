const pendingCryptoRequests = new Map();
let cryptoRequestCounter = 0;
let cryptoListenerAttached = false;
const DEFAULT_TIMEOUT_MS = 15000;

function ensureWorkerListener() {
  if (cryptoListenerAttached || typeof window === 'undefined') {
    return;
  }

  window.addEventListener('worker-message', (event) => {
    const message = event?.detail;
    if (!message || message.type !== 'crypto-response') {
      return;
    }

    const { requestId } = message;
    if (!requestId || !pendingCryptoRequests.has(requestId)) {
      return;
    }

    const entry = pendingCryptoRequests.get(requestId);
    pendingCryptoRequests.delete(requestId);
    clearTimeout(entry.timeoutId);

    if (message.success) {
      entry.resolve(message.result);
    } else {
      entry.reject(new Error(message.error || 'Worker crypto operation failed'));
    }
  });

  cryptoListenerAttached = true;
}

function createRequestId() {
  cryptoRequestCounter += 1;
  return `crypto:${Date.now()}:${cryptoRequestCounter}`;
}

async function invokeWorker(operation, payload, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof window === 'undefined' || !window.electronAPI?.sendToWorker) {
    throw new Error('Worker messaging is not available in this environment');
  }

  ensureWorkerListener();

  const requestId = createRequestId();
  const message = {
    type: operation === 'decrypt' ? 'crypto-decrypt' : 'crypto-encrypt',
    requestId,
    ...payload
  };

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (!pendingCryptoRequests.has(requestId)) return;
      pendingCryptoRequests.delete(requestId);
      reject(new Error('Worker crypto request timed out'));
    }, Math.max(1000, timeoutMs));

    pendingCryptoRequests.set(requestId, { resolve, reject, timeoutId });

    window.electronAPI.sendToWorker(message)
      .then((response) => {
        if (!response || response.success === false) {
          pendingCryptoRequests.delete(requestId);
          clearTimeout(timeoutId);
          reject(new Error(response?.error || 'Worker rejected crypto command'));
        }
      })
      .catch((error) => {
        pendingCryptoRequests.delete(requestId);
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}

export function encryptPayload(privkeyHex, pubkeyHex, plaintext, options = {}) {
  return invokeWorker('encrypt', { privkey: privkeyHex, pubkey: pubkeyHex, plaintext }, options);
}

export function decryptPayload(privkeyHex, pubkeyHex, ciphertext, options = {}) {
  return invokeWorker('decrypt', { privkey: privkeyHex, pubkey: pubkeyHex, ciphertext }, options);
}
