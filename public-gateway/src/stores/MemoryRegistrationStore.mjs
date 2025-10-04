class MemoryRegistrationStore {
  constructor(ttlSeconds = 300) {
    this.ttlSeconds = ttlSeconds;
    this.items = new Map();
    this.tokenMetadata = new Map();
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
}

export default MemoryRegistrationStore;
