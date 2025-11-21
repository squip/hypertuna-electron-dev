class MemoryRegistrationStore {
  constructor(ttlSeconds = 300) {
    this.ttlSeconds = ttlSeconds;
    this.items = new Map();
    this.tokenMetadata = new Map();
    this.capabilityMetadata = new Map(); // Map<relayKey, Map<capabilityId, metadata>>
  }

  async upsertRelay(relayKey, payload) {
    const record = {
      payload,
      expiresAt: Date.now() + this.ttlSeconds * 1000
    };
    this.items.set(relayKey, record);
  }

  async getRelay(relayKey) {
    const record = this.items.get(relayKey);
    if (!record) return null;
    if (record.expiresAt < Date.now()) {
      this.items.delete(relayKey);
      return null;
    }
    return record.payload;
  }

  async removeRelay(relayKey) {
    this.items.delete(relayKey);
    this.tokenMetadata.delete(relayKey);
    this.capabilityMetadata.delete(relayKey);
  }

  pruneExpired() {
    const now = Date.now();
    for (const [key, record] of this.items.entries()) {
      if (record.expiresAt < now) {
        this.items.delete(key);
      }
    }

    for (const [key, metadata] of this.tokenMetadata.entries()) {
      if (metadata?.expiresAt && metadata.expiresAt < now) {
        this.tokenMetadata.delete(key);
      }
    }

    for (const [relayKey, capabilityMap] of this.capabilityMetadata.entries()) {
      if (!capabilityMap || !(capabilityMap instanceof Map)) continue;
      for (const [capId, meta] of capabilityMap.entries()) {
        if (meta?.expiresAt && meta.expiresAt < now) {
          capabilityMap.delete(capId);
        }
      }
      if (capabilityMap.size === 0) {
        this.capabilityMetadata.delete(relayKey);
      }
    }
  }

  async storeTokenMetadata(relayKey, metadata = {}) {
    const record = {
      ...metadata,
      recordedAt: Date.now()
    };
    this.tokenMetadata.set(relayKey, record);
  }

  async getTokenMetadata(relayKey) {
    const record = this.tokenMetadata.get(relayKey);
    if (!record) return null;
    if (record.expiresAt && record.expiresAt < Date.now()) {
      this.tokenMetadata.delete(relayKey);
      return null;
    }
    return record;
  }

  async clearTokenMetadata(relayKey) {
    this.tokenMetadata.delete(relayKey);
  }

  async storeCapabilityMetadata(relayKey, capabilityId, metadata = {}) {
    if (!relayKey || !capabilityId) return;
    const entry = {
      ...metadata,
      recordedAt: Date.now()
    };
    if (!this.capabilityMetadata.has(relayKey)) {
      this.capabilityMetadata.set(relayKey, new Map());
    }
    this.capabilityMetadata.get(relayKey).set(capabilityId, entry);
  }

  async getCapabilityMetadata(relayKey, capabilityId) {
    const map = this.capabilityMetadata.get(relayKey);
    if (!map) return null;
    const record = map.get(capabilityId);
    if (!record) return null;
    if (record.expiresAt && record.expiresAt < Date.now()) {
      map.delete(capabilityId);
      return null;
    }
    if (record.revokedAt && record.revokedAt < Date.now() - 0) {
      // Even if revoked, return record so callers can surface revocation.
      return record;
    }
    return record;
  }

  async revokeCapability(relayKey, capabilityId, reason = null) {
    const map = this.capabilityMetadata.get(relayKey);
    if (!map) return null;
    const record = map.get(capabilityId) || {};
    const next = {
      ...record,
      revokedAt: Date.now(),
      revocationReason: reason || record.revocationReason || null,
      recordedAt: Date.now()
    };
    map.set(capabilityId, next);
    return next;
  }
}

export default MemoryRegistrationStore;
