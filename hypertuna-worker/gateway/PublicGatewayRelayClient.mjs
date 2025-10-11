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
    this.lastDownloaded = await this.core.downloaded().catch(() => 0);
    this.lastLength = this.core.length;

    this.core.on('download', () => {
      this.lastDownloaded += 1;
    });

    this.logger?.info?.('[PublicGatewayRelayClient] Configured', {
      hyperbeeKey: this.hyperbeeKey,
      discoveryKey: this.discoveryKey
    });
  }

  attachProtocol(protocol) {
    if (!this.core || !protocol?.mux?.stream) {
      return;
    }
    const stream = protocol.mux.stream;
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
      const downloaded = await this.core.downloaded();
      const length = this.core.length;
      this.lastDownloaded = downloaded;
      this.lastLength = length;
      const lag = Math.max(0, length - downloaded);
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
