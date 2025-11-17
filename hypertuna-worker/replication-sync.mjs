import { getRelaySecret } from './relay-secret-store.mjs';
import { getGatewayRelayClient } from './gateway/PublicGatewayRelayClient.mjs';
import { applyReplicationEvent } from './replication-apply.mjs';
import { logWithTimestamp } from './hypertuna-relay-helper.mjs';

export default class ReplicationSyncService {
  constructor({ logger = console, syncIntervalMs = 60000, relayManager = null } = {}) {
    this.logger = logger;
    this.syncIntervalMs = syncIntervalMs;
    this.relayManager = relayManager;
    this.timers = new Map();
    this.cursors = new Map();
    this.stats = new Map(); // relayId -> { lastSyncAt, lastCount, lastDurationMs, backlogCount, lagMs, applied, duplicate, failed, decryptFailed }
  }

  start(relayId) {
    if (!relayId) return;
    if (this.timers.has(relayId)) return;
    // clear cursor to avoid stale state after restart
    if (!this.cursors.has(relayId)) {
      this.cursors.set(relayId, 0);
    }
    const timer = setInterval(() => this.sync(relayId).catch(() => {}), this.syncIntervalMs);
    timer.unref?.();
    this.timers.set(relayId, timer);
  }

  stop(relayId) {
    const t = this.timers.get(relayId);
    if (t) clearInterval(t);
    this.timers.delete(relayId);
  }

  setCursor(relayId, ts) {
    if (!relayId || !Number.isFinite(ts)) return;
    this.cursors.set(relayId, Math.max(0, Math.floor(ts)));
  }

  getCursor(relayId) {
    return this.cursors.get(relayId) || 0;
  }

  async sync(relayId) {
    const secret = getRelaySecret(relayId);
    if (!secret) return;
    const gatewayClient = getGatewayRelayClient?.();
    if (!gatewayClient || typeof gatewayClient.fetchReplicationSince !== 'function') return;
    const since = this.getCursor(relayId);
    const fetchStart = Date.now();
    const events = await gatewayClient.fetchReplicationSince(relayId, since);
    const fetchDuration = Date.now() - fetchStart;
    if (!Array.isArray(events) || !events.length) return;

    let applied = 0;
    let duplicate = 0;
    let failed = 0;
    let decryptFailed = 0;
    let maxCreated = since;

    for (const ev of events) {
      try {
        if (!ev?.id) continue;
        const created = Number(ev.created_at || 0);
        if (Number.isFinite(created)) {
          maxCreated = Math.max(maxCreated, created);
        }
        const result = await applyReplicationEvent(this.relayManager, relayId, ev);
        if (result?.status === 'applied') {
          applied += 1;
          this.setCursor(relayId, ev.created_at || since);
        } else if (result?.status === 'duplicate') {
          duplicate += 1;
        } else {
          failed += 1;
        }
      } catch (err) {
        failed += 1;
        logWithTimestamp(`[ReplicationSync] failed to apply event ${ev?.id || 'unknown'}`, err?.message || err);
      }
    }
    const now = Date.now();
    const lagMs = maxCreated > 0 ? Math.max(0, (now / 1000) - maxCreated) * 1000 : null;
    this.stats.set(relayId, {
      lastSyncAt: now,
      lastCount: events.length,
      lastDurationMs: fetchDuration,
      backlogCount: events.length,
      lagMs,
      applied,
      duplicate,
      failed,
      decryptFailed,
      cursor: this.getCursor(relayId)
    });
  }

  getStats() {
    return Array.from(this.stats.entries()).map(([relayId, s]) => ({ relayId, ...s }));
  }
}
