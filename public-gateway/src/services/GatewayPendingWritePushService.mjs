import { randomBytes } from 'node:crypto';

import { forwardRequestToPeer } from '../../../shared/public-gateway/HyperswarmClient.mjs';

const BASE_RETRY_MS = 15_000;
const MAX_RETRY_MS = 300_000;
const JITTER_PCT = 0.2;

function jitterDelay(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  const jitter = 1 + ((Math.random() * 2 - 1) * JITTER_PCT);
  return Math.max(0, Math.floor(ms * jitter));
}

function toArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function buildPushId() {
  return randomBytes(8).toString('hex');
}

export default class GatewayPendingWritePushService {
  constructor({
    connectionPool,
    registrationStore,
    peerResolver,
    leaseProvider,
    metrics = {},
    logger = console
  } = {}) {
    this.connectionPool = connectionPool;
    this.registrationStore = registrationStore;
    this.peerResolver = typeof peerResolver === 'function' ? peerResolver : null;
    this.leaseProvider = typeof leaseProvider === 'function' ? leaseProvider : null;
    this.metrics = metrics || {};
    this.logger = logger || console;
    this.entries = new Map();
    this.stopped = false;
  }

  notifyPending(relayKey, metadata = {}) {
    if (!relayKey || this.stopped) return;
    const entry = this.#ensureEntry(relayKey);
    entry.pending = true;
    entry.metadataSnapshot = metadata;
    entry.pendingSince = metadata.gatewayPendingSince || metadata.gatewayPendingUpdatedAt || entry.pendingSince || Date.now();
    entry.lastMetadataUpdate = metadata.gatewayPendingUpdatedAt || Date.now();
    entry.cleared = false;
    this.entries.set(relayKey, entry);
    this.#schedulePush(relayKey, true);
  }

  notifyCleared(relayKey) {
    if (!relayKey) return;
    const entry = this.entries.get(relayKey) || this.#ensureEntry(relayKey);
    entry.cleared = true;
    entry.pending = false;
    this.entries.set(relayKey, entry);
    this.#sendCleared(relayKey, entry).catch((error) => {
      this.logger?.debug?.('[GatewayPendingWritePushService] Failed to send cleared push', {
        relayKey,
        error: error?.message || error
      });
    }).finally(() => {
      this.#clearEntry(relayKey);
    });
  }

  recordAck(relayKey) {
    const entry = this.entries.get(relayKey);
    if (!entry) return;
    if (!entry.acknowledgedAt) {
      entry.acknowledgedAt = Date.now();
      const seconds = entry.pendingSince
        ? (entry.acknowledgedAt - entry.pendingSince) / 1000
        : null;
      if (Number.isFinite(seconds) && seconds >= 0) {
        this.metrics?.observeAckDelay?.(relayKey, seconds);
      }
    }
    this.#cancelTimer(entry);
  }

  async stop() {
    this.stopped = true;
    for (const entry of this.entries.values()) {
      this.#cancelTimer(entry);
    }
    this.entries.clear();
  }

  #ensureEntry(relayKey) {
    const existing = this.entries.get(relayKey);
    if (existing) return existing;
    return {
      relayKey,
      pending: false,
      cleared: false,
      attempts: 0,
      pendingSince: null,
      lastPushAt: null,
      lastDelayMs: null,
      timer: null,
      metadataSnapshot: null,
      pushId: null,
      acknowledgedAt: null
    };
  }

  #clearEntry(relayKey) {
    const entry = this.entries.get(relayKey);
    if (!entry) return;
    this.#cancelTimer(entry);
    this.entries.delete(relayKey);
  }

  #cancelTimer(entry) {
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  #schedulePush(relayKey, immediate = false) {
    const entry = this.entries.get(relayKey);
    if (!entry || !entry.pending || this.stopped) return;
    this.#cancelTimer(entry);
    let delay;
    if (immediate) {
      delay = 0;
    } else {
      const exponent = Math.max(0, entry.attempts);
      const base = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * (2 ** exponent));
      delay = jitterDelay(base);
    }
    entry.timer = setTimeout(() => {
      this.#pushPending(relayKey).catch((error) => {
        this.logger?.debug?.('[GatewayPendingWritePushService] Pending push failed', {
          relayKey,
          error: error?.message || error
        });
      });
    }, delay);
    entry.timer?.unref?.();
    entry.lastDelayMs = delay;
  }

  async #pushPending(relayKey) {
    if (this.stopped) return;
    const entry = this.entries.get(relayKey);
    if (!entry || !entry.pending) return;

    const { registration, peers } = await this.#resolveRelay(relayKey);
    if (!registration || !registration.metadata?.gatewayPendingWrites) {
      this.logger?.debug?.('[GatewayPendingWritePushService] Pending cleared before push', { relayKey });
      this.#clearEntry(relayKey);
      return;
    }

    if (!peers.length) {
      this.logger?.debug?.('[GatewayPendingWritePushService] No peers available for pending push', { relayKey });
      this.#schedulePush(relayKey, false);
      return;
    }

    const payload = await this.#buildPayload(relayKey, registration, 'pending');
    const pushId = buildPushId();
    entry.pushId = pushId;

    const sendTasks = peers.map(async (peerKey) => {
      const ok = await this.#sendPayload(peerKey, payload, pushId);
      this.metrics?.recordPushResult?.(ok ? 'success' : 'error');
      return ok;
    });

    const results = await Promise.allSettled(sendTasks);
    const successful = results.filter((result) => result.status === 'fulfilled' && result.value === true).length;

    entry.attempts += 1;
    entry.lastPushAt = Date.now();

    if (!entry.acknowledgedAt && successful > 0) {
      // Workers still need to ack explicitly; keep retrying until they do or pending clears.
    }

    this.#schedulePush(relayKey, false);
  }

  async #sendCleared(relayKey, entry) {
    if (this.stopped) return;
    const { registration, peers } = await this.#resolveRelay(relayKey);
    if (!peers.length) return;
    const payload = await this.#buildPayload(relayKey, registration, 'cleared');
    const pushId = buildPushId();
    await Promise.allSettled(peers.map(async (peerKey) => {
      const ok = await this.#sendPayload(peerKey, payload, pushId);
      this.metrics?.recordPushResult?.(ok ? 'success' : 'error');
      return ok;
    }));
  }

  async #resolveRelay(relayKey) {
    if (this.peerResolver) {
      try {
        const result = await this.peerResolver(relayKey);
        if (result && Array.isArray(result.peers)) {
          return {
            peers: result.peers.filter(Boolean),
            registration: result.registration || null
          };
        }
      } catch (error) {
        this.logger?.debug?.('[GatewayPendingWritePushService] Peer resolver failed', {
          relayKey,
          error: error?.message || error
        });
      }
    }
    if (!this.registrationStore?.getRelay) {
      return { peers: [], registration: null };
    }
    try {
      const registration = await this.registrationStore.getRelay(relayKey);
      return { peers: [], registration };
    } catch (error) {
      this.logger?.debug?.('[GatewayPendingWritePushService] Failed to read registration', {
        relayKey,
        error: error?.message || error
      });
      return { peers: [], registration: null };
    }
  }

  async #buildPayload(relayKey, registration, state) {
    const metadata = registration?.metadata || {};
    const lease = this.leaseProvider ? this.leaseProvider(relayKey) : null;
    const pendingSince = metadata.gatewayPendingSince || metadata.gatewayPendingUpdatedAt || Date.now();
    const metadataLeaseVersion = Number.isFinite(metadata.gatewayLeaseVersion)
      ? metadata.gatewayLeaseVersion
      : null;
    const leaseVersion = Number.isFinite(lease?.leaseVersion)
      ? lease.leaseVersion
      : metadataLeaseVersion;
    const leaseActive = typeof metadata.gatewayLeaseActive === 'boolean'
      ? metadata.gatewayLeaseActive
      : (lease?.leaseActive ?? false);
    const base = {
      relayKey,
      state,
      reason: metadata.gatewayPendingReason || 'replica-write',
      types: toArray(metadata.gatewayPendingTypes),
      driveIdentifier: metadata.gatewayPendingDriveIdentifier || metadata.identifier || relayKey,
      driveVersion: metadata.gatewayDriveVersion ?? null,
      pendingSince,
      updatedAt: metadata.gatewayPendingUpdatedAt || Date.now(),
      leaseVersion: leaseVersion ?? null,
      leaseActive
    };
    if (lease) {
      base.lease = {
        leaseId: lease.leaseId || null,
        escrowId: lease.escrowId || null,
        expiresAt: lease.expiresAt || null,
        issuedAt: lease.issuedAt || null,
        releasedAt: lease.releasedAt || null,
        releasedReason: lease.releasedReason || null,
        version: lease.leaseVersion ?? null,
        status: lease.status || null
      };
    } else if (metadataLeaseVersion !== null) {
      base.lease = {
        leaseId: null,
        escrowId: null,
        expiresAt: null,
        issuedAt: null,
        releasedAt: null,
        releasedReason: null,
        version: metadataLeaseVersion,
        status: leaseActive ? 'active' : 'unknown'
      };
    }
    if (state === 'cleared') {
      base.clearedAt = Date.now();
    }
    return base;
  }

  async #sendPayload(peerKey, payload, pushId) {
    try {
      const response = await forwardRequestToPeer(
        { publicKey: peerKey },
        {
          method: 'POST',
          path: '/gateway/pending-writes',
          headers: {
            'content-type': 'application/json'
          },
          body: Buffer.from(JSON.stringify({
            pushId,
            ...payload
          }))
        },
        this.connectionPool
      );
      const status = response?.statusCode || 0;
      if (status >= 200 && status < 300) {
        this.logger?.debug?.('[GatewayPendingWritePushService] Pending push delivered', {
          relayKey: payload.relayKey,
          peerKey,
          state: payload.state
        });
        return true;
      }
      this.logger?.debug?.('[GatewayPendingWritePushService] Pending push rejected', {
        relayKey: payload.relayKey,
        peerKey,
        status
      });
      return false;
    } catch (error) {
      this.logger?.debug?.('[GatewayPendingWritePushService] Pending push failed', {
        relayKey: payload.relayKey,
        peerKey,
        error: error?.message || error
      });
      return false;
    }
  }
}
