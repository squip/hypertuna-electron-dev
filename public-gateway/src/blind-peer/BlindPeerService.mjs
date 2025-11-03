import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import HypercoreId from 'hypercore-id-encoding';

const DEFAULT_STORAGE_SUBDIR = 'blind-peer-data';

async function loadBlindPeerModule() {
  const mod = await import('blind-peer');
  return mod?.default || mod;
}

function toHex(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('hex') : null;
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
    return true;
  }

  removeTrustedPeer(peerKey) {
    const sanitized = sanitizePeerKey(peerKey);
    if (!sanitized) return false;
    const removed = this.trustedPeers.delete(sanitized);
    if (removed) {
      this.logger?.debug?.('[BlindPeer] Trusted peer removed', { peerKey: sanitized });
      this.#updateTrustedPeers();
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
        key: toHex(key),
        announce: request.announce,
        priority: request.priority
      });
      this.#updateMetrics();
      return { status: 'accepted', record };
    } catch (error) {
      this.logger?.warn?.('[BlindPeer] Failed to mirror core', {
        key: toHex(key),
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
        target: toHex(targetKey),
        writers: Array.isArray(autobase.writers) ? autobase.writers.length : null
      });
      this.#updateMetrics();
      return { status: 'accepted', result };
    } catch (error) {
      this.logger?.warn?.('[BlindPeer] Failed to mirror autobase', {
        target: toHex(targetKey),
        err: error?.message || error
      });
      throw error;
    }
  }

  getPublicKeyHex() {
    return this.blindPeer ? toHex(this.blindPeer.publicKey) : null;
  }

  getEncryptionKeyHex() {
    return this.blindPeer ? toHex(this.blindPeer.encryptionPublicKey) : null;
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
}
