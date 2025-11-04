import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import HypercoreId from 'hypercore-id-encoding';

const DEFAULT_STORAGE_SUBDIR = 'blind-peer-data';

async function loadBlindPeerModule() {
  const mod = await import('blind-peer');
  return mod?.default || mod;
}

function toKeyString(value) {
  if (!value) return null;
  try {
    if (typeof value === 'string') {
      return HypercoreId.encode(HypercoreId.decode(value));
    }
    const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
    return HypercoreId.encode(buf);
  } catch (_) {
    if (typeof value === 'string') return value.trim() || null;
    if (Buffer.isBuffer(value)) return value.toString('hex');
    if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
    return null;
  }
}

function sanitizePeerKey(key) {
  if (!key || typeof key !== 'string') return null;
  const trimmed = key.trim();
  return trimmed.length ? trimmed : null;
}

function sanitizeRelayKey(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function decodeKey(key) {
  if (!key) return null;
  if (Buffer.isBuffer(key)) return key;
  if (key instanceof Uint8Array) return Buffer.from(key);
  if (typeof key === 'string') {
    try {
      return HypercoreId.decode(key);
    } catch (_) {
      return Buffer.from(key, 'hex');
    }
  }
  return null;
}

export default class BlindPeerService extends EventEmitter {
  constructor({ logger, config, metrics } = {}) {
    super();
    this.logger = logger || console;
    this.config = config || {};
    this.metrics = metrics || {
      setActive: () => {},
      setTrustedPeers: () => {},
      setBytesAllocated: () => {},
      incrementGcRuns: () => {},
      recordEvictions: () => {}
    };

    this.initialized = false;
    this.running = false;
    this.storageDir = this.config.storageDir || null;
    this.trustedPeers = new Set();
    this.trustedPeerMeta = new Map();
    this.trustedPeersPersistPath = this.config.trustedPeersPersistPath
      ? resolve(this.config.trustedPeersPersistPath)
      : null;
    this.trustedPeersLoaded = false;
    this.blindPeer = null;
    this.cleanupInterval = null;
    this.hygieneInterval = null;
    this.hygieneRunning = false;
    this.hygieneStats = {
      totalRuns: 0,
      lastRunAt: null,
      lastDurationMs: null,
      lastResult: null,
      lastError: null,
      lastBytesFreed: 0,
      lastEvictions: 0
    };
    this.coreMetadata = new Map();
    this.dispatcherAssignments = new Map();
    this.dispatcherAssignmentTimers = new Map();
    this.metadataPersistPath = this.config.metadataPersistPath
      ? resolve(this.config.metadataPersistPath)
      : null;
    this.metadataDirty = false;
    this.metadataSaveTimer = null;
  }

  async initialize() {
    if (this.initialized) return;
    if (!this.config.enabled) {
      this.logger?.debug?.('[BlindPeer] Service disabled by configuration');
      this.initialized = true;
      this.metrics.setActive?.(0);
      this.#updateMetrics();
      return;
    }

    await this.#loadTrustedPeersFromDisk();
    await this.#ensureStorageDir();
    this.#ensureMetadataPersistPath();
    await this.#loadCoreMetadataFromDisk();
    this.initialized = true;
    this.logger?.info?.('[BlindPeer] Initialized', this.getStatus());
  }

  async start() {
    if (!this.initialized) await this.initialize();
    if (!this.config.enabled) return false;
    if (this.running) return true;

    await this.#createBlindPeer();
    this.running = true;
    this.metrics.setActive?.(1);
    this.logger?.info?.('[BlindPeer] Service started', this.getAnnouncementInfo());
    this.cleanupInterval = setInterval(() => this.#updateMetrics(), 30000).unref();
    // TODO: allow dynamic tuning once session bridging supplements the hygiene scheduler.
    this.#startHygieneLoop();
    return true;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.hygieneInterval) {
      clearInterval(this.hygieneInterval);
      this.hygieneInterval = null;
    }
    this.hygieneRunning = false;

    if (this.blindPeer?.close) {
      try {
        await this.blindPeer.close();
      } catch (error) {
        this.logger?.warn?.('[BlindPeer] Error while stopping blind-peer instance', {
          err: error?.message || error
        });
      }
    }

    this.blindPeer = null;
    this.#updateMetrics();
    this.metrics.setActive?.(0);
    for (const timer of this.dispatcherAssignmentTimers.values()) {
      clearTimeout(timer);
    }
    this.dispatcherAssignmentTimers.clear();
    this.dispatcherAssignments.clear();
    if (this.metadataSaveTimer) {
      clearTimeout(this.metadataSaveTimer);
      this.metadataSaveTimer = null;
    }
    await this.#persistCoreMetadata(true);
    this.logger?.info?.('[BlindPeer] Service stopped');
  }

  addTrustedPeer(peerKey) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return false;
    if (this.trustedPeers.has(sanitized)) return false;
    this.trustedPeers.add(sanitized);
    const now = Date.now();
    this.trustedPeerMeta.set(sanitized, {
      trustedSince: now
    });

    if (this.blindPeer?.addTrustedPubKey) {
      try {
        this.blindPeer.addTrustedPubKey(sanitized);
      } catch (error) {
        this.logger?.warn?.('[BlindPeer] Failed to add trusted peer to running service', {
          peerKey: sanitized,
          err: error?.message || error
        });
      }
    }

    this.logger?.debug?.('[BlindPeer] Trusted peer added', { peerKey: sanitized });
    this.#updateTrustedPeers();
    if (this.trustedPeersPersistPath) {
      this.#persistTrustedPeers().catch((error) => {
        this.logger?.warn?.('[BlindPeer] Failed to persist trusted peers', {
          err: error?.message || error
        });
      });
    }
    return true;
  }

  removeTrustedPeer(peerKey) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return false;
    const removed = this.trustedPeers.delete(sanitized);
    if (removed) {
      this.logger?.debug?.('[BlindPeer] Trusted peer removed', { peerKey: sanitized });
      this.trustedPeerMeta.delete(sanitized);
      this.#updateTrustedPeers();
      if (this.trustedPeersPersistPath) {
        this.#persistTrustedPeers().catch((error) => {
          this.logger?.warn?.('[BlindPeer] Failed to persist trusted peers', {
            err: error?.message || error
          });
        });
      }
    }
    return removed;
  }

  recordDispatcherAssignment({ jobId, peerKey, relayKey, filters = [], requester = null } = {}) {
    if (!jobId) return null;
    const sanitizedPeer = sanitizePeerKey(peerKey);
    const sanitizedRelay = sanitizeRelayKey(relayKey);
    const entry = {
      jobId,
      peerKey: sanitizedPeer,
      relayKey: sanitizedRelay,
      filters: Array.isArray(filters) ? filters : [],
      requester: requester || null,
      status: 'assigned',
      assignedAt: Date.now(),
      completedAt: null
    };
    if (!sanitizedPeer && sanitizedRelay) {
      entry.requester = entry.requester || {};
    }
    if (sanitizedPeer) {
      this.addTrustedPeer(sanitizedPeer);
    }
    if (this.dispatcherAssignmentTimers.has(jobId)) {
      clearTimeout(this.dispatcherAssignmentTimers.get(jobId));
      this.dispatcherAssignmentTimers.delete(jobId);
    }
    this.dispatcherAssignments.set(jobId, entry);
    return entry;
  }

  clearDispatcherAssignment(jobId, { status = 'completed', details = null } = {}) {
    if (!jobId) return null;
    const entry = this.dispatcherAssignments.get(jobId);
    if (!entry) return null;
    entry.status = status;
    entry.completedAt = Date.now();
    entry.details = details;
    this.dispatcherAssignments.set(jobId, entry);
    this.#scheduleDispatcherAssignmentCleanup(jobId);
    return entry;
  }

  getDispatcherAssignmentsSnapshot() {
    return Array.from(this.dispatcherAssignments.values())
      .sort((a, b) => (b.assignedAt || 0) - (a.assignedAt || 0));
  }

  async mirrorCore(coreOrKey, options = {}) {
    if (!this.running || !this.blindPeer) {
      this.logger?.debug?.('[BlindPeer] mirrorCore skipped (service inactive)', { core: !!coreOrKey });
      return { status: 'inactive' };
    }

    const core = coreOrKey && typeof coreOrKey === 'object' && typeof coreOrKey.key === 'object'
      ? coreOrKey
      : null;

    const key = core ? core.key : decodeKey(coreOrKey);
    if (!key) {
      throw new Error('Invalid core key provided to mirrorCore');
    }

    const request = {
      key,
      announce: options.announce === true,
      priority: options.priority ?? 0,
      referrer: options.referrer ? decodeKey(options.referrer) : null
    };
    const metadata = options.metadata && typeof options.metadata === 'object'
      ? { ...options.metadata }
      : null;

    try {
      const record = await this.blindPeer.addCore(request);
      this.logger?.info?.('[BlindPeer] Core mirror requested', {
        key: toKeyString(key),
        announce: request.announce,
        priority: request.priority
      });
      if (metadata) {
        this.#recordCoreMetadata(key, {
          priority: request.priority,
          announce: request.announce === true,
          ...metadata
        });
      } else {
        this.#touchCoreMetadata(key, {
          priority: request.priority,
          announce: request.announce === true
        });
      }
      this.#updateMetrics();
      return { status: 'accepted', record };
    } catch (error) {
      this.logger?.warn?.('[BlindPeer] Failed to mirror core', {
        key: toKeyString(key),
        err: error?.message || error
      });
      throw error;
    }
  }

  async mirrorAutobase(autobase, options = {}) {
    if (!this.running || !this.blindPeer) return { status: 'inactive' };
    if (!autobase || typeof autobase !== 'object') {
      throw new Error('Invalid autobase instance provided');
    }

    const targetKey = options.target ? decodeKey(options.target) : null;
    const metadata = options.metadata && typeof options.metadata === 'object'
      ? { ...options.metadata }
      : null;
    try {
      const result = await this.blindPeer.addAutobase(autobase, targetKey);
      this.logger?.info?.('[BlindPeer] Autobase mirrored', {
        target: toKeyString(targetKey),
        writers: Array.isArray(autobase.writers) ? autobase.writers.length : null
      });
      if (metadata?.coreKey) {
        const resolvedKey = metadata.coreKey;
        this.#recordCoreMetadata(resolvedKey, {
          priority: metadata.priority ?? 1,
          ownerPeerKey: metadata.ownerPeerKey,
          type: metadata.type || 'autobase',
          identifier: metadata.identifier || null,
          announce: metadata.announce === true
        });
      }
      this.#updateMetrics();
      return { status: 'accepted', result };
    } catch (error) {
      this.logger?.warn?.('[BlindPeer] Failed to mirror autobase', {
        target: toKeyString(targetKey),
        err: error?.message || error
      });
      throw error;
    }
  }

  async runHygiene(reason = 'manual') {
    return this.#runHygieneCycle(reason);
  }

  async deleteMirror(coreKey, { reason = 'manual' } = {}) {
    if (!this.running || !this.blindPeer) {
      throw new Error('Blind peer service inactive');
    }
    const keyInput = typeof coreKey === 'string' ? coreKey.trim() : coreKey;
    if (!keyInput) {
      throw new Error('coreKey is required');
    }
    const decoded = decodeKey(keyInput);
    if (!decoded) {
      throw new Error('invalid-core-key');
    }
    try {
      await this.blindPeer.db.deleteCore(decoded);
      this.#removeCoreMetadata(decoded);
      try {
        await this.blindPeer.flush();
      } catch (flushError) {
        this.logger?.debug?.('[BlindPeer] Flush after delete failed', {
          err: flushError?.message || flushError
        });
      }
      this.logger?.info?.('[BlindPeer] Mirror deleted via admin request', {
        key: toKeyString(decoded),
        reason
      });
      this.#updateMetrics();
      return true;
    } catch (error) {
      this.logger?.warn?.('[BlindPeer] Failed to delete mirror via admin request', {
        key: toKeyString(decoded) || keyInput,
        reason,
        err: error?.message || error
      });
      throw error;
    }
  }

  getPublicKeyHex() {
    return this.blindPeer ? toKeyString(this.blindPeer.publicKey) : null;
  }

  getEncryptionKeyHex() {
    return this.blindPeer ? toKeyString(this.blindPeer.encryptionPublicKey) : null;
  }

  isTrustedPeer(peerKey) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return false;
    return this.trustedPeers.has(sanitized);
  }

  getTrustedPeerInfo(peerKey) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return null;
    const meta = this.trustedPeerMeta.get(sanitized);
    if (!meta) return null;
    return {
      key: sanitized,
      trustedSince: meta.trustedSince || null
    };
  }

  getTrustedPeers() {
    const peers = [];
    for (const key of this.trustedPeers) {
      const info = this.getTrustedPeerInfo(key) || { key, trustedSince: null };
      peers.push(info);
    }
    return peers;
  }

  getStatus(options = {}) {
    const ownerLimit = Number.isFinite(options.ownerLimit) && options.ownerLimit > 0
      ? Math.trunc(options.ownerLimit)
      : 10;
    const coresPerOwner = Number.isFinite(options.coresPerOwner) && options.coresPerOwner > 0
      ? Math.trunc(options.coresPerOwner)
      : 0;
    const includeCores = options.includeCores === true && coresPerOwner !== 0;
    return {
      enabled: !!this.config.enabled,
      running: this.running,
      trustedPeerCount: this.trustedPeers.size,
      storageDir: this.storageDir,
      digest: this.blindPeer?.digest || null,
      publicKey: this.getPublicKeyHex(),
      encryptionKey: this.getEncryptionKeyHex(),
      trustedPeers: this.getTrustedPeers(),
      hygiene: this.#getHygieneSummary(),
      metadata: {
        trackedCores: this.coreMetadata.size
      },
      ownership: this.getOwnershipSnapshot({
        ownerLimit,
        includeCores,
        coresPerOwner: includeCores ? coresPerOwner : 0
      }),
      dispatcherAssignments: this.getDispatcherAssignmentsSnapshot(),
      config: {
        maxBytes: this.config.maxBytes,
        gcIntervalMs: this.config.gcIntervalMs,
        dedupeBatchSize: this.config.dedupeBatchSize,
        staleCoreTtlMs: this.config.staleCoreTtlMs
      }
    };
  }

  getAnnouncementInfo() {
    if (!this.config.enabled || !this.blindPeer) {
      return {
        enabled: false
      };
    }

    return {
      enabled: true,
      publicKey: this.getPublicKeyHex(),
      encryptionKey: this.getEncryptionKeyHex(),
      maxBytes: this.config.maxBytes,
      trustedPeerCount: this.trustedPeers.size
    };
  }

  #ensureMetadataPersistPath() {
    if (this.metadataPersistPath) return this.metadataPersistPath;
    if (!this.storageDir) return null;
    this.metadataPersistPath = resolve(this.storageDir, 'blind-peer-metadata.json');
    return this.metadataPersistPath;
  }

  async #loadCoreMetadataFromDisk() {
    const path = this.#ensureMetadataPersistPath();
    if (!path) return;
    try {
      const raw = await readFile(path, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) return;
      this.coreMetadata.clear();
      for (const entry of parsed.entries) {
        if (!entry || typeof entry !== 'object' || !entry.key) continue;
        const owners = new Map();
        if (Array.isArray(entry.owners)) {
          for (const owner of entry.owners) {
            if (!owner) continue;
            const ownerId = owner.ownerId || owner.ownerPeerKey || owner.alias || `owner:${owners.size}`;
            owners.set(ownerId, {
              ownerPeerKey: sanitizePeerKey(owner.ownerPeerKey) || null,
              type: owner.type || null,
              identifier: typeof owner.identifier === 'string' ? owner.identifier : null,
              priority: this.#normalizeMetadataPriority(owner.priority),
              lastSeen: Number.isFinite(owner.lastSeen) ? Math.trunc(owner.lastSeen) : null
            });
          }
        }
        const identifiers = new Set();
        if (Array.isArray(entry.identifiers)) {
          for (const id of entry.identifiers) {
            if (typeof id === 'string' && id.trim()) {
              identifiers.add(id.trim());
            }
          }
        }
        const record = {
          key: entry.key,
          owners,
          identifiers,
          primaryIdentifier: typeof entry.primaryIdentifier === 'string' ? entry.primaryIdentifier : null,
          firstSeen: Number.isFinite(entry.firstSeen) ? Math.trunc(entry.firstSeen) : Date.now(),
          lastUpdated: Number.isFinite(entry.lastUpdated) ? Math.trunc(entry.lastUpdated) : Date.now(),
          priority: this.#normalizeMetadataPriority(entry.priority),
          announce: entry.announce === true,
          lastActive: Number.isFinite(entry.lastActive) ? Math.trunc(entry.lastActive) : Date.now()
        };
        if (record.primaryIdentifier) {
          record.identifiers.add(record.primaryIdentifier);
        }
        this.coreMetadata.set(record.key, record);
      }
      this.metadataDirty = false;
      this.logger?.debug?.('[BlindPeer] Loaded metadata snapshot', {
        entries: this.coreMetadata.size,
        path
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.('[BlindPeer] Failed to load metadata snapshot', {
          path,
          err: error?.message || error
        });
      }
    }
  }

  async #persistCoreMetadata(force = false) {
    const path = this.#ensureMetadataPersistPath();
    if (!path) return;
    if (!force && !this.metadataDirty) return;
    try {
      await mkdir(dirname(path), { recursive: true });
      const entries = [];
      for (const entry of this.coreMetadata.values()) {
        entries.push({
          key: entry.key,
          primaryIdentifier: entry.primaryIdentifier || null,
          announce: entry.announce === true,
          priority: this.#normalizeMetadataPriority(entry.priority),
          firstSeen: entry.firstSeen || null,
          lastUpdated: entry.lastUpdated || null,
          lastActive: entry.lastActive || null,
          identifiers: Array.from(entry.identifiers || []),
          owners: Array.from(entry.owners.entries()).map(([ownerId, ownerInfo]) => ({
            ownerId,
            ownerPeerKey: ownerInfo.ownerPeerKey || null,
            type: ownerInfo.type || null,
            identifier: ownerInfo.identifier || null,
            priority: this.#normalizeMetadataPriority(ownerInfo.priority),
            lastSeen: ownerInfo.lastSeen || null
          }))
        });
      }
      const payload = JSON.stringify({ entries }, null, 2);
      await writeFile(path, payload, 'utf8');
      this.metadataDirty = false;
    } catch (error) {
      this.logger?.warn?.('[BlindPeer] Failed to persist metadata snapshot', {
        path,
        err: error?.message || error
      });
    }
  }

  #scheduleCoreMetadataPersist() {
    if (this.metadataSaveTimer) return;
    this.metadataSaveTimer = setTimeout(() => {
      this.metadataSaveTimer = null;
      this.#persistCoreMetadata().catch((error) => {
        this.logger?.warn?.('[BlindPeer] Metadata snapshot task failed', {
          err: error?.message || error
        });
      });
    }, 5000);
    this.metadataSaveTimer.unref?.();
  }

  #markCoreMetadataDirty() {
    this.metadataDirty = true;
    this.#scheduleCoreMetadataPersist();
  }

  #scheduleDispatcherAssignmentCleanup(jobId, delayMs = 120000) {
    if (!jobId) return;
    if (this.dispatcherAssignmentTimers.has(jobId)) {
      clearTimeout(this.dispatcherAssignmentTimers.get(jobId));
      this.dispatcherAssignmentTimers.delete(jobId);
    }
    const timer = setTimeout(() => {
      this.dispatcherAssignmentTimers.delete(jobId);
      this.dispatcherAssignments.delete(jobId);
    }, delayMs);
    timer.unref?.();
    this.dispatcherAssignmentTimers.set(jobId, timer);
  }

  #startHygieneLoop() {
    const intervalMs = Number(this.config.gcIntervalMs);
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;

    if (this.hygieneInterval) {
      clearInterval(this.hygieneInterval);
      this.hygieneInterval = null;
    }

    const runner = () => {
      if (!this.running) return;
      this.#runHygieneCycle('timer').catch((error) => {
        this.logger?.warn?.('[BlindPeer] Hygiene cycle threw', {
          err: error?.message || error
        });
      });
    };

    this.hygieneInterval = setInterval(runner, intervalMs);
    this.hygieneInterval.unref?.();

    const initialDelay = Math.min(10_000, Math.max(1_000, Math.round(intervalMs / 2)));
    setTimeout(() => {
      if (!this.running) return;
      this.#runHygieneCycle('startup').catch((error) => {
        this.logger?.warn?.('[BlindPeer] Initial hygiene run failed', {
          err: error?.message || error
        });
      });
    }, initialDelay).unref?.();
  }

  async #runHygieneCycle(reason = 'timer') {
    if (!this.running || !this.blindPeer) {
      return { status: 'inactive' };
    }
    if (this.hygieneRunning) {
      this.logger?.debug?.('[BlindPeer] Hygiene run skipped (already running)', { reason });
      return { status: 'skipped', reason: 'running' };
    }

    const startedAt = Date.now();
    const staleThreshold = this.config.staleCoreTtlMs > 0
      ? startedAt - this.config.staleCoreTtlMs
      : null;
    const dedupeLimit = Number.isFinite(this.config.dedupeBatchSize)
      ? Math.max(0, this.config.dedupeBatchSize)
      : 100;

    this.hygieneRunning = true;
    let scanned = 0;
    let dedupeDecisions = 0;
    let staleCandidates = 0;
    const evictionPlans = new Map();
    const dedupeByIdentifier = new Map();

    try {
      for await (const record of this.blindPeer.db.createGcCandidateReadStream()) {
        scanned += 1;
        const candidate = this.#buildCandidate(record);
        if (!candidate) continue;

        if (candidate.identifier && dedupeDecisions < dedupeLimit) {
          const existing = dedupeByIdentifier.get(candidate.identifier);
          if (!existing) {
            dedupeByIdentifier.set(candidate.identifier, candidate);
          } else {
            const choice = this.#choosePreferredReplica(existing, candidate);
            if (choice === 'replace') {
              evictionPlans.set(existing.keyStr, {
                reason: 'duplicate',
                bytesAllocated: existing.bytesAllocated
              });
              dedupeByIdentifier.set(candidate.identifier, candidate);
              dedupeDecisions += 1;
            } else if (choice === 'keep') {
              evictionPlans.set(candidate.keyStr, {
                reason: 'duplicate',
                bytesAllocated: candidate.bytesAllocated
              });
              dedupeDecisions += 1;
            }
          }
        }

        if (this.#isRecordStale(candidate, staleThreshold) && !evictionPlans.has(candidate.keyStr)) {
          evictionPlans.set(candidate.keyStr, {
            reason: 'stale',
            bytesAllocated: candidate.bytesAllocated
          });
          staleCandidates += 1;
        }
      }
    } catch (error) {
      this.logger?.warn?.('[BlindPeer] Hygiene scan failed', {
        reason,
        err: error?.message || error
      });
      this.hygieneStats.totalRuns += 1;
      this.hygieneStats.lastRunAt = startedAt;
      this.hygieneStats.lastDurationMs = Date.now() - startedAt;
      this.hygieneStats.lastError = {
        message: error?.message || String(error),
        stack: error?.stack || null
      };
      this.hygieneRunning = false;
      this.metrics.incrementGcRuns?.();
      return { status: 'error', error };
    }

    let totalEvictions = 0;
    let bytesFreed = 0;
    const reasonTally = new Map();

    for (const [keyStr, plan] of evictionPlans) {
      const keyBuf = decodeKey(keyStr);
      if (!keyBuf) continue;
      try {
        await this.blindPeer.db.deleteCore(keyBuf);
        totalEvictions += 1;
        bytesFreed += Number(plan.bytesAllocated) || 0;
        const label = plan.reason || 'unknown';
        reasonTally.set(label, (reasonTally.get(label) || 0) + 1);
        this.#removeCoreMetadata(keyBuf);
        this.logger?.info?.('[BlindPeer] Hygiene eviction applied', {
          key: keyStr,
          reason: label,
          bytesFreed: plan.bytesAllocated ?? null
        });
      } catch (error) {
        this.logger?.warn?.('[BlindPeer] Hygiene eviction failed', {
          key: keyStr,
          reason: plan.reason,
          err: error?.message || error
        });
      }
    }

    try {
      await this.blindPeer.flush();
    } catch (error) {
      this.logger?.warn?.('[BlindPeer] Hygiene flush failed', {
        reason,
        err: error?.message || error
      });
    }

    this.hygieneStats.totalRuns += 1;
    this.hygieneStats.lastRunAt = startedAt;
    this.hygieneStats.lastDurationMs = Date.now() - startedAt;
    this.hygieneStats.lastError = null;
    this.hygieneStats.lastBytesFreed = bytesFreed;
    this.hygieneStats.lastEvictions = totalEvictions;
    this.hygieneStats.lastResult = {
      reason,
      scanned,
      totalEvictions,
      bytesFreed,
      duplicatesProcessed: dedupeDecisions,
      staleCandidates,
      evictionReasons: Object.fromEntries(reasonTally)
    };

    this.metrics.incrementGcRuns?.();
    for (const [evictionReason, count] of reasonTally.entries()) {
      this.metrics.recordEvictions?.({ reason: evictionReason, count });
    }
    this.#updateMetrics();

    this.logger?.info?.('[BlindPeer] Hygiene cycle completed', {
      reason,
      scanned,
      totalEvictions,
      bytesFreed,
      duplicatesProcessed: dedupeDecisions,
      staleCandidates,
      ownersTracked: this.coreMetadata.size,
      evictionReasons: Object.fromEntries(reasonTally)
    });

    this.hygieneRunning = false;
    return { status: 'ok', ...this.hygieneStats.lastResult };
  }

  #buildCandidate(record) {
    if (!record) return null;
    const keyStr = toKeyString(record.key);
    if (!keyStr) return null;
    let metadata = this.coreMetadata.get(keyStr);
    if (!metadata) {
      metadata = this.#touchCoreMetadata(record.key, { priority: record?.priority ?? 0 });
    }

    const priority = this.#normalizeMetadataPriority(
      metadata?.priority,
      record?.priority
    );
    const identifier = this.#selectMetadataIdentifier(metadata);
    const announced = (metadata?.announce === true) || (record?.announce === true);
    return {
      keyStr,
      metadata,
      identifier,
      priority,
      announced,
      lastActive: this.#extractLastActive(record, metadata),
      bytesAllocated: Number(record?.bytesAllocated) || 0
    };
  }

  #selectMetadataIdentifier(metadata) {
    if (!metadata) return null;
    if (metadata.primaryIdentifier && typeof metadata.primaryIdentifier === 'string') {
      const trimmed = metadata.primaryIdentifier.trim();
      if (trimmed) return trimmed;
    }
    if (metadata.identifiers instanceof Set) {
      for (const id of metadata.identifiers) {
        if (typeof id === 'string' && id.trim().length) {
          return id.trim();
        }
      }
    }
    return null;
  }

  #extractLastActive(record, metadata = null) {
    if (metadata?.lastActive) {
      return metadata.lastActive;
    }
    if (!record) return null;
    const active = Number(record.active);
    if (Number.isFinite(active) && active > 0) return active;
    const updated = Number(record.updated);
    if (Number.isFinite(updated) && updated > 0) return updated;
    return null;
  }

  #isRecordStale(candidate, staleThreshold) {
    if (!candidate || !staleThreshold || staleThreshold <= 0) return false;
    if (candidate.announced) return false;
    const priority = Number(candidate.priority ?? 0);
    if (priority > 0) return false;
    if (!candidate.lastActive) return false;
    return candidate.lastActive < staleThreshold;
  }

  #choosePreferredReplica(existing, challenger) {
    if (!existing) return 'replace';
    if (!challenger) return 'keep';

    if (challenger.announced && !existing.announced) return 'replace';
    if (!challenger.announced && existing.announced) return 'keep';

    const existingPriority = Number(existing.priority ?? 0);
    const challengerPriority = Number(challenger.priority ?? 0);
    if (challengerPriority > existingPriority) return 'replace';
    if (challengerPriority < existingPriority) return 'keep';

    const existingActive = Number(existing.lastActive ?? 0);
    const challengerActive = Number(challenger.lastActive ?? 0);
    if (challengerActive > existingActive) return 'replace';
    if (challengerActive < existingActive) return 'keep';

    const challengerBytes = Number(challenger.bytesAllocated ?? 0);
    const existingBytes = Number(existing.bytesAllocated ?? 0);
    if (challengerBytes < existingBytes) return 'replace';
    return 'keep';
  }

  #normalizeMetadataPriority(...values) {
    let result = null;
    for (const value of values) {
      const num = Number(value);
      if (!Number.isFinite(num)) continue;
      result = result === null ? num : Math.max(result, num);
    }
    return result;
  }

  #recordCoreMetadata(coreKey, metadata = {}) {
    const entry = this.#touchCoreMetadata(coreKey, metadata);
    if (!entry) return null;

    const ownerKey = sanitizePeerKey(metadata.ownerPeerKey);
    const identifierKey = typeof metadata.identifier === 'string' ? metadata.identifier.trim() || null : null;
    const ownerId = ownerKey || (identifierKey ? `identifier:${identifierKey}` : 'anonymous');
    const ownerInfo = {
      ownerPeerKey: ownerKey,
      type: metadata.type || null,
      identifier: identifierKey,
      priority: this.#normalizeMetadataPriority(metadata.priority),
      lastSeen: metadata.lastSeenAt && Number.isFinite(metadata.lastSeenAt)
        ? Math.trunc(metadata.lastSeenAt)
        : Date.now()
    };
    entry.owners.set(ownerId, ownerInfo);

    if (ownerInfo.identifier) {
      entry.identifiers.add(ownerInfo.identifier);
      if (!entry.primaryIdentifier) {
        entry.primaryIdentifier = ownerInfo.identifier;
      }
    }

    if (metadata.announce === true) {
      entry.announce = true;
    }

    if (Number.isFinite(metadata.priority)) {
      entry.priority = this.#normalizeMetadataPriority(entry.priority, metadata.priority);
    }

    entry.lastUpdated = Date.now();
    entry.lastActive = Date.now();

    this.coreMetadata.set(entry.key, entry);
    this.#markCoreMetadataDirty();
    return entry;
  }

  #touchCoreMetadata(coreKey, metadata = {}) {
    const keyBuf = coreKey?.key ? coreKey.key : coreKey;
    const keyStr = toKeyString(decodeKey(keyBuf) || keyBuf);
    if (!keyStr) return null;

    const existing = this.coreMetadata.get(keyStr);
    const now = Date.now();
    if (existing) {
      existing.lastUpdated = now;
      if (Number.isFinite(metadata.priority)) {
        existing.priority = this.#normalizeMetadataPriority(existing.priority, metadata.priority);
      }
      if (metadata.announce === true) {
        existing.announce = true;
      }
      if (Number.isFinite(metadata.lastActive)) {
        const activeVal = Math.trunc(metadata.lastActive);
        if (!existing.lastActive || activeVal > existing.lastActive) {
          existing.lastActive = activeVal;
        }
      } else if (!existing.lastActive) {
        existing.lastActive = now;
      }
      this.#markCoreMetadataDirty();
      return existing;
    }

    const entry = {
      key: keyStr,
      owners: new Map(),
      identifiers: new Set(),
      primaryIdentifier: typeof metadata.identifier === 'string' ? metadata.identifier.trim() || null : null,
      firstSeen: now,
      lastUpdated: now,
      priority: this.#normalizeMetadataPriority(metadata.priority),
      announce: metadata.announce === true,
      lastActive: Number.isFinite(metadata.lastActive) ? Math.trunc(metadata.lastActive) : now
    };
    if (entry.primaryIdentifier) {
      entry.identifiers.add(entry.primaryIdentifier);
    }
    this.coreMetadata.set(keyStr, entry);
    this.#markCoreMetadataDirty();
    return entry;
  }

  #removeCoreMetadata(coreKey) {
    const keyBuf = coreKey?.key ? coreKey.key : coreKey;
    const keyStr = toKeyString(decodeKey(keyBuf) || keyBuf);
    if (!keyStr) return false;
    const removed = this.coreMetadata.delete(keyStr);
    if (removed) {
      this.#markCoreMetadataDirty();
    }
    return removed;
  }

  #onBlindPeerAddCore(record, stream, context = {}) {
    if (!record?.key) return;
    const ownerPeerKey = stream?.remotePublicKey ? toKeyString(stream.remotePublicKey) : null;
    const identifier = record?.referrer ? toKeyString(record.referrer) : null;

    this.#recordCoreMetadata(record.key, {
      ownerPeerKey,
      priority: record?.priority,
      identifier,
      announce: record?.announce === true,
      type: context?.isNew ? 'new-core' : null,
      lastSeenAt: Date.now()
    });

    if (this.logger?.debug) {
      this.logger.debug('[BlindPeer] Mirror recorded', {
        key: toKeyString(record.key),
        ownerPeerKey,
        identifier,
        priority: record?.priority ?? null,
        announce: record?.announce === true,
        sourceEvent: context?.event || null
      });
    }
  }

  #onBlindPeerDeleteCore(info = {}, { stream } = {}) {
    if (!info?.key) return;
    const keyStr = toKeyString(info.key);
    this.#removeCoreMetadata(info.key);
    if (this.logger?.debug) {
      this.logger.debug('[BlindPeer] Mirror removed', {
        key: keyStr,
        ownerPeerKey: stream?.remotePublicKey ? toKeyString(stream.remotePublicKey) : null,
        existing: info?.existing ?? null
      });
    }
  }

  #collectOwnershipMap() {
    const owners = new Map();
    for (const entry of this.coreMetadata.values()) {
      const entryPriority = this.#normalizeMetadataPriority(entry.priority);
      const entryAnnounced = entry.announce === true;
      const entryLastActive = entry.lastActive || entry.lastUpdated || entry.firstSeen || Date.now();

      for (const [ownerId, ownerInfo] of entry.owners.entries()) {
        const key = ownerInfo.ownerPeerKey || ownerId;
        let owner = owners.get(key);
        if (!owner) {
          owner = {
            ownerId: key,
            peerKey: ownerInfo.ownerPeerKey || null,
            alias: ownerInfo.ownerPeerKey ? null : ownerId,
            totalCores: 0,
            announcedCount: 0,
            lastSeen: 0,
            priorityMax: null,
            priorityMin: null,
            cores: []
          };
          owners.set(key, owner);
        }

        const effectivePriority = this.#normalizeMetadataPriority(ownerInfo.priority, entryPriority);
        if (effectivePriority !== null) {
          owner.priorityMax = owner.priorityMax === null
            ? effectivePriority
            : Math.max(owner.priorityMax, effectivePriority);
          owner.priorityMin = owner.priorityMin === null
            ? effectivePriority
            : Math.min(owner.priorityMin, effectivePriority);
        }

        owner.totalCores += 1;
        if (entryAnnounced) owner.announcedCount += 1;

        const lastSeenCandidate = ownerInfo.lastSeen || entryLastActive;
        owner.lastSeen = Math.max(owner.lastSeen || 0, lastSeenCandidate || 0);

        owner.cores.push({
          key: entry.key,
          identifier: entry.primaryIdentifier || null,
          priority: effectivePriority,
          announced: entryAnnounced,
          lastActive: entryLastActive,
          lastUpdated: entry.lastUpdated || entryLastActive,
          firstSeen: entry.firstSeen || null,
          type: ownerInfo.type || null
        });
      }
    }
    return owners;
  }

  getOwnershipSnapshot({ includeCores = false, ownerLimit = 10, coresPerOwner = 0 } = {}) {
    const ownersMap = this.#collectOwnershipMap();
    const ownersArray = Array.from(ownersMap.values()).map((owner) => {
      const base = {
        peerKey: owner.peerKey,
        alias: owner.alias,
        totalCores: owner.totalCores,
        announcedCount: owner.announcedCount,
        lastSeen: owner.lastSeen || null,
        priorityMax: owner.priorityMax,
        priorityMin: owner.priorityMin,
        ownerId: owner.ownerId
      };

      if (!Number.isFinite(base.priorityMax)) base.priorityMax = null;
      if (!Number.isFinite(base.priorityMin)) base.priorityMin = null;

      if (includeCores) {
        const limit = Number.isFinite(coresPerOwner) && coresPerOwner > 0
          ? Math.trunc(coresPerOwner)
          : owner.cores.length;
        const sortedCores = owner.cores
          .slice()
          .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
        base.cores = sortedCores.slice(0, limit).map((core) => ({
          key: core.key,
          identifier: core.identifier,
          priority: core.priority,
          announced: core.announced,
          lastActive: core.lastActive || null,
          lastUpdated: core.lastUpdated || null,
          firstSeen: core.firstSeen || null,
          type: core.type
        }));
      }

      return base;
    });

    ownersArray.sort((a, b) => {
      if (b.totalCores !== a.totalCores) return b.totalCores - a.totalCores;
      return (b.lastSeen || 0) - (a.lastSeen || 0);
    });

    const limitedOwners = Number.isFinite(ownerLimit) && ownerLimit > 0
      ? ownersArray.slice(0, Math.trunc(ownerLimit))
      : ownersArray;

    const sanitizedOwners = limitedOwners.map((owner) => {
      const result = {
        peerKey: owner.peerKey,
        alias: owner.alias,
        totalCores: owner.totalCores,
        announcedCount: owner.announcedCount,
        lastSeen: owner.lastSeen,
        priorityMax: owner.priorityMax,
        priorityMin: owner.priorityMin
      };
      if (includeCores) {
        result.cores = owner.cores;
      }
      return result;
    });

    return {
      ownerCount: ownersArray.length,
      owners: sanitizedOwners
    };
  }

  getPeerMirrorSummary(peerKey, { includeCores = true, coresPerOwner = 25 } = {}) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return null;
    const ownersMap = this.#collectOwnershipMap();
    const owner = ownersMap.get(sanitized);
    if (!owner) return null;

    const result = {
      peerKey: owner.peerKey || sanitized,
      alias: owner.alias,
      totalCores: owner.totalCores,
      announcedCount: owner.announcedCount,
      lastSeen: owner.lastSeen || null,
      priorityMax: owner.priorityMax,
      priorityMin: owner.priorityMin
    };

    if (!Number.isFinite(result.priorityMax)) result.priorityMax = null;
    if (!Number.isFinite(result.priorityMin)) result.priorityMin = null;

    if (includeCores) {
      const limit = Number.isFinite(coresPerOwner) && coresPerOwner > 0
        ? Math.trunc(coresPerOwner)
        : owner.cores.length;
      const sorted = owner.cores
        .slice()
        .sort((a, b) => (b.lastActive || 0) - (a.lastActive || 0));
      result.cores = sorted.slice(0, limit).map((core) => ({
        key: core.key,
        identifier: core.identifier,
        priority: core.priority,
        announced: core.announced,
        lastActive: core.lastActive || null,
        lastUpdated: core.lastUpdated || null,
        firstSeen: core.firstSeen || null,
        type: core.type
      }));
    }

    return result;
  }

  #getHygieneSummary() {
    return {
      intervalMs: this.config.gcIntervalMs,
      running: this.hygieneRunning,
      totalRuns: this.hygieneStats.totalRuns,
      lastRunAt: this.hygieneStats.lastRunAt,
      lastDurationMs: this.hygieneStats.lastDurationMs,
      lastEvictions: this.hygieneStats.lastEvictions,
      lastBytesFreed: this.hygieneStats.lastBytesFreed,
      lastResult: this.hygieneStats.lastResult,
      lastError: this.hygieneStats.lastError
    };
  }

  async #createBlindPeer() {
    if (this.blindPeer) return this.blindPeer;
    const BlindPeer = await loadBlindPeerModule();
    const storage = await this.#ensureStorageDir();

    this.blindPeer = new BlindPeer(storage, {
      maxBytes: this.config.maxBytes,
      enableGc: true,
      trustedPubKeys: Array.from(this.trustedPeers)
    });

    this.blindPeer.on('add-core', (record, _isTrusted, stream) => {
      this.#onBlindPeerAddCore(record, stream, { event: 'add-core' });
      this.#updateMetrics();
    });
    this.blindPeer.on('add-new-core', (record, _isTrusted, stream) => {
      this.#onBlindPeerAddCore(record, stream, { event: 'add-new-core', isNew: true });
      this.#updateMetrics();
    });
    this.blindPeer.on('delete-core', (stream, info) => {
      this.#onBlindPeerDeleteCore(info, { stream });
      this.#updateMetrics();
    });
    this.blindPeer.on('gc-done', (stats) => {
      this.logger?.debug?.('[BlindPeer] Underlying daemon GC completed', {
        bytesCleared: stats?.bytesCleared ?? null
      });
      this.#updateMetrics();
    });

    if (typeof this.blindPeer.listen === 'function') {
      await this.blindPeer.listen();
    } else if (typeof this.blindPeer.ready === 'function') {
      await this.blindPeer.ready();
    }

    this.logger?.info?.('[BlindPeer] Listening', {
      publicKey: this.getPublicKeyHex(),
      encryptionKey: this.getEncryptionKeyHex()
    });

    return this.blindPeer;
  }

  async #ensureStorageDir() {
    if (!this.storageDir) {
      this.storageDir = resolve(process.cwd(), DEFAULT_STORAGE_SUBDIR);
    }
    await mkdir(this.storageDir, { recursive: true });
    return this.storageDir;
  }

  #updateMetrics() {
    const bytes = this.blindPeer?.digest?.bytesAllocated ?? 0;
    this.metrics.setBytesAllocated?.(bytes);
    this.#updateTrustedPeers();
  }

  #updateTrustedPeers() {
    this.metrics.setTrustedPeers?.(this.trustedPeers.size);
  }

  async #loadTrustedPeersFromDisk() {
    if (!this.trustedPeersPersistPath || this.trustedPeersLoaded) return;
    try {
      const raw = await readFile(this.trustedPeersPersistPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          const key = sanitizePeerKey(entry?.key);
          if (!key) continue;
          this.trustedPeers.add(key);
          const trustedSince = Number(entry?.trustedSince);
          this.trustedPeerMeta.set(key, {
            trustedSince: Number.isFinite(trustedSince) ? trustedSince : Date.now()
          });
        }
      }
      this.logger?.info?.('[BlindPeer] Loaded trusted peers from disk', {
        count: this.trustedPeers.size,
        path: this.trustedPeersPersistPath
      });
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.('[BlindPeer] Failed to load trusted peers from disk', {
          path: this.trustedPeersPersistPath,
          err: error?.message || error
        });
      }
    } finally {
      this.trustedPeersLoaded = true;
    }
  }

  async #persistTrustedPeers() {
    if (!this.trustedPeersPersistPath) return;
    const payload = this.getTrustedPeers();
    try {
      await mkdir(dirname(this.trustedPeersPersistPath), { recursive: true });
      await writeFile(
        this.trustedPeersPersistPath,
        JSON.stringify(payload, null, 2),
        'utf8'
      );
    } catch (error) {
      throw error;
    }
  }
}
