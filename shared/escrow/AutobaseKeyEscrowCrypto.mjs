import { randomBytes, createHash } from 'node:crypto';
import nacl from 'tweetnacl';

function bufferFromString(value, encodingCandidates = ['base64', 'hex']) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  for (const enc of encodingCandidates) {
    try {
      const buf = Buffer.from(trimmed, enc);
      if (buf.length) return buf;
    } catch (_) {
      // fall through to next encoding
    }
  }
  return null;
}

function encodeKey(key) {
  if (!key) return null;
  const buf = bufferFromString(key) || Buffer.from(key);
  return buf.toString('base64');
}

function decodeKey(key) {
  if (!key) return null;
  const buf = bufferFromString(key, ['base64', 'hex']);
  if (!buf) return null;
  return new Uint8Array(buf);
}

function createNonce() {
  return new Uint8Array(randomBytes(24));
}

function generateKeyPair() {
  const pair = nacl.box.keyPair();
  return {
    publicKey: Buffer.from(pair.publicKey),
    secretKey: Buffer.from(pair.secretKey)
  };
}

function normalizePayload(payload) {
  if (payload == null) return Buffer.alloc(0);
  if (typeof payload === 'string') return Buffer.from(payload);
  if (Buffer.isBuffer(payload)) return Buffer.from(payload);
  if (payload instanceof Uint8Array) return Buffer.from(payload);
  return Buffer.from(JSON.stringify(payload));
}

function sealPayload({
  payload,
  recipientPublicKey,
  senderSecretKey = null,
  senderPublicKey = null,
  nonce = null
} = {}) {
  if (!recipientPublicKey) {
    throw new Error('recipientPublicKey is required to seal payload');
  }

  const recipientKey = decodeKey(recipientPublicKey);
  if (!recipientKey) throw new Error('Invalid recipient public key');

  let secretKey = senderSecretKey ? decodeKey(senderSecretKey) : null;
  let publicKey = senderPublicKey ? decodeKey(senderPublicKey) : null;

  if (!secretKey || !publicKey) {
    const pair = generateKeyPair();
    secretKey = new Uint8Array(pair.secretKey);
    publicKey = new Uint8Array(pair.publicKey);
  }

  const message = normalizePayload(payload);
  const nonceBuf = nonce ? decodeKey(nonce) : createNonce();

  const cipher = nacl.box(message, nonceBuf, recipientKey, secretKey);
  if (!cipher) {
    throw new Error('Sealing payload failed');
  }

  return {
    cipherText: Buffer.from(cipher).toString('base64'),
    nonce: Buffer.from(nonceBuf).toString('base64'),
    publicKey: Buffer.from(publicKey).toString('base64')
  };
}

function openPayload({
  cipherText,
  nonce,
  senderPublicKey,
  recipientSecretKey
} = {}) {
  if (!cipherText || !nonce || !senderPublicKey || !recipientSecretKey) {
    throw new Error('cipherText, nonce, senderPublicKey, and recipientSecretKey are required');
  }

  const ciphertextBuf = decodeKey(cipherText);
  const nonceBuf = decodeKey(nonce);
  const senderKey = decodeKey(senderPublicKey);
  const secretKey = decodeKey(recipientSecretKey);

  if (!ciphertextBuf || !nonceBuf || !senderKey || !secretKey) {
    throw new Error('Invalid sealed payload parameters');
  }

  const message = nacl.box.open(ciphertextBuf, nonceBuf, senderKey, secretKey);
  if (!message) {
    throw new Error('Failed to decrypt sealed payload');
  }
  return Buffer.from(message);
}

function zeroize(buffer) {
  if (!buffer) return;
  if (Buffer.isBuffer(buffer) || buffer instanceof Uint8Array) {
    buffer.fill(0);
  } else if (typeof buffer === 'string') {
    // Strings are immutable; noop.
  }
}

function hashSecret(value) {
  const buf = bufferFromString(value, ['utf8', 'hex', 'base64']) || Buffer.from(String(value));
  return createHash('sha256').update(buf).digest('hex');
}

function toSecureBuffer(source, { encodings = ['base64', 'hex'] } = {}) {
  if (Buffer.isBuffer(source)) return Buffer.from(source);
  if (source instanceof Uint8Array) return Buffer.from(source);
  if (typeof source === 'string') {
    const buf = bufferFromString(source, encodings);
    return buf ? Buffer.from(buf) : Buffer.from(source);
  }
  if (source == null) return null;
  return Buffer.from(String(source));
}

function withZeroizedBuffer(source, handler) {
  if (typeof handler !== 'function') {
    throw new Error('withZeroizedBuffer requires a handler function');
  }
  const resolveSource = () => {
    if (typeof source === 'function') {
      return source();
    }
    return source;
  };
  let buffer = resolveSource();
  if (buffer && !(Buffer.isBuffer(buffer))) {
    if (buffer instanceof Uint8Array) {
      buffer = Buffer.from(buffer);
    } else if (buffer != null) {
      buffer = Buffer.from(buffer);
    }
  }
  const finalize = () => {
    if (buffer) {
      zeroize(buffer);
      buffer = null;
    }
  };
  try {
    const result = handler(buffer);
    if (result && typeof result.then === 'function') {
      return result.finally(finalize);
    }
    finalize();
    return result;
  } catch (error) {
    finalize();
    throw error;
  }
}

export {
  createNonce,
  decodeKey,
  encodeKey,
  generateKeyPair,
  hashSecret,
  normalizePayload,
  openPayload,
  sealPayload,
  toSecureBuffer,
  withZeroizedBuffer,
  zeroize
};
