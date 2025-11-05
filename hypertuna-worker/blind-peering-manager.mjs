import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import Hyperswarm from 'hyperswarm';
import BlindPeering from 'blind-peering';
import HypercoreId from 'hypercore-id-encoding';

function sanitizeKey(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    HypercoreId.decode(trimmed);
    return trimmed;
  } catch (_) {
    return null;
  }
}

function normalizeCoreKey(value) {
  if (!value) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      HypercoreId.decode(trimmed);
      return trimmed;
    } catch (_) {
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        try {
          return HypercoreId.encode(Buffer.from(trimmed, 'hex'));
        } catch (_) {
          return null;
        }
      }
      return null;
    }
  }
  if (Buffer.isBuffer(value)) {
    try {
      return HypercoreId.encode(value);
    } catch (_) {
      return null;
    }
  }
  if (value instanceof Uint8Array) {
    return normalizeCoreKey(Buffer.from(value));
  }
  if (value && typeof value === 'object') {
    if (value.key) return normalizeCoreKey(value.key);
    if (value.core) return normalizeCoreKey(value.core);
  }
  return null;
}

function decodeCoreKey(value) {
  if (!value) return null;
  const candidate = typeof value === 'string' ? value.trim() : value;
  if (!candidate) return null;
  if (typeof candidate === 'string') {
    try {
      return HypercoreId.decode(candidate);
    } catch (_) {
      if (/^[0-9a-fA-F]{64}$/.test(candidate)) {
        return Buffer.from(candidate, 'hex');
      }
      return null;
    }
  }
  if (Buffer.isBuffer(candidate)) {
    return Buffer.from(candidate);
  }
  if (candidate instanceof Uint8Array) {
    return Buffer.from(candidate);
  }
  return null;
}

export default class BlindPeeringManager extends EventEmitter {
  constructor({ logger, settingsProvider } = {}) {
    super();
    this.logger = logger || console;
    this.settingsProvider = typeof settingsProvider === 'function' ? settingsProvider : () => null;

    this.runtime = {
      corestore: null,
      wakeup: null,
      swarmKeyPair: null
    };

    this.enabled = false;
    this.started = false;
    this.handshakeMirrors = new Set();
    this.manualMirrors = new Set();
    this.trustedMirrors = new Set();
    this.mirrorTargets = new Map();
    this.blindPeering = null;
    this.swarm = null;
    this.ownsSwarm = false;

    this.metadataPath = null;
    this.metadata = {
      targets: {}
    };
    this.metadataLoaded = false;
    this.metadataDirty = false;
    this.metadataSaveTimer = null;

    this.backoffConfig = {
      initialDelayMs: 1000,
      maxDelayMs: 60000,
      maxAttempts: 6
    };
    this.refreshBackoff = {
      attempt: 0,
      timer: null,
      inflight: null,
      nextDelayMs: null,
      nextReason: null,
      nextScheduledAt: null
    };
    this.rehydrationState = {
      inflight: null,
      lastResult: null,
      lastCompletedAt: null
    };
  }

  configure(settings) {
    const nextSettings = settings || this.settingsProvider();
    if (!nextSettings) {
      this.enabled = false;
      this.trustedMirrors.clear();
      return;
    }

    this.enabled = !!nextSettings.blindPeerEnabled;
    const handshakeKeys = Array.isArray(nextSettings.blindPeerKeys)
      ? nextSettings.blindPeerKeys
      : [];
    const manualKeys = Array.isArray(nextSettings.blindPeerManualKeys)
      ? nextSettings.blindPeerManualKeys
      : [];
    const sanitizedHandshake = handshakeKeys.map(sanitizeKey).filter(Boolean);
    const sanitizedManual = manualKeys.map(sanitizeKey).filter(Boolean);
    this.handshakeMirrors = new Set(sanitizedHandshake);
    this.manualMirrors = new Set(sanitizedManual);
    this.trustedMirrors = new Set([...this.handshakeMirrors, ...this.manualMirrors]);

    this.logger?.debug?.('[BlindPeering] Configuration updated', {
      enabled: this.enabled,
      handshakeKeys: this.handshakeMirrors.size,
      manualKeys: this.manualMirrors.size,
      keys: this.trustedMirrors.size
    });

    if (this.blindPeering?.setKeys) {
      this.blindPeering.setKeys(Array.from(this.trustedMirrors));
    }
  }

  async start(runtime = {}) {
    this.configure();
    if (!this.enabled) {
      this.logger?.debug?.('[BlindPeering] Start skipped (disabled)');
      return false;
    }

    this.runtime = {
      corestore: runtime.corestore || this.runtime.corestore,
      wakeup: runtime.wakeup || this.runtime.wakeup,
      swarmKeyPair: runtime.swarmKeyPair || this.runtime.swarmKeyPair || null
    };

    if (!this.runtime.corestore) {
      throw new Error('[BlindPeering] Corestore instance is required to start blind peering manager');
    }

    if (!this.swarm) {
      if (runtime.swarm && typeof runtime.swarm === 'object') {
        this.swarm = runtime.swarm;
        this.ownsSwarm = false;
      } else {
        const swarmOptions = {};
        if (this.runtime.swarmKeyPair?.publicKey && this.runtime.swarmKeyPair?.secretKey) {
          swarmOptions.keyPair = this.runtime.swarmKeyPair;
        }
        this.swarm = new Hyperswarm(swarmOptions);
        this.ownsSwarm = true;
      }
    }

    this.blindPeering = new BlindPeering(this.swarm, this.runtime.corestore, {
      mirrors: Array.from(this.trustedMirrors),
      pick: 2
    });

    await this.#loadMetadata();

    this.started = true;
    this.logger?.info?.('[BlindPeering] Manager started', {
      mirrors: this.trustedMirrors.size
    });
    this.emit('started', this.getStatus());
    return true;
  }

  async stop() {
    if (!this.started) return;
    this.started = false;
    try {
      await this.blindPeering?.close?.();
    } catch (error) {
      this.logger?.warn?.('[BlindPeering] Failed to close blind-peering instance', { error: error?.message || error });
    }
    this.blindPeering = null;

    if (this.ownsSwarm && this.swarm) {
      try {
        await this.swarm.destroy();
      } catch (error) {
        this.logger?.warn?.('[BlindPeering] Failed to destroy hyperswarm', { error: error?.message || error });
      }
    }
    this.swarm = null;
    this.ownsSwarm = false;
    if (this.metadataSaveTimer) {
      clearTimeout(this.metadataSaveTimer);
      this.metadataSaveTimer = null;
    }
    await this.#persistMetadata(true);
    this.logger?.info?.('[BlindPeering] Manager stopped');
    this.emit('stopped', this.getStatus());
  }

  markTrustedMirrors(peerKeys = []) {
    let updated = false;
    for (const key of peerKeys) {
      const sanitized = sanitizeKey(key);
      if (!sanitized) continue;
      if (!this.handshakeMirrors.has(sanitized)) {
        this.handshakeMirrors.add(sanitized);
      }
      if (!this.trustedMirrors.has(sanitized)) {
        this.trustedMirrors.add(sanitized);
        updated = true;
      }
    }
    if (updated) {
      this.logger?.debug?.('[BlindPeering] Trusted mirrors updated', {
        count: this.trustedMirrors.size
      });
      if (this.blindPeering?.setKeys) {
        this.blindPeering.setKeys(Array.from(this.trustedMirrors));
      }
      this.emit('trusted-peers-changed', Array.from(this.trustedMirrors));
    }
  }

  ensureRelayMirror(relayContext = {}) {
    if (!this.started) return;
    if (!this.blindPeering) return;

    const autobase = relayContext.autobase || null;
    let autobaseTarget = null;
    if (autobase) {
      autobaseTarget = this.#resolveAutobaseTarget(relayContext);
      if (!autobaseTarget) {
        this.logger?.warn?.('[BlindPeering] Skipping autobase mirroring (no wakeup target)', {
          identifier: relayContext.relayKey || relayContext.publicIdentifier || null
        });
      } else {
        try {
          this.blindPeering.addAutobaseBackground(autobase, autobaseTarget, {
            pick: 2,
            all: true
          });
        } catch (error) {
          this.logger?.warn?.('[BlindPeering] Failed to mirror autobase', {
            identifier: relayContext.relayKey || relayContext.publicIdentifier || null,
            error: error?.message || error
          });
        }
      }
    }
    const identifier = sanitizeKey(relayContext.relayKey || relayContext.publicIdentifier);
    if (!identifier) return;
    const entry = {
      type: 'relay',
      identifier,
      context: { ...relayContext },
      updatedAt: Date.now()
    };
    if (!entry.context.relayKey) {
      entry.context.relayKey = identifier;
    }
    if (!entry.context.identifier) {
      entry.context.identifier = identifier;
    }
    if (autobaseTarget) {
      try {
        entry.context.autobaseTarget = HypercoreId.encode(autobaseTarget);
      } catch (_) {
        entry.context.autobaseTarget = autobaseTarget.toString('hex');
      }
    }
    const coreRefs = this.#collectRelayCoreRefs(relayContext);
    if (coreRefs.length) {
      entry.coreRefs = coreRefs;
      entry.context.coreRefs = coreRefs;
    }
    this.mirrorTargets.set(`relay:${identifier}`, entry);
    this.#recordMirrorMetadata(entry);
    this.logger?.debug?.('[BlindPeering] Relay mirror scheduled', {
      identifier,
      writers: coreRefs.length
    });
    this.emit('mirror-requested', entry);
  }

  ensureHyperdriveMirror(driveContext = {}) {
    if (!this.started) return;
    if (!this.blindPeering) return;
    const identifier = sanitizeKey(driveContext.identifier || driveContext.driveKey);
    if (!identifier) return;
    const entry = {
      type: driveContext.type || 'drive',
      identifier,
      context: { ...driveContext },
      updatedAt: Date.now()
    };
    if (!entry.context.identifier) {
      entry.context.identifier = identifier;
    }
    if (!entry.context.driveKey) {
      entry.context.driveKey = identifier;
    }
    const coreRefs = this.#collectDriveCoreRefs(driveContext);
    if (coreRefs.length) {
      entry.coreRefs = coreRefs;
      entry.context.coreRefs = coreRefs;
    }
    this.mirrorTargets.set(`drive:${identifier}`, entry);
    this.#recordMirrorMetadata(entry);
    this.logger?.debug?.('[BlindPeering] Hyperdrive mirror scheduled', {
      identifier,
      pfp: !!driveContext.isPfp
    });
    this.emit('mirror-requested', entry);

    const drive = driveContext.drive || null;
    if (!drive) return;

    try {
      if (drive.core) {
        this.blindPeering.addCoreBackground(drive.core, drive.core.key, {
          announce: true,
          priority: 1
        });
      }
      if (drive.blobs?.core) {
        this.blindPeering.addCoreBackground(drive.blobs.core, drive.blobs.core.key, {
          announce: false,
          priority: 0
        });
      }
    } catch (error) {
      this.logger?.warn?.('[BlindPeering] Failed to schedule hyperdrive cores', {
        identifier,
        error: error?.message || error
      });
    }
  }

  async removeRelayMirror(relayContext = {}, { reason = 'manual' } = {}) {
    const identifier = sanitizeKey(relayContext.relayKey || relayContext.identifier || relayContext.publicIdentifier);
    if (!identifier) return false;
    const entryKey = `relay:${identifier}`;
    const entry = this.mirrorTargets.get(entryKey);
    const context = entry?.context || relayContext || {};
    const autobase = relayContext.autobase || context.autobase || null;
    const collected = new Set();
    const addKey = (candidate) => {
      const normalized = normalizeCoreKey(candidate);
      if (normalized) collected.add(normalized);
    };
    for (const key of this.#collectRelayCoreRefs({ ...context, autobase })) {
      addKey(key);
    }
    if (Array.isArray(relayContext.coreRefs)) {
      for (const key of relayContext.coreRefs) addKey(key);
    }
    if (Array.isArray(entry?.coreRefs)) {
      for (const key of entry.coreRefs) addKey(key);
    }

    if (entry) {
      this.mirrorTargets.delete(entryKey);
    }

    this.#removeMetadataEntry(entryKey);

    let deleted = 0;
    if (this.blindPeering && collected.size) {
      const operations = [];
      for (const key of collected) {
        operations.push(
          this.#deleteCoreByKey(key).then(() => {
            deleted += 1;
          }).catch((error) => {
            this.logger?.warn?.('[BlindPeering] Failed to delete mirrored relay core', {
              key,
              reason,
              err: error?.message || error
            });
          })
        );
      }
      if (operations.length) {
        await Promise.allSettled(operations);
      }
    }

    this.logger?.debug?.('[BlindPeering] Relay mirror removed', {
      identifier,
      reason,
      mirroredCores: collected.size,
      deletedCores: deleted
    });
    this.emit('mirror-removed', {
      type: 'relay',
      identifier,
      reason,
      deleted
    });
    return true;
  }

  async removeHyperdriveMirror(driveContext = {}, { reason = 'manual' } = {}) {
    const identifier = sanitizeKey(driveContext.identifier || driveContext.driveKey);
    if (!identifier) return false;
    const entryKey = `drive:${identifier}`;
    const entry = this.mirrorTargets.get(entryKey);
    const context = entry?.context || driveContext || {};
    const collected = new Set();
    const addKey = (candidate) => {
      const normalized = normalizeCoreKey(candidate);
      if (normalized) collected.add(normalized);
    };
    for (const key of this.#collectDriveCoreRefs(context)) {
      addKey(key);
    }
    if (Array.isArray(driveContext.coreRefs)) {
      for (const key of driveContext.coreRefs) addKey(key);
    }
    if (Array.isArray(entry?.coreRefs)) {
      for (const key of entry.coreRefs) addKey(key);
    }

    if (entry) {
      this.mirrorTargets.delete(entryKey);
    }

    this.#removeMetadataEntry(entryKey);

    let deleted = 0;
    if (this.blindPeering && collected.size) {
      const operations = [];
      for (const key of collected) {
        operations.push(
          this.#deleteCoreByKey(key).then(() => {
            deleted += 1;
          }).catch((error) => {
            this.logger?.warn?.('[BlindPeering] Failed to delete mirrored drive core', {
              key,
              reason,
              err: error?.message || error
            });
          })
        );
      }
      if (operations.length) {
        await Promise.allSettled(operations);
      }
    }

    const eventType = entry?.type || driveContext.type || 'drive';
    this.logger?.debug?.('[BlindPeering] Drive mirror removed', {
      identifier,
      reason,
      type: eventType,
      mirroredCores: collected.size,
      deletedCores: deleted
    });
    this.emit('mirror-removed', {
      type: eventType,
      identifier,
      reason,
      deleted
    });
    return true;
  }

  async clearAllMirrors({ reason = 'cleanup' } = {}) {
    const entries = Array.from(this.mirrorTargets.values());
    for (const entry of entries) {
      if (entry.type === 'relay') {
        await this.removeRelayMirror(
          { ...entry.context, relayKey: entry.identifier },
          { reason }
        );
      } else {
        await this.removeHyperdriveMirror(
          { ...entry.context, identifier: entry.identifier },
          { reason }
        );
      }
    }
  }

  async rehydrateMirrors({ reason = 'manual', timeoutMs = 45000 } = {}) {
    if (!this.started) {
      return { status: 'skipped', reason: 'not-started' };
    }

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      timeoutMs = 45000;
    }

    if (this.rehydrationState.inflight) {
      return this.rehydrationState.inflight;
    }

    const promise = (async () => {
      const targets = this.#collectAllMirrorCoreObjects();
      const summary = {
        status: 'ok',
        reason,
        total: targets.size,
        synced: 0,
        failed: 0
      };

      for (const [key, info] of targets) {
        const label = info.label || key;
        try {
          await this.#waitForCoreSync(info.core, timeoutMs, label);
          summary.synced += 1;
        } catch (error) {
          summary.failed += 1;
          this.logger?.warn?.('[BlindPeering] Mirror rehydration failed', {
            key,
            label,
            reason,
            err: error?.message || error
          });
        }
      }

      this.logger?.info?.('[BlindPeering] Rehydration cycle completed', summary);
      this.rehydrationState.lastResult = summary;
      this.rehydrationState.lastCompletedAt = Date.now();
      return summary;
    })();

    this.rehydrationState.inflight = promise;
    try {
      return await promise;
    } finally {
      if (this.rehydrationState.inflight === promise) {
        this.rehydrationState.inflight = null;
      }
    }
  }

  #resolveAutobaseTarget(relayContext = {}) {
    const tryDecode = (candidate) => {
      if (!candidate) return null;
      if (Buffer.isBuffer(candidate)) {
        return candidate.length === 32 ? Buffer.from(candidate) : null;
      }
      if (typeof candidate === 'string') {
        return decodeCoreKey(candidate);
      }
      if (candidate && typeof candidate === 'object') {
        if (candidate.key) return tryDecode(candidate.key);
        if (candidate.discoveryKey) return tryDecode(candidate.discoveryKey);
      }
      return null;
    };

    const pickFirst = (...candidates) => {
      for (const candidate of candidates) {
        const decoded = tryDecode(candidate);
        if (decoded && decoded.length === 32) return decoded;
      }
      return null;
    };

    const autobase = relayContext.autobase || null;
    const candidateTarget = pickFirst(
      relayContext.target,
      autobase?.wakeupCapability?.key,
      autobase?.local?.key,
      autobase?.local?.discoveryKey,
      autobase?.discoveryKey,
      autobase?.localWriter?.core?.key,
      autobase?.key,
      relayContext.relayKey,
      relayContext.publicIdentifier
    );

    return candidateTarget;
  }

  #collectRelayCoreRefs(relayContext = {}) {
    if (!relayContext) return [];
    const refs = new Set();
    if (Array.isArray(relayContext.coreRefs)) {
      for (const key of relayContext.coreRefs) {
        const normalized = normalizeCoreKey(key);
        if (normalized) refs.add(normalized);
      }
    }
    const autobase = relayContext.autobase || null;
    if (autobase) {
      const objects = this.#collectAutobaseCoreObjects(autobase);
      for (const key of objects.keys()) {
        refs.add(key);
      }
    }
    return Array.from(refs);
  }

  #collectDriveCoreRefs(driveContext = {}) {
    if (!driveContext) return [];
    const refs = new Set();
    if (Array.isArray(driveContext.coreRefs)) {
      for (const key of driveContext.coreRefs) {
        const normalized = normalizeCoreKey(key);
        if (normalized) refs.add(normalized);
      }
    }
    const drive = driveContext.drive || null;
    if (drive) {
      const objects = this.#collectDriveCoreObjects(drive, driveContext.type || 'drive');
      for (const key of objects.keys()) {
        refs.add(key);
      }
    }
    return Array.from(refs);
  }

  #collectAutobaseCoreObjects(autobase) {
    const map = new Map();
    if (!autobase) return map;

    const addWriterArray = (writers, labelPrefix) => {
      if (!Array.isArray(writers)) return;
      writers.forEach((writer, index) => {
        this.#addCoreObject(map, writer?.core || writer, `${labelPrefix}-${index}`);
      });
    };

    this.#addCoreObject(map, autobase.core, 'autobase-core');
    this.#addCoreObject(map, autobase.local?.core || autobase.local, 'autobase-local');
    addWriterArray(autobase.activeWriters, 'autobase-writer');
    addWriterArray(autobase.writers, 'autobase-writer');

    if (typeof autobase.views === 'function') {
      let index = 0;
      try {
        for (const view of autobase.views()) {
          this.#addCoreObject(map, view?.core || view, `autobase-view-${index++}`);
        }
      } catch (_) {
        // ignore iterator errors
      }
    } else if (autobase.view) {
      this.#addCoreObject(map, autobase.view?.core || autobase.view, 'autobase-view');
    }

    if (Array.isArray(autobase.viewCores)) {
      autobase.viewCores.forEach((core, index) => {
        this.#addCoreObject(map, core?.core || core, `autobase-view-${index}`);
      });
    }

    return map;
  }

  #collectDriveCoreObjects(drive, type = 'drive') {
    const map = new Map();
    if (!drive) return map;
    this.#addCoreObject(map, drive.core, `${type}-metadata`);
    this.#addCoreObject(map, drive.content?.core || drive.content, `${type}-content`);
    this.#addCoreObject(map, drive.blobs?.core || drive.blobs, `${type}-blobs`);
    this.#addCoreObject(map, drive.metadata?.core || drive.metadata, `${type}-meta`);
    return map;
  }

  #collectAllMirrorCoreObjects() {
    const map = new Map();
    for (const entry of this.mirrorTargets.values()) {
      if (entry.type === 'relay') {
        const autobase = entry.context?.autobase || null;
        if (!autobase) continue;
        const objects = this.#collectAutobaseCoreObjects(autobase);
        for (const [key, info] of objects) {
          if (!map.has(key)) {
            map.set(key, info);
          }
        }
      } else if (entry.type === 'drive' || entry.type === 'pfp-drive') {
        const drive = entry.context?.drive || null;
        if (!drive) continue;
        const objects = this.#collectDriveCoreObjects(drive, entry.type);
        for (const [key, info] of objects) {
          if (!map.has(key)) {
            map.set(key, info);
          }
        }
      }
    }
    return map;
  }

  #addCoreObject(target, candidate, label) {
    if (!candidate) return;
    const core = candidate.core && typeof candidate.core.update === 'function'
      ? candidate.core
      : candidate;
    if (!core || typeof core.update !== 'function' || !core.key) return;
    const key = normalizeCoreKey(core.key);
    if (!key || target.has(key)) return;
    target.set(key, { core, label });
  }

  async #deleteCoreByKey(key) {
    if (!this.blindPeering?.deleteCore) return false;
    const decoded = decodeCoreKey(key);
    if (!decoded) {
      throw new Error(`Invalid core key provided: ${key}`);
    }
    await this.blindPeering.deleteCore(decoded);
    return true;
  }

  #removeMetadataEntry(entryKey) {
    if (!entryKey) return;
    if (Object.prototype.hasOwnProperty.call(this.metadata.targets, entryKey)) {
      delete this.metadata.targets[entryKey];
      this.metadataDirty = true;
      this.#scheduleMetadataPersist();
    }
  }

  async #waitForCoreSync(core, timeoutMs, label) {
    if (!core || typeof core.update !== 'function') return false;
    try {
      if (typeof core.ready === 'function') {
        await this.#withTimeout(core.ready(), timeoutMs, label ? `${label}:ready` : null);
      }
    } catch (error) {
      this.logger?.debug?.('[BlindPeering] Core ready wait failed', {
        label,
        err: error?.message || error
      });
    }
    await this.#withTimeout(core.update({ wait: true }), timeoutMs, label ? `${label}:update` : null);
    return true;
  }

  async #withTimeout(promise, timeoutMs, label) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      return promise;
    }
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const message = label
              ? `Operation timed out after ${timeoutMs}ms (${label})`
              : `Operation timed out after ${timeoutMs}ms`;
            reject(new Error(message));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async refreshFromBlindPeers(reason = 'startup') {
    if (this.refreshBackoff.timer) {
      clearTimeout(this.refreshBackoff.timer);
      this.refreshBackoff.timer = null;
      this.refreshBackoff.nextDelayMs = null;
      this.refreshBackoff.nextReason = null;
      this.refreshBackoff.nextScheduledAt = null;
    }
    if (!this.started) {
      this.logger?.debug?.('[BlindPeering] refresh skipped (not started)', { reason });
      return;
    }
    if (this.refreshBackoff.inflight) {
      this.logger?.debug?.('[BlindPeering] Refresh skipped (in-flight)', { reason });
      return this.refreshBackoff.inflight;
    }
    const attempt = Math.max(0, this.refreshBackoff.attempt);
    const promise = (async () => {
      this.logger?.info?.('[BlindPeering] Refresh requested', {
        reason,
        targets: this.mirrorTargets.size,
        attempt
      });
      try {
        await this.blindPeering?.resume?.();
        this.refreshBackoff.attempt = 0;
        this.refreshBackoff.nextDelayMs = null;
        this.refreshBackoff.nextReason = null;
        this.refreshBackoff.nextScheduledAt = null;
        this.emit('refresh-requested', { reason, targets: Array.from(this.mirrorTargets.values()) });
      } catch (error) {
        const attemptNext = attempt + 1;
        this.logger?.warn?.('[BlindPeering] Failed to resume blind-peering activity', {
          error: error?.message || error,
          reason,
          attempt: attemptNext
        });
        this.refreshBackoff.attempt = attemptNext;
        this.#scheduleRefreshRetry(reason, attemptNext);
      } finally {
        this.refreshBackoff.inflight = null;
      }
    })();
    this.refreshBackoff.inflight = promise;
    return promise;
  }

  getStatus() {
    return {
      enabled: this.enabled,
      running: this.started,
      handshakeMirrors: this.handshakeMirrors.size,
      manualMirrors: this.manualMirrors.size,
      trustedMirrors: this.trustedMirrors.size,
      targets: this.mirrorTargets.size,
      refreshBackoff: {
        attempt: this.refreshBackoff.attempt,
        nextDelayMs: this.refreshBackoff.nextDelayMs,
        nextReason: this.refreshBackoff.nextReason,
        nextScheduledAt: this.refreshBackoff.nextScheduledAt
      },
      rehydration: {
        inflight: !!this.rehydrationState.inflight,
        lastCompletedAt: this.rehydrationState.lastCompletedAt || null,
        lastResult: this.rehydrationState.lastResult || null
      }
    };
  }

  setMetadataPath(path) {
    if (typeof path === 'string' && path.trim()) {
      this.metadataPath = path.trim();
    }
  }

  configureBackoff(options = {}) {
    if (Number.isFinite(options.initialDelayMs) && options.initialDelayMs > 0) {
      this.backoffConfig.initialDelayMs = Math.trunc(options.initialDelayMs);
    }
    if (Number.isFinite(options.maxDelayMs) && options.maxDelayMs > 0) {
      this.backoffConfig.maxDelayMs = Math.trunc(options.maxDelayMs);
    }
    if (Number.isFinite(options.maxAttempts) && options.maxAttempts >= 0) {
      this.backoffConfig.maxAttempts = Math.trunc(options.maxAttempts);
    }
  }

  getMirrorMetadata() {
    return {
      ...this.metadata,
      targets: { ...this.metadata.targets }
    };
  }

  async #loadMetadata() {
    if (this.metadataLoaded) return;
    if (!this.metadataPath) {
      this.metadataLoaded = true;
      return;
    }
    try {
      const raw = await readFile(this.metadataPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        if (parsed.targets && typeof parsed.targets === 'object') {
          this.metadata.targets = parsed.targets;
          for (const key of Object.keys(parsed.targets)) {
            const entry = parsed.targets[key];
            if (!entry || typeof entry !== 'object') continue;
            const targetKey = `${entry.type || 'unknown'}:${entry.identifier || key}`;
            if (!this.mirrorTargets.has(targetKey)) {
              this.mirrorTargets.set(targetKey, {
                type: entry.type || 'unknown',
                identifier: entry.identifier || key,
                context: { ...entry.context },
                updatedAt: entry.updatedAt || Date.now()
              });
            }
          }
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.logger?.warn?.('[BlindPeering] Failed to load persisted metadata', {
          path: this.metadataPath,
          err: error?.message || error
        });
      }
    } finally {
      this.metadataLoaded = true;
    }
  }

  async #persistMetadata(force = false) {
    if (!this.metadataPath) return;
    if (!force && !this.metadataDirty) return;
    try {
      await mkdir(dirname(this.metadataPath), { recursive: true });
      const payload = JSON.stringify({
        targets: this.metadata.targets
      }, null, 2);
      await writeFile(this.metadataPath, payload, 'utf8');
      this.metadataDirty = false;
    } catch (error) {
      this.logger?.warn?.('[BlindPeering] Failed to persist mirror metadata', {
        path: this.metadataPath,
        err: error?.message || error
      });
    }
  }

  #scheduleMetadataPersist() {
    if (this.metadataSaveTimer) return;
    this.metadataSaveTimer = setTimeout(() => {
      this.metadataSaveTimer = null;
      this.#persistMetadata().catch((error) => {
        this.logger?.warn?.('[BlindPeering] Metadata persist task failed', {
          err: error?.message || error
        });
      });
    }, 2000);
    this.metadataSaveTimer.unref?.();
  }

  #recordMirrorMetadata(entry) {
    if (!entry || !entry.type || !entry.identifier) return;
    const key = `${entry.type}:${entry.identifier}`;
    const payload = this.#sanitizeMetadataEntry(entry);
    if (!payload) return;
    this.metadata.targets[key] = payload;
    this.metadataDirty = true;
    this.#scheduleMetadataPersist();
  }

  #sanitizeMetadataEntry(entry) {
    const base = {
      type: entry.type,
      identifier: entry.identifier,
      updatedAt: entry.updatedAt || Date.now()
    };
    if (entry.type === 'relay') {
      const context = entry.context || {};
      const relayCoreRefs = Array.isArray(context.coreRefs)
        ? Array.from(new Set(context.coreRefs.map(normalizeCoreKey).filter(Boolean)))
        : [];
      return {
        ...base,
        relayKey: context.relayKey || entry.identifier,
        publicIdentifier: context.publicIdentifier || null,
        lastWriterCount: relayCoreRefs.length || null,
        announce: !!context.announce,
        coreRefs: relayCoreRefs,
        context: {
          relayKey: context.relayKey || entry.identifier,
          publicIdentifier: context.publicIdentifier || null,
          coreRefs: relayCoreRefs
        }
      };
    }
    if (entry.type === 'drive') {
      const context = entry.context || {};
      const driveCoreRefs = Array.isArray(context.coreRefs)
        ? Array.from(new Set(context.coreRefs.map(normalizeCoreKey).filter(Boolean)))
        : [];
      return {
        ...base,
        driveKey: context.driveKey || entry.identifier,
        isPfp: !!context.isPfp,
        announce: true,
        coreRefs: driveCoreRefs,
        context: {
          driveKey: context.driveKey || entry.identifier,
          isPfp: !!context.isPfp,
          coreRefs: driveCoreRefs
        }
      };
    }
    return {
      ...base,
      context: {}
    };
  }

  #scheduleRefreshRetry(reason, attempt) {
    if (attempt > this.backoffConfig.maxAttempts) {
      this.logger?.warn?.('[BlindPeering] Refresh backoff aborted after max attempts', {
        reason,
        attempt
      });
      return;
    }
    if (this.refreshBackoff.timer) return;
    const delay = this.#calculateBackoffDelay(attempt);
    this.refreshBackoff.nextDelayMs = delay;
    this.refreshBackoff.nextReason = reason;
    this.refreshBackoff.nextScheduledAt = Date.now() + delay;
    this.logger?.debug?.('[BlindPeering] Scheduling refresh retry', {
      reason,
      attempt,
      delay
    });
    this.refreshBackoff.timer = setTimeout(() => {
      this.refreshBackoff.timer = null;
      this.refreshBackoff.nextDelayMs = null;
      this.refreshBackoff.nextReason = null;
      this.refreshBackoff.nextScheduledAt = null;
      this.refreshFromBlindPeers(reason).catch((error) => {
        this.logger?.warn?.('[BlindPeering] Scheduled refresh failed', {
          err: error?.message || error,
          reason
        });
      });
    }, delay);
    this.refreshBackoff.timer.unref?.();
  }

  #calculateBackoffDelay(attempt) {
    if (attempt <= 0) return this.backoffConfig.initialDelayMs;
    const factor = 2 ** Math.max(0, attempt - 1);
    const delay = this.backoffConfig.initialDelayMs * factor;
    return Math.min(delay, this.backoffConfig.maxDelayMs);
  }
}
