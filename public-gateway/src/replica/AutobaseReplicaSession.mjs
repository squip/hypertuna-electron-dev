import Hyperbee from 'hyperbee';
import HypercoreId from 'hypercore-id-encoding';
import b4a from 'b4a';

import PublicGatewayHyperbeeAdapter from '../../../shared/public-gateway/PublicGatewayHyperbeeAdapter.mjs';
import { zeroize } from '../../../shared/escrow/AutobaseKeyEscrowCrypto.mjs';

const HEX_64 = /^[0-9a-f]{64}$/i;

function hexToBuffer(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const trimmed = hex.trim();
  if (!trimmed) return null;
  try {
    return Buffer.from(trimmed, 'hex');
  } catch {
    return null;
  }
}

function safeStringify(payload) {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return JSON.stringify({ error: 'serialization-error', message: error?.message });
  }
}

function padNumber(num, length) {
  const value = Number.isFinite(num) ? num : 0;
  return String(Math.trunc(value)).padStart(length, '0');
}

function padTimestamp(timestamp) {
  const value = Number.isFinite(timestamp) ? timestamp : 0;
  return String(Math.trunc(value)).padStart(10, '0');
}

function decodeWriterSecret(value) {
  if (!value) return null;
  if (Buffer.isBuffer(value)) {
    return Buffer.from(value);
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (HEX_64.test(trimmed)) {
      try {
        return Buffer.from(trimmed, 'hex');
      } catch {
        return null;
      }
    }
    try {
      return Buffer.from(trimmed, 'base64');
    } catch {
      return null;
    }
  }
  return null;
}

export default class AutobaseReplicaSession {
  constructor({ identifier, ownerPeerKey, coreKey, corestore, logger = console }) {
    this.identifier = identifier || null;
    this.ownerPeerKey = ownerPeerKey || null;
    this.coreKeyString = coreKey || null;
    this.corestore = corestore;
    this.logger = logger;

    this.core = null;
    this.hyperbee = null;
    this.adapter = null;
    this.writerLease = null;
    this.writerSecret = null;
    this.decodedKey = this.#decodeCoreKey(this.coreKeyString);
    this.readyPromise = null;
  }

  getLeaseId() {
    return this.writerLease?.leaseId || null;
  }

  hasWritableLease() {
    return !!(this.writerSecret && this.writerLease);
  }

  async query(filters = []) {
    await this.#ensureReady();
    if (!this.adapter) {
      throw new Error('replica-adapter-unavailable');
    }
    return this.adapter.query(filters);
  }

  async appendEvent(event) {
    if (!this.hasWritableLease()) {
      throw new Error('replica-writer-missing');
    }
    await this.#ensureReady({ writable: true });
    if (!this.hyperbee?.writable) {
      throw new Error('replica-readonly');
    }

    const keyBuffer = hexToBuffer(event?.id);
    if (!keyBuffer) {
      throw new Error('invalid-event-id');
    }

    const payload = safeStringify(event);
    const batch = this.hyperbee.batch();
    await batch.put(keyBuffer, payload);

    for (const entry of this.#buildIndexEntries(event)) {
      await batch.put(entry.key, entry.value);
    }

    await batch.flush();
    return { id: event?.id || null, status: 'accepted' };
  }

  async setWriterLease(lease) {
    if (!lease) {
      await this.clearWriterLease();
      return;
    }
    this.writerLease = lease;
    const secret = decodeWriterSecret(lease?.writerPackage?.writerKey);
    if (!secret) {
      this.logger?.warn?.('[AutobaseReplicaSession] Writer lease missing secret', {
        relayKey: lease?.relayKey || this.identifier
      });
      return;
    }
    if (this.writerSecret) {
      zeroize(this.writerSecret);
    }
    this.writerSecret = secret;
    await this.#ensureReady({ writable: true, force: true });
  }

  async clearWriterLease() {
    this.writerLease = null;
    if (this.writerSecret) {
      zeroize(this.writerSecret);
      this.writerSecret = null;
    }
    await this.#ensureReady({ force: true });
  }

  async close() {
    if (this.hyperbee?.close) {
      try {
        await this.hyperbee.close();
      } catch (error) {
        this.logger?.debug?.('[AutobaseReplicaSession] Hyperbee close failed', {
          identifier: this.identifier,
          error: error?.message || error
        });
      }
    }
    if (this.core?.close) {
      try {
        await this.core.close();
      } catch (error) {
        this.logger?.debug?.('[AutobaseReplicaSession] Core close failed', {
          identifier: this.identifier,
          error: error?.message || error
        });
      }
    }
    this.hyperbee = null;
    this.core = null;
    this.adapter = null;
    this.readyPromise = null;
  }

  async #ensureReady({ writable = false, force = false } = {}) {
    if (!this.corestore) {
      throw new Error('replica-corestore-missing');
    }
    if (!this.decodedKey) {
      throw new Error('replica-corekey-invalid');
    }
    if (!force && this.hyperbee) {
      if (!writable) return this.hyperbee;
      if (this.hyperbee?.writable) return this.hyperbee;
    }

    if (this.readyPromise && !force) {
      return this.readyPromise;
    }

    const openPromise = this.#openHyperbee({ writable });
    if (!writable) {
      this.readyPromise = openPromise;
    }
    return openPromise;
  }

  async #openHyperbee({ writable }) {
    if (this.hyperbee) {
      await this.close();
    }
    const options = writable && this.writerSecret
      ? { keyPair: { publicKey: this.decodedKey, secretKey: this.writerSecret } }
      : { key: this.decodedKey };
    const core = this.corestore.get({
      ...options,
      valueEncoding: 'binary'
    });
    await core.ready();
    this.core = core;
    this.hyperbee = new Hyperbee(core, {
      keyEncoding: 'binary',
      valueEncoding: 'utf-8'
    });
    await this.hyperbee.ready();
    this.adapter = new PublicGatewayHyperbeeAdapter({
      logger: this.logger,
      relayClient: {
        getHyperbee: () => this.hyperbee,
        getCore: () => this.core
      }
    });
    return this.hyperbee;
  }

  #decodeCoreKey(coreKey) {
    if (!coreKey) return null;
    try {
      if (Buffer.isBuffer(coreKey)) {
        return Buffer.from(coreKey);
      }
      if (coreKey instanceof Uint8Array) {
        return Buffer.from(coreKey);
      }
      if (typeof coreKey === 'string') {
        return HypercoreId.decode(coreKey.trim());
      }
    } catch (error) {
      this.logger?.debug?.('[AutobaseReplicaSession] Failed to decode core key', {
        identifier: this.identifier,
        error: error?.message || error
      });
    }
    return null;
  }

  #buildIndexEntries(event) {
    const entries = [];
    if (!event?.id) return entries;

    const eventIdValue = b4a.from(event.id, 'utf8');
    const createdAt = Number(event?.created_at) || 0;
    const paddedCreatedAt = padTimestamp(createdAt);

    const timeKey = b4a.from(`created_at:${paddedCreatedAt}:id:${event.id}`, 'utf8');
    entries.push({ key: timeKey, value: eventIdValue });

    if (Number.isInteger(event?.kind)) {
      const paddedKind = padNumber(event.kind, 5);
      const kindKey = b4a.from(`kind:${paddedKind}:created_at:${paddedCreatedAt}:id:${event.id}`, 'utf8');
      entries.push({ key: kindKey, value: eventIdValue });
    }

    if (typeof event?.pubkey === 'string' && event.pubkey.length) {
      const authorKey = b4a.from(`pubkey:${event.pubkey}:created_at:${paddedCreatedAt}:id:${event.id}`, 'utf8');
      entries.push({ key: authorKey, value: eventIdValue });
    }

    if (Array.isArray(event?.tags)) {
      for (const tag of event.tags) {
        if (!Array.isArray(tag) || tag.length < 2) continue;
        const [name, value] = tag;
        if (typeof name !== 'string' || typeof value !== 'string') continue;
        const tagKey = b4a.from(`tagKey:${name}:tagValue:${value}:created_at:${paddedCreatedAt}:id:${event.id}`, 'utf8');
        entries.push({ key: tagKey, value: eventIdValue });
      }
    }

    return entries;
  }
}
