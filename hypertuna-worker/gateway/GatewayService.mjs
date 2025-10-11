import express from 'express';
import WebSocket from 'ws';
import url from 'node:url';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

import LocalGatewayServer from './LocalGatewayServer.mjs';
import {
  EnhancedHyperswarmPool,
  checkPeerHealthWithHyperswarm,
  forwardRequestToPeer,
  forwardMessageToPeerHyperswarm,
  getEventsFromPeerHyperswarm,
  forwardJoinRequestToPeer,
  forwardCallbackToPeer,
  requestFileFromPeer,
  requestPfpFromPeer
} from './HyperswarmClient.mjs';
import PublicGatewayRegistrar from './PublicGatewayRegistrar.mjs';
import PublicGatewayDiscoveryClient from './PublicGatewayDiscoveryClient.mjs';
import { getRelayAuthStore } from '../relay-auth-store.mjs';
import { updatePublicGatewaySettings } from '../../shared/config/PublicGatewaySettings.mjs';

const MAX_LOG_ENTRIES = 500;
const DEFAULT_PORT = 8443;

class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
  }

  async enqueue(message, handler) {
    this.queue.push({ message, handler });
    if (!this.processing) {
      this.processing = true;
      while (this.queue.length) {
        const { message: msg, handler: cb } = this.queue.shift();
        try {
          await cb(msg);
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('[GatewayService] Message handler error:', error);
        }
      }
      this.processing = false;
    }
  }
}

class PeerHealthManager {
  constructor(cleanupThreshold = 5 * 60 * 1000) {
    this.healthChecks = new Map();
    this.checkLocks = new Map();
    this.failureCount = new Map();
    this.cleanupThreshold = cleanupThreshold;
    this.circuitBreakerThreshold = 3;
    this.circuitBreakerTimeout = 5 * 60 * 1000;
    this.metrics = {
      totalChecks: 0,
      failedChecks: 0,
      recoveredPeers: 0,
      lastMetricsReset: Date.now()
    };
  }

  async checkPeerHealth(peer, connectionPool) {
    if (this.checkLocks.get(peer.publicKey)) {
      return this.isPeerHealthy(peer.publicKey);
    }

    this.checkLocks.set(peer.publicKey, true);
    const now = Date.now();
    this.metrics.totalChecks++;

    try {
      if (peer.mode === 'hyperswarm') {
        const connection = connectionPool.connections.get(peer.publicKey);
        if (connection && connection.connected) {
          try {
            const isHealthy = await checkPeerHealthWithHyperswarm(peer, connectionPool);
            if (isHealthy) {
              peer.lastSeen = now;
              this.healthChecks.set(peer.publicKey, {
                lastCheck: now,
                status: 'healthy',
                responseTime: Date.now() - now
              });

              if (this.failureCount.get(peer.publicKey)) {
                this.metrics.recoveredPeers++;
                this.failureCount.delete(peer.publicKey);
              }
              return true;
            }
          } catch (_) {
            // fall through to full check
          }
        }
      }

      const healthy = await checkPeerHealthWithHyperswarm(peer, connectionPool);
      if (healthy) {
        peer.lastSeen = now;
        this.healthChecks.set(peer.publicKey, {
          lastCheck: now,
          status: 'healthy',
          responseTime: Date.now() - now
        });
        this.failureCount.delete(peer.publicKey);
        return true;
      }

      await this.recordFailure(peer.publicKey);
      return false;
    } catch (error) {
      this.healthChecks.set(peer.publicKey, {
        lastCheck: now,
        status: 'unhealthy',
        error: error.message
      });
      await this.recordFailure(peer.publicKey);
      return false;
    } finally {
      this.checkLocks.delete(peer.publicKey);
    }
  }

  async recordFailure(publicKey) {
    const failures = (this.failureCount.get(publicKey) || 0) + 1;
    this.failureCount.set(publicKey, failures);

    if (failures >= this.circuitBreakerThreshold) {
      this.healthChecks.set(publicKey, {
        ...(this.healthChecks.get(publicKey) || {}),
        status: 'circuit-broken',
        circuitBroken: true,
        circuitBrokenAt: Date.now()
      });
    }
  }

  isPeerHealthy(publicKey) {
    const check = this.healthChecks.get(publicKey);
    if (!check) return false;

    const now = Date.now();
    if (check.circuitBroken) {
      if (now - (check.circuitBrokenAt || 0) > this.circuitBreakerTimeout) {
        check.circuitBroken = false;
        check.circuitBrokenAt = null;
        this.healthChecks.set(publicKey, check);
        return true;
      }
      return false;
    }

    return check.status === 'healthy' && (now - check.lastCheck) < this.cleanupThreshold;
  }
}

function generateConnectionKey() {
  return crypto.randomBytes(16).toString('hex');
}

export class GatewayService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.server = null;
    this.wss = null;
    this.app = null;
    this.gatewayServer = null;
    this.connectionPool = new EnhancedHyperswarmPool({
      onProtocol: this._onProtocolCreated.bind(this),
      onHandshake: this._onProtocolHandshake.bind(this),
      onTelemetry: this._onPeerTelemetry.bind(this)
    });
    this.peerHealthManager = new PeerHealthManager();
    this.activePeers = [];
    this.activeRelays = new Map();
    this.wsConnections = new Map();
    this.messageQueues = new Map();
    this.logs = [];
    this.isRunning = false;
    this.startedAt = null;
    this.config = null;
    this.healthState = {
      startTime: null,
      lastCheck: null,
      status: 'offline',
      activeRelaysCount: 0,
      metrics: {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        lastMetricsReset: Date.now()
      },
      services: {
        hyperswarmStatus: 'disconnected',
        protocolStatus: 'disconnected',
        gatewayStatus: 'offline'
      }
    };
    this.healthInterval = null;
    this.eventCheckTimers = new Map();
    this.pfpOwnerIndex = new Map(); // owner -> Set<peerPublicKey>
    this.pfpDriveKeys = new Map(); // peerPublicKey -> driveKey
    this.peerHandshakes = new Map();
    this.loggerBridge = null;
    this.publicGatewaySettings = this.#normalizePublicGatewayConfig(options.publicGateway);
    this.publicGatewayRegistrar = null;
    this.publicGatewayRelayState = new Map();
    this.publicGatewayRelayTokens = new Map();
    this.publicGatewayRelayTokenTimers = new Map();
    this.gatewayTelemetryTimers = new Map();
    this.publicGatewayRelayClient = new PublicGatewayRelayClient();
    this.publicGatewayWsBase = null;
    this.publicGatewayStatusUpdatedAt = null;
    this.discoveredGateways = [];
    this.discoveryDisabledReason = null;
    this.discoveryWarning = null;
    this.discoveryClient = null;
    this.discoveryClientReady = null;
    this._discoveryRefreshScheduled = false;
    this.getCurrentPubkey = typeof options.getCurrentPubkey === 'function'
      ? options.getCurrentPubkey
      : () => options.currentPubkey || null;

    this.#configurePublicGateway();
  }

  #normalizePublicGatewayConfig(rawConfig = {}) {
    const envEnabled = process.env.PUBLIC_GATEWAY_ENABLED === 'true';
    const envBaseUrl = (process.env.PUBLIC_GATEWAY_URL || '').trim();
    const envSecret = (process.env.PUBLIC_GATEWAY_SECRET || '').trim();
    const envTtl = Number(process.env.PUBLIC_GATEWAY_DEFAULT_TOKEN_TTL);

    const ttlCandidate = rawConfig?.defaultTokenTtl ?? (Number.isFinite(envTtl) ? envTtl : undefined);
    const ttlNumber = Number(ttlCandidate);
    const defaultTokenTtl = Number.isFinite(ttlNumber) && ttlNumber > 0 ? Math.round(ttlNumber) : 3600;

    const refreshCandidate = rawConfig?.tokenRefreshWindowSeconds ?? Number(process.env.PUBLIC_GATEWAY_TOKEN_REFRESH_WINDOW);
    const refreshNumber = Number(refreshCandidate);
    const tokenRefreshWindowSeconds = Number.isFinite(refreshNumber) && refreshNumber > 0
      ? Math.round(refreshNumber)
      : 300;

    const selectionRaw = typeof rawConfig?.selectionMode === 'string'
      ? rawConfig.selectionMode.trim().toLowerCase()
      : '';
    const selectionMode = ['default', 'discovered', 'manual'].includes(selectionRaw)
      ? selectionRaw
      : '';

    const config = {
      enabled: rawConfig?.enabled ?? envEnabled,
      selectionMode,
      selectedGatewayId: typeof rawConfig?.selectedGatewayId === 'string'
        ? rawConfig.selectedGatewayId.trim() || null
        : null,
      baseUrl: typeof rawConfig?.baseUrl === 'string' ? rawConfig.baseUrl.trim() : '',
      sharedSecret: typeof rawConfig?.sharedSecret === 'string' ? rawConfig.sharedSecret.trim() : '',
      preferredBaseUrl: typeof rawConfig?.preferredBaseUrl === 'string'
        ? rawConfig.preferredBaseUrl.trim()
        : '',
      defaultTokenTtl,
      tokenRefreshWindowSeconds,
      resolvedGatewayId: rawConfig?.resolvedGatewayId || null,
      resolvedSecretVersion: rawConfig?.resolvedSecretVersion || null,
      resolvedSharedSecretHash: rawConfig?.resolvedSharedSecretHash || null,
      resolvedDisplayName: rawConfig?.resolvedDisplayName || null,
      resolvedRegion: rawConfig?.resolvedRegion || null,
      resolvedWsUrl: rawConfig?.resolvedWsUrl || null,
      resolvedAt: Number(rawConfig?.resolvedAt) || null,
      resolvedFallback: !!rawConfig?.resolvedFallback,
      resolvedFromDiscovery: !!rawConfig?.resolvedFromDiscovery,
      disabledReason: rawConfig?.disabledReason || null,
      dispatcherMaxConcurrent: this.#parsePositiveNumber(rawConfig?.dispatcherMaxConcurrent, 3),
      dispatcherInFlightWeight: this.#parsePositiveNumber(rawConfig?.dispatcherInFlightWeight, 25),
      dispatcherLatencyWeight: this.#parsePositiveNumber(rawConfig?.dispatcherLatencyWeight, 1),
      dispatcherFailureWeight: this.#parsePositiveNumber(rawConfig?.dispatcherFailureWeight, 500),
      dispatcherReassignLagBlocks: this.#parsePositiveNumber(rawConfig?.dispatcherReassignLagBlocks, 500),
      dispatcherCircuitBreakerThreshold: this.#parsePositiveNumber(rawConfig?.dispatcherCircuitBreakerThreshold, 5),
      dispatcherCircuitBreakerTimeoutMs: this.#parsePositiveNumber(rawConfig?.dispatcherCircuitBreakerTimeoutMs, 60000)
    };

    if (!config.selectionMode) {
      config.selectionMode = envSecret ? 'manual' : 'default';
    }

    if (!config.preferredBaseUrl) {
      config.preferredBaseUrl = config.baseUrl || envBaseUrl || 'https://hypertuna.com';
    }

    if (config.selectionMode === 'default') {
      config.baseUrl = config.preferredBaseUrl || envBaseUrl || 'https://hypertuna.com';
      config.selectedGatewayId = null;
    } else if (config.selectionMode === 'manual' && !config.baseUrl) {
      config.baseUrl = envBaseUrl || config.preferredBaseUrl || 'https://hypertuna.com';
    }

    if (envBaseUrl && envSecret) {
      config.enabled = true;
      config.selectionMode = 'manual';
      config.baseUrl = envBaseUrl;
      config.preferredBaseUrl = envBaseUrl;
      config.sharedSecret = envSecret;
    } else if (envSecret && config.selectionMode === 'manual' && !config.sharedSecret) {
      config.sharedSecret = envSecret;
    }

    if (!config.baseUrl && config.selectionMode !== 'default') {
      config.baseUrl = config.preferredBaseUrl || envBaseUrl || 'https://hypertuna.com';
    }

    config.enabled = !!config.enabled;
    return config;
  }

  #parsePositiveNumber(value, fallback) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return Math.round(num);
    return fallback;
  }

  #configurePublicGateway() {
    const config = this.publicGatewaySettings || { enabled: false };

    if (!this.loggerBridge) {
      this.loggerBridge = this.#createExternalLogger();
    }

    if (config.enabled && config.baseUrl && config.sharedSecret) {
      this.publicGatewayRegistrar = new PublicGatewayRegistrar({
        baseUrl: config.baseUrl,
        sharedSecret: config.sharedSecret,
        logger: this.loggerBridge
      });
      this.publicGatewayWsBase = this.#computePublicGatewayWsBase(config.baseUrl);
    } else {
      this.publicGatewayRegistrar = null;
      this.publicGatewayWsBase = null;
      this.#clearAllRelayTokens();
    }
    this.discoveryDisabledReason = config.disabledReason || null;
    if (config.disabledReason) {
      this.discoveryWarning = null;
    }
  }

  async #ensureDiscoveryClient() {
    if (!this.discoveryClient) {
      if (!this.loggerBridge) {
        this.loggerBridge = this.#createExternalLogger();
      }
      this.discoveryClient = new PublicGatewayDiscoveryClient({ logger: this.loggerBridge });
      this.discoveryClient.on('updated', (catalog) => {
        this.discoveredGateways = catalog;
        if (this.publicGatewaySettings?.enabled) {
          this.#scheduleDiscoveryConfigRefresh();
        }
        this.#emitPublicGatewayStatus();
      });
    }

    if (!this.discoveryClientReady) {
      this.discoveryClientReady = this.discoveryClient.start().catch((error) => {
        this.discoveryClientReady = null;
        this.discoveryDisabledReason = error?.message || 'Failed to start gateway discovery';
        throw error;
      });
    }

    try {
      await this.discoveryClientReady;
      this.discoveryDisabledReason = null;
      this.discoveredGateways = this.discoveryClient.getGateways({ includeExpired: true });
    } catch (error) {
      throw error;
    }
  }

  #scheduleDiscoveryConfigRefresh() {
    if (this._discoveryRefreshScheduled) {
      return;
    }
    this._discoveryRefreshScheduled = true;

    queueMicrotask(() => {
      this._discoveryRefreshScheduled = false;
      if (!this.publicGatewaySettings?.enabled) {
        return;
      }
      this.updatePublicGatewayConfig({ ...this.publicGatewaySettings }).catch((error) => {
        this.log('debug', `[PublicGateway] Discovery refresh skipped: ${error.message}`);
      });
    });
  }

  #clearRelayToken(relayKey) {
    if (!relayKey) return;
    const timer = this.publicGatewayRelayTokenTimers.get(relayKey);
    if (timer) {
      clearTimeout(timer);
      this.publicGatewayRelayTokenTimers.delete(relayKey);
    }
    this.publicGatewayRelayTokens.delete(relayKey);
    if (this.publicGatewayRelayState.has(relayKey)) {
      const current = this.publicGatewayRelayState.get(relayKey);
      if (current) {
        const next = { ...current };
        delete next.token;
        delete next.expiresAt;
        delete next.ttlSeconds;
        delete next.connectionUrl;
        delete next.tokenIssuedAt;
        this.publicGatewayRelayState.set(relayKey, next);
      }
    }
  }

  #clearAllRelayTokens() {
    for (const timer of this.publicGatewayRelayTokenTimers.values()) {
      clearTimeout(timer);
    }
    this.publicGatewayRelayTokenTimers.clear();
    this.publicGatewayRelayTokens.clear();
    for (const [relayKey, state] of this.publicGatewayRelayState.entries()) {
      if (!state) continue;
      const next = { ...state };
      delete next.token;
      delete next.expiresAt;
      delete next.ttlSeconds;
      delete next.connectionUrl;
      delete next.tokenIssuedAt;
      this.publicGatewayRelayState.set(relayKey, next);
    }
  }

  #scheduleRelayTokenRetry(relayKey) {
    if (!relayKey) return;
    const existing = this.publicGatewayRelayTokenTimers.get(relayKey);
    if (existing) {
      clearTimeout(existing);
      this.publicGatewayRelayTokenTimers.delete(relayKey);
    }
    const handle = setTimeout(() => {
      this.publicGatewayRelayTokenTimers.delete(relayKey);
      this.#refreshRelayToken(relayKey, { force: true }).catch((error) => {
        this.log('warn', `[PublicGateway] Token retry failed for ${relayKey}: ${error.message}`);
        this.#scheduleRelayTokenRetry(relayKey);
      });
    }, 30_000);
    handle.unref?.();
    this.publicGatewayRelayTokenTimers.set(relayKey, handle);
  }

  #scheduleRelayTokenRefresh(relayKey, targetTime, fallbackExpiresAt = null) {
    if (!relayKey) return;
    if (!Number.isFinite(targetTime)) return;
    const existing = this.publicGatewayRelayTokenTimers.get(relayKey);
    if (existing) {
      clearTimeout(existing);
      this.publicGatewayRelayTokenTimers.delete(relayKey);
    }
    const now = Date.now();
    let delay = targetTime - now;
    if (!Number.isFinite(delay)) {
      delay = 30_000;
    }
    if (delay <= 0) {
      const fallback = Number.isFinite(fallbackExpiresAt) ? fallbackExpiresAt : targetTime;
      delay = fallback > now ? Math.max(5_000, fallback - now - 5_000) : 5_000;
    }
    const handle = setTimeout(() => {
      this.publicGatewayRelayTokenTimers.delete(relayKey);
      this.#refreshRelayToken(relayKey, { force: true }).catch((error) => {
        this.log('warn', `[PublicGateway] Automatic token refresh failed for ${relayKey}: ${error.message}`);
        this.#scheduleRelayTokenRetry(relayKey);
      });
    }, Math.max(5_000, delay));
    handle.unref?.();
    this.publicGatewayRelayTokenTimers.set(relayKey, handle);
  }

  #resolveRelayAuth(relayKey, requestingPubkey) {
    if (!relayKey || !requestingPubkey) return null;
    const relayData = this.activeRelays.get(relayKey);
    if (!relayData) return null;

    const authStore = getRelayAuthStore();
    const candidateIdentifiers = new Set([relayKey]);

    const metadataIdentifier = relayData.metadata?.identifier;
    if (metadataIdentifier) {
      candidateIdentifiers.add(metadataIdentifier);
    }

    const metadataGatewayPath = relayData.metadata?.gatewayPath;
    if (metadataGatewayPath && typeof metadataGatewayPath === 'string') {
      const normalizedPath = this._normalizeRelayIdentifier(metadataGatewayPath);
      if (normalizedPath) {
        candidateIdentifiers.add(normalizedPath);
      }
    }

    for (const identifier of candidateIdentifiers) {
      if (!identifier) continue;
      const record = authStore.getAuthByPubkey(identifier, requestingPubkey);
      if (record) {
        return { identifier, ...record };
      }
    }

    return null;
  }

  #recordRelayToken(relayKey, info, { schedule = true } = {}) {
    if (!relayKey || !info) return;
    const storedInfo = { ...info };
    this.publicGatewayRelayTokens.set(relayKey, storedInfo);
    if (schedule) {
      const targetTime = storedInfo.refreshAfter || storedInfo.expiresAt;
      if (Number.isFinite(targetTime)) {
        this.#scheduleRelayTokenRefresh(relayKey, targetTime, storedInfo.expiresAt);
      }
    }
    const current = this.publicGatewayRelayState.get(relayKey);
    if (current) {
      const issuedAt = Number.isFinite(info.issuedAt) ? info.issuedAt : null;
      const next = {
        ...current,
        token: info.token,
        expiresAt: info.expiresAt,
        ttlSeconds: info.ttlSeconds,
        connectionUrl: info.connectionUrl,
        tokenIssuedAt: issuedAt
      };
      this.publicGatewayRelayState.set(relayKey, next);
      this.#emitPublicGatewayStatus();
    }
  }

  async #refreshRelayToken(relayKey, { force = false } = {}) {
    if (!relayKey) return;
    const state = this.publicGatewayRelayState.get(relayKey);
    const isBridgeEnabled = this.publicGatewaySettings?.enabled && this.publicGatewayRegistrar?.isEnabled?.();
    if (!isBridgeEnabled || !state || state.status !== 'registered') {
      this.#clearRelayToken(relayKey);
      this.#emitPublicGatewayStatus();
      return;
    }

    const requestingPubkey = this.getCurrentPubkey?.() || null;
    if (!requestingPubkey) {
      this.log('debug', `[PublicGateway] Skipping token refresh for ${relayKey}: no active pubkey`);
      this.#clearRelayToken(relayKey);
      this.#emitPublicGatewayStatus();
      return;
    }

    const authResolution = this.#resolveRelayAuth(relayKey, requestingPubkey);
    if (!authResolution?.token) {
      this.log('debug', `[PublicGateway] Skipping token refresh for ${relayKey}: no relay auth available`);
      this.#clearRelayToken(relayKey);
      this.#scheduleRelayTokenRetry(relayKey);
      return;
    }

    const authToken = authResolution.token;
    const existing = this.publicGatewayRelayTokens.get(relayKey);
    const now = Date.now();
    const tokenMismatch = !existing?.relayAuthToken || existing.relayAuthToken !== authToken;
    const ttlSeconds = this.publicGatewaySettings?.defaultTokenTtl || 3600;

    if (existing) {
      existing.relayAuthToken = authToken;
      this.publicGatewayRelayTokens.set(relayKey, { ...existing });
    }

    const refreshAfter = existing?.refreshAfter || existing?.expiresAt || null;

    if (!force && refreshAfter && (refreshAfter - now) > 30_000 && !tokenMismatch) {
      this.#scheduleRelayTokenRefresh(relayKey, refreshAfter, existing?.expiresAt);
      const next = {
        ...state,
        token: existing.token,
        expiresAt: existing.expiresAt,
        ttlSeconds: existing.ttlSeconds,
        connectionUrl: existing.connectionUrl,
        tokenIssuedAt: existing.issuedAt || null
      };
      this.publicGatewayRelayState.set(relayKey, next);
      this.#emitPublicGatewayStatus();
      return;
    }

    if (tokenMismatch) {
      this.log('debug', `[PublicGateway] Relay auth updated for ${relayKey}; issuing new public gateway token`);
    }

    try {
      if (existing?.token && !tokenMismatch) {
        const refreshed = await this.publicGatewayRegistrar.refreshGatewayToken(relayKey, {
          token: existing.token,
          ttlSeconds
        });
        const expiresAt = Number(refreshed?.expiresAt) || (now + ttlSeconds * 1000);
        const refreshAfterResult = Number(refreshed?.refreshAfter) || null;
        const sequence = refreshed?.sequence || existing?.sequence || null;

        const metadata = this.activeRelays.get(relayKey)?.metadata || {};
        let gatewayPath = metadata.gatewayPath || null;
        if (!gatewayPath) {
          gatewayPath = this._normalizeGatewayPath(relayKey, metadata.gatewayPath, metadata.connectionUrl);
        }
        if (!gatewayPath) {
          gatewayPath = relayKey.includes(':') ? relayKey.replace(':', '/') : relayKey;
        }
        const connectionUrl = `${this.publicGatewayWsBase}/${gatewayPath}?token=${encodeURIComponent(refreshed.token)}`;

        this.#recordRelayToken(relayKey, {
          token: refreshed.token,
          expiresAt,
          ttlSeconds,
          connectionUrl,
          baseUrl: this.publicGatewaySettings.baseUrl,
          issuedForPubkey: requestingPubkey,
          issuedAt: now,
          relayAuthToken: authToken,
          refreshAfter: refreshAfterResult,
          sequence
        }, { schedule: true });
        return;
      }

      await this.issuePublicGatewayToken(relayKey, { ttlSeconds });
    } catch (error) {
      this.log('warn', `[PublicGateway] Failed to refresh relay token for ${relayKey}: ${error.message}`);
      this.#scheduleRelayTokenRetry(relayKey);
    }
  }

  async #resolvePublicGatewayConfig(rawConfig = {}) {
    const config = this.#normalizePublicGatewayConfig(rawConfig);
    this.discoveryWarning = null;
    const previousResolved = {
      baseUrl: config.baseUrl,
      sharedSecret: config.sharedSecret,
      resolvedGatewayId: config.resolvedGatewayId,
      resolvedSecretVersion: config.resolvedSecretVersion,
      resolvedSharedSecretHash: config.resolvedSharedSecretHash,
      resolvedDisplayName: config.resolvedDisplayName,
      resolvedRegion: config.resolvedRegion,
      resolvedWsUrl: config.resolvedWsUrl,
      resolvedAt: config.resolvedAt,
      resolvedFallback: config.resolvedFallback,
      resolvedFromDiscovery: config.resolvedFromDiscovery
    };
    config.resolvedFromDiscovery = false;
    config.resolvedFallback = false;
    config.disabledReason = null;
    config.resolvedGatewayId = null;
    config.resolvedSecretVersion = null;
    config.resolvedSharedSecretHash = null;
    config.resolvedDisplayName = null;
    config.resolvedRegion = null;
    config.resolvedWsUrl = null;
    config.resolvedAt = null;

    const restorePreviousResolved = () => {
      if (config.selectionMode !== 'default') {
        return;
      }
      if (previousResolved.baseUrl != null && previousResolved.baseUrl !== '') {
        config.baseUrl = previousResolved.baseUrl;
      }
      if (previousResolved.sharedSecret != null) {
        config.sharedSecret = previousResolved.sharedSecret;
      }
      config.resolvedGatewayId = previousResolved.resolvedGatewayId || null;
      config.resolvedSecretVersion = previousResolved.resolvedSecretVersion || null;
      config.resolvedSharedSecretHash = previousResolved.resolvedSharedSecretHash || null;
      config.resolvedDisplayName = previousResolved.resolvedDisplayName || null;
      config.resolvedRegion = previousResolved.resolvedRegion || null;
      config.resolvedWsUrl = previousResolved.resolvedWsUrl || null;
      config.resolvedAt = previousResolved.resolvedAt || null;
      config.resolvedFallback = !!previousResolved.resolvedFallback;
      config.resolvedFromDiscovery = !!previousResolved.resolvedFromDiscovery;
    };

    if (!config.enabled) {
      config.baseUrl = '';
      config.sharedSecret = '';
      return config;
    }

    if (config.selectionMode === 'manual') {
      if (!config.baseUrl || !config.sharedSecret) {
        config.enabled = false;
        config.disabledReason = 'Manual configuration requires base URL and shared secret';
        config.baseUrl = '';
        config.sharedSecret = '';
      }
      return config;
    }

    try {
      await this.#ensureDiscoveryClient();
    } catch (error) {
      config.disabledReason = error?.message || 'Gateway discovery unavailable';
      restorePreviousResolved();
      return config;
    }

    const refreshCatalog = () => {
      if (this.discoveryClient) {
        this.discoveredGateways = this.discoveryClient.getGateways({ includeExpired: true });
      }
    };

    refreshCatalog();

    const ensureEntrySecret = async (entry) => {
      if (!entry) return null;
      try {
        await this.discoveryClient.ensureSecret(entry.gatewayId);
        refreshCatalog();
        return this.discoveryClient.getGatewayById(entry.gatewayId);
      } catch (error) {
        this.log('warn', `[PublicGateway] Failed to retrieve shared secret for gateway ${entry.gatewayId}: ${error.message}`);
        return null;
      }
    };

    let resolvedEntry = null;

    if (config.selectionMode === 'discovered') {
      if (!config.selectedGatewayId) {
        config.disabledReason = 'No public gateway selected';
        config.sharedSecret = '';
        return config;
      }

      const entry = this.discoveryClient.getGatewayById(config.selectedGatewayId);
      if (!entry) {
        config.disabledReason = 'Selected public gateway is offline';
        config.sharedSecret = '';
        return config;
      }

      resolvedEntry = await ensureEntrySecret(entry);
      if (!resolvedEntry || !resolvedEntry.sharedSecret) {
        config.disabledReason = entry.isExpired
          ? 'Selected public gateway advertisement expired'
          : 'Unable to retrieve shared secret for selected gateway';
        config.sharedSecret = '';
        return config;
      }
    } else {
      const preferredUrl = config.preferredBaseUrl || config.baseUrl || 'https://hypertuna.com';
      let entry = this.discoveryClient.findGatewayByUrl(preferredUrl);
      if (entry && entry.isExpired) {
        entry = null;
      }

      resolvedEntry = await ensureEntrySecret(entry);

      if (!resolvedEntry || !resolvedEntry.sharedSecret) {
        const candidates = (this.discoveryClient.getGateways() || [])
          .filter((candidate) => candidate.sharedSecret && !candidate.isExpired);
        if (candidates.length) {
          resolvedEntry = await ensureEntrySecret(candidates[0]);
          if (resolvedEntry && resolvedEntry.sharedSecret) {
            config.resolvedFallback = true;
          }
        }
      }

      if (!resolvedEntry || !resolvedEntry.sharedSecret) {
        this.discoveryWarning = 'No open public gateways available; using cached discovery state';
        this.log('debug', '[PublicGateway] Discovery catalog empty; reusing cached gateway credentials');
        restorePreviousResolved();
        return config;
      }
    }

    config.baseUrl = resolvedEntry.publicUrl || config.baseUrl || config.preferredBaseUrl;
    config.sharedSecret = resolvedEntry.sharedSecret || '';
    config.resolvedGatewayId = resolvedEntry.gatewayId;
    config.resolvedSecretVersion = resolvedEntry.sharedSecretVersion || null;
    config.resolvedSharedSecretHash = resolvedEntry.secretHash || null;
    config.resolvedDisplayName = resolvedEntry.displayName || null;
    config.resolvedRegion = resolvedEntry.region || null;
    config.resolvedWsUrl = resolvedEntry.wsUrl || null;
    config.resolvedAt = Date.now();
    config.resolvedFromDiscovery = config.selectionMode !== 'manual';
    config.disabledReason = null;

    return config;
  }

  #createExternalLogger() {
    return {
      info: (message, meta) => this.#logExternal('info', message, meta),
      warn: (message, meta) => this.#logExternal('warn', message, meta),
      error: (message, meta) => this.#logExternal('error', message, meta),
      debug: (message, meta) => this.#logExternal('debug', message, meta)
    };
  }

  #logExternal(level, message, meta) {
    const parts = ['[PublicGateway]'];
    if (message) parts.push(message);
    if (meta && Object.keys(meta).length) {
      try {
        parts.push(JSON.stringify(meta));
      } catch (_) {
        parts.push(String(meta));
      }
    }
    this.log(level, parts.join(' '));
  }

  #computePublicGatewayWsBase(baseUrl) {
    if (!baseUrl) return null;
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        this.log('warn', `[PublicGateway] Unsupported protocol for base URL: ${parsed.protocol}`);
        return null;
      }
      return parsed.toString().replace(/\/$/, '');
    } catch (error) {
      this.log('warn', `[PublicGateway] Invalid base URL: ${error.message}`);
      return null;
    }
  }

  #emitPublicGatewayStatus() {
    this.publicGatewayStatusUpdatedAt = Date.now();
    const state = this.getPublicGatewayState();
    this.emit('public-gateway-status', state);
  }

  _normalizeOwnerKey(owner) {
    if (!owner) return null;
    try {
      return owner.trim().toLowerCase();
    } catch (_) {
      return null;
    }
  }

  _addOwnerMapping(owner, peerKey) {
    const normalized = this._normalizeOwnerKey(owner);
    if (!normalized) return;
    let peers = this.pfpOwnerIndex.get(normalized);
    if (!peers) {
      peers = new Set();
      this.pfpOwnerIndex.set(normalized, peers);
    }
    peers.add(peerKey);
  }

  _removeOwnerMapping(owner, peerKey) {
    const normalized = this._normalizeOwnerKey(owner);
    if (!normalized) return;
    const peers = this.pfpOwnerIndex.get(normalized);
    if (!peers) return;
    peers.delete(peerKey);
    if (peers.size === 0) {
      this.pfpOwnerIndex.delete(normalized);
    }
  }

  _getPeersForOwner(owner) {
    const normalized = this._normalizeOwnerKey(owner);
    if (!normalized) return [];
    const peers = this.pfpOwnerIndex.get(normalized);
    return peers ? Array.from(peers) : [];
  }

  _getPeersWithPfpDrives() {
    return Array.from(this.pfpDriveKeys.keys());
  }

  _drainStream(stream) {
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      stream.on('end', done);
      stream.on('close', done);
      stream.on('error', done);
      try {
        stream.resume?.();
      } catch (_) {
        done();
      }
    });
  }

  async #syncPublicGatewayRelay(relayKey, { forceTokenRefresh = false } = {}) {
    const enabled = this.publicGatewaySettings?.enabled && this.publicGatewayRegistrar?.isEnabled?.();

    if (!enabled) {
      this.publicGatewayRelayState.delete(relayKey);
      this.#clearRelayToken(relayKey);
      this.#emitPublicGatewayStatus();
      return;
    }

    const relayData = this.activeRelays.get(relayKey);
    if (!relayData) {
      this.publicGatewayRelayState.delete(relayKey);
      this.#clearRelayToken(relayKey);
      this.#emitPublicGatewayStatus();
      return;
    }

    const peers = Array.from(relayData.peers || []);
    const metadata = relayData.metadata || {};
    const metadataCopy = metadata ? { ...metadata } : {};
    const now = Date.now();

    if (!peers.length) {
      try {
        await this.publicGatewayRegistrar.unregisterRelay(relayKey);
        this.publicGatewayRelayState.set(relayKey, {
          relayKey,
          status: 'offline',
          peerCount: 0,
          lastSyncedAt: now,
          message: 'No peers connected',
          metadata: metadataCopy,
          peers: []
        });
      } catch (error) {
        this.publicGatewayRelayState.set(relayKey, {
          relayKey,
          status: 'error',
          peerCount: 0,
          lastSyncedAt: now,
          message: error.message,
          metadata: metadataCopy,
          peers: []
        });
        this.log('warn', `[PublicGateway] Failed to unregister relay ${relayKey}: ${error.message}`);
      }
      this.#clearRelayToken(relayKey);
      this.#emitPublicGatewayStatus();
      return;
    }

    const payload = {
      peers,
      metadata: metadataCopy
    };

    try {
      const registrationResult = await this.publicGatewayRegistrar.registerRelay(relayKey, payload);
      if (!registrationResult?.success) {
        throw new Error(registrationResult?.error || 'Registration rejected by gateway');
      }
      if (registrationResult.hyperbee?.hyperbeeKey) {
        try {
          await this.publicGatewayRelayClient.configure({
            hyperbeeKey: registrationResult.hyperbee.hyperbeeKey,
            discoveryKey: registrationResult.hyperbee.discoveryKey
          });
          metadataCopy.gatewayRelay = {
            hyperbeeKey: registrationResult.hyperbee.hyperbeeKey,
            discoveryKey: registrationResult.hyperbee.discoveryKey,
            replicationTopic: registrationResult.hyperbee.replicationTopic || null
          };
          relayData.metadata = {
            ...metadata,
            gatewayRelay: metadataCopy.gatewayRelay
          };
        } catch (error) {
          this.log('warn', `[PublicGateway] Failed to configure Hyperbee relay client: ${error.message}`);
        }
      }
      const tokenInfo = this.publicGatewayRelayTokens.get(relayKey) || null;
      this.publicGatewayRelayState.set(relayKey, {
        relayKey,
        status: 'registered',
        peerCount: peers.length,
        lastSyncedAt: now,
        message: null,
        metadata: metadataCopy,
        peers,
        token: tokenInfo?.token || null,
        expiresAt: tokenInfo?.expiresAt || null,
        ttlSeconds: tokenInfo?.ttlSeconds || null,
        connectionUrl: tokenInfo?.connectionUrl || null,
        tokenIssuedAt: tokenInfo?.issuedAt || null
      });
      await this.#refreshRelayToken(relayKey, {
        force: forceTokenRefresh || !tokenInfo
      });
    } catch (error) {
      this.publicGatewayRelayState.set(relayKey, {
        relayKey,
        status: 'error',
        peerCount: peers.length,
        lastSyncedAt: now,
        message: error.message,
        metadata: metadataCopy,
        peers
      });
      this.log('warn', `[PublicGateway] Failed to sync relay ${relayKey}: ${error.message}`);
      this.#scheduleRelayTokenRetry(relayKey);
    }

    this.#emitPublicGatewayStatus();
  }

  async _fetchPfpFromPeers(owner, file) {
    const ownerPeers = owner ? this._getPeersForOwner(owner) : [];
    const generalPeers = this._getPeersWithPfpDrives().filter((peerKey) => !ownerPeers.includes(peerKey));
    const candidates = [...ownerPeers, ...generalPeers];

    if (!candidates.length) return null;

    for (const peerKey of candidates) {
      const peer = this.activePeers.find(p => p.publicKey === peerKey);
      if (!peer) continue;
      let healthy = this.peerHealthManager.isPeerHealthy(peerKey);
      if (!healthy) {
        try {
          healthy = await this.peerHealthManager.checkPeerHealth(peer, this.connectionPool);
        } catch (err) {
          this.log('warn', `PFP health check failed for peer ${peerKey.slice(0, 8)}: ${err.message}`);
          healthy = false;
        }
      }
      if (!healthy) continue;

      try {
        const stream = await requestPfpFromPeer(peer, owner || null, file, this.connectionPool);
        peer.lastSeen = Date.now();
        if ((stream.statusCode || 200) === 200) {
          return stream;
        }

        if ((stream.statusCode || 500) === 404) {
          await this._drainStream(stream);
          continue;
        }

        return stream;
      } catch (error) {
        this.log('warn', `Failed to proxy pfp from peer ${peerKey.slice(0, 8)}: ${error.message}`);
      }
    }

    return null;
  }

  async _fetchPfpFromRelay(identifier, owner, file) {
    const normalized = this._normalizeRelayIdentifier(identifier);
    if (!normalized) return null;

    const relayEntry = this.activeRelays.get(normalized);
    if (!relayEntry || !relayEntry.peers?.size) {
      return null;
    }

    const peerKeys = Array.from(relayEntry.peers);
    let encounteredNotFound = false;
    let attempted = false;

    for (const peerKey of peerKeys) {
      const peer = this.activePeers.find(p => p.publicKey === peerKey);
      if (!peer) continue;

      let healthy = this.peerHealthManager.isPeerHealthy(peerKey);
      if (!healthy) {
        try {
          healthy = await this.peerHealthManager.checkPeerHealth(peer, this.connectionPool);
        } catch (error) {
          this.log('warn', `PFP health probe failed for relay host ${peerKey.slice(0, 8)}: ${error.message}`);
          healthy = false;
        }
      }

      if (!healthy) {
        continue;
      }

      try {
        attempted = true;
        const stream = await requestPfpFromPeer(peer, owner || null, file, this.connectionPool);
        peer.lastSeen = Date.now();

        if ((stream.statusCode || 200) === 200) {
          return stream;
        }

        if ((stream.statusCode || 500) === 404) {
          encounteredNotFound = true;
        }

        await this._drainStream(stream);
      } catch (error) {
        this.log('warn', `Failed to proxy relay PFP ${file} for ${normalized} via ${peerKey.slice(0, 8)}: ${error.message}`);
      }
    }

    if (encounteredNotFound) {
      return false;
    }

    return null;
  }

  _onProtocolCreated({ publicKey, protocol, context = {} }) {
    if (!protocol) return;
    const isServer = !!context.isServer;
    if (!isServer) return;

    protocol.handle('/gateway/register', async (request) => {
      return this._handleGatewayRegisterRequest(publicKey, request);
    });
  }

  _onProtocolHandshake({ publicKey, protocol, handshake, context = {} }) {
    if (!handshake) return;
    this.peerHandshakes.set(publicKey, handshake);

    if (handshake.role === 'relay' || handshake.isGateway === false) {
      this.healthState.services.hyperswarmStatus = 'connected';
      this.healthState.services.protocolStatus = 'connected';
      this.emit('status', this.getStatus());
    }

    if (handshake.isGateway) {
      this.publicGatewayRelayClient?.attachProtocol(protocol);
      this.#startGatewayTelemetry(publicKey, protocol);
    }
  }

  _onPeerTelemetry({ publicKey, payload }) {
    if (!publicKey || !payload) return;
    this.dispatcher?.reportPeerMetrics(publicKey, {
      peerId: publicKey,
      latencyMs: Number(payload.latencyMs) || 0,
      inFlightJobs: Number(payload.inFlightJobs) || 0,
      failureRate: Number(payload.failureRate) || 0,
      hyperbeeVersion: payload.hyperbeeVersion,
      hyperbeeLag: payload.hyperbeeLag,
      queueDepth: payload.queueDepth,
      reportedAt: Number(payload.reportedAt) || Date.now()
    });
  }

  log(level, message) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      level,
      message,
      timestamp: new Date().toISOString()
    };
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) {
      this.logs.shift();
    }
    this.emit('log', entry);
  }

  async start(config = {}) {
    if (this.isRunning) {
      return;
    }

    const port = Number(config.port) || DEFAULT_PORT;
    const hostname = config.hostname || 'localhost';
    const listenHost = config.listenHost || '127.0.0.1';
    this.log('info', `Starting gateway on port ${port}`);

    global.joinSessions = global.joinSessions || new Map();

    this.app = express();
    this.app.use(express.json({ limit: '2mb' }));

    this.gatewayServer = new LocalGatewayServer({
      hostname,
      port,
      listenHost
    });

    await this.gatewayServer.init();

    this.setupRoutes();

    const { server, wss } = this.gatewayServer.startServer(
      (ws, req) => this.handleGatewayWebSocketConnection(ws, req),
      this.app,
      () => this.log('info', `Gateway listening on port ${port}`)
    );

    this.server = server;
    this.wss = wss;
    await this.connectionPool.initialize();
    this.config = {
      hostname,
      port,
      listenHost,
      urls: this.gatewayServer.getServerUrls()
    };

    this.isRunning = true;
    this.startedAt = Date.now();
    this.healthState.startTime = this.startedAt;
    this.healthState.services.gatewayStatus = 'online';
    this.healthState.services.hyperswarmStatus = 'connected';

    this.healthInterval = setInterval(() => {
      this.healthState.lastCheck = Date.now();
      this.emit('status', this.getStatus());
    }, 30000);

    this.emit('status', this.getStatus());
  }

  async stop() {
    if (!this.isRunning) return;

    this.log('info', 'Stopping gateway');

    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    for (const timer of this.eventCheckTimers.values()) {
      clearTimeout(timer);
    }
    this.eventCheckTimers.clear();

    for (const { ws } of this.wsConnections.values()) {
      try { ws.close(); } catch (_) {}
    }
    this.wsConnections.clear();

    for (const cleanup of this.gatewayTelemetryTimers.values()) {
      try {
        cleanup();
      } catch (_) {}
    }
    this.gatewayTelemetryTimers.clear();

    await this.publicGatewayRelayClient?.close?.();

    await this.connectionPool.destroy();

    if (this.wss) {
      await new Promise(resolve => this.wss.close(resolve));
      this.wss = null;
    }

    if (this.server) {
      await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }

    this.app = null;
    this.isRunning = false;
    this.startedAt = null;
    this.healthState.status = 'offline';
    this.healthState.services.gatewayStatus = 'offline';

    this.emit('status', this.getStatus());
  }

  getPublicGatewayState() {
    const relays = {};
    for (const [key, value] of this.publicGatewayRelayState.entries()) {
      relays[key] = { ...value };
    }

    const config = this.publicGatewaySettings || {};
    const enabled = !!(config.enabled && this.publicGatewayRegistrar?.isEnabled?.());

    return {
      enabled,
      selectionMode: config.selectionMode || 'default',
      selectedGatewayId: config.selectedGatewayId || null,
      preferredBaseUrl: config.preferredBaseUrl || null,
      baseUrl: enabled ? config.baseUrl || null : null,
      resolvedGatewayId: config.resolvedGatewayId || null,
      resolvedDisplayName: config.resolvedDisplayName || null,
      resolvedRegion: config.resolvedRegion || null,
      resolvedSecretVersion: config.resolvedSecretVersion || null,
      resolvedFallback: !!config.resolvedFallback,
      resolvedFromDiscovery: !!config.resolvedFromDiscovery,
      resolvedAt: config.resolvedAt || null,
      defaultTokenTtl: config.defaultTokenTtl || 3600,
      wsBase: enabled ? (config.resolvedWsUrl || this.publicGatewayWsBase) : null,
      lastUpdatedAt: this.publicGatewayStatusUpdatedAt,
      relays,
      discoveredGateways: this.discoveredGateways || [],
      discoveryUnavailableReason: this.discoveryDisabledReason,
      discoveryWarning: this.discoveryWarning,
      disabledReason: enabled ? null : (config.disabledReason || this.discoveryDisabledReason || null)
    };
  }

  async syncPublicGatewayRelay(relayKey, { forceTokenRefresh = true } = {}) {
    await this.#syncPublicGatewayRelay(relayKey, { forceTokenRefresh });
  }

  async resyncPublicGateway() {
    const enabled = this.publicGatewaySettings?.enabled && this.publicGatewayRegistrar?.isEnabled?.();
    if (!enabled) {
      this.publicGatewayRelayState.clear();
      this.#clearAllRelayTokens();
      this.#emitPublicGatewayStatus();
      return;
    }

    for (const key of this.activeRelays.keys()) {
      // Sequential resync to avoid saturating registrar
      // eslint-disable-next-line no-await-in-loop
      await this.#syncPublicGatewayRelay(key, { forceTokenRefresh: true });
    }
  }

  async updatePublicGatewayConfig(rawConfig = {}) {
    const previousSettings = this.publicGatewaySettings;
    this.publicGatewaySettings = await this.#resolvePublicGatewayConfig(rawConfig);
    this.#configurePublicGateway();

    const isEnabled = this.publicGatewaySettings?.enabled && this.publicGatewayRegistrar?.isEnabled?.();

    if (isEnabled) {
      try {
        await this.resyncPublicGateway();
      } catch (error) {
        this.log('warn', `[PublicGateway] Resync failed: ${error.message}`);
      }
    } else {
      this.publicGatewayRelayState.clear();
      this.#clearAllRelayTokens();
    }

    const previousHash = previousSettings?.resolvedSharedSecretHash || null;
    const nextHash = this.publicGatewaySettings?.resolvedSharedSecretHash || null;
    const statusChanged = Boolean(previousSettings?.enabled) !== Boolean(this.publicGatewaySettings?.enabled);
    const secretChanged = previousHash !== nextHash && nextHash !== null;

    if (statusChanged || secretChanged) {
      try {
        await updatePublicGatewaySettings(this.publicGatewaySettings);
      } catch (error) {
        this.log('warn', `[PublicGateway] Failed to persist settings: ${error.message}`);
      }
    }

    this.#emitPublicGatewayStatus();
  }

  async issuePublicGatewayToken(relayKey, options = {}) {
    if (!relayKey) {
      throw new Error('relayKey is required');
    }

    if (!this.publicGatewayRegistrar?.isEnabled?.() || !this.publicGatewaySettings?.enabled) {
      throw new Error('Public gateway bridge is disabled');
    }

    const relayData = this.activeRelays.get(relayKey);
    if (!relayData) {
      throw new Error('Relay not registered with gateway');
    }

    const requestingPubkey = this.getCurrentPubkey?.() || null;
    if (!requestingPubkey) {
      throw new Error('Unable to determine requesting pubkey for token issuance');
    }

    const authRecord = this.#resolveRelayAuth(relayKey, requestingPubkey);
    if (!authRecord) {
      throw new Error('No relay authentication token found for requesting user');
    }

    const relayAuthToken = authRecord.token;

    const ttl = Number(options?.ttlSeconds);
    const ttlSeconds = Number.isFinite(ttl) && ttl > 0
      ? Math.round(ttl)
      : this.publicGatewaySettings?.defaultTokenTtl || 3600;

    const issuedAt = Date.now();

    const tokenResponse = await this.publicGatewayRegistrar.issueGatewayToken(relayKey, {
      ttlSeconds,
      relayAuthToken,
      pubkey: requestingPubkey,
      scope: options.scope || 'relay-access'
    });

    const token = tokenResponse?.token;
    if (!token) {
      throw new Error('Gateway did not return token');
    }

    const expiresAt = Number(tokenResponse.expiresAt) || (issuedAt + ttlSeconds * 1000);
    const refreshAfter = Number(tokenResponse.refreshAfter) || null;
    const sequence = tokenResponse.sequence || null;
    const metadata = relayData.metadata || {};
    let gatewayPath = metadata.gatewayPath || null;
    if (!gatewayPath) {
      gatewayPath = this._normalizeGatewayPath(relayKey, metadata.gatewayPath, metadata.connectionUrl);
    }
    if (!gatewayPath) {
      gatewayPath = relayKey.includes(':') ? relayKey.replace(':', '/') : relayKey;
    }

    if (!this.publicGatewayWsBase) {
      throw new Error('Invalid public gateway base URL');
    }

    const connectionUrl = `${this.publicGatewayWsBase}/${gatewayPath}?token=${encodeURIComponent(token)}`;

    const logDetails = {
      relayKey,
      expiresAt,
      ttlSeconds,
      gatewayPath,
      pubkey: `${requestingPubkey.slice(0, 16)}...`
    };
    this.log('info', `[PublicGateway] Issued public token ${JSON.stringify(logDetails)}`);

    this.#recordRelayToken(relayKey, {
      token,
      expiresAt,
      ttlSeconds,
      connectionUrl,
      baseUrl: this.publicGatewaySettings.baseUrl,
      issuedForPubkey: requestingPubkey,
      issuedAt,
      relayAuthToken,
      refreshAfter,
      sequence
    }, { schedule: true });

    return {
      relayKey,
      token,
      connectionUrl,
      expiresAt,
      ttlSeconds,
      gatewayPath,
      baseUrl: this.publicGatewaySettings.baseUrl,
      issuedForPubkey: requestingPubkey,
      refreshAfter,
      sequence
    };
  }

  #startGatewayTelemetry(publicKey, protocol) {
    if (!protocol || this.gatewayTelemetryTimers.has(publicKey)) return;

    const sendTelemetry = async () => {
      try {
        const payload = await this.#collectTelemetrySnapshot();
        payload.peerId = payload.peerId || publicKey;
        protocol.sendTelemetry(payload);
      } catch (error) {
        this.log('debug', `[PublicGateway] Failed to send telemetry for ${publicKey}: ${error.message}`);
      }
    };

    sendTelemetry();
    const interval = setInterval(sendTelemetry, 15000);
    interval.unref?.();

    const cleanup = () => {
      clearInterval(interval);
      this.gatewayTelemetryTimers.delete(publicKey);
    };

    this.gatewayTelemetryTimers.set(publicKey, cleanup);
    protocol.once('close', cleanup);
    protocol.once('destroy', cleanup);
    protocol.mux?.stream?.once('close', cleanup);
  }

  async #collectTelemetrySnapshot() {
    const queueDepth = Array.from(this.messageQueues.values()).reduce((total, queue) => {
      if (!queue || !Array.isArray(queue.queue)) return total;
      return total + queue.queue.length;
    }, 0);

    const metrics = this.peerHealthManager?.metrics || {};
    const failureRate = metrics.totalChecks
      ? Math.min(1, metrics.failedChecks / metrics.totalChecks)
      : 0;

    let hyperbeeVersion = 0;
    let hyperbeeLag = 0;
    if (this.publicGatewayRelayClient) {
      try {
        const telemetry = await this.publicGatewayRelayClient.getTelemetry();
        hyperbeeVersion = telemetry?.hyperbeeVersion || 0;
        hyperbeeLag = telemetry?.hyperbeeLag || 0;
      } catch (error) {
        this.log('debug', `[PublicGateway] Hyperbee telemetry error: ${error.message}`);
      }
    }

    return {
      peerId: this.getCurrentPubkey?.() || null,
      latencyMs: 0,
      inFlightJobs: queueDepth,
      failureRate,
      hyperbeeVersion,
      hyperbeeLag,
      queueDepth,
      reportedAt: Date.now()
    };
  }

  getStatus() {
    const peerRelayMap = {};
    for (const [identifier, relay] of this.activeRelays.entries()) {
      peerRelayMap[identifier] = {
        peers: Array.from(relay.peers || []),
        peerCount: relay.peers ? relay.peers.size : 0,
        status: relay.status || 'unknown',
        lastActive: relay.lastActive || null,
        createdAt: relay.createdAt || null,
        metadata: relay.metadata || null
      };
    }

    const peerDetails = {};
    for (const peer of this.activePeers) {
      const relays = peer.relays ? Array.from(peer.relays) : [];
      peerDetails[peer.publicKey] = {
        nostrPubkeyHex: peer.nostrPubkeyHex || null,
        relays,
        relayCount: relays.length,
        lastSeen: peer.lastSeen || null,
        status: peer.status || 'unknown',
        mode: peer.mode || null,
        address: peer.address || null
      };
    }

    return {
      running: this.isRunning,
      port: this.config?.port || DEFAULT_PORT,
      hostname: this.config?.hostname || 'localhost',
      startedAt: this.startedAt,
      urls: this.config?.urls || this.gatewayServer?.getServerUrls() || null,
      health: this.healthState,
      peers: this.activePeers.length,
      relays: this.activeRelays.size,
      peerRelayMap,
      peerDetails,
      publicGateway: this.getPublicGatewayState()
    };
  }

  getDiagnostics() {
    const peerList = this.activePeers.map(peer => ({
      publicKey: peer.publicKey,
      status: this.peerHealthManager.isPeerHealthy(peer.publicKey) ? 'healthy' : 'unknown',
      relayCount: peer.relays?.size || 0,
      lastSeen: peer.lastSeen,
      mode: peer.mode
    }));

    const relays = Array.from(this.activeRelays.entries()).map(([identifier, relay]) => ({
      identifier,
      peers: Array.from(relay.peers)
    }));

    return {
      peers: {
        totalActive: peerList.length,
        list: peerList
      },
      relays: {
        totalActive: relays.length,
        list: relays
      }
    };
  }

  getLogs() {
    return [...this.logs];
  }

  setupRoutes() {
    if (!this.app) return;

    this.app.get('/', (_req, res) => {
      res.json({
        status: this.isRunning ? 'ok' : 'offline',
        peers: this.activePeers.length,
        relays: this.activeRelays.size,
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/health', (_req, res) => {
      res.json({
        status: this.isRunning ? 'healthy' : 'offline',
        mode: 'hyperswarm',
        timestamp: new Date().toISOString()
      });
    });

    this.app.get('/debug/connections', (_req, res) => {
      res.json(this.getDiagnostics());
    });

    this.app.post('/register', async (req, res) => {
      try {
        const result = await this.registerPeerMetadata(req.body || {}, { source: 'http' });
        res.json(result);
      } catch (error) {
        const statusCode = error.message === 'Public key is required' ? 400 : 500;
        this.log('error', `Registration failed: ${error.message}`);
        res.status(statusCode).json({ error: error.message });
      }
    });

    this.app.post('/callback/finalize-auth/:identifier', async (req, res) => {
      const identifier = req.params.identifier;
      try {
        const { pubkey } = req.body || {};
        if (!pubkey) {
          return res.status(400).json({ error: 'Missing pubkey' });
        }

        const sessionKey = `${pubkey}-${identifier}`;
        const session = global.joinSessions?.get(sessionKey);
        if (!session || !session.token) {
          return res.status(400).json({ error: 'Session not found or verification not completed' });
        }

        const peer = this.activePeers.find(p => p.publicKey === session.peerPublicKey);
        if (!peer) {
          return res.status(503).json({ error: 'Peer no longer available' });
        }

        const result = await forwardCallbackToPeer(
          peer,
          '/finalize-auth',
          {
            pubkey,
            token: session.token,
            identifier
          },
          this.connectionPool
        );

        global.joinSessions.delete(sessionKey);
        res.json(result);
      } catch (error) {
        this.log('error', `Finalize auth error: ${error.message}`);
        res.status(500).json({ error: 'Finalization failed', message: error.message });
      }
    });

    this.app.get('/drive/:identifier/:file', async (req, res) => {
      const { identifier, file } = req.params;
      try {
        const peer = await this.findHealthyPeerForRelay(identifier);
        if (!peer) {
          return res.status(503).json({ error: 'No healthy peers available for this relay' });
        }

        const stream = await requestFileFromPeer(peer, identifier, file, this.connectionPool);
        Object.entries(stream.headers).forEach(([key, value]) => res.setHeader(key, value));
        res.status(stream.statusCode);
        stream.pipe(res);
        peer.lastSeen = Date.now();
      } catch (error) {
        this.log('error', `Drive file error: ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
      }
    });

    this.app.post('/post/join/:identifier', async (req, res) => {
      const identifier = req.params.identifier;

      try {
        const relayEntry = this.activeRelays.get(identifier);
        if (!relayEntry || !relayEntry.peers?.size) {
          return res.status(404).json({ error: 'Relay not registered with gateway' });
        }

        const peer = await this.findHealthyPeerForRelay(identifier, true);
        if (!peer) {
          return res.status(503).json({ error: 'No healthy peers available for this relay' });
        }

        const payloadBody = req.body ? Buffer.from(JSON.stringify(req.body)) : undefined;
        const headers = { ...req.headers };
        delete headers['content-length'];
        delete headers['transfer-encoding'];
        delete headers['content-encoding'];
        headers['content-type'] = 'application/json';

        const forwardResponse = await forwardRequestToPeer(peer, {
          method: req.method,
          path: req.originalUrl || req.url,
          headers,
          body: payloadBody
        }, this.connectionPool);

        Object.entries(forwardResponse.headers || {}).forEach(([key, value]) => {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        });

        const statusCode = forwardResponse.statusCode || 200;
        const responseBody = forwardResponse.body || Buffer.alloc(0);
        res.status(statusCode);
        res.send(responseBody);
      } catch (error) {
        this.log('error', `Join request forwarding failed for ${identifier}: ${error.message}`);

        const match = /status\s(\d{3})/i.exec(error.message || '');
        const status = match ? Number(match[1]) : 502;
        res.status(status).json({ error: error.message });
      }
    });

    const servePfp = async (req, res) => {
      const owner = req.params.owner;
      const file = req.params.file;
      if (!file) {
        res.status(400).json({ error: 'Missing file parameter' });
        return;
      }

      const relayHintRaw = req.query?.relay || req.query?.identifier || req.query?.relayId;
      const relayIdentifier = this._normalizeRelayIdentifier(relayHintRaw);

      if (relayIdentifier) {
        try {
          const targetedStream = await this._fetchPfpFromRelay(relayIdentifier, owner || null, file);
          if (targetedStream === false) {
            res.status(404).json({ error: 'Avatar not found' });
            return;
          }

          if (!targetedStream) {
            const relayEntry = this.activeRelays.get(relayIdentifier);
            if (!relayEntry || !relayEntry.peers?.size) {
              res.status(404).json({ error: 'Relay not registered with gateway' });
            } else {
              res.status(503).json({ error: 'No healthy peers available for this relay' });
            }
            return;
          }

          Object.entries(targetedStream.headers || {}).forEach(([key, value]) => {
            if (value !== undefined) {
              res.setHeader(key, value);
            }
          });
          res.status(targetedStream.statusCode || 200);
          targetedStream.pipe(res);
          return;
        } catch (error) {
          this.log('warn', `Relay-specific PFP fetch failed for ${relayIdentifier}: ${error.message}`);
          res.status(502).json({ error: 'Failed to proxy avatar from relay host', message: error.message });
          return;
        }
      }

      try {
        const stream = await this._fetchPfpFromPeers(owner || null, file);
        if (!stream) {
          res.status(404).json({ error: 'Avatar not found' });
          return;
        }

        Object.entries(stream.headers || {}).forEach(([key, value]) => {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        });
        res.status(stream.statusCode || 200);
        stream.pipe(res);
      } catch (error) {
        this.log('error', `PFP proxy error: ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error', message: error.message });
      }
    };

    this.app.get('/pfp/:file', servePfp);
    this.app.get('/pfp/:owner/:file', servePfp);

    this.app.use(async (req, res, next) => {
      if (req.path === '/health' || req.path === '/register' || req.path.startsWith('/callback')) {
        return next();
      }

      if (this.activePeers.length === 0) {
        return res.status(503).json({
          status: 'error',
          message: 'No peers available',
          timestamp: new Date().toISOString()
        });
      }

      const hyperswarmPeers = this.activePeers.filter(p => p.mode === 'hyperswarm');
      if (!hyperswarmPeers.length) {
        return res.status(503).json({ error: 'No Hyperswarm peers available' });
      }

      const targetPeer = hyperswarmPeers[Math.floor(Math.random() * hyperswarmPeers.length)];
      try {
        const response = await forwardRequestToPeer(targetPeer, {
          method: req.method,
          path: req.url,
          headers: req.headers,
          body: req.body ? Buffer.from(JSON.stringify(req.body)) : undefined
        }, this.connectionPool);

        Object.entries(response.headers || {}).forEach(([key, value]) => {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        });
        res.status(response.statusCode || 200);
        res.send(response.body || Buffer.alloc(0));
      } catch (error) {
        this.log('error', `Forward request error: ${error.message}`);
        res.status(502).json({ error: error.message });
      }
    });
  }

  async registerPeerMetadata(data = {}, options = {}) {
    const { skipConnect = false, source = 'unknown' } = options;
    const { publicKey, relays, mode = 'hyperswarm', address } = data;

    if (!publicKey) {
      throw new Error('Public key is required');
    }

    let peer = this.activePeers.find(p => p.publicKey === publicKey);
    if (!peer) {
      peer = {
        publicKey,
        lastSeen: Date.now(),
        relays: new Set(),
        status: 'registered',
        registeredAt: Date.now(),
        mode
      };
      this.activePeers.push(peer);
    } else {
      peer.lastSeen = Date.now();
      peer.status = 'registered';
      peer.mode = mode;
    }

    const previousOwner = peer.nostrPubkeyHex || null;
    const previousDriveKey = peer.pfpDriveKey || null;

    const nostrPubkeyHex = data.nostrPubkeyHex || data.nostr_pubkey_hex || null;
    const pfpDriveKey = data.pfpDriveKey || data.pfp_drive_key || null;

    if (previousOwner && previousOwner !== nostrPubkeyHex) {
      this._removeOwnerMapping(previousOwner, publicKey);
    }

    peer.nostrPubkeyHex = nostrPubkeyHex || previousOwner || null;
    peer.pfpDriveKey = pfpDriveKey || previousDriveKey || null;

    if (peer.nostrPubkeyHex) {
      this._addOwnerMapping(peer.nostrPubkeyHex, publicKey);
    }

    if (peer.pfpDriveKey) {
      this.pfpDriveKeys.set(publicKey, peer.pfpDriveKey);
    } else {
      this.pfpDriveKeys.delete(publicKey);
    }

    const updatedRelays = [];

    if (Array.isArray(relays)) {
      relays.forEach(entry => {
        const identifier = typeof entry === 'string' ? entry : entry?.identifier;
        if (!identifier) return;

        const relayObj = (entry && typeof entry === 'object') ? entry : { identifier };

        peer.relays.add(identifier);
        if (!this.activeRelays.has(identifier)) {
          this.activeRelays.set(identifier, {
            peers: new Set(),
            status: 'active',
            createdAt: Date.now(),
            lastActive: Date.now(),
            metadata: null
          });
        }

        const relayData = this.activeRelays.get(identifier);
        relayData.peers.add(publicKey);
        relayData.lastActive = Date.now();

        const prevMetadata = relayData.metadata || {};
        const nextMetadata = { ...prevMetadata };

        if (relayObj.name && relayObj.name !== prevMetadata.name) {
          nextMetadata.name = relayObj.name;
        }
        if (relayObj.description !== undefined && relayObj.description !== prevMetadata.description) {
          nextMetadata.description = relayObj.description;
        }
        if (relayObj.avatarUrl !== undefined) {
          if (relayObj.avatarUrl) {
            nextMetadata.avatarUrl = this._ensureRelayAvatarUrl(relayObj.avatarUrl, identifier);
          } else {
            nextMetadata.avatarUrl = null;
          }
        }
        if (relayObj.metadataEventId) {
          nextMetadata.metadataEventId = relayObj.metadataEventId;
        }
        if (!nextMetadata.identifier) {
          nextMetadata.identifier = identifier;
        }

        const gatewayPath = this._normalizeGatewayPath(identifier, relayObj.gatewayPath, relayObj.connectionUrl);
        if (gatewayPath) {
          nextMetadata.gatewayPath = gatewayPath;
        }

        if (typeof relayObj.isPublic === 'boolean') {
          nextMetadata.isPublic = relayObj.isPublic;
        } else if (nextMetadata.isPublic === undefined) {
          nextMetadata.isPublic = true;
        }

        const incomingTimestamp = this._coerceTimestamp(relayObj.metadataUpdatedAt);
        const existingTimestamp = this._coerceTimestamp(prevMetadata.metadataUpdatedAt);
        if (incomingTimestamp !== null) {
          if (existingTimestamp === null || incomingTimestamp >= existingTimestamp) {
            nextMetadata.metadataUpdatedAt = incomingTimestamp;
          }
        }

        relayData.metadata = nextMetadata;
        updatedRelays.push(identifier);
      });
    }

    peer.address = address || null;
    peer.lastSeen = Date.now();

    updatedRelays.forEach(identifier => {
      this.#syncPublicGatewayRelay(identifier, { forceTokenRefresh: true }).catch(error => {
        this.log('warn', `[PublicGateway] Sync error for ${identifier}: ${error.message}`);
      });
    });

    this.healthState.activeRelaysCount = this.activeRelays.size;
    this.healthState.services.hyperswarmStatus = 'connected';

    this.emit('status', this.getStatus());

    const connectAndCheck = async () => {
      try {
        await this.connectionPool.getConnection(publicKey);
        peer.status = 'connected';
        await this.peerHealthManager.checkPeerHealth(peer, this.connectionPool);
        this.emit('status', this.getStatus());
      } catch (error) {
        this.log('warn', `Failed to connect to peer ${publicKey.slice(0, 8)} (${source}): ${error.message}`);
      }
    };

    setTimeout(connectAndCheck, skipConnect ? 0 : 1000);

    return {
      message: 'Registered successfully (Hyperswarm mode)',
      status: 'active',
      mode,
      timestamp: new Date().toISOString(),
      relayCount: peer.relays.size,
      relays: Array.from(peer.relays)
    };
  }

  async _handleGatewayRegisterRequest(publicKey, request) {
    try {
      let payload = {};
      if (request.body && request.body.length) {
        payload = JSON.parse(request.body.toString());
      }

      if (!payload.publicKey) {
        payload.publicKey = publicKey;
      }

      const result = await this.registerPeerMetadata(payload, {
        source: 'hyperswarm',
        skipConnect: true
      });

      const responseBody = {
        status: 'ok',
        acknowledgedAt: new Date().toISOString(),
        publicKey,
        relayCount: result.relayCount,
        relays: result.relays,
        subnetHash: this.config?.subnetHash || null
      };

      this.log('info', `Hyperswarm registration acknowledged for peer ${publicKey.slice(0, 8)}...`);

      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify(responseBody))
      };
    } catch (error) {
      this.log('error', `Hyperswarm registration failed for peer ${publicKey.slice(0, 8)}: ${error.message}`);
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: error.message }))
      };
    }
  }

  _coerceTimestamp(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  _normalizeGatewayPath(identifier, gatewayPath = null, legacyUrl = null) {
    if (typeof gatewayPath === 'string' && gatewayPath.trim()) {
      return gatewayPath.replace(/^\//, '');
    }

    if (typeof legacyUrl === 'string' && legacyUrl.trim()) {
      try {
        const parsed = new URL(legacyUrl);
        const path = parsed.pathname.replace(/^\//, '');
        if (path) return path;
      } catch (_) {
        // ignore malformed URL
      }
    }

    if (typeof identifier === 'string' && identifier.includes(':')) {
      return identifier.replace(':', '/');
    }

    return typeof identifier === 'string' ? identifier : null;
  }

  _normalizeRelayIdentifier(value) {
    if (!value || typeof value !== 'string') return null;
    let normalized = value.trim();
    if (!normalized) return null;

    try {
      normalized = decodeURIComponent(normalized);
    } catch (_) {
      // ignore URI decoding errors
    }

    if (normalized.includes('/')) {
      const parts = normalized.split('/').filter(Boolean);
      if (parts.length >= 2) {
        normalized = `${parts[0]}:${parts[1]}`;
      }
    }

    return normalized;
  }

  _ensureRelayAvatarUrl(url, identifier) {
    if (!url || typeof url !== 'string' || !identifier) {
      return url;
    }

    const trimmed = url.trim();
    if (!trimmed) return url;

    const isRelative = trimmed.startsWith('/');
    let parsed;

    try {
      parsed = new URL(trimmed, 'http://placeholder.local');
    } catch (_) {
      return url;
    }

    if (!parsed.pathname.startsWith('/pfp/')) {
      return url;
    }

    parsed.searchParams.set('relay', identifier);

    if (isRelative) {
      const search = parsed.search ? parsed.search : '';
      return `${parsed.pathname}${search}`;
    }

    return parsed.toString();
  }

  handleGatewayWebSocketConnection(ws, req) {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname || '';

    const strippedPath = pathname.replace(/^\/+/, '');
    const normalizedIdentifier = this._normalizeRelayIdentifier(strippedPath);

    const rawParts = strippedPath.split('/').filter(Boolean);
    let fallbackIdentifier = null;
    if (rawParts.length >= 2) {
      fallbackIdentifier = `${rawParts[0]}:${rawParts.slice(1).join('/')}`;
    } else if (rawParts.length === 1) {
      fallbackIdentifier = rawParts[0];
    }

    const candidateIdentifiers = [normalizedIdentifier, fallbackIdentifier].filter(Boolean);
    const matchedIdentifier = candidateIdentifiers.find(id => this.activeRelays.has(id));

    const authToken = parsedUrl.query?.token || null;

    if (matchedIdentifier) {
      this.handleWebSocket(ws, matchedIdentifier, authToken);
      return;
    }

    ws.close(1008, 'Invalid relay key');
  }

  handleWebSocket(ws, identifier, authToken = null) {
    const connectionKey = generateConnectionKey();
    this.wsConnections.set(connectionKey, {
      ws,
      relayKey: identifier,
      authToken
    });

    const messageQueue = new MessageQueue();
    this.messageQueues.set(connectionKey, messageQueue);

    ws.on('message', async (message) => {
      await messageQueue.enqueue(message, async (msg) => {
        const connData = this.wsConnections.get(connectionKey);
        if (!connData) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(['NOTICE', 'Internal server error: connection data missing']));
          }
          return;
        }

        const healthyPeer = await this.findHealthyPeerForRelay(identifier);
        if (!healthyPeer) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(['NOTICE', 'No healthy peers available for this relay']));
          }
          return;
        }

        try {
          const responses = await forwardMessageToPeerHyperswarm(
            healthyPeer.publicKey,
            identifier,
            msg,
            connectionKey,
            this.connectionPool,
            connData.authToken
          );

          for (const response of responses) {
            if (!response) continue;
            if (response[0] === 'OK' && response[2] === false) {
              const errorMsg = response[3] || '';
              if (errorMsg.includes('Authentication') && ws.readyState === WebSocket.OPEN) {
                ws.close(4403, 'Authentication failed');
                return;
              }
            }
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(response));
            }
          }
        } catch (error) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(['NOTICE', `Error: ${error.message}`]));
          }
        }
      });
    });

    ws.on('close', () => {
      this.cleanupConnection(connectionKey);
    });

    ws.on('error', () => {
      this.cleanupConnection(connectionKey);
    });

    this.startEventChecking(connectionKey);
  }

  cleanupConnection(connectionKey) {
    const data = this.wsConnections.get(connectionKey);
    if (!data) return;

    this.wsConnections.delete(connectionKey);
    this.messageQueues.delete(connectionKey);
    const timer = this.eventCheckTimers.get(connectionKey);
    if (timer) {
      clearTimeout(timer);
      this.eventCheckTimers.delete(connectionKey);
    }
  }

  async startEventChecking(connectionKey) {
    const loop = async () => {
      const connectionData = this.wsConnections.get(connectionKey);
      if (!connectionData) {
        this.eventCheckTimers.delete(connectionKey);
        return;
      }

      const { ws, relayKey: identifier, authToken } = connectionData;
      if (ws.readyState !== WebSocket.OPEN) {
        this.cleanupConnection(connectionKey);
        return;
      }

      try {
        const healthyPeer = await this.findHealthyPeerForRelay(identifier, true);
        if (!healthyPeer) {
          ws.send(JSON.stringify(['NOTICE', 'Gateway temporarily unavailable - no healthy peers']));
        } else {
          const events = await getEventsFromPeerHyperswarm(
            healthyPeer.publicKey,
            identifier,
            connectionKey,
            this.connectionPool,
            authToken
          );

          for (const event of events) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(event));
            }
          }
        }
      } catch (error) {
        this.log('warn', `Event check failed: ${error.message}`);
      }

      const timer = setTimeout(loop, 10000);
      this.eventCheckTimers.set(connectionKey, timer);
    };

    const timer = setTimeout(loop, 1000);
    this.eventCheckTimers.set(connectionKey, timer);
  }

  async findHealthyPeerForRelay(identifier, allowRetry = false) {
    const relay = this.activeRelays.get(identifier);
    if (!relay) return null;

    const peerKeys = Array.from(relay.peers);
    if (!peerKeys.length) return null;

    for (const publicKey of peerKeys) {
      const peer = this.activePeers.find(p => p.publicKey === publicKey);
      if (!peer) continue;
      const healthy = this.peerHealthManager.isPeerHealthy(publicKey);
      if (healthy) {
        return peer;
      }
    }

    if (allowRetry) {
      for (const publicKey of peerKeys) {
        const peer = this.activePeers.find(p => p.publicKey === publicKey);
        if (!peer) continue;
        const healthy = await this.peerHealthManager.checkPeerHealth(peer, this.connectionPool);
        if (healthy) {
          return peer;
        }
      }
    }

    return null;
  }

  getPeersWithPfpDrive() {
    return this.activePeers
      .filter(peer => !!peer.pfpDriveKey)
      .map(peer => ({
        publicKey: peer.publicKey,
        pfpDriveKey: peer.pfpDriveKey,
        nostrPubkeyHex: peer.nostrPubkeyHex || null
      }));
  }
}

export default GatewayService;
