import { EventEmitter } from 'node:events';
import HypercoreId from 'hypercore-id-encoding';

import AutobaseReplicaSession from '../replica/AutobaseReplicaSession.mjs';

function toKeyString(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) {
    try {
      return HypercoreId.encode(value);
    } catch (_) {
      return value.toString('hex');
    }
  }
  if (value instanceof Uint8Array) {
    return toKeyString(Buffer.from(value));
  }
  return null;
}

function decodeKey(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return HypercoreId.decode(trimmed);
  } catch (_) {
    return null;
  }
}

export default class BlindPeerReplicaManager extends EventEmitter {
  constructor({ logger, maxReplicas = 32 } = {}) {
    super();
    this.logger = logger || console;
    this.maxReplicas = Number.isFinite(maxReplicas) && maxReplicas > 0
      ? Math.trunc(maxReplicas)
      : 32;
    this.blindPeerService = null;
    this.corestore = null;
    this.replicas = new Map();
    this.sequence = 0;
    this.listeners = new Map();
    this.sessions = new Map();
  }

  async initialize({ blindPeerService } = {}) {
    this.blindPeerService = blindPeerService || null;
    if (!this.blindPeerService) {
      this.logger?.warn?.('[BlindPeerReplicaManager] Initialized without blind-peer service reference');
      return;
    }

    await this.#prepareCorestore();

    const onAdd = (payload) => this.#handleMirrorAdded(payload);
    const onRemove = (payload) => this.#handleMirrorRemoved(payload);
    this.listeners.set('mirror-added', onAdd);
    this.listeners.set('mirror-removed', onRemove);
    this.blindPeerService.on('mirror-added', onAdd);
    this.blindPeerService.on('mirror-removed', onRemove);

    try {
      const snapshot = this.blindPeerService.getMirrorReadinessSnapshot?.({
        includeCores: false,
        limit: Number.POSITIVE_INFINITY
      }) || [];
      for (const record of snapshot) {
        this.#upsertFromReadiness(record);
      }
    } catch (error) {
      this.logger?.debug?.('[BlindPeerReplicaManager] Failed to seed replica snapshot', {
        error: error?.message || error
      });
    }
  }

  async stop() {
    for (const [event, handler] of this.listeners.entries()) {
      this.blindPeerService?.off?.(event, handler);
    }
    this.listeners.clear();
    await Promise.allSettled(Array.from(this.sessions.values()).map(async (session) => {
      await session?.close?.();
    }));
    this.sessions.clear();
    await Promise.allSettled(Array.from(this.replicas.values()).map(async (replica) => {
      await this.#closeReplica(replica);
    }));
    this.replicas.clear();
  }

  getReplicaSnapshot({ includeInternals = false, limit = 100 } = {}) {
    const list = Array.from(this.replicas.values()).map((replica) => ({
      identifier: replica.identifier,
      ownerPeerKey: replica.ownerPeerKey,
      ownerAlias: replica.ownerAlias || null,
      type: replica.type || null,
      totalCores: replica.totalCores || 0,
      announcedCount: replica.announcedCount || 0,
      priorityMax: replica.priorityMax ?? null,
      priorityMin: replica.priorityMin ?? null,
      lastEventAt: replica.lastEventAt || null,
      lastOpenedAt: replica.openedAt || null,
      opened: !!replica.core,
      healthy: replica.healthy ?? null,
      lagMs: replica.lagMs ?? null,
      writerLeaseActive: replica.writerLeaseActive ?? false,
      writerLeaseExpiresAt: replica.writerLeaseExpiresAt ?? null,
      writerLeaseId: replica.writerLeaseId || null,
      metadata: includeInternals ? replica.metadata || null : undefined
    }));
    list.sort((a, b) => {
      if ((b.opened ? 1 : 0) !== (a.opened ? 1 : 0)) {
        return (b.opened ? 1 : 0) - (a.opened ? 1 : 0);
      }
      return (b.lastEventAt || 0) - (a.lastEventAt || 0);
    });
    if (Number.isFinite(limit) && limit > 0 && list.length > limit) {
      return list.slice(0, Math.trunc(limit));
    }
    return list;
  }

  setWriterLeaseState(identifier, ownerPeerKey, lease = null) {
    if (!identifier) return false;
    const replica = this.#findReplica(identifier, ownerPeerKey) || this.#findReplica(identifier, null);
    if (!replica) return false;
    replica.writerLeaseActive = !!lease;
    replica.writerLeaseExpiresAt = lease?.expiresAt || null;
    replica.writerLeaseId = lease?.leaseId || null;
    replica.currentLease = lease ? this.#cloneLease(lease) : null;
    this.emit('replica-updated', replica);
    const session = this.#getSession(identifier, ownerPeerKey || replica.ownerPeerKey);
    if (session) {
      if (lease) {
        Promise.resolve(session.setWriterLease(this.#cloneLease(lease))).catch((error) => {
          this.logger?.warn?.('[BlindPeerReplicaManager] Failed to apply writer lease to session', {
            identifier,
            error: error?.message || error
          });
        });
      } else {
        Promise.resolve(session.clearWriterLease()).catch((error) => {
          this.logger?.warn?.('[BlindPeerReplicaManager] Failed to clear writer lease from session', {
            identifier,
            error: error?.message || error
          });
        });
      }
    }
    return true;
  }

  async ensureReplicaCore(identifier, ownerPeerKey) {
    const replica = this.#findReplica(identifier, ownerPeerKey);
    if (!replica) return null;
    return await this.#ensureCore(replica);
  }

  hasReplica(identifier, ownerPeerKey = null) {
    return !!this.#findReplica(identifier, ownerPeerKey);
  }

  async acquireAutobaseSession(identifier, ownerPeerKey = null) {
    if (!identifier) return null;
    const replica = this.#findReplica(identifier, ownerPeerKey) || this.#findReplica(identifier, null);
    if (!replica || !replica.coreKey) return null;
    const cacheKey = this.#sessionKey(identifier, replica.ownerPeerKey);
    let session = this.sessions.get(cacheKey);
    if (session) {
      return session;
    }
    const corestore = await this.#prepareCorestore();
    if (!corestore) {
      this.logger?.warn?.('[BlindPeerReplicaManager] Unable to prepare corestore for replica session', {
        identifier
      });
      return null;
    }
    const ensured = await this.#ensureCore(replica);
    if (!ensured) {
      return null;
    }
    session = new AutobaseReplicaSession({
      identifier,
      ownerPeerKey: replica.ownerPeerKey,
      coreKey: replica.coreKey,
      corestore,
      logger: this.logger
    });
    if (replica.currentLease) {
      try {
        await session.setWriterLease(this.#cloneLease(replica.currentLease));
      } catch (error) {
        this.logger?.warn?.('[BlindPeerReplicaManager] Failed to hydrate replica session lease', {
          identifier,
          error: error?.message || error
        });
      }
    }
    this.sessions.set(cacheKey, session);
    return session;
  }

  async #prepareCorestore() {
    if (this.corestore) return this.corestore;
    if (!this.blindPeerService?.getCorestore) return null;
    const store = this.blindPeerService.getCorestore();
    if (!store) return null;
    if (typeof store.ready === 'function') {
      try {
        await store.ready();
      } catch (error) {
        this.logger?.debug?.('[BlindPeerReplicaManager] Failed to ready blind-peer corestore', {
          error: error?.message || error
        });
      }
    }
    if (typeof store.namespace === 'function') {
      this.corestore = store.namespace('public-gateway-replicas');
    } else {
      this.corestore = store;
    }
    return this.corestore;
  }

  #handleMirrorAdded(payload = {}) {
    const coreKey = payload.coreKey || payload.key || null;
    const identifier = payload.identifier || payload.metadataSummary?.identifier || coreKey;
    const ownerPeerKey = payload.ownerPeerKey || payload.metadataSummary?.ownerPeerKey || null;
    const replicaKey = this.#replicaKey(identifier, ownerPeerKey);
    const entry = this.replicas.get(replicaKey) || {
      coreKeys: new Set(),
      announcedKeys: new Set()
    };
    if (!entry.coreKeys) entry.coreKeys = new Set();
    if (!entry.announcedKeys) entry.announcedKeys = new Set();
    entry.identifier = identifier;
    entry.ownerPeerKey = ownerPeerKey;
    entry.ownerAlias = payload.ownerAlias || null;
    entry.type = payload.type || payload.metadataSummary?.type || null;
    entry.priorityMax = this.#normalize(entry.priorityMax, payload.priority ?? payload.metadataSummary?.priority);
    entry.priorityMin = this.#normalize(entry.priorityMin, payload.priority ?? payload.metadataSummary?.priority, true);
    if (coreKey) {
      const isNew = !entry.coreKeys.has(coreKey);
      entry.coreKeys.add(coreKey);
      entry.primaryCoreKey = entry.primaryCoreKey || coreKey;
      if (payload.announce || payload.metadataSummary?.announce) {
        entry.announcedKeys.add(coreKey);
      }
      if (isNew) {
        entry.totalCores = entry.coreKeys.size;
        entry.announcedCount = entry.announcedKeys.size;
      } else {
        entry.totalCores = entry.coreKeys.size;
        entry.announcedCount = entry.announcedKeys.size;
      }
    } else {
      entry.totalCores = entry.coreKeys.size;
      entry.announcedCount = entry.announcedKeys.size;
    }
    entry.coreKey = entry.primaryCoreKey || null;
    entry.lastEventAt = payload.lastSeenAt || Date.now();
    entry.sequence = ++this.sequence;
    entry.metadata = payload.metadataSummary || null;
    entry.healthy = payload.healthy ?? entry.healthy ?? null;
    entry.lagMs = payload.lagMs ?? entry.lagMs ?? null;
    this.replicas.set(replicaKey, entry);
    this.#enforceReplicaLimit();
    this.emit('replica-updated', entry);
  }

  #handleMirrorRemoved(payload = {}) {
    const coreKey = payload.coreKey || payload.key || null;
    const identifier = payload.identifier || null;
    const ownerPeerKey = payload.ownerPeerKey || null;
    let replica = null;
    if (coreKey) {
      replica = this.#findReplicaByCoreKey(coreKey);
    }
    if (!replica && identifier) {
      replica = this.#findReplica(identifier, ownerPeerKey);
    }
    if (!replica) return;
    if (coreKey && replica.coreKeys?.has(coreKey)) {
      replica.coreKeys.delete(coreKey);
      replica.announcedKeys?.delete(coreKey);
    }
    replica.totalCores = replica.coreKeys?.size || 0;
    replica.announcedCount = replica.announcedKeys?.size || 0;
    const replicaKey = this.#replicaKey(replica.identifier, replica.ownerPeerKey);
    if (replica.totalCores === 0) {
      this.#deleteSession(replica.identifier, replica.ownerPeerKey);
      this.replicas.delete(replicaKey);
      this.#closeReplica(replica).catch((error) => {
        this.logger?.debug?.('[BlindPeerReplicaManager] Failed to close replica core', {
          error: error?.message || error
        });
      });
      this.emit('replica-removed', {
        identifier: replica.identifier,
        ownerPeerKey: replica.ownerPeerKey
      });
    } else {
      if (replica.primaryCoreKey === coreKey) {
        replica.primaryCoreKey = Array.from(replica.coreKeys)[0] || null;
        replica.coreKey = replica.primaryCoreKey;
      }
      this.emit('replica-updated', replica);
    }
  }

  async #ensureCore(replica) {
    if (replica.core) return replica.core;
    const coreKey = replica.coreKey;
    if (!coreKey) return null;
    const store = await this.#prepareCorestore();
    if (!store || typeof store.get !== 'function') return null;
    const decoded = decodeKey(coreKey);
    if (!decoded) return null;
    try {
      const core = store.get({ key: decoded, valueEncoding: 'binary' });
      await core.ready();
      replica.core = core;
      replica.openedAt = Date.now();
      const info = await core.info().catch(() => null);
      if (info) {
        replica.lastLength = info.length ?? null;
        replica.lastContiguous = info.contiguousLength ?? null;
        if (Number.isFinite(info.length) && Number.isFinite(info.contiguousLength)) {
          replica.lagMs = Math.max(0, info.length - info.contiguousLength);
        }
      }
      core.once?.('close', () => {
        replica.core = null;
      });
      return core;
    } catch (error) {
      this.logger?.debug?.('[BlindPeerReplicaManager] Failed to open replica core', {
        identifier: replica.identifier,
        ownerPeerKey: replica.ownerPeerKey,
        error: error?.message || error
      });
      return null;
    }
  }

  async #closeReplica(replica) {
    if (replica?.core?.close) {
      try {
        await replica.core.close();
      } catch (error) {
        this.logger?.debug?.('[BlindPeerReplicaManager] Replica core close failed', {
          identifier: replica?.identifier,
          error: error?.message || error
        });
      }
    }
    replica.core = null;
  }

  #upsertFromReadiness(record = {}) {
    const payload = {
      coreKey: record.coreKey || null,
      identifier: record.identifier,
      ownerPeerKey: record.ownerPeerKey,
      ownerAlias: record.ownerAlias,
      type: record.type,
      priority: record.priorityMax ?? record.priorityMin ?? null,
      announce: record.announcedCount > 0,
      lastSeenAt: record.lastActive,
      healthy: record.healthy,
      lagMs: record.lagMs,
      metadataSummary: {
        primaryIdentifier: record.identifier,
        priority: record.priorityMax ?? record.priorityMin ?? null,
        announce: record.announcedCount > 0,
        ownerPeerKey: record.ownerPeerKey,
        type: record.type
      }
    };
    this.#handleMirrorAdded(payload);
  }

  #findReplica(identifier, ownerPeerKey) {
    for (const replica of this.replicas.values()) {
      if (replica.identifier === identifier) {
        if (!ownerPeerKey || replica.ownerPeerKey === ownerPeerKey) {
          return replica;
        }
      }
    }
    return null;
  }

  #findReplicaByCoreKey(coreKey) {
    for (const replica of this.replicas.values()) {
      if (replica.coreKey === coreKey) {
        return replica;
      }
    }
    return null;
  }

  #enforceReplicaLimit() {
    if (this.replicas.size <= this.maxReplicas) return;
    const entries = Array.from(this.replicas.entries());
    entries.sort((a, b) => {
      const entryA = a[1];
      const entryB = b[1];
      return (entryA.sequence || 0) - (entryB.sequence || 0);
    });
    while (this.replicas.size > this.maxReplicas && entries.length) {
      const [key, replica] = entries.shift();
      this.replicas.delete(key);
      this.#closeReplica(replica).catch((error) => {
        this.logger?.debug?.('[BlindPeerReplicaManager] Failed to close LRU replica', {
          error: error?.message || error
        });
      });
    }
  }

  #replicaKey(identifier, ownerPeerKey) {
    return `${identifier || 'unknown'}::${ownerPeerKey || 'anonymous'}`;
  }

  #sessionKey(identifier, ownerPeerKey) {
    return `session:${identifier || 'unknown'}::${ownerPeerKey || 'anonymous'}`;
  }

  #getSession(identifier, ownerPeerKey) {
    const key = this.#sessionKey(identifier, ownerPeerKey);
    return this.sessions.get(key) || null;
  }

  async #deleteSession(identifier, ownerPeerKey) {
    const key = this.#sessionKey(identifier, ownerPeerKey);
    const session = this.sessions.get(key);
    if (!session) return;
    this.sessions.delete(key);
    try {
      await session.close();
    } catch (error) {
      this.logger?.debug?.('[BlindPeerReplicaManager] Failed to close replica session', {
        identifier,
        error: error?.message || error
      });
    }
  }

  #cloneLease(lease = null) {
    if (!lease || typeof lease !== 'object') return null;
    const copy = { ...lease };
    if (lease.writerPackage && typeof lease.writerPackage === 'object') {
      copy.writerPackage = { ...lease.writerPackage };
      if (lease.writerPackage.writerKey) {
        const keyValue = lease.writerPackage.writerKey;
        if (Buffer.isBuffer(keyValue)) {
          copy.writerPackage.writerKey = Buffer.from(keyValue);
        } else if (keyValue instanceof Uint8Array) {
          copy.writerPackage.writerKey = Buffer.from(keyValue);
        } else {
          copy.writerPackage.writerKey = keyValue;
        }
      }
    }
    return copy;
  }

  #normalize(existing, current, preferMin = false) {
    if (!Number.isFinite(current)) return existing ?? null;
    if (!Number.isFinite(existing)) return current;
    return preferMin ? Math.min(existing, current) : Math.max(existing, current);
  }
}
