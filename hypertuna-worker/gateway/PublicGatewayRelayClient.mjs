import { EventEmitter } from 'node:events';
import b4a from 'b4a';
import Hyperbee from 'hyperbee';

import { getCorestore } from '../hyperdrive-manager.mjs';

class PublicGatewayRelayClient extends EventEmitter {
  constructor({ logger = console } = {}) {
    super();
    this.logger = logger;
    this.store = null;
    this.core = null;
    this.db = null;
    this.replications = new Map();
    this.hyperbeeKey = null;
    this.discoveryKey = null;
    this.lastDownloaded = 0;
    this.lastLength = 0;
    this.lastReplicationLog = 0;
    this.lastReplicaUpdateAt = 0;
    this.replicaSnapshot = {
      length: 0,
      contiguousLength: 0,
      lag: 0,
      version: 0,
      updatedAt: 0
    };
  }

  async configure(options = {}) {
    const hyperbeeKey = options.hyperbeeKey || options.key;
    if (!hyperbeeKey || typeof hyperbeeKey !== 'string') {
      throw new Error('hyperbeeKey is required to configure relay client');
    }
    if (this.hyperbeeKey === hyperbeeKey && this.core) {
      return;
    }

    await this.close();

    const store = getCorestore();
    const key = b4a.from(hyperbeeKey, 'hex');
    this.logger?.info?.('[PublicGatewayRelayClient] Opening hypercore for public gateway relay', {
      hyperbeeKey
    });
    this.core = store.get({ key, valueEncoding: 'binary', sparse: true });
    await this.core.ready();
    this.db = new Hyperbee(this.core, { keyEncoding: 'binary', valueEncoding: 'utf-8' });
    await this.db.ready();

    this.store = store;
    this.hyperbeeKey = hyperbeeKey;
    this.discoveryKey = options.discoveryKey || b4a.toString(this.core.discoveryKey, 'hex');
    const initialLength = typeof this.core.length === 'number' ? this.core.length : 0;
    const initialContiguous = typeof this.core.contiguousLength === 'number'
      ? this.core.contiguousLength
      : initialLength;
    this.lastDownloaded = initialContiguous;
    this.lastLength = initialLength;
    this.lastReplicationLog = 0;
    this.lastReplicaUpdateAt = Date.now();
    this.replicaSnapshot = {
      length: initialLength,
      contiguousLength: initialContiguous,
      lag: Math.max(0, initialLength - initialContiguous),
      version: this.db?.version || 0,
      updatedAt: this.lastReplicaUpdateAt
    };

    this.core.on('download', (index, data) => {
      const contiguous = typeof this.core.contiguousLength === 'number'
        ? this.core.contiguousLength
        : null;
      if (typeof contiguous === 'number') {
        this.lastDownloaded = contiguous;
        this.lastLength = typeof this.core.length === 'number' ? this.core.length : this.lastLength;
        this.logger?.debug?.('[PublicGatewayRelayClient] Download progress', {
          hyperbeeKey: this.hyperbeeKey,
          contiguousLength: contiguous,
          totalLength: this.lastLength
        });
        this.lastReplicaUpdateAt = Date.now();
        this.replicaSnapshot = {
          length: this.lastLength,
          contiguousLength: contiguous,
          lag: Math.max(0, this.lastLength - contiguous),
          version: this.db?.version || 0,
          updatedAt: this.lastReplicaUpdateAt
        };
        const now = Date.now();
        if (!this.lastReplicationLog || (now - this.lastReplicationLog) >= 5000) {
          this.logger?.info?.('[PublicGatewayRelayClient] Replication sync update', {
            hyperbeeKey: this.hyperbeeKey,
            contiguousLength: contiguous,
            totalLength: this.lastLength
          });
          this.lastReplicationLog = now;
        }
      } else {
        this.lastDownloaded += 1;
      }
      if (Number.isInteger(index)) {
        this.logger?.debug?.('[PublicGatewayRelayClient] Downloaded block', {
          hyperbeeKey: this.hyperbeeKey,
          index,
          size: data?.length || 0
        });
      }
    });

    this.logger?.info?.('[PublicGatewayRelayClient] Configured', {
      hyperbeeKey: this.hyperbeeKey,
      discoveryKey: this.discoveryKey,
      contiguousLength: this.lastDownloaded,
      totalLength: this.lastLength
    });
  }

  getHyperbee() {
    return this.db;
  }

  getCore() {
    return this.core;
  }

  getHyperbeeKey() {
    return this.hyperbeeKey;
  }

  hasReplica() {
    return !!(this.core && this.db);
  }

  attachProtocol(protocol) {
    if (!this.core) {
      return;
    }

    const muxStream = protocol?.mux?.stream || protocol?.stream || protocol?.connection?.stream;
    if (!muxStream) {
      this.logger?.debug?.('[PublicGatewayRelayClient] No multiplexed stream available for protocol attachment', {
        hyperbeeKey: this.hyperbeeKey
      });
      return;
    }
    const stream = muxStream;
    if (this.replications.has(stream)) return;

    try {
      this.logger?.info?.('[PublicGatewayRelayClient] Attaching replication stream', {
        hyperbeeKey: this.hyperbeeKey,
        contiguousLength: this.lastDownloaded,
        totalLength: this.lastLength
      });
      const replication = this.core.replicate(stream, {
        live: true,
        download: true,
        upload: false
      });
      this.replications.set(stream, replication);
      const cleanup = () => {
        if (this.replications.has(stream)) {
          const repl = this.replications.get(stream);
          try {
            repl?.end?.();
            repl?.destroy?.();
          } catch (_) {}
          this.replications.delete(stream);
        }
      };
      const cleanupWithLog = (event) => {
        this.logger?.debug?.('[PublicGatewayRelayClient] Replication stream closed', {
          hyperbeeKey: this.hyperbeeKey,
          event,
          contiguousLength: this.lastDownloaded,
          totalLength: this.lastLength
        });
        cleanup();
      };
      stream.once('close', () => cleanupWithLog('close'));
      stream.once('end', () => cleanupWithLog('end'));
      stream.once('error', (err) => {
        this.logger?.warn?.('[PublicGatewayRelayClient] Replication stream error', {
          hyperbeeKey: this.hyperbeeKey,
          error: err?.message || err
        });
        cleanup();
      });
      protocol.once('close', () => cleanupWithLog('protocol-close'));
      protocol.once('destroy', () => cleanupWithLog('protocol-destroy'));

      replication.on('error', (error) => {
        this.logger?.warn?.('[PublicGatewayRelayClient] Replication error', {
          hyperbeeKey: this.hyperbeeKey,
          error: error?.message || error
        });
      });
      replication.on('close', () => {
        this.logger?.debug?.('[PublicGatewayRelayClient] Replication ended', {
          hyperbeeKey: this.hyperbeeKey
        });
      });

      this.logger?.debug?.('[PublicGatewayRelayClient] Replication stream attached', {
        hyperbeeKey: this.hyperbeeKey
      });
    } catch (error) {
      this.logger?.warn?.('[PublicGatewayRelayClient] Failed to attach protocol replication', {
        error: error?.message || error
      });
    }
  }

  async close() {
    for (const replication of this.replications.values()) {
      try {
        replication?.end?.();
        replication?.destroy?.();
      } catch (_) {}
    }
    this.replications.clear();
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
    if (this.core) {
      await this.core.close();
      this.core = null;
    }
    this.store = null;
    this.hyperbeeKey = null;
    this.discoveryKey = null;
    this.replicaSnapshot = {
      length: 0,
      contiguousLength: 0,
      lag: 0,
      version: 0,
      updatedAt: 0
    };
    this.lastReplicaUpdateAt = 0;
  }

  async getTelemetry() {
    if (!this.core) {
      return {
        hyperbeeVersion: 0,
        hyperbeeLag: 0,
        hyperbeeContiguousLength: 0,
        hyperbeeLength: 0,
        hyperbeeLastUpdatedAt: 0,
        hyperbeeKey: null,
        hyperbeeDiscoveryKey: null
      };
    }
    try {
      const info = await this.core.info().catch(() => null);
      const length = info?.length ?? (typeof this.core.length === 'number' ? this.core.length : this.lastLength);
      const contiguous = info?.contiguousLength ?? (typeof this.core.contiguousLength === 'number' ? this.core.contiguousLength : this.lastDownloaded);
      this.lastDownloaded = contiguous;
      this.lastLength = length;
      const lag = Math.max(0, length - contiguous);
      this.lastReplicaUpdateAt = Date.now();
      this.replicaSnapshot = {
        length,
        contiguousLength: contiguous,
        lag,
        version: this.db?.version || 0,
        updatedAt: this.lastReplicaUpdateAt
      };
      return {
        hyperbeeVersion: this.db?.version || 0,
        hyperbeeLag: lag,
        hyperbeeContiguousLength: contiguous,
        hyperbeeLength: length,
        hyperbeeLastUpdatedAt: this.lastReplicaUpdateAt,
        hyperbeeKey: this.hyperbeeKey,
        hyperbeeDiscoveryKey: this.discoveryKey
      };
    } catch (error) {
      this.logger?.debug?.('[PublicGatewayRelayClient] Failed to collect telemetry', {
        error: error?.message || error
      });
      return {
        hyperbeeVersion: this.db?.version || 0,
        hyperbeeLag: Math.max(0, this.lastLength - this.lastDownloaded),
        hyperbeeContiguousLength: this.lastDownloaded,
        hyperbeeLength: this.lastLength,
        hyperbeeLastUpdatedAt: this.lastReplicaUpdateAt,
        hyperbeeKey: this.hyperbeeKey,
        hyperbeeDiscoveryKey: this.discoveryKey
      };
    }
  }

  getReplicaSnapshot() {
    return {
      hyperbeeKey: this.hyperbeeKey,
      discoveryKey: this.discoveryKey,
      ...this.replicaSnapshot
    };
  }
}

export default PublicGatewayRelayClient;
