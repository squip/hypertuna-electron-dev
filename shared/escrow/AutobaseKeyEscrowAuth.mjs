import { createHmac, timingSafeEqual } from 'node:crypto';

function stableStringify(input) {
  if (input == null) return '';
  if (typeof input === 'string') return input;
  return JSON.stringify(input, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.keys(value)
        .sort()
        .reduce((acc, key) => {
          acc[key] = value[key];
          return acc;
        }, {});
    }
    return value;
  });
}

function computeSignature({ secret, clientId = '', body = '', timestamp = Date.now() } = {}) {
  if (!secret) throw new Error('Escrow secret is required for signing');
  const normalizedBody = stableStringify(body);
  const payload = `${timestamp}:${clientId}:${normalizedBody}`;
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return {
    signature: hmac.digest('hex'),
    timestamp,
    clientId
  };
}

function verifySignature({
  secret,
  clientId = '',
  body = '',
  timestamp,
  signature,
  toleranceMs = 5 * 60 * 1000,
  now = Date.now()
} = {}) {
  if (!secret) throw new Error('Escrow secret is required for signature verification');
  if (!signature || !timestamp) return false;
  const delta = Math.abs(now - Number(timestamp));
  if (Number.isFinite(toleranceMs) && toleranceMs > 0 && delta > toleranceMs) {
    return false;
  }
  const { signature: expected } = computeSignature({ secret, clientId, body, timestamp });
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function buildAuthHeaders({ secret, clientId, body, timestamp = Date.now() } = {}) {
  const { signature } = computeSignature({ secret, clientId, body, timestamp });
  return {
    'x-escrow-client-id': clientId || '',
    'x-escrow-timestamp': String(timestamp),
    'x-escrow-signature': signature
  };
}

export {
  buildAuthHeaders,
  computeSignature,
  stableStringify,
  verifySignature
};
