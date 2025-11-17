export default class ReplicationSecretManager {
  constructor() {
    this.secrets = new Map(); // relayId -> sorted array [{ createdAt, secret }]
    this.subscribers = new Map(); // relayId -> Set<fn>
  }

  setSecret(relayId, secret, createdAt = Date.now()) {
    if (!relayId || !secret) return;
    const entry = { createdAt: Math.floor(createdAt), secret };
    const list = this.secrets.get(relayId) || [];
    list.push(entry);
    list.sort((a, b) => b.createdAt - a.createdAt);
    this.secrets.set(relayId, list);
    this.#notify(relayId, entry);
  }

  hasSecret(relayId) {
    const list = this.secrets.get(relayId);
    return Array.isArray(list) && list.length > 0;
  }

  getSecret(relayId) {
    const list = this.secrets.get(relayId);
    if (!list || !list.length) return null;
    return list[0].secret;
  }

  getSecretForTimestamp(relayId, createdAt) {
    const list = this.secrets.get(relayId);
    if (!list || !list.length) return null;
    const ts = Number(createdAt) || 0;
    for (const entry of list) {
      if (entry.createdAt <= ts) return entry.secret;
    }
    return list[list.length - 1].secret;
  }

  listSecrets(relayId) {
    return this.secrets.get(relayId) || [];
  }

  subscribe(relayId, fn) {
    if (typeof fn !== 'function') return () => {};
    const set = this.subscribers.get(relayId) || new Set();
    set.add(fn);
    this.subscribers.set(relayId, set);
    return () => {
      const current = this.subscribers.get(relayId);
      if (current) current.delete(fn);
    };
  }

  #notify(relayId, entry) {
    const set = this.subscribers.get(relayId);
    if (!set) return;
    for (const fn of set) {
      try { fn(entry); } catch (_) { /* noop */ }
    }
  }
}

