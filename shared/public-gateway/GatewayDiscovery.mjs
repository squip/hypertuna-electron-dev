import { createHash, randomBytes } from 'node:crypto';
import hyperCrypto from 'hypercore-crypto';
import * as c from 'compact-encoding';

const DISCOVERY_TOPIC_SEED = 'hypertuna-public-gateway-discovery-v1';
const DISCOVERY_TOPIC = hyperCrypto.hash(Buffer.from(DISCOVERY_TOPIC_SEED));

const announcementEncoding = {
  preencode(state, value) {
    c.string.preencode(state, value.gatewayId || '');
    c.uint.preencode(state, value.timestamp || 0);
    c.uint.preencode(state, value.ttl || 0);
    c.string.preencode(state, value.publicUrl || '');
    c.string.preencode(state, value.wsUrl || '');
    c.string.preencode(state, value.secretUrl || '');
    c.string.preencode(state, value.secretHash || '');
    c.bool.preencode(state, value.openAccess === true);
    c.string.preencode(state, value.sharedSecretVersion || '');
    c.string.preencode(state, value.displayName || '');
    c.string.preencode(state, value.region || '');
    c.uint.preencode(state, value.protocolVersion || 1);
    c.string.preencode(state, value.signature || '');
    c.string.preencode(state, value.signatureKey || '');
  },
  encode(state, value) {
    c.string.encode(state, value.gatewayId || '');
    c.uint.encode(state, value.timestamp || 0);
    c.uint.encode(state, value.ttl || 0);
    c.string.encode(state, value.publicUrl || '');
    c.string.encode(state, value.wsUrl || '');
    c.string.encode(state, value.secretUrl || '');
    c.string.encode(state, value.secretHash || '');
    c.bool.encode(state, value.openAccess === true);
    c.string.encode(state, value.sharedSecretVersion || '');
    c.string.encode(state, value.displayName || '');
    c.string.encode(state, value.region || '');
    c.uint.encode(state, value.protocolVersion || 1);
    c.string.encode(state, value.signature || '');
    c.string.encode(state, value.signatureKey || '');
  },
  decode(state) {
    return {
      gatewayId: c.string.decode(state),
      timestamp: c.uint.decode(state),
      ttl: c.uint.decode(state),
      publicUrl: c.string.decode(state),
      wsUrl: c.string.decode(state),
      secretUrl: c.string.decode(state),
      secretHash: c.string.decode(state),
      openAccess: c.bool.decode(state),
      sharedSecretVersion: c.string.decode(state),
      displayName: c.string.decode(state),
      region: c.string.decode(state),
      protocolVersion: c.uint.decode(state),
      signature: c.string.decode(state),
      signatureKey: c.string.decode(state)
    };
  }
};

function deriveKeyPair(seed) {
  if (seed && typeof seed === 'string') {
    const digest = createHash('sha256').update(seed).digest();
    return hyperCrypto.keyPair(digest);
  }
  if (seed instanceof Uint8Array) {
    const buf = seed.length === 32 ? seed : createHash('sha256').update(seed).digest();
    return hyperCrypto.keyPair(buf);
  }
  return hyperCrypto.keyPair(randomBytes(32));
}

function canonicalizeAnnouncement(announcement) {
  const payload = {
    gatewayId: announcement.gatewayId || '',
    timestamp: announcement.timestamp || 0,
    ttl: announcement.ttl || 0,
    publicUrl: announcement.publicUrl || '',
    wsUrl: announcement.wsUrl || '',
    secretUrl: announcement.secretUrl || '',
    secretHash: announcement.secretHash || '',
    openAccess: announcement.openAccess === true,
    sharedSecretVersion: announcement.sharedSecretVersion || '',
    displayName: announcement.displayName || '',
    region: announcement.region || '',
    protocolVersion: announcement.protocolVersion || 1
  };
  const json = JSON.stringify(payload);
  return Buffer.from(json, 'utf8');
}

function ensureSecretKeyBuffer(secretKey) {
  if (!secretKey) {
    throw new Error('Gateway discovery secret key not provided');
  }

  if (Buffer.isBuffer(secretKey)) {
    return secretKey;
  }

  if (secretKey instanceof Uint8Array) {
    return Buffer.from(secretKey);
  }

  throw new Error('Gateway discovery secret key must be a Buffer or Uint8Array');
}

function signAnnouncement(announcement, secretKey) {
  const payload = canonicalizeAnnouncement(announcement);
  const skBuffer = ensureSecretKeyBuffer(secretKey);
  if (skBuffer.length !== 64) {
    throw new Error(`Gateway discovery secret key must be 64 bytes, received ${skBuffer.length}`);
  }
  const signature = hyperCrypto.sign(payload, skBuffer);
  return Buffer.from(signature).toString('hex');
}

function verifyAnnouncementSignature(announcement) {
  if (!announcement?.signature || !announcement?.signatureKey) {
    return false;
  }
  try {
    const payload = canonicalizeAnnouncement(announcement);
    const signature = Buffer.from(announcement.signature, 'hex');
    const publicKey = Buffer.from(announcement.signatureKey, 'hex');
    return hyperCrypto.verify(payload, signature, publicKey);
  } catch (_) {
    return false;
  }
}

function computeSecretHash(secret) {
  if (secret == null) return '';
  return createHash('sha256').update(String(secret)).digest('hex');
}

function encodeAnnouncement(announcement) {
  const state = { start: 0, end: 0, buffer: null };
  announcementEncoding.preencode(state, announcement);
  state.buffer = Buffer.allocUnsafe(state.end);
  state.start = 0;
  announcementEncoding.encode(state, announcement);
  return state.buffer;
}

function decodeAnnouncement(buffer) {
  const state = { start: 0, end: buffer.length, buffer };
  return announcementEncoding.decode(state);
}

function isAnnouncementExpired(announcement, now = Date.now()) {
  if (!announcement?.ttl || !announcement?.timestamp) return true;
  return announcement.timestamp + announcement.ttl * 1000 < now;
}

export {
  DISCOVERY_TOPIC,
  DISCOVERY_TOPIC_SEED,
  computeSecretHash,
  decodeAnnouncement,
  deriveKeyPair,
  encodeAnnouncement,
  isAnnouncementExpired,
  signAnnouncement,
  verifyAnnouncementSignature
};
