export async function decryptReplicationPayload(ciphertext, secret, logger = console) {
  try {
    const buf = Uint8Array.from(Buffer.from(ciphertext, 'base64'));
    const iv = buf.slice(0, 12);
    const data = buf.slice(12);
    const keyBytes = deriveKey(secret);
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
    return JSON.parse(new TextDecoder().decode(plainBuf));
  } catch (err) {
    logger?.debug?.('[ReplicationCrypto] decrypt failed', err?.message || err);
    return null;
  }
}

function deriveKey(secret) {
  const enc = new TextEncoder();
  const bytes = enc.encode(typeof secret === 'string' ? secret : String(secret));
  if (bytes.length >= 32) return bytes.slice(0, 32);
  const out = new Uint8Array(32);
  out.set(bytes);
  return out;
}
