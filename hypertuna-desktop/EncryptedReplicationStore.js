// Simple IndexedDB-based store for decrypted replication events.
// Keys: relayId -> events object store. Events keyed by event id.

const DB_NAME = 'encrypted-replication-store';
const DB_VERSION = 1;

export default class EncryptedReplicationStore {
  constructor() {
    this.dbPromise = null;
  }

  async _open() {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('events')) {
          const store = db.createObjectStore('events', { keyPath: 'id' });
          store.createIndex('relayId', 'relayId', { unique: false });
          store.createIndex('relayId_created_at', ['relayId', 'created_at'], { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbPromise;
  }

  async putEvents(relayId, events = []) {
    if (!relayId || !Array.isArray(events) || !events.length) return;
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      const store = tx.objectStore('events');
      events.forEach((ev) => {
        store.put({ ...ev, relayId });
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getEvents(relayId, filters = {}) {
    if (!relayId) return [];
    const db = await this._open();
    const { since = 0, until = 9999999999, kinds = null, limit = null } = filters;
    return new Promise((resolve, reject) => {
      const index = db.transaction('events').objectStore('events').index('relayId_created_at');
      const range = IDBKeyRange.bound([relayId, since], [relayId, until + 1]);
      const req = index.openCursor(range, 'prev');
      const results = [];
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return resolve(results);
        const value = cursor.value;
        if (Array.isArray(kinds) && kinds.length && !kinds.includes(value.kind)) {
          cursor.continue();
          return;
        }
        results.push(value);
        if (limit && results.length >= limit) {
          return resolve(results);
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }

  async clearRelay(relayId) {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      const index = tx.objectStore('events').index('relayId');
      const range = IDBKeyRange.only(relayId);
      const req = index.openKeyCursor(range);
      req.onsuccess = (event) => {
        const cursor = event.target.result;
        if (!cursor) return;
        tx.objectStore('events').delete(cursor.primaryKey);
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async purgeAll() {
    const db = await this._open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('events', 'readwrite');
      tx.objectStore('events').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
}
