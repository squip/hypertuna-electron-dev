import { createHmac, randomBytes } from 'node:crypto';

function stableStringify(value) {
  const replacer = (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.keys(val)
        .sort()
        .reduce((acc, key) => {
          acc[key] = val[key];
          return acc;
        }, {});
    }
    return val;
  };
  return JSON.stringify(value, replacer);
}

function createSignature(payload, secret) {
  if (!secret) throw new Error('Missing shared secret for signature');
  const hmac = createHmac('sha256', secret);
  hmac.update(typeof payload === 'string' ? payload : stableStringify(payload));
  return hmac.digest('hex');
}

function verifySignature(payload, signature, secret) {
  const expected = createSignature(payload, secret);
  return timingSafeEqualHex(expected, signature);
}

function timingSafeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

function issueClientToken(payload, secret) {
  const tokenPayload = {
    ...payload,
    issuedAt: Date.now()
  };
  const serialized = stableStringify(tokenPayload);
  const signature = createSignature(serialized, secret);
  return Buffer.from(serialized).toString('base64url') + '.' + signature;
}

function verifyClientToken(token, secret) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [encodedPayload, signature] = parts;
  try {
    const json = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    const isValid = verifySignature(json, signature, secret);
    if (!isValid) return null;
    return JSON.parse(json);
  } catch (error) {
    return null;
  }
}

function createRelayRegistration(relayKey, data = {}) {
  return {
    relayKey,
    nonce: randomBytes(12).toString('hex'),
    issuedAt: Date.now(),
    ...data
  };
}

export {
  createSignature,
  verifySignature,
  issueClientToken,
  verifyClientToken,
  createRelayRegistration
};
