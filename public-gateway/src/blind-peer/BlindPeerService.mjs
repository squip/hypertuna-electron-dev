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
      setBytesAllocated: () => {}
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
    return true;
  }

  async stop() {
    if (!this.running) return;
    this.running = false;

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

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

    try {
      const record = await this.blindPeer.addCore(request);
      this.logger?.info?.('[BlindPeer] Core mirror requested', {
        key: toKeyString(key),
        announce: request.announce,
        priority: request.priority
      });
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
    try {
      const result = await this.blindPeer.addAutobase(autobase, targetKey);
      this.logger?.info?.('[BlindPeer] Autobase mirrored', {
        target: toKeyString(targetKey),
        writers: Array.isArray(autobase.writers) ? autobase.writers.length : null
      });
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

  getStatus() {
    return {
      enabled: !!this.config.enabled,
      running: this.running,
      trustedPeerCount: this.trustedPeers.size,
      storageDir: this.storageDir,
      digest: this.blindPeer?.digest || null,
      publicKey: this.getPublicKeyHex(),
      encryptionKey: this.getEncryptionKeyHex(),
      trustedPeers: this.getTrustedPeers(),
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

  async #createBlindPeer() {
    if (this.blindPeer) return this.blindPeer;
    const BlindPeer = await loadBlindPeerModule();
    const storage = await this.#ensureStorageDir();

    this.blindPeer = new BlindPeer(storage, {
      maxBytes: this.config.maxBytes,
      enableGc: true,
      trustedPubKeys: Array.from(this.trustedPeers)
    });

    this.blindPeer.on('add-core', () => this.#updateMetrics());
    this.blindPeer.on('delete-core', () => this.#updateMetrics());
    this.blindPeer.on('gc-done', () => this.#updateMetrics());

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
