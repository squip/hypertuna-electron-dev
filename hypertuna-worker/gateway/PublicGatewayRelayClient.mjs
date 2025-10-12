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

    this.core.on('download', () => {
      const contiguous = typeof this.core.contiguousLength === 'number'
        ? this.core.contiguousLength
        : null;
      if (typeof contiguous === 'number') {
        this.lastDownloaded = contiguous;
        this.lastLength = typeof this.core.length === 'number' ? this.core.length : this.lastLength;
      } else {
        this.lastDownloaded += 1;
      }
    });

    this.logger?.info?.('[PublicGatewayRelayClient] Configured', {
      hyperbeeKey: this.hyperbeeKey,
      discoveryKey: this.discoveryKey
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
      return;
    }
    const stream = muxStream;
    if (this.replications.has(stream)) return;

    try {
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
      stream.once('close', cleanup);
      stream.once('end', cleanup);
      stream.once('error', cleanup);
      protocol.once('close', cleanup);
      protocol.once('destroy', cleanup);
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
  }

  async getTelemetry() {
    if (!this.core) {
      return {
        hyperbeeVersion: 0,
        hyperbeeLag: 0
      };
    }
    try {
      const info = await this.core.info().catch(() => null);
      const length = info?.length ?? (typeof this.core.length === 'number' ? this.core.length : this.lastLength);
      const contiguous = info?.contiguousLength ?? (typeof this.core.contiguousLength === 'number' ? this.core.contiguousLength : this.lastDownloaded);
      this.lastDownloaded = contiguous;
      this.lastLength = length;
      const lag = Math.max(0, length - contiguous);
      return {
        hyperbeeVersion: this.db?.version || 0,
        hyperbeeLag: lag
      };
    } catch (error) {
      this.logger?.debug?.('[PublicGatewayRelayClient] Failed to collect telemetry', {
        error: error?.message || error
      });
      return {
        hyperbeeVersion: this.db?.version || 0,
        hyperbeeLag: Math.max(0, this.lastLength - this.lastDownloaded)
      };
    }
  }
}

export default PublicGatewayRelayClient;
