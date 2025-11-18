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

async function hmacSha256Hex(message, secret) {
  if (!secret) throw new Error('Missing shared secret for HMAC');
  if (typeof window === 'undefined' || !window.crypto?.subtle) {
    throw new Error('WebCrypto unavailable for HMAC');
  }
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const data = typeof message === 'string' ? enc.encode(message) : enc.encode(stableStringify(message));
  const signature = await crypto.subtle.sign('HMAC', key, data);
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export {
  hmacSha256Hex,
  stableStringify
};
