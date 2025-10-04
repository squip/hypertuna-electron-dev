import { createClient } from 'redis';

class RedisRegistrationStore {
  constructor({ url, ttlSeconds = 300, prefix = 'gateway:registrations:', logger } = {}) {
    if (!url) throw new Error('Redis URL is required for RedisRegistrationStore');
    this.url = url;
    this.ttlSeconds = ttlSeconds;
    this.prefix = prefix.endsWith(':') ? prefix : `${prefix}:`;
    this.tokenPrefix = `${this.prefix}tokens:`;
    this.logger = logger || console;
    this.client = createClient({ url: this.url });
    this.readyPromise = null;
    this.client.on('error', (err) => {
      this.logger?.error?.('Redis registration store error', { error: err?.message || err });
    });
  }

  async #ensureConnected() {
    if (this.client.isReady) return;
    if (!this.readyPromise) {
      this.readyPromise = this.client.connect().catch((error) => {
        this.readyPromise = null;
        throw error;
      });
    }
    await this.readyPromise;
  }

  async connect() {
    await this.#ensureConnected();
  }

  #key(relayKey) {
    return `${this.prefix}${relayKey}`;
  }

  #tokenKey(relayKey) {
    return `${this.tokenPrefix}${relayKey}`;
  }

  async upsertRelay(relayKey, payload) {
    await this.#ensureConnected();
    const data = JSON.stringify({ ...payload, relayKey, updatedAt: Date.now() });
    const key = this.#key(relayKey);
    await this.client.set(key, data, { EX: this.ttlSeconds });
  }

  async getRelay(relayKey) {
    await this.#ensureConnected();
    const value = await this.client.get(this.#key(relayKey));
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (error) {
      this.logger?.warn?.('Failed to parse redis registration payload', { relayKey, error: error.message });
      return null;
    }
  }

  async removeRelay(relayKey) {
    await this.#ensureConnected();
    await this.client.del(this.#key(relayKey));
    await this.client.del(this.#tokenKey(relayKey));
  }

  pruneExpired() {
    // Redis handles TTL expiry automatically.
    return undefined;
  }

  async disconnect() {
    if (!this.client.isOpen) return;
    await this.client.disconnect();
  }

  async storeTokenMetadata(relayKey, metadata = {}) {
    await this.#ensureConnected();
    const payload = JSON.stringify({
      ...metadata,
      relayKey,
      recordedAt: Date.now()
    });
    await this.client.set(this.#tokenKey(relayKey), payload, { EX: this.ttlSeconds });
  }

  async getTokenMetadata(relayKey) {
    await this.#ensureConnected();
    const value = await this.client.get(this.#tokenKey(relayKey));
    if (!value) return null;
    try {
      return JSON.parse(value);
    } catch (error) {
      this.logger?.warn?.('Failed to parse redis token metadata', { relayKey, error: error.message });
      return null;
    }
  }
}

export default RedisRegistrationStore;
