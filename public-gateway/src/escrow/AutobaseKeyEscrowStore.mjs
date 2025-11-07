import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

class AutobaseKeyEscrowStore {
  constructor({ persistPath } = {}) {
    if (!persistPath) throw new Error('AutobaseKeyEscrowStore requires a persistPath');
    this.persistPath = persistPath;
    this.records = new Map();
    this.indexByRelay = new Map();
    this.loaded = false;
    this.persisting = null;
  }

  async init() {
    if (this.loaded) return;
    try {
      const buf = await readFile(this.persistPath, 'utf8');
      const parsed = JSON.parse(buf);
      const list = Array.isArray(parsed?.records) ? parsed.records : [];
      for (const record of list) {
        if (!record?.id) continue;
        this.records.set(record.id, record);
        if (record.relayKey) {
          this.indexByRelay.set(record.relayKey, record.id);
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
    this.loaded = true;
  }

  async put(record) {
    if (!record?.id) {
      throw new Error('Escrow record requires an id');
    }
    this.records.set(record.id, record);
    if (record.relayKey) {
      this.indexByRelay.set(record.relayKey, record.id);
    }
    await this.#persist();
    return record;
  }

  async update(recordId, patch = {}) {
    const existing = this.records.get(recordId);
    if (!existing) return null;
    const next = {
      ...existing,
      ...patch,
      updatedAt: Date.now()
    };
    this.records.set(recordId, next);
    if (next.relayKey) {
      this.indexByRelay.set(next.relayKey, next.id);
    }
    await this.#persist();
    return next;
  }

  async remove(recordId) {
    const existing = this.records.get(recordId);
    if (!existing) return false;
    this.records.delete(recordId);
    if (existing.relayKey && this.indexByRelay.get(existing.relayKey) === recordId) {
      this.indexByRelay.delete(existing.relayKey);
    }
    await this.#persist();
    return true;
  }

  getByRelayKey(relayKey) {
    if (!relayKey) return null;
    const recordId = this.indexByRelay.get(relayKey);
    if (!recordId) return null;
    return this.records.get(recordId) || null;
  }

  getById(recordId) {
    return recordId ? (this.records.get(recordId) || null) : null;
  }

  list() {
    return Array.from(this.records.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  async #persist() {
    if (!this.loaded) return;
    if (this.persisting) {
      await this.persisting;
      return;
    }
    const payload = JSON.stringify({ version: 1, records: this.list() }, null, 2);
    this.persisting = (async () => {
      try {
        await mkdir(dirname(this.persistPath), { recursive: true });
        await writeFile(this.persistPath, payload);
      } finally {
        this.persisting = null;
      }
    })();
    await this.persisting;
  }
}

export default AutobaseKeyEscrowStore;
