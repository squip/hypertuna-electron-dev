import { EventEmitter } from 'node:events';
import { mkdir } from 'node:fs/promises';
import Corestore from 'corestore';
import Hyperbee from 'hyperbee';
import b4a from 'b4a';

const DEFAULT_STATS_INTERVAL_MS = 15_000;
const DEFAULT_NAMESPACE = 'public-gateway-relay';

function hexToBuffer(hex) {
  if (!hex) return null;
  return Buffer.isBuffer(hex) ? hex : Buffer.from(hex, 'hex');
}

function safeStringify(payload) {
  try {
    return JSON.stringify(payload);
  } catch (error) {
    return JSON.stringify({ error: 'serialization-error', message: error?.message });
  }
}

export class HyperbeeRelayHost extends EventEmitter {
  constructor({ logger = console, telemetryIntervalMs = DEFAULT_STATS_INTERVAL_MS } = {}) {
    super();
    this.logger = logger;
    this.telemetryIntervalMs = telemetryIntervalMs;
    this.store = null;
    this.namespace = DEFAULT_NAMESPACE;
    this.core = null;
    this.db = null;
    this.options = null;
    this.initialized = false;
    this.started = false;
    this.statsTimer = null;
    this.telemetrySinks = new Set();
  }

  async initialize(options) {
    if (this.initialized) return;
    if (!options?.storageDir) {
      throw new Error('HyperbeeRelayHost requires a storageDir');
    }
    if (!options?.adminKeyPair?.publicKey || !options?.adminKeyPair?.secretKey) {
      throw new Error('HyperbeeRelayHost requires admin key pair');
    }

    this.options = {
      statsIntervalMs: this.telemetryIntervalMs,
      ...options
    };

    await mkdir(options.storageDir, { recursive: true });

    const adminKeyPair = {
      publicKey: hexToBuffer(options.adminKeyPair.publicKey),
      secretKey: hexToBuffer(options.adminKeyPair.secretKey)
    };

    this.namespace = options.datasetNamespace || this.namespace;

    this.store = new Corestore(options.storageDir);
    await this.store.ready();

    const coreOptions = {
      cache: true
    };

    if (adminKeyPair.secretKey) {
      coreOptions.keyPair = adminKeyPair;
    } else {
      coreOptions.name = options.datasetNamespace || this.namespace;
    }

    this.core = this.store.get(coreOptions);

    this.db = new Hyperbee(this.core, {
      keyEncoding: 'binary',
      valueEncoding: 'utf-8'
    });

    await this.db.ready();
    this.initialized = true;

    this.logger.info?.('[HyperbeeRelayHost] Initialized', {
      namespace: this.core.id,
      writable: this.db?.writable,
      key: this.getPublicKey()
    });
  }

  async start() {
    if (!this.initialized) {
      throw new Error('HyperbeeRelayHost not initialized');
    }
    if (this.started) return;
    this.started = true;
    this.#startStatsLoop();
    this.logger.info?.('[HyperbeeRelayHost] Started');
  }

  async stop() {
    if (!this.initialized) return;
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
    if (this.core) {
      await this.core.close();
      this.core = null;
    }
    if (this.store) {
      await this.store.close();
      this.store = null;
    }
    this.started = false;
    this.initialized = false;
    this.logger.info?.('[HyperbeeRelayHost] Stopped');
  }

  async applyEvent(event) {
    if (!this.started || !this.db?.writable) {
      return { id: event?.id, status: 'rejected', reason: 'host-not-writable' };
    }
    if (!event?.id) {
      return { id: null, status: 'rejected', reason: 'invalid-event' };
    }

    const key = hexToBuffer(event.id);
    if (!key) {
      return { id: event.id, status: 'rejected', reason: 'invalid-event-id' };
    }

    const payload = safeStringify(event);

    try {
      await this.db.put(key, payload);
      this.#emitTelemetry('hyperbee-append', { id: event.id, kind: event.kind, created_at: event.created_at });
      return { id: event.id, status: 'accepted' };
    } catch (error) {
      this.logger.error?.('[HyperbeeRelayHost] Failed to append event', { error: error?.message });
      this.#emitTelemetry('hyperbee-error', { id: event.id, error: error?.message || error });
      return { id: event.id, status: 'rejected', reason: error?.message || 'append-failed' };
    }
  }

  async replicateWithPeer(peer) {
    if (!this.core) {
      throw new Error('HyperbeeRelayHost core not initialized');
    }
    this.logger.debug?.('[HyperbeeRelayHost] Replication requested', { peer });
    // Placeholder for replication stream wiring; to be implemented in dispatcher phase.
  }

  async getStats() {
    if (!this.core || !this.db) {
      return {
        version: 0,
        eventCount: 0,
        replicationPeers: []
      };
    }

    await this.core.ready();
    await this.db.ready();

    const eventCount = this.core.length;

    return {
      version: this.db.version,
      eventCount,
      lastAppendAt: this.core?.header?.timestamp || null,
      replicationPeers: []
    };
  }

  registerTelemetrySink(sink) {
    if (typeof sink !== 'function') return () => {};
    this.telemetrySinks.add(sink);
    return () => {
      this.telemetrySinks.delete(sink);
    };
  }

  getPublicKey() {
    if (!this.core?.key) return null;
    return b4a.toString(this.core.key, 'hex');
  }

  getDiscoveryKey() {
    if (!this.core?.discoveryKey) return null;
    return b4a.toString(this.core.discoveryKey, 'hex');
  }

  #startStatsLoop() {
    if (this.statsTimer) return;
    const interval = this.options?.statsIntervalMs || DEFAULT_STATS_INTERVAL_MS;
    this.statsTimer = setInterval(async () => {
      try {
        const stats = await this.getStats();
        this.#emitTelemetry('replication', { stats });
      } catch (error) {
        this.logger.error?.('[HyperbeeRelayHost] Failed to collect stats', { error: error?.message });
        this.#emitTelemetry('hyperbee-error', { error: error?.message || error });
      }
    }, interval);
    this.statsTimer.unref?.();
  }

  #emitTelemetry(type, payload) {
    const event = {
      type,
      timestamp: Date.now(),
      payload
    };
    for (const sink of this.telemetrySinks) {
      try {
        sink(event);
      } catch (error) {
        this.logger.warn?.('[HyperbeeRelayHost] Telemetry sink failed', { error: error?.message });
      }
    }
    this.emit('telemetry', event);
  }
}

export default HyperbeeRelayHost;
