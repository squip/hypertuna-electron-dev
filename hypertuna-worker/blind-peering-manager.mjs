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
      inflight: null
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
    const keys = Array.isArray(nextSettings.blindPeerKeys)
      ? nextSettings.blindPeerKeys
      : [];
    this.trustedMirrors = new Set(keys.map(sanitizeKey).filter(Boolean));

    this.logger?.debug?.('[BlindPeering] Configuration updated', {
      enabled: this.enabled,
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
    if (relayContext.autobase) {
      try {
        this.blindPeering.addAutobaseBackground(relayContext.autobase, relayContext.target || null, {
          mirrors: Array.from(this.trustedMirrors),
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
    const identifier = sanitizeKey(relayContext.relayKey || relayContext.publicIdentifier);
    if (!identifier) return;
    const entry = {
      type: 'relay',
      identifier,
      context: relayContext,
      updatedAt: Date.now()
    };
    this.mirrorTargets.set(`relay:${identifier}`, entry);
    this.#recordMirrorMetadata(entry);
    this.logger?.debug?.('[BlindPeering] Relay mirror scheduled', {
      identifier,
      writers: Array.isArray(relayContext.coreRefs) ? relayContext.coreRefs.length : 0
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
      context: driveContext,
      updatedAt: Date.now()
    };
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
          mirrors: Array.from(this.trustedMirrors),
          priority: 1
        });
      }
      if (drive.blobs?.core) {
        this.blindPeering.addCoreBackground(drive.blobs.core, drive.blobs.core.key, {
          announce: false,
          mirrors: Array.from(this.trustedMirrors),
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

  async refreshFromBlindPeers(reason = 'startup') {
    if (this.refreshBackoff.timer) {
      clearTimeout(this.refreshBackoff.timer);
      this.refreshBackoff.timer = null;
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
      trustedMirrors: this.trustedMirrors.size,
      targets: this.mirrorTargets.size
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
      return {
        ...base,
        relayKey: context.relayKey || entry.identifier,
        publicIdentifier: context.publicIdentifier || null,
        lastWriterCount: Array.isArray(context.coreRefs) ? context.coreRefs.length : null,
        announce: !!context.announce,
        context: {
          relayKey: context.relayKey || entry.identifier,
          publicIdentifier: context.publicIdentifier || null
        }
      };
    }
    if (entry.type === 'drive') {
      const context = entry.context || {};
      return {
        ...base,
        driveKey: context.driveKey || entry.identifier,
        isPfp: !!context.isPfp,
        announce: true,
        context: {
          driveKey: context.driveKey || entry.identifier,
          isPfp: !!context.isPfp
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
    this.logger?.debug?.('[BlindPeering] Scheduling refresh retry', {
      reason,
      attempt,
      delay
    });
    this.refreshBackoff.timer = setTimeout(() => {
      this.refreshBackoff.timer = null;
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
