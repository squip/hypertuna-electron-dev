import { EventEmitter } from 'node:events';
import Hyperswarm from 'hyperswarm';

import {
  DISCOVERY_TOPIC,
  decodeAnnouncement,
  isAnnouncementExpired,
  verifyAnnouncementSignature,
  computeSecretHash
} from '../../shared/public-gateway/GatewayDiscovery.mjs';

function normalizeUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return value.trim();
  }
}

class PublicGatewayDiscoveryClient extends EventEmitter {
  constructor({ logger, fetchImpl = globalThis.fetch?.bind(globalThis), clock = () => Date.now() } = {}) {
    super();
    if (typeof fetchImpl !== 'function') {
      throw new Error('PublicGatewayDiscoveryClient requires a fetch implementation');
    }
    this.logger = logger || console;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.swarm = null;
    this.discovery = null;
    this.cleanupTimer = null;
    this.gateways = new Map();
  }

  #positiveNumber(value) {
    const num = Number(value);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num;
  }

  #sanitizeDispatcherPolicy(existing = null, announcement = {}) {
    const policy = { ...(existing || {}) };
    const assignIfPositive = (key, value) => {
      const num = this.#positiveNumber(value);
      if (num !== null) policy[key] = num;
      else delete policy[key];
    };

    assignIfPositive('maxConcurrentJobsPerPeer', announcement.dispatcherMaxConcurrent);
    assignIfPositive('inFlightWeight', announcement.dispatcherInFlightWeight);
    assignIfPositive('latencyWeight', announcement.dispatcherLatencyWeight);
    assignIfPositive('failureWeight', announcement.dispatcherFailureWeight);
    assignIfPositive('reassignOnLagBlocks', announcement.dispatcherReassignLagBlocks);
    assignIfPositive('circuitBreakerThreshold', announcement.dispatcherCircuitBreakerThreshold);
    assignIfPositive('circuitBreakerDurationMs', announcement.dispatcherCircuitBreakerTimeoutMs);

    return Object.keys(policy).length ? policy : null;
  }

  async start() {
    if (this.swarm) return;
    this.swarm = new Hyperswarm();
    this.swarm.on('connection', (socket) => {
      this.#handleConnection(socket).catch((error) => {
        this.logger?.warn?.('[PublicGatewayDiscovery] Connection handling failed', {
          error: error?.message || error
        });
      });
    });
    this.swarm.on('error', (error) => {
      this.logger?.warn?.('[PublicGatewayDiscovery] Hyperswarm error', {
        error: error?.message || error
      });
    });
    this.discovery = this.swarm.join(DISCOVERY_TOPIC, { server: false, client: true });
    await this.discovery.flushed();
    this.cleanupTimer = setInterval(() => {
      this.#cleanupExpired();
    }, 30_000).unref();
    this.logger?.info?.('[PublicGatewayDiscovery] Discovery client started');
  }

  async stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.discovery) {
      try {
        await this.discovery.destroy?.();
      } catch (error) {
        this.logger?.debug?.('[PublicGatewayDiscovery] Failed to destroy discovery handle', {
          error: error?.message || error
        });
      }
      this.discovery = null;
    }
    if (this.swarm) {
      try {
        await this.swarm.destroy();
      } catch (error) {
        this.logger?.debug?.('[PublicGatewayDiscovery] Failed to destroy hyperswarm instance', {
          error: error?.message || error
        });
      }
      this.swarm = null;
    }
    this.gateways.clear();
  }

  getGateways({ includeExpired = false } = {}) {
    const now = this.clock();
    const entries = [];
    for (const gateway of this.gateways.values()) {
      if (!includeExpired && this.#isExpired(gateway, now)) continue;
      entries.push(this.#formatGateway(gateway));
    }
    entries.sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
    return entries;
  }

  getGatewayById(gatewayId) {
    if (!gatewayId) return null;
    const entry = this.gateways.get(gatewayId);
    if (!entry) return null;
    if (this.#isExpired(entry, this.clock())) return null;
    return this.#formatGateway(entry);
  }

  findGatewayByUrl(url) {
    const normalized = normalizeUrl(url);
    if (!normalized) return null;
    const now = this.clock();
    for (const entry of this.gateways.values()) {
      if (entry.normalizedPublicUrl === normalized && !this.#isExpired(entry, now)) {
        return this.#formatGateway(entry);
      }
    }
    return null;
  }

  async ensureSecret(gatewayId) {
    const entry = this.gateways.get(gatewayId);
    if (!entry) throw new Error('Gateway not found');
    if (this.#isExpired(entry, this.clock())) throw new Error('Gateway announcement expired');
    await this.#ensureSecretFetched(entry);
    if (!entry.sharedSecret) throw new Error(entry.secretFetchError || 'Shared secret unavailable');
    return this.#formatGateway(entry);
  }

  async #handleConnection(socket) {
    const chunks = [];
    socket.on('data', (chunk) => {
      chunks.push(chunk);
    });
    await new Promise((resolve) => {
      socket.once('end', resolve);
      socket.once('close', resolve);
      socket.once('error', resolve);
    });
    if (!chunks.length) return;
    const buffer = Buffer.concat(chunks);
    this.#processAnnouncement(buffer).catch((error) => {
      this.logger?.warn?.('[PublicGatewayDiscovery] Failed to process announcement', {
        error: error?.message || error
      });
    });
  }

  async #processAnnouncement(buffer) {
    let announcement;
    try {
      announcement = decodeAnnouncement(buffer);
    } catch (error) {
      this.logger?.debug?.('[PublicGatewayDiscovery] Announcement decode failed', {
        error: error?.message || error
      });
      return;
    }

    if (!announcement?.gatewayId) {
      this.logger?.debug?.('[PublicGatewayDiscovery] Announcement missing gatewayId');
      return;
    }

    if (!announcement.openAccess) {
      this.logger?.debug?.('[PublicGatewayDiscovery] Gateway is restricted, skipping', {
        gatewayId: announcement.gatewayId
      });
      return;
    }

    if (!verifyAnnouncementSignature(announcement)) {
      this.logger?.warn?.('[PublicGatewayDiscovery] Invalid announcement signature', {
        gatewayId: announcement.gatewayId,
        signatureKey: announcement.signatureKey
      });
      return;
    }

    const now = this.clock();
    if (isAnnouncementExpired(announcement, now)) {
      this.logger?.debug?.('[PublicGatewayDiscovery] Announcement already expired', {
        gatewayId: announcement.gatewayId
      });
      return;
    }

    const ttlMs = Math.max(5_000, (announcement.ttl || 60) * 1000);
    const expiresAt = announcement.timestamp + ttlMs;

    const existing = this.gateways.get(announcement.gatewayId) || {};
    const normalizedPublicUrl = normalizeUrl(announcement.publicUrl);
    const needsSecretRefresh = existing.secretHash !== announcement.secretHash;

    const entry = {
      gatewayId: announcement.gatewayId,
      publicUrl: announcement.publicUrl || '',
      normalizedPublicUrl,
      wsUrl: announcement.wsUrl || '',
      secretUrl: announcement.secretUrl || '',
      displayName: announcement.displayName || '',
      region: announcement.region || '',
      sharedSecretVersion: announcement.sharedSecretVersion || '',
      signatureKey: announcement.signatureKey || '',
      ttl: announcement.ttl || 60,
      secretHash: announcement.secretHash || '',
      lastSeenAt: now,
      expiresAt,
      openAccess: true,
      sharedSecret: needsSecretRefresh ? null : existing.sharedSecret || null,
      secretFetchedAt: needsSecretRefresh ? 0 : existing.secretFetchedAt || 0,
      secretFetchError: needsSecretRefresh ? null : existing.secretFetchError || null,
      secretHashVerified: needsSecretRefresh ? false : existing.secretHashVerified || false,
      fetchPromise: existing.fetchPromise || null,
      relayHyperbeeKey: announcement.relayKey || existing.relayHyperbeeKey || '',
      relayDiscoveryKey: announcement.relayDiscoveryKey || existing.relayDiscoveryKey || '',
      relayReplicationTopic: announcement.relayReplicationTopic || existing.relayReplicationTopic || '',
      defaultTokenTtl: this.#positiveNumber(announcement.relayTokenTtl) || existing.defaultTokenTtl || null,
      tokenRefreshWindowSeconds: this.#positiveNumber(announcement.relayTokenRefreshWindow) || existing.tokenRefreshWindowSeconds || null,
      dispatcherPolicy: this.#sanitizeDispatcherPolicy(existing.dispatcherPolicy, announcement)
    };

    this.gateways.set(entry.gatewayId, entry);
    this.emit('updated', this.getGateways());

    if (entry.secretUrl && entry.secretHash && (needsSecretRefresh || !entry.sharedSecret)) {
      this.#ensureSecretFetched(entry).catch((error) => {
        this.logger?.warn?.('[PublicGatewayDiscovery] Secret fetch failed', {
          gatewayId: entry.gatewayId,
          url: entry.secretUrl,
          error: error?.message || error
        });
      });
    }
  }

  async #ensureSecretFetched(entry) {
    if (!entry.secretUrl) return;
    if (entry.fetchPromise) {
      await entry.fetchPromise;
      return;
    }

    if (entry.sharedSecret && entry.secretHashVerified) {
      const maxAge = Math.max(30_000, entry.ttl * 1000);
      if (entry.secretFetchedAt && (this.clock() - entry.secretFetchedAt) < maxAge) {
        return;
      }
    }

    entry.fetchPromise = (async () => {
      try {
        const response = await this.fetch(entry.secretUrl, {
          method: 'GET',
          headers: { accept: 'application/json' }
        });
        if (!response.ok) {
          throw new Error(`Secret fetch failed with status ${response.status}`);
        }
        const payload = await response.json();
        const sharedSecret = typeof payload?.sharedSecret === 'string' ? payload.sharedSecret.trim() : '';
        if (!sharedSecret) {
          throw new Error('Secret payload missing sharedSecret');
        }
        const hash = computeSecretHash(sharedSecret);
        if (entry.secretHash && hash !== entry.secretHash) {
          throw new Error('Secret hash mismatch');
        }
        entry.sharedSecret = sharedSecret;
        entry.secretHashVerified = hash === entry.secretHash;
        entry.secretFetchedAt = this.clock();
        entry.secretFetchError = null;
        if (typeof payload?.version === 'string' && payload.version) {
          entry.sharedSecretVersion = payload.version;
        }
        if (typeof payload?.wsUrl === 'string' && payload.wsUrl) {
          entry.wsUrl = payload.wsUrl;
        }
      } catch (error) {
        entry.sharedSecret = null;
        entry.secretFetchedAt = this.clock();
        entry.secretFetchError = error?.message || String(error);
        entry.secretHashVerified = false;
        throw error;
      } finally {
        entry.fetchPromise = null;
        this.emit('updated', this.getGateways());
      }
    })();

    await entry.fetchPromise;
  }

  #cleanupExpired() {
    const now = this.clock();
    let removed = false;
    for (const [gatewayId, entry] of this.gateways.entries()) {
      if (!this.#isExpired(entry, now)) continue;
      if (now - entry.expiresAt < (entry.ttl || 60) * 1000) continue;
      this.gateways.delete(gatewayId);
      removed = true;
    }
    if (removed) {
      this.emit('updated', this.getGateways());
    }
  }

  #isExpired(entry, now = this.clock()) {
    return !!entry.expiresAt && entry.expiresAt <= now;
  }

  #formatGateway(entry) {
    const now = this.clock();
    const expired = this.#isExpired(entry, now);
    return {
      gatewayId: entry.gatewayId,
      publicUrl: entry.publicUrl,
      wsUrl: entry.wsUrl,
      secretUrl: entry.secretUrl,
      displayName: entry.displayName || null,
      region: entry.region || null,
      sharedSecretVersion: entry.sharedSecretVersion || null,
      secretHash: entry.secretHash || null,
      sharedSecret: entry.sharedSecret || null,
      secretHashVerified: !!entry.secretHashVerified,
      secretFetchedAt: entry.secretFetchedAt || null,
      secretFetchError: entry.secretFetchError || null,
      lastSeenAt: entry.lastSeenAt || null,
      expiresAt: entry.expiresAt || null,
      ttl: entry.ttl || 60,
      signatureKey: entry.signatureKey || null,
      openAccess: true,
      relayHyperbeeKey: entry.relayHyperbeeKey || null,
      relayDiscoveryKey: entry.relayDiscoveryKey || null,
      relayReplicationTopic: entry.relayReplicationTopic || null,
      defaultTokenTtl: entry.defaultTokenTtl || null,
      tokenRefreshWindowSeconds: entry.tokenRefreshWindowSeconds || null,
      dispatcherPolicy: entry.dispatcherPolicy ? { ...entry.dispatcherPolicy } : null,
      isExpired: expired
    };
  }
}

export default PublicGatewayDiscoveryClient;
