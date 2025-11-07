import Corestore from 'corestore';

class AutobaseKeyEscrowAuditLog {
  constructor({ storageDir, namespace = 'autobase-escrow-audit', logger = console } = {}) {
    if (!storageDir) {
      throw new Error('AutobaseKeyEscrowAuditLog requires a storageDir');
    }
    this.storageDir = storageDir;
    this.namespace = namespace;
    this.logger = logger;
    this.store = null;
    this.core = null;
  }

  async init() {
    if (this.core) return;
    this.store = new Corestore(this.storageDir);
    await this.store.ready();
    this.core = this.store.get({ name: this.namespace, valueEncoding: 'binary' });
    await this.core.ready();
  }

  async append(event = {}) {
    if (!this.core) return null;
    const payload = {
      ...event,
      timestamp: event.timestamp || Date.now()
    };
    try {
      const buffer = Buffer.from(JSON.stringify(payload));
      const seq = await this.core.append(buffer);
      return seq;
    } catch (error) {
      this.logger?.warn?.('[EscrowAuditLog] Failed to append audit entry', {
        error: error?.message || error
      });
      return null;
    }
  }

  async tail(limit = 50) {
    if (!this.core) return [];
    const total = this.core.length || 0;
    const start = Math.max(0, total - limit);
    const entries = [];
    for (let i = start; i < total; i++) {
      try {
        const data = await this.core.get(i);
        entries.push(JSON.parse(data.toString('utf8')));
      } catch (error) {
        this.logger?.debug?.('[EscrowAuditLog] Failed to read audit entry', {
          index: i,
          error: error?.message || error
        });
      }
    }
    return entries;
  }

  async close() {
    if (this.core?.close) {
      await this.core.close();
    }
    if (this.store?.close) {
      await this.store.close();
    }
    this.core = null;
    this.store = null;
  }
}

export default AutobaseKeyEscrowAuditLog;
