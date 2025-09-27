class MemoryRegistrationStore {
  constructor(ttlSeconds = 300) {
    this.ttlSeconds = ttlSeconds;
    this.items = new Map();
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
  }

  pruneExpired() {
    const now = Date.now();
    for (const [key, record] of this.items.entries()) {
      if (record.expiresAt < now) {
        this.items.delete(key);
      }
    }
  }
}

export default MemoryRegistrationStore;
