import { EventEmitter } from 'node:events';
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
      wakeup: null
    };

    this.enabled = false;
    this.started = false;
    this.trustedMirrors = new Set();
    this.mirrorTargets = new Map();
    this.blindPeering = null;
    this.swarm = null;
    this.ownsSwarm = false;
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
      wakeup: runtime.wakeup || this.runtime.wakeup
    };

    if (!this.runtime.corestore) {
      throw new Error('[BlindPeering] Corestore instance is required to start blind peering manager');
    }

    if (!this.swarm) {
      if (runtime.swarm && typeof runtime.swarm === 'object') {
        this.swarm = runtime.swarm;
        this.ownsSwarm = false;
      } else {
        this.swarm = new Hyperswarm();
        this.ownsSwarm = true;
      }
    }

    this.blindPeering = new BlindPeering(this.swarm, this.runtime.corestore, {
      mirrors: Array.from(this.trustedMirrors),
      pick: 2
    });

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
    if (!this.started) {
      this.logger?.debug?.('[BlindPeering] refresh skipped (not started)', { reason });
      return;
    }
    this.logger?.info?.('[BlindPeering] Refresh requested', {
      reason,
      targets: this.mirrorTargets.size
    });
    try {
      await this.blindPeering?.resume?.();
    } catch (error) {
      this.logger?.warn?.('[BlindPeering] Failed to resume blind-peering activity', {
        error: error?.message || error
      });
    }
    this.emit('refresh-requested', { reason, targets: Array.from(this.mirrorTargets.values()) });
  }

  getStatus() {
    return {
      enabled: this.enabled,
      running: this.started,
      trustedMirrors: this.trustedMirrors.size,
      targets: this.mirrorTargets.size
    };
  }
}
