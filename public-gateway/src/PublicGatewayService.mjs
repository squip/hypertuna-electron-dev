import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import {
  EnhancedHyperswarmPool,
  forwardMessageToPeerHyperswarm,
  getEventsFromPeerHyperswarm,
  requestFileFromPeer
} from '../../shared/public-gateway/HyperswarmClient.mjs';
import { computeSecretHash } from '../../shared/public-gateway/GatewayDiscovery.mjs';
import {
  verifySignature,
  verifyClientToken
} from '../../shared/auth/PublicGatewayTokens.mjs';
import {
  metricsMiddleware,
  sessionGauge,
  peerGauge,
  requestCounter,
  relayEventCounter,
  relayReqCounter,
  relayErrorCounter,
  relayTokenIssueCounter,
  relayTokenRefreshCounter,
  relayTokenRevocationCounter
} from './metrics.mjs';
import MemoryRegistrationStore from './stores/MemoryRegistrationStore.mjs';
import MessageQueue from './utils/MessageQueue.mjs';
import GatewayAdvertiser from './discovery/GatewayAdvertiser.mjs';
import HyperbeeRelayHost from './relay/HyperbeeRelayHost.mjs';
import RelayWebsocketController from './relay/RelayWebsocketController.mjs';
import RelayDispatcherService from './relay/RelayDispatcherService.mjs';
import RelayTokenService from './relay/RelayTokenService.mjs';
import PublicGatewayHyperbeeAdapter from '../../shared/public-gateway/PublicGatewayHyperbeeAdapter.mjs';
import { openHyperbeeReplicationChannel } from '../../shared/public-gateway/hyperbeeReplicationChannel.mjs';

const DELEGATION_FALLBACK_MS = 3000;

function safeString(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (_) {
    return null;
  }
}

class PublicGatewayService {
  constructor({ config, logger, tlsOptions = null, registrationStore }) {
    this.config = config;
    this.logger = logger;
    this.tlsOptions = tlsOptions;
    this.registrationStore = registrationStore || new MemoryRegistrationStore(config.registration?.cacheTtlSeconds);
    this.sharedSecret = config.registration?.sharedSecret || null;
    this.discoveryConfig = config.discovery || {};
    this.explicitSharedSecretVersion = this.discoveryConfig?.sharedSecretVersion || null;
    this.sharedSecretVersion = this.explicitSharedSecretVersion;
    this.secretEndpointPath = this.#normalizeSecretPath(this.discoveryConfig?.secretPath);
    this.wsBaseUrl = this.#computeWsBase(this.config.publicBaseUrl);
    this.gatewayAdvertiser = null;
    if (this.discoveryConfig?.enabled && this.discoveryConfig.openAccess && this.sharedSecret) {
      this.gatewayAdvertiser = new GatewayAdvertiser({
        logger: this.logger,
        discoveryConfig: this.discoveryConfig,
        getSharedSecret: async () => this.sharedSecret,
        getSharedSecretVersion: async () => this.#getSharedSecretVersion(),
        getRelayInfo: async () => this.#getRelayHostInfo(),
        publicUrl: this.config.publicBaseUrl,
        wsUrl: this.wsBaseUrl
      });
    } else if (this.discoveryConfig?.enabled && this.discoveryConfig.openAccess && !this.sharedSecret) {
      this.logger?.warn?.('Gateway discovery enabled but shared secret missing; advertisement disabled');
    }

    this.app = express();
    this.server = null;
    this.wss = null;
    this.featureFlags = {
      hyperbeeRelayEnabled: !!config?.features?.hyperbeeRelayEnabled,
      dispatcherEnabled: config?.features?.dispatcherEnabled === undefined
        ? true
        : !!config?.features?.dispatcherEnabled,
      tokenEnforcementEnabled: !!config?.features?.tokenEnforcementEnabled
    };
    this.relayConfig = this.#normalizeRelayConfig(config?.relay);
    this.relayHost = null;
    this.relayTelemetryUnsub = null;
    this.relayWebsocketController = null;
    this.hyperbeeAdapter = null;
    this.internalRelayKey = 'public-gateway:hyperbee';
    this.internalRegistrationInterval = null;
    this.dispatcher = this.featureFlags.dispatcherEnabled
      ? new RelayDispatcherService({ logger: this.logger, policy: this.config.dispatcher })
      : null;
    this.tokenService = null;
    this.tokenMetrics = {
      issueCounter: relayTokenIssueCounter,
      refreshCounter: relayTokenRefreshCounter,
      revokeCounter: relayTokenRevocationCounter
    };
    this.connectionPool = new EnhancedHyperswarmPool({
      logger: this.logger,
      onProtocol: this.#onProtocolCreated.bind(this),
      onHandshake: this.#onProtocolHandshake.bind(this),
      onTelemetry: this.#handlePeerTelemetry.bind(this),
      handshakeBuilder: this.#buildHandshakePayload.bind(this)
    });

    this.sessions = new Map();
    this.healthInterval = null;
    this.pruneInterval = null;
    this.eventCheckTimers = new Map();
    this.delegationFallbackTimers = new Map();
    this.relayPeerIndex = new Map();
    this.peerMetadata = new Map();
    this.peerHyperbeeReplications = new Map();
    this.publicGatewayStatusUpdatedAt = null;
  }

  async init() {
    this.#setupHttpServer();
    await this.connectionPool.initialize();
    if (this.featureFlags.tokenEnforcementEnabled && this.sharedSecret) {
      this.tokenService = new RelayTokenService({
        registrationStore: this.registrationStore,
        sharedSecret: this.sharedSecret,
        logger: this.logger,
        defaultTtlSeconds: this.config.registration?.defaultTokenTtl,
        refreshWindowSeconds: this.config.registration?.tokenRefreshWindowSeconds
      });
    } else if (this.featureFlags.tokenEnforcementEnabled && !this.sharedSecret) {
      this.logger?.warn?.('Token enforcement enabled but shared secret missing; token service disabled');
    }
    if (this.#isHyperbeeRelayEnabled()) {
      await this.#ensureRelayHost();
    }
    this.logger.info('PublicGatewayService initialized');
  }

  async start() {
    if (!this.server) {
      throw new Error('Service not initialized');
    }

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.removeListener('error', reject);
        this.logger.info({ port: this.config.port, host: this.config.host }, 'Public gateway listening');
        resolve();
      });
    });

    if (this.gatewayAdvertiser) {
      try {
        await this.gatewayAdvertiser.start();
      } catch (error) {
        if (this.logger?.error) {
          this.logger.error({ err: error, stack: error?.stack }, 'Failed to start gateway discovery advertiser');
        }
      }
    }

    this.healthInterval = setInterval(() => this.#collectMetrics(), 10000).unref();
    this.pruneInterval = setInterval(() => this.registrationStore.pruneExpired?.(), 60000).unref();
  }

  async stop() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }

    if (this.pruneInterval) {
      clearInterval(this.pruneInterval);
      this.pruneInterval = null;
    }

    for (const timer of this.eventCheckTimers.values()) {
      clearTimeout(timer);
    }
    this.eventCheckTimers.clear();

    for (const timer of this.delegationFallbackTimers.values()) {
      clearTimeout(timer);
    }
    this.delegationFallbackTimers.clear();

    this.sessions.clear();
    sessionGauge.set(0);

    if (this.wss) {
      await new Promise((resolve) => this.wss.close(resolve));
      this.wss = null;
    }

    if (this.server) {
      await new Promise((resolve, reject) => this.server.close(err => err ? reject(err) : resolve()));
      this.server = null;
    }

    if (this.gatewayAdvertiser) {
      await this.gatewayAdvertiser.stop();
    }

    if (this.relayHost) {
      try {
        await this.relayHost.stop();
      } catch (error) {
        this.logger?.error?.('Failed to stop Hyperbee relay host', { error: error?.message });
      }
      if (this.relayTelemetryUnsub) {
        this.relayTelemetryUnsub();
        this.relayTelemetryUnsub = null;
      }
      this.relayHost = null;
      this.relayWebsocketController = null;
    }

    if (this.internalRegistrationInterval) {
      clearInterval(this.internalRegistrationInterval);
      this.internalRegistrationInterval = null;
    }

    await this.connectionPool.destroy();
    await this.registrationStore?.disconnect?.();
  }

  #setupHttpServer() {
    const app = this.app;
    app.disable('x-powered-by');
    app.use(helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    }));
    app.use(express.json({ limit: '256kb' }));

    if (this.config.rateLimit?.enabled) {
      app.use(rateLimit({
        windowMs: this.config.rateLimit.windowSeconds * 1000,
        limit: this.config.rateLimit.maxRequests
      }));
    }

    if (this.config.metrics?.enabled) {
      app.use(metricsMiddleware(this.config.metrics.path));
    }

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok' });
    });

    if (this.#shouldExposeSecretEndpoint()) {
      app.get(this.secretEndpointPath, (req, res) => this.#handleSecretRequest(req, res));
    }

    app.get('/drive/:identifier/:file', async (req, res) => {
      const { identifier, file } = req.params;
      try {
        const target = await this.#resolveRelayTarget(identifier);
        if (!target) {
          this.logger.warn?.('Drive request for unknown relay identifier', { identifier, file });
          return res.status(404).json({ error: 'Relay not registered with gateway' });
        }

        const streamResult = await this.#withRelayPeerKey(target.relayKey, async (peerKey) => {
          const peer = { publicKey: peerKey };
          const result = await requestFileFromPeer(peer, target.driveIdentifier, file, this.connectionPool);

          if (!result) {
            const err = new Error('Peer returned empty response');
            err.statusCode = 502;
            err.peerKey = peerKey;
            throw err;
          }

          const status = Number.isInteger(result.statusCode) ? result.statusCode : 200;
          if (status >= 400) {
            const err = new Error(`Peer responded with status ${status}`);
            err.statusCode = status;
            err.peerKey = peerKey;
            throw err;
          }

          return { peerKey, stream: result };
        });

        const { stream: bodyStream, peerKey } = streamResult;
        if (!bodyStream) {
          this.logger.warn?.('Peer returned empty stream for drive request', { identifier, file, peerKey });
          return res.status(404).json({ error: 'File not found' });
        }

        Object.entries(bodyStream.headers || {}).forEach(([key, value]) => {
          if (value !== undefined) {
            res.setHeader(key, value);
          }
        });

        const statusCode = Number.isInteger(bodyStream.statusCode) ? bodyStream.statusCode : 200;
        res.status(statusCode);
        bodyStream.pipe(res);
      } catch (error) {
        const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
        this.logger.error?.('Drive request failed', {
          identifier,
          file,
          statusCode,
          error: error?.message || error
        });
        if (!res.headersSent) {
          res.status(statusCode).json({ error: error?.message || 'Unable to fetch file' });
        } else {
          res.end();
        }
      }
    });

    app.post('/api/relays', (req, res) => this.#handleRelayRegistration(req, res));
    app.delete('/api/relays/:relayKey', (req, res) => this.#handleRelayDeletion(req, res));

    app.post('/api/relay-tokens/issue', (req, res) => this.#handleTokenIssue(req, res));
    app.post('/api/relay-tokens/refresh', (req, res) => this.#handleTokenRefresh(req, res));
    app.post('/api/relay-tokens/revoke', (req, res) => this.#handleTokenRevoke(req, res));

    const serverFactory = this.tlsOptions ? https.createServer : http.createServer;
    this.server = serverFactory(this.tlsOptions || {}, app);

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this.#handleWebSocket(ws, req));
  }

  #normalizeRelayConfig(raw = {}) {
    const baseDir = raw?.storageDir
      || process.env.GATEWAY_RELAY_STORAGE
      || resolve(process.env.STORAGE_DIR || process.cwd(), 'gateway-relay');
    const statsIntervalMs = Number(raw?.statsIntervalMs);
    return {
      storageDir: baseDir,
      datasetNamespace: raw?.datasetNamespace || 'public-gateway-relay',
      adminPublicKey: raw?.adminPublicKey || process.env.GATEWAY_RELAY_ADMIN_PUBLIC_KEY || null,
      adminSecretKey: raw?.adminSecretKey || process.env.GATEWAY_RELAY_ADMIN_SECRET_KEY || null,
      statsIntervalMs: Number.isFinite(statsIntervalMs) && statsIntervalMs > 0 ? statsIntervalMs : undefined,
      replicationTopic: raw?.replicationTopic || null
    };
  }

  #isHyperbeeRelayEnabled() {
    return this.featureFlags.hyperbeeRelayEnabled;
  }

  async #ensureRelayHost() {
    if (this.relayHost) return;
    if (!this.relayConfig.adminPublicKey || !this.relayConfig.adminSecretKey) {
      this.logger?.warn?.('Hyperbee relay feature enabled but admin key pair missing');
      return;
    }

    const host = new HyperbeeRelayHost({
      logger: this.logger,
      telemetryIntervalMs: this.relayConfig.statsIntervalMs
    });

    await host.initialize({
      storageDir: this.relayConfig.storageDir,
      datasetNamespace: this.relayConfig.datasetNamespace,
      adminKeyPair: {
        publicKey: this.relayConfig.adminPublicKey,
        secretKey: this.relayConfig.adminSecretKey
      },
      statsIntervalMs: this.relayConfig.statsIntervalMs,
      replicationTopic: this.relayConfig.replicationTopic
    });

    this.relayTelemetryUnsub = host.registerTelemetrySink((event) => {
      this.logger?.debug?.('[HyperbeeRelayHost] Telemetry', event);
    });

    try {
      await host.start();
    } catch (error) {
      this.logger?.error?.('Failed to start Hyperbee relay host', { error: error?.message });
      if (this.relayTelemetryUnsub) {
        this.relayTelemetryUnsub();
        this.relayTelemetryUnsub = null;
      }
      throw error;
    }

    this.relayHost = host;
    this.hyperbeeAdapter = new PublicGatewayHyperbeeAdapter({
      logger: this.logger,
      relayClient: {
        getHyperbee: () => this.relayHost?.getHyperbee?.(),
        getCore: () => this.relayHost?.getCore?.()
      }
    });
    this.logger?.info?.('Hyperbee relay host ready', {
      relayKey: host.getPublicKey()
    });

    this.relayWebsocketController = new RelayWebsocketController({
      relayHost: host,
      hyperbeeAdapter: this.hyperbeeAdapter,
      dispatcher: this.dispatcher,
      logger: this.logger,
      featureFlags: this.featureFlags,
      metrics: {
        eventCounter: relayEventCounter,
        reqCounter: relayReqCounter,
        errorCounter: relayErrorCounter
      },
      legacyForward: (session, message, preferredPeer, context = {}) => this.#forwardLegacyMessage(session, message, preferredPeer, context)
    });

    await this.#ensureInternalRelayRegistration();

    const ttlSeconds = Math.max(Number(this.config.registration?.cacheTtlSeconds) || 300, 60);
    const refreshIntervalMs = Math.max(60000, Math.floor((ttlSeconds * 1000) / 2));
    this.internalRegistrationInterval = setInterval(() => {
      this.#ensureInternalRelayRegistration().catch((error) => {
        this.logger?.debug?.('Failed to refresh internal relay registration', {
          error: error?.message || error
        });
      });
    }, refreshIntervalMs);
    this.internalRegistrationInterval.unref?.();
  }

  async #ensureInternalRelayRegistration() {
    if (!this.relayHost || !this.registrationStore?.upsertRelay) return;

    const timestamp = new Date().toISOString();
    const gatewayPath = this.internalRelayKey.replace(':', '/');

    const registration = {
      relayKey: this.internalRelayKey,
      identifier: this.internalRelayKey,
      peers: [],
      registeredAt: timestamp,
      updatedAt: timestamp,
      metadata: {
        identifier: this.internalRelayKey,
        name: 'Public Gateway Hyperbee',
        description: 'Authoritative public gateway relay dataset',
        requiresAuth: false,
        isPublic: true,
        isGatewayReplica: true,
        gatewayPath,
        gatewayRelay: this.#getRelayHostInfo()
      }
    };

    await this.registrationStore.upsertRelay(this.internalRelayKey, registration);
  }

  #computeWsBase(baseUrl) {
    if (!baseUrl) return '';
    try {
      const parsed = new URL(baseUrl);
      if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
      else if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
      else if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
        this.logger?.warn?.('Unsupported protocol for public gateway base URL', {
          protocol: parsed.protocol,
          baseUrl
        });
        return '';
      }
      return parsed.toString().replace(/\/$/, '');
    } catch (error) {
      this.logger?.warn?.('Failed to compute websocket base from public URL', {
        baseUrl,
        error: error?.message || error
      });
      return '';
    }
  }

  #normalizeSecretPath(secretPath) {
    if (!secretPath) return '/.well-known/hypertuna-gateway-secret';
    if (typeof secretPath !== 'string') return '/.well-known/hypertuna-gateway-secret';
    const trimmed = secretPath.trim();
    if (!trimmed) return '/.well-known/hypertuna-gateway-secret';
    try {
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const parsed = new URL(trimmed);
        return parsed.pathname || '/.well-known/hypertuna-gateway-secret';
      }
    } catch (error) {
      this.logger?.warn?.('Failed to parse discovery secret path as URL', {
        secretPath,
        error: error?.message || error
      });
    }
    return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  }

  #deriveSharedSecretVersion(secret) {
    if (!secret) return '';
    return computeSecretHash(secret).slice(0, 24);
  }

  #getSharedSecretVersion() {
    if (this.explicitSharedSecretVersion) return this.explicitSharedSecretVersion;
    if (!this.sharedSecretVersion) {
      this.sharedSecretVersion = this.#deriveSharedSecretVersion(this.sharedSecret);
    }
    return this.sharedSecretVersion || '';
  }

  #shouldExposeSecretEndpoint() {
    return Boolean(this.sharedSecret && this.discoveryConfig?.enabled && this.discoveryConfig.openAccess);
  }

  #handleSecretRequest(_req, res) {
    if (!this.#shouldExposeSecretEndpoint()) {
      return res.status(404).json({ error: 'Gateway secret not available' });
    }
    if (!this.sharedSecret) {
      return res.status(503).json({ error: 'Gateway shared secret not configured' });
    }

    const payload = {
      gatewayId: this.gatewayAdvertiser?.gatewayId || null,
      sharedSecret: this.sharedSecret,
      version: this.#getSharedSecretVersion(),
      hash: computeSecretHash(this.sharedSecret),
      wsUrl: this.wsBaseUrl,
      publicUrl: this.config.publicBaseUrl,
      timestamp: Date.now()
    };

    res.json(payload);
  }

  #handleWebSocket(ws, req) {
    this.#initializeSession(ws, req).catch((error) => {
      this.logger.error?.('Failed to initialize websocket session', {
        error: error?.message || 'unknown error',
        stack: error?.stack || null,
        relayKey: error?.relayKey || null
      });
      try {
        ws.close(1011, 'Internal error');
      } catch (_) {}
      ws.terminate();
    });
  }

  async #initializeSession(ws, req) {
    if (!this.sharedSecret) {
      this.logger.error?.('WebSocket rejected: shared secret missing');
      ws.close(1011, 'Gateway not configured');
      ws.terminate();
      return;
    }

    const { relayKey, token } = this.#parseWebSocketRequest(req);

    if (!relayKey) {
      this.logger.warn?.('WebSocket rejected: invalid relay key', {
        url: req?.url || null
      });
      ws.close(4404, 'Invalid relay key');
      ws.terminate();
      return;
    }

    const registration = await this.registrationStore.getRelay(relayKey);
    if (!registration) {
      this.logger.warn?.('WebSocket rejected: relay not registered', { relayKey });
      ws.close(4404, 'Relay not registered');
      ws.terminate();
      return;
    }

    const requiresAuth = registration?.metadata?.requiresAuth !== false;

    let tokenValidation = null;
    if (requiresAuth) {
      if (!token) {
        this.logger.warn?.('WebSocket rejected: token missing', { relayKey });
        ws.close(4403, 'Token required');
        ws.terminate();
        return;
      }

      tokenValidation = await this.#validateToken(token, relayKey);
      if (!tokenValidation) {
        this.logger.warn?.('WebSocket rejected: token validation failed', { relayKey });
        ws.close(4403, 'Invalid token');
        ws.terminate();
        return;
      }
    }

    const { payload: tokenPayload, relayAuthToken, pubkey: tokenPubkey, scope: tokenScope } = tokenValidation || {};

    const metadata = registration?.metadata || {};
    const delegateReqToPeers = metadata?.delegateReqToPeers === true
      || registration?.gatewayReplica?.delegateReqToPeers === true;

    const availablePeers = this.#getPeersFromRegistration(registration);
    this.logger.info?.('Initializing websocket session - relay registration fetched', {
      relayKey,
      peerCount: availablePeers.length,
      peers: availablePeers
    });

    const selection = this.#selectPeer({ ...registration, peers: availablePeers });
    const supportsLocal = this.#supportsLocalRelay(registration);

    let peerKey = null;
    let peers = availablePeers;
    let peerIndex = 0;
    const localOnly = !selection && supportsLocal;

    if (selection) {
      peerKey = selection.peerKey;
      peers = selection.peers;
      peerIndex = selection.index >= 0 ? selection.index : 0;
    } else if (!localOnly) {
      this.logger.warn?.('WebSocket rejected: no peers available', { relayKey });
      ws.close(1013, 'No peers available');
      ws.terminate();
      return;
    }

    if (!localOnly && peerKey) {
      try {
        this.logger.info?.('Attempting hyperswarm connection for websocket session', {
          relayKey,
          peerKey
        });
        await this.connectionPool.getConnection(peerKey);
        this.logger.info?.('Hyperswarm connection established for websocket session', {
          relayKey,
          peerKey
        });
      } catch (err) {
        err.relayKey = relayKey;
        this.logger.error?.('WebSocket rejected: failed to connect to peer', {
          relayKey,
          peerKey,
          error: err?.message || 'unknown error'
        });
        throw err;
      }
    } else if (localOnly) {
      this.logger.info?.('WebSocket session using local Hyperbee host', { relayKey });
    }

    const connectionKey = this.#generateConnectionKey();
    const session = {
      connectionKey,
      relayKey,
      ws,
      clientToken: token || null,
      tokenPayload,
      relayAuthToken,
      clientPubkey: tokenPubkey || null,
      clientScope: tokenScope || null,
      peerKey,
      peers,
      peerIndex,
      localOnly,
      delegateReqToPeers,
      messageQueue: new MessageQueue(),
      openedAt: Date.now(),
      subscriptionPeers: new Map(),
      assignPeer: null,
      pendingDelegatedMessages: []
    };
    session.assignPeer = (assignedPeer, subscriptionId) => {
      if (session.localOnly) return;
      this.#assignPeerForSubscription(session, assignedPeer, subscriptionId);
    };

    this.sessions.set(connectionKey, session);
    sessionGauge.set(this.sessions.size);

    ws.on('message', (message) => this.#handleClientMessage(session, message));
    ws.on('close', () => this.#cleanupSession(connectionKey));
    ws.on('error', () => this.#cleanupSession(connectionKey));

    this.#startEventChecking(session);

    if (session.delegateReqToPeers) {
      this.#updateSessionsForDelegation({
        peerKey,
        delegate: true
      });
    }

    this.logger.info?.('WebSocket session established', { relayKey, connectionKey, peerKey });
  }

  #generateConnectionKey() {
    return randomBytes(16).toString('hex');
  }

  #handleClientMessage(session, rawMessage) {
    if (!this.sessions.has(session.connectionKey)) {
      return;
    }

    const payload = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString();
    session.messageQueue.enqueue(payload, async (msg) => {
      if (!this.sessions.has(session.connectionKey)) {
        return;
      }

      const useRelayController = this.#isHyperbeeRelayEnabled() && this.relayWebsocketController;

      if (useRelayController) {
        const handled = await this.relayWebsocketController.handleMessage(session, msg);
        if (handled) return;
      }

      await this.#forwardLegacyMessage(session, msg);
    });
  }

  #cleanupSession(connectionKey) {
    const session = this.sessions.get(connectionKey);
    if (!session) return;

    this.sessions.delete(connectionKey);
    const timer = this.eventCheckTimers.get(connectionKey);
    if (timer) {
      clearTimeout(timer);
      this.eventCheckTimers.delete(connectionKey);
    }

    const fallbackTimer = this.delegationFallbackTimers.get(connectionKey);
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      this.delegationFallbackTimers.delete(connectionKey);
    }

    this.relayWebsocketController?.removeSession(connectionKey);

    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.close(); } catch (_) {}
    }

    sessionGauge.set(this.sessions.size);
  }

  async #forwardLegacyMessage(session, msg, preferredPeer = null, options = {}) {
    const { allowQueue = true, subscriptionId = null, storePending = false } = options || {};
    const serialized = typeof msg === 'string' ? msg : safeString(msg);
    if (!serialized) {
      this.logger.warn?.('Failed to serialize legacy message', { relayKey: session.relayKey });
      return;
    }

    let pendingEntry = null;
    if (storePending && session?.delegateReqToPeers) {
      if (!Array.isArray(session.pendingDelegatedMessages)) {
        session.pendingDelegatedMessages = [];
      }
      pendingEntry = {
        message: serialized,
        preferredPeer: preferredPeer || null,
        queuedAt: Date.now(),
        subscriptionId
      };
      session.pendingDelegatedMessages.push(pendingEntry);
    }

    if (!session?.peers?.length) {
      if (allowQueue && session?.delegateReqToPeers) {
        if (!Array.isArray(session.pendingDelegatedMessages)) {
          session.pendingDelegatedMessages = [];
        }
        session.pendingDelegatedMessages.push({
          message: serialized,
          preferredPeer: preferredPeer || null,
          queuedAt: Date.now(),
          subscriptionId
        });
        this.logger.debug?.('Queued delegated relay message pending peer availability', {
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey,
          queueLength: session.pendingDelegatedMessages.length
        });
        this.#scheduleDelegationFallback(session);
      } else if (!allowQueue && session?.delegateReqToPeers) {
        if (!Array.isArray(session.pendingDelegatedMessages)) {
          session.pendingDelegatedMessages = [];
        }
        session.pendingDelegatedMessages.unshift({
          message: serialized,
          preferredPeer: preferredPeer || null,
          queuedAt: Date.now(),
          subscriptionId
        });
        this.logger.debug?.('Re-queued delegated relay message while peers unavailable', {
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey,
          queueLength: session.pendingDelegatedMessages.length
        });
        this.#scheduleDelegationFallback(session);
      } else {
        this.logger.debug?.('Legacy forward skipped - no peers available for relay', {
          relayKey: session?.relayKey
        });
      }
      return;
    }

    try {
      const responses = await this.#withPeer(session, async (peerKey) => {
        requestCounter.inc({ relay: session.relayKey });
        return forwardMessageToPeerHyperswarm(
          peerKey,
          session.relayKey,
          serialized,
          session.connectionKey,
          this.connectionPool,
          session.relayAuthToken
        );
      }, { preferredPeer });

      if (!Array.isArray(responses)) return;
      for (const response of responses) {
        if (!response) continue;
        if (session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify(response));
        }
      }
      if (pendingEntry) {
        const queue = session.pendingDelegatedMessages;
        if (Array.isArray(queue)) {
          const idx = queue.indexOf(pendingEntry);
          if (idx !== -1) queue.splice(idx, 1);
        }
      }
    } catch (error) {
      const awaitingPeer = error?.message === 'delegated-session-awaiting-peer';
      if (allowQueue && awaitingPeer && session?.delegateReqToPeers) {
        if (pendingEntry) {
          pendingEntry.preferredPeer = preferredPeer || null;
          pendingEntry.queuedAt = Date.now();
        } else {
          if (!Array.isArray(session.pendingDelegatedMessages)) {
            session.pendingDelegatedMessages = [];
          }
          session.pendingDelegatedMessages.push({
            message: serialized,
            preferredPeer: preferredPeer || null,
            queuedAt: Date.now(),
            subscriptionId
          });
        }
        this.logger.debug?.('Queued delegated relay message while awaiting peer', {
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey,
          queueLength: session.pendingDelegatedMessages.length
        });
        this.#scheduleDelegationFallback(session);
        return;
      }

      this.logger.warn?.('Forwarding message failed', { relayKey: session.relayKey, error: error.message });
      if (session.ws.readyState === WebSocket.OPEN) {
        session.ws.send(JSON.stringify(['NOTICE', `Error: ${error.message}`]));
      } else {
        this.#cleanupSession(session.connectionKey);
      }
      if (session?.delegateReqToPeers && Array.isArray(session.pendingDelegatedMessages) && session.pendingDelegatedMessages.length) {
        this.#scheduleDelegationFallback(session);
      }
    }
  }

  async #flushPendingDelegatedMessages(session, preferredPeer = null) {
    if (!session || !Array.isArray(session.pendingDelegatedMessages) || !session.pendingDelegatedMessages.length) {
      return;
    }

    const pending = session.pendingDelegatedMessages.splice(0);
    for (const entry of pending) {
      try {
        const targetPeer = entry?.preferredPeer ?? preferredPeer ?? null;
        await this.#forwardLegacyMessage(session, entry.message, targetPeer, {
          allowQueue: false,
          subscriptionId: entry?.subscriptionId || null
        });
        if (targetPeer && entry?.subscriptionId) {
          session.assignPeer?.(targetPeer, entry.subscriptionId);
        }
        if (!session?.peers?.length && session.delegateReqToPeers) {
          this.#scheduleDelegationFallback(session);
          break;
        }
      } catch (error) {
        this.logger.debug?.('Failed to flush delegated message to peer', {
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey,
          error: error?.message || error
        });
        if (entry) {
          entry.retryCount = (entry.retryCount || 0) + 1;
          const maxRetries = 5;
          if (entry.retryCount <= maxRetries) {
            session.pendingDelegatedMessages.unshift(entry);
          } else {
            this.logger.warn?.('Dropping delegated message after max retries', {
              relayKey: session?.relayKey,
              connectionKey: session?.connectionKey,
              subscriptionId: entry?.subscriptionId || null
            });
          }
        }
        this.#scheduleDelegationFallback(session);
        break;
      }
    }

    if (!session.pendingDelegatedMessages.length) {
      this.#cancelDelegationFallback(session);
    }
  }

  #startEventChecking(session) {
    const run = async () => {
      if (!this.sessions.has(session.connectionKey)) {
        this.eventCheckTimers.delete(session.connectionKey);
        return;
      }

      try {
        if (session.localOnly) {
          await this.#pollLocalHyperbee(session);
        } else {
          const registration = await this.registrationStore.getRelay(session.relayKey);
          if (registration) {
            session.peers = this.#getPeersFromRegistration(registration);
          }

          if (!session.localOnly
            && session.delegateReqToPeers
            && Array.isArray(session.pendingDelegatedMessages)
            && session.pendingDelegatedMessages.length
            && session.peers?.length) {
            await this.#flushPendingDelegatedMessages(session);
          }

          const events = await this.#withPeer(session, async (peerKey) => {
            return getEventsFromPeerHyperswarm(
              peerKey,
              session.relayKey,
              session.connectionKey,
              this.connectionPool,
              session.relayAuthToken
            );
          });

          if (Array.isArray(events) && events.length && session.ws.readyState === WebSocket.OPEN) {
            for (const event of events) {
              if (!event) continue;
              session.ws.send(JSON.stringify(event));
            }
          }
        }
      } catch (error) {
        this.logger.debug?.('Event polling error', { relayKey: session.relayKey, error: error.message });
      } finally {
        const timer = setTimeout(run, 1000);
        timer.unref?.();
        this.eventCheckTimers.set(session.connectionKey, timer);
      }
    };

    const timer = setTimeout(run, 1000);
    timer.unref?.();
    this.eventCheckTimers.set(session.connectionKey, timer);
  }

  async #pollLocalHyperbee(session) {
    if (!this.hyperbeeAdapter?.hasReplica?.()) {
      return;
    }

    const snapshot = this.relayWebsocketController?.getSubscriptionSnapshot?.(session.connectionKey);
    if (!Array.isArray(snapshot) || snapshot.length === 0) {
      return;
    }

    for (const entry of snapshot) {
      const { subscriptionId, filters, lastReturnedAt } = entry;
      try {
        const queryResult = await this.hyperbeeAdapter.query(filters || []);
        const events = Array.isArray(queryResult?.events) ? queryResult.events : [];
        if (!events.length) continue;

        const filtered = events
          .filter((event) => {
            const createdAt = Number(event?.created_at ?? 0);
            if (!Number.isFinite(lastReturnedAt)) return true;
            return createdAt > lastReturnedAt;
          })
          .sort((a, b) => (a?.created_at || 0) - (b?.created_at || 0));

        if (!filtered.length || session.ws.readyState !== WebSocket.OPEN) {
          continue;
        }

        let newestTimestamp = Number.isFinite(lastReturnedAt) ? lastReturnedAt : null;
        for (const event of filtered) {
          const createdAt = Number(event?.created_at ?? 0);
          if (Number.isFinite(createdAt)) {
            newestTimestamp = newestTimestamp === null ? createdAt : Math.max(newestTimestamp, createdAt);
          }
          session.ws.send(JSON.stringify(['EVENT', subscriptionId, event]));
        }

        if (Number.isFinite(newestTimestamp)) {
          this.relayWebsocketController?.updateSubscriptionCursor?.(session.connectionKey, subscriptionId, newestTimestamp);
        }
      } catch (error) {
        this.logger.debug?.('Local Hyperbee poll failed', {
          relayKey: session.relayKey,
          subscriptionId,
          error: error?.message || error
        });
      }
    }
  }

  #getPeersFromRegistration(registration) {
    if (!registration) return [];
    const { peers } = registration;
    if (!peers) return [];
    if (Array.isArray(peers)) {
      return peers.filter(Boolean);
    }
    if (peers instanceof Set) {
      return Array.from(peers).filter(Boolean);
    }
    return [];
  }

  #supportsLocalRelay(registration) {
    if (!registration) return false;
    if (!this.relayHost) return false;
    const metadata = registration.metadata || {};
    const delegateReqToPeers = metadata.delegateReqToPeers === true
      || registration.gatewayReplica?.delegateReqToPeers === true;
    if (delegateReqToPeers) {
      const peerCount = this.#getPeersFromRegistration(registration).length;
      if (peerCount > 0) return false;
    }

    if (registration.relayKey === this.internalRelayKey) return true;
    if (registration.identifier === this.internalRelayKey) return true;
    if (metadata.identifier === this.internalRelayKey) return true;
    return metadata.isGatewayReplica === true;
  }

  #selectPeer(registration) {
    const peers = this.#getPeersFromRegistration(registration);
    if (!peers.length) return null;

    const relayKey = registration.relayKey || registration.identifier || peers[0];
    const currentIndex = this.relayPeerIndex.get(relayKey) || 0;
    const peerKey = peers[currentIndex % peers.length];
    this.relayPeerIndex.set(relayKey, (currentIndex + 1) % peers.length);

    return {
      peerKey,
      peers,
      index: peers.indexOf(peerKey)
    };
  }

  #currentPeer(session) {
    if (!session.peers?.length) return null;
    const idx = session.peerIndex % session.peers.length;
    return session.peers[idx];
  }

  #advancePeer(session) {
    if (!session.peers?.length) return;
    session.peerIndex = (session.peerIndex + 1) % session.peers.length;
    session.peerKey = this.#currentPeer(session);
  }

  async #withRelayPeerKey(relayKey, handler) {
    const registration = await this.registrationStore.getRelay(relayKey);
    if (!registration) {
      const error = new Error('Relay not registered with gateway');
      error.statusCode = 404;
      throw error;
    }

    const peers = this.#getPeersFromRegistration(registration);
    if (!peers.length) {
      const error = new Error('Relay has no available peers');
      error.statusCode = 503;
      throw error;
    }

    const startIndex = this.relayPeerIndex.get(relayKey) || 0;
    let lastError = null;

    for (let attempt = 0; attempt < peers.length; attempt += 1) {
      const index = (startIndex + attempt) % peers.length;
      const peerKey = peers[index];

      try {
        await this.connectionPool.getConnection(peerKey);
        this.relayPeerIndex.set(relayKey, (index + 1) % peers.length);
        return handler(peerKey, registration);
      } catch (error) {
        lastError = error;
        this.logger.warn?.('Failed to use peer for drive request', {
          relayKey,
          peerKey,
          error: error?.message || error
        });
      }
    }

    if (lastError) {
      throw lastError;
    }

    const error = new Error('No peers available for relay');
    error.statusCode = 503;
    throw error;
  }

  async #resolveRelayTarget(identifier) {
    if (!identifier) return null;

    const direct = await this.registrationStore.getRelay(identifier);
    if (direct) {
      const driveIdentifier = this.#extractDriveIdentifier(direct, identifier);
      if (!driveIdentifier) return null;
      return {
        relayKey: identifier,
        driveIdentifier
      };
    }

    const allKeys = typeof this.registrationStore.getAllRelayKeys === 'function'
      ? await this.registrationStore.getAllRelayKeys()
      : Array.from(this.registrationStore.items?.keys?.() || []);

    for (const relayKey of allKeys) {
      const registration = await this.registrationStore.getRelay(relayKey);
      if (!registration) continue;

      const driveIdentifier = this.#extractDriveIdentifier(registration, relayKey);
      if (!driveIdentifier) continue;

      if (identifier === driveIdentifier) {
        return { relayKey, driveIdentifier };
      }

      const gatewayPath = this.#toGatewayPath(driveIdentifier);
      if (gatewayPath && identifier === gatewayPath) {
        return { relayKey, driveIdentifier };
      }

      const metadataPath = this.#normalizePathValue(registration?.metadata?.gatewayPath);
      if (metadataPath) {
        if (identifier === metadataPath) {
          return { relayKey, driveIdentifier };
        }
        const colonFromMetadata = this.#toColonIdentifier(metadataPath);
        if (colonFromMetadata && identifier === colonFromMetadata) {
          return { relayKey, driveIdentifier: colonFromMetadata };
        }
      }

      const connectionUrl = registration?.metadata?.connectionUrl;
      if (connectionUrl) {
        try {
          const parsed = new URL(connectionUrl);
          const path = this.#normalizePathValue(parsed.pathname);
          if (path) {
            if (identifier === path) {
              return { relayKey, driveIdentifier };
            }
            const colonPath = this.#toColonIdentifier(path);
            if (colonPath && identifier === colonPath) {
              return { relayKey, driveIdentifier: colonPath };
            }
          }
        } catch (_) {}
      }
    }

    return null;
  }

  #extractDriveIdentifier(registration, fallbackKey) {
    const identifier = registration?.identifier || registration?.publicIdentifier;
    if (typeof identifier === 'string' && identifier.trim()) {
      return identifier.trim();
    }

    const gatewayPath = this.#normalizePathValue(registration?.metadata?.gatewayPath);
    if (gatewayPath) {
      const colon = this.#toColonIdentifier(gatewayPath);
      if (colon) return colon;
    }

    const fallback = typeof fallbackKey === 'string' && fallbackKey.trim()
      ? fallbackKey.trim()
      : null;
    if (fallback && fallback.includes(':')) return fallback;
    if (fallback) {
      const colonFallback = this.#toColonIdentifier(fallback);
      if (colonFallback) return colonFallback;
    }
    return fallback;
  }

  #normalizePathValue(value) {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  #toGatewayPath(identifier) {
    if (!identifier || typeof identifier !== 'string') return null;
    const trimmed = identifier.trim();
    if (!trimmed) return null;
    if (trimmed.includes('/')) {
      return this.#normalizePathValue(trimmed);
    }
    const idx = trimmed.indexOf(':');
    if (idx !== -1) {
      return `${trimmed.slice(0, idx)}/${trimmed.slice(idx + 1)}`;
    }
    return trimmed;
  }

  #toColonIdentifier(value) {
    if (!value || typeof value !== 'string') return null;
    const normalized = this.#normalizePathValue(value);
    if (!normalized) return null;
    if (normalized.includes(':')) return normalized;
    const idx = normalized.indexOf('/');
    if (idx !== -1) {
      return `${normalized.slice(0, idx)}:${normalized.slice(idx + 1)}`;
    }
    return normalized;
  }

  async #withPeer(session, handler, options = {}) {
    const sessionSupportsDelegation = session?.delegateReqToPeers === true
      && session.localOnly === true
      && Array.isArray(session.peers)
      && session.peers.length > 0;

    if (!session.peers?.length) {
      if (sessionSupportsDelegation) {
        this.logger?.debug?.('Delegated session waiting for peer availability', {
          relayKey: session?.relayKey,
          connectionKey: session?.connectionKey
        });
        throw new Error('delegated-session-awaiting-peer');
      }
      throw new Error('No peers registered for relay');
    }

    let attempts = 0;
    let lastError = null;

    const preferredPeer = options.preferredPeer;
    if (preferredPeer && session.peers.includes(preferredPeer)) {
      session.peerIndex = session.peers.indexOf(preferredPeer);
      session.peerKey = preferredPeer;
    }

    while (attempts < session.peers.length) {
      const peerKey = this.#currentPeer(session);
      if (!peerKey) break;

      try {
        const result = await handler(peerKey);
        session.peerKey = peerKey;
        this.logger.info?.('Peer operation succeeded', {
          relayKey: session.relayKey,
          peerKey
        });
        if (session.delegateReqToPeers) {
          session.localOnly = false;
          this.#cancelDelegationFallback(session);
        }
        return result;
      } catch (error) {
        lastError = error;
        this.logger.warn?.('Peer operation failed', {
          relayKey: session.relayKey,
          peerKey,
          error: error.message
        });
        this.logger.info?.('Advancing to next peer after failure', {
          relayKey: session.relayKey,
          previousPeer: peerKey
        });
        this.#advancePeer(session);
        attempts += 1;
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error('No peers available for relay');
  }

  #assignPeerForSubscription(session, peerKey, subscriptionId) {
    if (!peerKey) return;
    if (!Array.isArray(session.peers)) {
      session.peers = [];
    }
    if (!session.peers.includes(peerKey)) {
      session.peers.push(peerKey);
    }
    session.subscriptionPeers?.set?.(subscriptionId, peerKey);
    session.peerIndex = session.peers.indexOf(peerKey);
    session.peerKey = peerKey;
  }

  async #handlePeerTelemetry({ publicKey, payload }) {
    if (!publicKey || !payload) return;

    const metrics = {
      peerId: publicKey,
      latencyMs: Number(payload.latencyMs) || 0,
      inFlightJobs: Number(payload.inFlightJobs) || 0,
      failureRate: Number(payload.failureRate) || 0,
      hyperbeeVersion: payload.hyperbeeVersion,
      hyperbeeLag: payload.hyperbeeLag,
      queueDepth: payload.queueDepth,
      reportedAt: Number(payload.reportedAt) || Date.now(),
      tokenExpiresAt: payload.tokenExpiresAt
    };
    this.dispatcher?.reportPeerMetrics(publicKey, metrics);

    const entry = this.peerMetadata.get(publicKey) || {};
    entry.telemetry = payload;
    entry.lastTelemetryAt = Date.now();
    this.peerMetadata.set(publicKey, entry);

    const handshake = entry.handshake || {};
    const isReplica = handshake.gatewayReplica === true
      || handshake.role === 'gateway-replica'
      || payload.gatewayReplica === true;

    if (isReplica || payload.hyperbeeKey || payload.hyperbeeLag !== undefined) {
      const gatewayRelay = {
        hyperbeeKey: payload.hyperbeeKey || handshake.hyperbeeKey || null,
        discoveryKey: payload.hyperbeeDiscoveryKey || handshake.hyperbeeDiscoveryKey || null,
        replicationTopic: payload.replicationTopic || null
      };

      const replicaMetrics = {
        length: Number(payload.hyperbeeLength) || Number(handshake.hyperbeeLength) || 0,
        contiguousLength: Number(payload.hyperbeeContiguousLength) || Number(handshake.hyperbeeContiguousLength) || 0,
        lag: Number(payload.hyperbeeLag) || Number(handshake.hyperbeeLag) || 0,
        version: Number(payload.hyperbeeVersion) || Number(handshake.hyperbeeVersion) || 0,
        updatedAt: Number(payload.hyperbeeLastUpdatedAt) || Number(payload.reportedAt) || Date.now()
      };

      const delegateReqToPeers = typeof payload.delegateReqToPeers === 'boolean'
        ? payload.delegateReqToPeers
        : (typeof handshake.delegateReqToPeers === 'boolean' ? handshake.delegateReqToPeers : null);

      try {
        await this.#upsertInternalReplicaPeer(publicKey, {
          gatewayRelay,
          replicaMetrics,
          replicaTelemetry: payload,
          delegateReqToPeers
        });
        this.#emitPublicGatewayStatus();
      } catch (error) {
        this.logger?.warn?.('Failed to update replica telemetry for peer', {
          peer: publicKey,
          error: error?.message || error
        });
      }
    }
  }

  #getRelayHostInfo() {
    if (!this.relayHost) {
      return null;
    }
    const registrationConfig = this.config.registration || {};
    const dispatcherConfig = this.config.dispatcher || {};
    const sanitizePositive = (value) => {
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) return null;
      return Math.round(num);
    };
    const dispatcherInfo = {
      maxConcurrentJobsPerPeer: sanitizePositive(dispatcherConfig.maxConcurrentJobsPerPeer),
      inFlightWeight: sanitizePositive(dispatcherConfig.inFlightWeight),
      latencyWeight: sanitizePositive(dispatcherConfig.latencyWeight),
      failureWeight: sanitizePositive(dispatcherConfig.failureWeight),
      reassignOnLagBlocks: sanitizePositive(dispatcherConfig.reassignOnLagBlocks),
      circuitBreakerThreshold: sanitizePositive(dispatcherConfig.circuitBreakerThreshold),
      circuitBreakerDurationMs: sanitizePositive(dispatcherConfig.circuitBreakerDurationMs)
    };
    const hasDispatcher = Object.values(dispatcherInfo).some((value) => value !== null);

    return {
      hyperbeeKey: this.relayHost.getPublicKey(),
      discoveryKey: this.relayHost.getDiscoveryKey(),
      replicationTopic: this.relayConfig?.replicationTopic || null,
      defaultTokenTtl: sanitizePositive(registrationConfig.defaultTokenTtl),
      tokenRefreshWindowSeconds: sanitizePositive(registrationConfig.tokenRefreshWindowSeconds),
      dispatcher: hasDispatcher ? dispatcherInfo : null
    };
  }

  #coerceTimestamp(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  #emitPublicGatewayStatus() {
    this.publicGatewayStatusUpdatedAt = Date.now();
    if (!this.logger?.debug) return;

    let relayCount;
    const storeItems = this.registrationStore?.items;
    if (storeItems && typeof storeItems.size === 'number') {
      relayCount = storeItems.size;
    }

    const peerCount = (() => {
      try {
        return this.connectionPool?.connections?.size;
      } catch (_) {
        return undefined;
      }
    })();

    this.logger.debug('[PublicGateway] Replica status updated', {
      relayCount,
      peerCount,
      updatedAt: this.publicGatewayStatusUpdatedAt
    });
  }

  #verifySignedPayload(payload, signature) {
    if (!this.sharedSecret) return false;
    if (!payload || typeof payload !== 'object' || !signature) return false;
    try {
      return verifySignature(payload, signature, this.sharedSecret);
    } catch (error) {
      this.logger?.warn?.('Signed payload verification failed', { error: error?.message || error });
      return false;
    }
  }

  async #handleTokenIssue(req, res) {
    if (!this.tokenService) {
      return res.status(503).json({ error: 'Token service disabled' });
    }
    const { payload, signature } = req.body || {};
    if (!this.#verifySignedPayload(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const relayKey = payload?.relayKey;
    const relayAuthToken = payload?.relayAuthToken;
    if (!relayKey || !relayAuthToken) {
      return res.status(400).json({ error: 'relayKey and relayAuthToken are required' });
    }

    try {
      const result = await this.tokenService.issueToken(relayKey, {
        relayAuthToken,
        pubkey: payload?.pubkey || null,
        scope: payload?.scope,
        ttlSeconds: payload?.ttlSeconds
      });
      this.tokenMetrics.issueCounter.inc({ result: 'success' });
      return res.json(result);
    } catch (error) {
      this.logger?.error?.('Failed to issue relay token', {
        relayKey,
        error: error?.message || error
      });
      this.tokenMetrics.issueCounter.inc({ result: 'error' });
      return res.status(400).json({ error: error?.message || 'Failed to issue token' });
    }
  }

  async #handleTokenRefresh(req, res) {
    if (!this.tokenService) {
      return res.status(503).json({ error: 'Token service disabled' });
    }
    const { payload, signature } = req.body || {};
    if (!this.#verifySignedPayload(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const relayKey = payload?.relayKey;
    const token = payload?.token;
    if (!relayKey || !token) {
      return res.status(400).json({ error: 'relayKey and token are required' });
    }

    try {
      const result = await this.tokenService.refreshToken(relayKey, {
        token,
        ttlSeconds: payload?.ttlSeconds
      });
      this.tokenMetrics.refreshCounter.inc({ result: 'success' });
      return res.json(result);
    } catch (error) {
      this.logger?.warn?.('Failed to refresh relay token', {
        relayKey,
        error: error?.message || error
      });
      this.tokenMetrics.refreshCounter.inc({ result: 'error' });
      return res.status(400).json({ error: error?.message || 'Failed to refresh token' });
    }
  }

  async #handleTokenRevoke(req, res) {
    if (!this.tokenService) {
      return res.status(503).json({ error: 'Token service disabled' });
    }
    const { payload, signature } = req.body || {};
    if (!this.#verifySignedPayload(payload, signature)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const relayKey = payload?.relayKey;
    if (!relayKey) {
      return res.status(400).json({ error: 'relayKey is required' });
    }

    try {
      const result = await this.tokenService.revokeToken(relayKey, { reason: payload?.reason });
      this.tokenMetrics.revokeCounter.inc({ result: 'success' });
      const disconnected = this.#broadcastTokenRevocation(relayKey, {
        reason: payload?.reason || null,
        sequence: result?.sequence || null
      });
      return res.json({ status: 'revoked', disconnected, sequence: result?.sequence || null });
    } catch (error) {
      this.logger?.warn?.('Failed to revoke relay token', {
        relayKey,
        error: error?.message || error
      });
      this.tokenMetrics.revokeCounter.inc({ result: 'error' });
      return res.status(400).json({ error: error?.message || 'Failed to revoke token' });
    }
  }

  #broadcastTokenRevocation(relayKey, { reason, sequence } = {}) {
    let disconnected = 0;
    for (const [connectionKey, session] of this.sessions.entries()) {
      if (session.relayKey !== relayKey) continue;
      disconnected += 1;
      if (session.ws?.readyState === WebSocket.OPEN) {
        const controlFrame = ['TOKEN', 'REVOKED', {
          reason: reason || 'revoked',
          sequence: sequence || null
        }];
        try {
          session.ws.send(JSON.stringify(controlFrame));
        } catch (error) {
          this.logger?.debug?.('Failed to send token revocation control frame', {
            relayKey,
            error: error?.message || error
          });
        }
        try {
          session.ws.close(4403, 'Token revoked');
        } catch (_) {}
      }
      this.#cleanupSession(connectionKey);
    }
    return disconnected;
  }

  async #handleGatewayHyperswarmRegistration(peerKey, request) {
    const method = typeof request?.method === 'string' ? request.method.toUpperCase() : 'GET';
    if (method !== 'POST') {
      return {
        statusCode: 405,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ error: 'method-not-allowed' }))
      };
    }

    let payload = {};
    if (request?.body && request.body.length) {
      try {
        payload = JSON.parse(Buffer.from(request.body).toString());
      } catch (error) {
        this.logger.warn?.('Failed to parse Hyperswarm registration payload', {
          peer: peerKey,
          error: error?.message || error
        });
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ error: 'invalid-json' }))
        };
      }
    }

    if (!payload || typeof payload !== 'object') {
      payload = {};
    }

    payload.publicKey = payload.publicKey || peerKey;

    const now = Date.now();
    const relays = Array.isArray(payload.relays) ? payload.relays : [];

    for (const entry of relays) {
      let relayKey = null;
      let relayPayload = entry;
      if (typeof entry === 'string') {
        relayKey = entry;
        relayPayload = { identifier: entry };
      } else if (entry && typeof entry === 'object') {
        relayKey = entry.identifier || entry.relayKey || null;
      }
      if (!relayKey) continue;

      try {
        await this.#mergeRelayRegistration(relayKey, peerKey, relayPayload, payload.gatewayReplica, now);
      } catch (error) {
        this.logger.error?.('Failed to merge relay registration from peer', {
          relayKey,
          peer: peerKey,
          error: error?.message || error
        });
      }
    }

    if (payload.gatewayReplica && typeof payload.gatewayReplica === 'object') {
      const gatewayRelay = {
        hyperbeeKey: payload.gatewayReplica.hyperbeeKey || null,
        discoveryKey: payload.gatewayReplica.discoveryKey || null,
        replicationTopic: payload.gatewayReplica.replicationTopic || null
      };
      const replicaMetrics = {
        length: Number(payload.gatewayReplica.length) || 0,
        contiguousLength: Number(payload.gatewayReplica.contiguousLength) || 0,
        lag: Number(payload.gatewayReplica.lag) || 0,
        version: Number(payload.gatewayReplica.version) || 0,
        updatedAt: Number(payload.gatewayReplica.updatedAt) || now
      };
      const replicaTelemetry = payload.gatewayReplica.telemetry || null;
      const delegateReqToPeers = typeof payload.gatewayReplica.delegateReqToPeers === 'boolean'
        ? payload.gatewayReplica.delegateReqToPeers
        : null;

      await this.#upsertInternalReplicaPeer(peerKey, {
        gatewayRelay,
        replicaMetrics,
        replicaTelemetry,
        delegateReqToPeers
      });
    }

    const peerEntry = this.peerMetadata.get(peerKey) || {};
    peerEntry.registration = payload;
    peerEntry.lastRegistrationAt = now;
    this.peerMetadata.set(peerKey, peerEntry);

    this.#emitPublicGatewayStatus();

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        status: 'ok',
        hyperbee: this.#getRelayHostInfo()
      }))
    };
  }

  async #mergeRelayRegistration(relayKey, peerKey, relayPayload = {}, globalReplicaPayload = null, now = Date.now()) {
    if (!relayKey || !peerKey) return;

    const existing = await this.registrationStore.getRelay(relayKey);
    const peers = new Set(Array.isArray(existing?.peers) ? existing.peers : []);
    peers.add(peerKey);

    const metadata = { ...(existing?.metadata || {}) };
    metadata.identifier = metadata.identifier || relayKey;

    const maybeString = (value) => (typeof value === 'string' && value.trim().length ? value.trim() : null);

    const name = maybeString(relayPayload?.name);
    if (name) metadata.name = name;

    if (relayPayload?.description !== undefined) {
      const desc = maybeString(relayPayload.description);
      metadata.description = desc || null;
    }

    const avatar = maybeString(relayPayload?.avatarUrl);
    if (avatar !== null) {
      metadata.avatarUrl = avatar;
    } else if (relayPayload?.avatarUrl === null) {
      metadata.avatarUrl = null;
    }

    const gatewayPath = maybeString(relayPayload?.gatewayPath);
    if (gatewayPath) {
      metadata.gatewayPath = gatewayPath;
    }

    if (typeof relayPayload?.isPublic === 'boolean') {
      metadata.isPublic = relayPayload.isPublic;
    }

    if (typeof relayPayload?.isGatewayReplica === 'boolean') {
      metadata.isGatewayReplica = relayPayload.isGatewayReplica;
    }

    const incomingTimestamp = this.#coerceTimestamp(relayPayload?.metadataUpdatedAt);
    const existingTimestamp = this.#coerceTimestamp(metadata.metadataUpdatedAt);
    if (incomingTimestamp !== null) {
      if (existingTimestamp === null || incomingTimestamp >= existingTimestamp) {
        metadata.metadataUpdatedAt = incomingTimestamp;
      }
    }

    if (relayPayload?.metadataEventId) {
      metadata.metadataEventId = relayPayload.metadataEventId;
    }

    if (relayPayload?.gatewayRelay && typeof relayPayload.gatewayRelay === 'object') {
      metadata.gatewayRelay = {
        ...(metadata.gatewayRelay || {}),
        ...relayPayload.gatewayRelay
      };
    }

    if (relayPayload?.replicaMetrics && typeof relayPayload.replicaMetrics === 'object') {
      metadata.replicaMetrics = {
        ...(metadata.replicaMetrics || {}),
        ...relayPayload.replicaMetrics,
        peerId: peerKey,
        updatedAt: now
      };
    }

    if (relayPayload?.replicaTelemetry && typeof relayPayload.replicaTelemetry === 'object') {
      metadata.replicaTelemetry = relayPayload.replicaTelemetry;
    }

    if (typeof relayPayload?.delegateReqToPeers === 'boolean') {
      metadata.delegateReqToPeers = relayPayload.delegateReqToPeers;
    }

    metadata.lastPeerUpdateAt = now;

    const record = {
      relayKey,
      peers: Array.from(peers),
      metadata,
      registeredAt: existing?.registeredAt || now,
      updatedAt: now
    };

    if (metadata.isGatewayReplica) {
      const gatewayReplica = { ...(existing?.gatewayReplica || {}) };
      gatewayReplica.peerId = peerKey;
      gatewayReplica.updatedAt = now;

      if (metadata.gatewayRelay) {
        Object.assign(gatewayReplica, metadata.gatewayRelay);
      }

      if (globalReplicaPayload && typeof globalReplicaPayload === 'object') {
        if (globalReplicaPayload.hyperbeeKey) {
          gatewayReplica.hyperbeeKey = globalReplicaPayload.hyperbeeKey;
        }
        if (globalReplicaPayload.discoveryKey) {
          gatewayReplica.discoveryKey = globalReplicaPayload.discoveryKey;
        }
        if (typeof globalReplicaPayload.delegateReqToPeers === 'boolean') {
          gatewayReplica.delegateReqToPeers = globalReplicaPayload.delegateReqToPeers;
        }
        if (globalReplicaPayload.telemetry && typeof globalReplicaPayload.telemetry === 'object') {
          gatewayReplica.telemetry = globalReplicaPayload.telemetry;
        }

        const replicaMetrics = {};
        const toNumber = (value) => {
          const num = Number(value);
          return Number.isFinite(num) ? num : null;
        };
        const lengthVal = toNumber(globalReplicaPayload.length);
        if (lengthVal !== null) replicaMetrics.length = lengthVal;
        const contiguousVal = toNumber(globalReplicaPayload.contiguousLength);
        if (contiguousVal !== null) replicaMetrics.contiguousLength = contiguousVal;
        const lagVal = toNumber(globalReplicaPayload.lag);
        if (lagVal !== null) replicaMetrics.lag = lagVal;
        const versionVal = toNumber(globalReplicaPayload.version);
        if (versionVal !== null) replicaMetrics.version = versionVal;
        const updatedVal = toNumber(globalReplicaPayload.updatedAt);
        if (updatedVal !== null) replicaMetrics.updatedAt = updatedVal;

        if (Object.keys(replicaMetrics).length) {
          gatewayReplica.metrics = {
            ...(gatewayReplica.metrics || {}),
            ...replicaMetrics,
            peerId: peerKey,
            reportedAt: now
          };
        }
      }

      if (metadata.replicaMetrics) {
        gatewayReplica.metrics = {
          ...(gatewayReplica.metrics || {}),
          ...metadata.replicaMetrics
        };
      }

      if (metadata.replicaTelemetry) {
        gatewayReplica.telemetry = metadata.replicaTelemetry;
      }

      record.gatewayReplica = gatewayReplica;
    } else if (existing?.gatewayReplica) {
      record.gatewayReplica = existing.gatewayReplica;
    }

    await this.registrationStore.upsertRelay(relayKey, record);
  }

  async #upsertInternalReplicaPeer(peerKey, { gatewayRelay = {}, replicaMetrics = null, replicaTelemetry = null, delegateReqToPeers = null } = {}) {
    const relayKey = this.internalRelayKey;
    const payload = {
      identifier: relayKey,
      isGatewayReplica: true,
      gatewayRelay,
      replicaMetrics,
      replicaTelemetry,
      delegateReqToPeers
    };
    await this.#mergeRelayRegistration(relayKey, peerKey, payload, {
      hyperbeeKey: gatewayRelay?.hyperbeeKey,
      discoveryKey: gatewayRelay?.discoveryKey,
      length: replicaMetrics?.length,
      contiguousLength: replicaMetrics?.contiguousLength,
      lag: replicaMetrics?.lag,
      version: replicaMetrics?.version,
      updatedAt: replicaMetrics?.updatedAt,
      telemetry: replicaTelemetry,
      delegateReqToPeers
    });
  }

  async #handleRelayRegistration(req, res) {
    if (!this.sharedSecret) {
      return res.status(503).json({ error: 'Registration disabled' });
    }

    const { registration, signature } = req.body || {};
    if (!registration || !signature) {
      return res.status(400).json({ error: 'Missing registration payload or signature' });
    }

    if (!registration.relayKey) {
      return res.status(400).json({ error: 'relayKey is required' });
    }

    const valid = verifySignature(registration, signature, this.sharedSecret);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
      await this.registrationStore.upsertRelay(registration.relayKey, registration);
      this.logger.info?.('Relay registration accepted', { relayKey: registration.relayKey });
      const hyperbeeInfo = this.#getRelayHostInfo();
      return res.json({
        status: 'ok',
        hyperbee: hyperbeeInfo
      });
    } catch (error) {
      this.logger.error?.('Failed to persist relay registration', { relayKey: registration.relayKey, error: error.message });
      return res.status(500).json({ error: 'Failed to persist registration' });
    }
  }

  async #handleRelayDeletion(req, res) {
    if (!this.sharedSecret) {
      return res.status(503).json({ error: 'Registration disabled' });
    }

    const relayKey = req.params?.relayKey;
    if (!relayKey) {
      return res.status(400).json({ error: 'relayKey param is required' });
    }

    const signature = req.headers['x-signature'];
    if (!signature) {
      return res.status(401).json({ error: 'Missing signature' });
    }

    const valid = verifySignature({ relayKey }, signature, this.sharedSecret);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid signature' });
    }

    try {
      await this.registrationStore.removeRelay(relayKey);
      this.logger.info?.('Relay unregistered', { relayKey });
      return res.json({ status: 'ok' });
    } catch (error) {
      this.logger.error?.('Failed to unregister relay', { relayKey, error: error.message });
      return res.status(500).json({ error: 'Failed to unregister relay' });
    }
  }

  #parseWebSocketRequest(req) {
    const base = this.config.publicBaseUrl || 'https://hypertuna.com';
    const parsed = new URL(req.url, base);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const relayKey = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : parts[0] || null;
    const token = parsed.searchParams.get('token');
    return { relayKey, token };
  }

  async #validateToken(token, relayKey) {
    if (this.tokenService) {
      try {
        return await this.tokenService.verifyToken(token, relayKey);
      } catch (error) {
        this.logger.warn?.('Token verification failed', {
          relayKey,
          error: error?.message || error
        });
        return null;
      }
    }

    const payload = verifyClientToken(token, this.sharedSecret);
    if (!payload) {
      this.logger.warn?.('Token verification failed - signature mismatch', { relayKey });
      return null;
    }

    if (payload.relayKey && payload.relayKey !== relayKey) {
      this.logger.warn?.('Token verification failed - relay mismatch', {
        relayKey,
        tokenRelayKey: payload.relayKey
      });
      return null;
    }

    if (payload.expiresAt && payload.expiresAt < Date.now()) {
      this.logger.warn?.('Token verification failed - token expired', {
        relayKey,
        expiresAt: payload.expiresAt
      });
      return null;
    }

    if (!payload.relayAuthToken || typeof payload.relayAuthToken !== 'string') {
      this.logger.warn?.('Token verification failed - missing relay auth token', { relayKey });
      return null;
    }

    return {
      payload,
      relayAuthToken: payload.relayAuthToken,
      pubkey: payload.pubkey || null,
      scope: payload.scope || null
    };
  }

  #onProtocolCreated({ publicKey, protocol }) {
    if (!protocol || !publicKey) return;

    protocol.handle('/gateway/register', async (request) => {
      try {
        return await this.#handleGatewayHyperswarmRegistration(publicKey, request);
      } catch (error) {
        this.logger.error?.('Hyperswarm registration handler failed', {
          peer: publicKey,
          error: error?.message || error
        });
        return {
          statusCode: 500,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ error: 'registration-failed' }))
        };
      }
    });

    const cleanup = () => {
      this.peerMetadata.delete(publicKey);
      this.#detachHyperbeeReplication(publicKey);
    };
    protocol.once('close', cleanup);
    protocol.once('destroy', cleanup);
  }

  #buildHandshakePayload({ isServer }) {
    const payload = {
      role: 'gateway',
      isGateway: true,
      gatewayReplica: false,
      dispatcherEnabled: !!this.featureFlags?.dispatcherEnabled,
      hyperbeeRelayEnabled: this.#isHyperbeeRelayEnabled(),
      isServer: !!isServer
    };

    if (typeof this.relayHost?.getPublicKey === 'function') {
      payload.hyperbeeKey = this.relayHost.getPublicKey();
    }
    if (typeof this.relayHost?.getDiscoveryKey === 'function') {
      payload.hyperbeeDiscoveryKey = this.relayHost.getDiscoveryKey();
    }

    const core = typeof this.relayHost?.getCore === 'function' ? this.relayHost.getCore() : null;
    if (core) {
      const length = typeof core.length === 'number' ? core.length : 0;
      const contiguous = typeof core.contiguousLength === 'number' ? core.contiguousLength : length;
      payload.hyperbeeLength = length;
      payload.hyperbeeContiguousLength = contiguous;
      payload.hyperbeeLag = Math.max(0, length - contiguous);
      payload.hyperbeeUpdatedAt = core?.header?.timestamp || null;
    }

    const hyperbee = this.hyperbeeAdapter?.hyperbee || null;
    if (hyperbee) {
      payload.hyperbeeVersion = hyperbee.version || 0;
    }

    return payload;
  }

  #onProtocolHandshake({ publicKey, protocol, handshake, stage = 'open' }) {
    if (!publicKey || !handshake) return;

    this.logger.debug?.('[PublicGateway] Hyperswarm handshake event', {
      peer: publicKey,
      stage,
      role: handshake?.role ?? 'unknown',
      isGateway: handshake?.isGateway ?? 'unknown'
    });

    const entry = this.peerMetadata.get(publicKey) || {};
    entry.handshake = handshake;
    entry.lastHandshakeAt = Date.now();
    this.peerMetadata.set(publicKey, entry);

    const isReplica = handshake.gatewayReplica === true
      || handshake.role === 'gateway-replica'
      || handshake.gatewayReplica === 'true'
      || handshake.gatewayReplica === 1;

    if (isReplica) {
      const gatewayRelay = {
        hyperbeeKey: handshake.hyperbeeKey || null,
        discoveryKey: handshake.hyperbeeDiscoveryKey || null
      };
      const replicaMetrics = {
        length: Number(handshake.hyperbeeLength) || 0,
        contiguousLength: Number(handshake.hyperbeeContiguousLength) || 0,
        lag: Number(handshake.hyperbeeLag) || 0,
        version: Number(handshake.hyperbeeVersion) || 0,
        updatedAt: Number(handshake.hyperbeeUpdatedAt) || Date.now()
      };
      const replicaTelemetry = handshake.telemetry && typeof handshake.telemetry === 'object'
        ? handshake.telemetry
        : null;
      const delegateReqToPeers = typeof handshake.delegateReqToPeers === 'boolean'
        ? handshake.delegateReqToPeers
        : null;

      this.#upsertInternalReplicaPeer(publicKey, {
        gatewayRelay,
        replicaMetrics,
        replicaTelemetry,
        delegateReqToPeers
      }).then(() => {
        this.#emitPublicGatewayStatus();
      }).catch((error) => {
        this.logger?.warn?.('Failed to apply replica data from handshake', {
          peer: publicKey,
          error: error?.message || error
        });
      });

      this.#attachHyperbeeReplication(publicKey, protocol, handshake).catch((error) => {
        this.logger?.warn?.('[PublicGateway] Failed to initialise replication channel', {
          peer: publicKey,
          error: error?.message || error
        });
      });

      if (delegateReqToPeers === true) {
        this.#updateSessionsForDelegation({
          peerKey: publicKey,
          delegate: true
        });
      }

      this.#promoteDelegatedSessions(publicKey).catch((error) => {
        this.logger?.warn?.('Failed to promote delegated sessions to peer', {
          peer: publicKey,
          error: error?.message || error
        });
      });

      this.dispatcher?.reportPeerMetrics(publicKey, {
        peerId: publicKey,
        latencyMs: Number(handshake.latencyMs) || 0,
        inFlightJobs: Number(handshake.inFlightJobs) || 0,
        failureRate: Number(handshake.failureRate) || 0,
        hyperbeeVersion: Number(handshake.hyperbeeVersion) || 0,
        hyperbeeLag: Number(handshake.hyperbeeLag) || 0,
        queueDepth: Number(handshake.queueDepth) || 0,
        reportedAt: Date.now()
      });
    }
  }

  #collectMetrics() {
    sessionGauge.set(this.sessions.size);
    peerGauge.set(this.connectionPool.connections.size);
  }

  async #promoteDelegatedSessions(peerKey) {
    if (!peerKey || !this.sessions.size) return;

    for (const session of this.sessions.values()) {
      if (!session || session.relayKey !== this.internalRelayKey) continue;
      if (!session?.delegateReqToPeers) continue;
      if (session.localOnly !== true) continue;
      if (!session.ws || session.ws.readyState !== WebSocket.OPEN) continue;
      if (!session.peers || !Array.isArray(session.peers)) {
        session.peers = [];
      }
      if (!session.peers.includes(peerKey)) {
        session.peers.push(peerKey);
      }

      session.peerKey = peerKey;
      session.peerIndex = session.peers.indexOf(peerKey);

      session.localOnly = false;
      await this.#flushPendingDelegatedMessages(session, peerKey);

      const snapshots = this.relayWebsocketController?.getSubscriptionSnapshot(session.connectionKey) || [];
      if (!snapshots.length) {
        continue;
      }

      for (const snapshot of snapshots) {
        if (!snapshot?.subscriptionId || !Array.isArray(snapshot.filters)) continue;

        const filters = snapshot.filters.map((filter) => this.#cloneDelegatedFilter(filter, snapshot.lastReturnedAt)).filter(Boolean);
        if (!filters.length) continue;

        const frame = ['REQ', snapshot.subscriptionId, ...filters];
        try {
          await this.#forwardLegacyMessage(session, JSON.stringify(frame), peerKey, {
            subscriptionId: snapshot.subscriptionId
          });
          session.assignPeer?.(peerKey, snapshot.subscriptionId);
        } catch (error) {
          this.logger?.warn?.('Failed to delegate subscription to peer', {
            relayKey: session.relayKey,
            connectionKey: session.connectionKey,
            subscriptionId: snapshot.subscriptionId,
            peerKey,
            error: error?.message || error
          });
        }
      }
    }
  }

  #cloneDelegatedFilter(filter, lastReturnedAt = null) {
    if (!filter || typeof filter !== 'object') return null;
    let clone;
    try {
      clone = JSON.parse(JSON.stringify(filter));
    } catch (_) {
      clone = { ...filter };
      for (const key of Object.keys(clone)) {
        if (Array.isArray(clone[key])) {
          clone[key] = [...clone[key]];
        }
      }
    }

    if (Number.isFinite(lastReturnedAt)) {
      const exclusiveCursor = lastReturnedAt + 1;
      const existingSince = Number(clone.since);
      if (!Number.isFinite(existingSince) || existingSince < exclusiveCursor) {
        clone.since = exclusiveCursor;
      }
      if (Number.isFinite(clone.until) && clone.until < clone.since) {
        delete clone.until;
      }
    }

    return clone;
  }

  #scheduleDelegationFallback(session) {
    if (!session || session.delegateReqToPeers !== true) return;
    if (!Array.isArray(session.pendingDelegatedMessages) || !session.pendingDelegatedMessages.length) return;
    const connectionKey = session.connectionKey;
    if (this.delegationFallbackTimers.has(connectionKey)) return;
    const timer = setTimeout(async () => {
      this.delegationFallbackTimers.delete(connectionKey);
      if (!this.sessions.has(connectionKey)) return;
      if (session.delegateReqToPeers !== true) return;
      if (!Array.isArray(session.pendingDelegatedMessages) || !session.pendingDelegatedMessages.length) return;
      this.logger?.debug?.('[PublicGateway] Delegation fallback triggered', {
        relayKey: session.relayKey,
        connectionKey
      });
      await this.#fallbackToLocal(session);
    }, DELEGATION_FALLBACK_MS);
    timer.unref?.();
    this.delegationFallbackTimers.set(connectionKey, timer);
  }

  #cancelDelegationFallback(session) {
    if (!session) return;
    const connectionKey = session.connectionKey;
    const timer = this.delegationFallbackTimers.get(connectionKey);
    if (timer) {
      clearTimeout(timer);
      this.delegationFallbackTimers.delete(connectionKey);
    }
  }

  async #fallbackToLocal(session) {
    if (!session) return;
    if (!Array.isArray(session.pendingDelegatedMessages) || !session.pendingDelegatedMessages.length) return;
    this.#cancelDelegationFallback(session);
    this.logger?.info?.('[PublicGateway] Delegation fallback to local processing', {
      relayKey: session.relayKey,
      connectionKey: session.connectionKey,
      queued: session.pendingDelegatedMessages.length
    });
    const pending = session.pendingDelegatedMessages.splice(0);
    session.localOnly = true;
    for (const entry of pending) {
      try {
        await this.relayWebsocketController?.handleMessage(session, entry.message);
      } catch (error) {
        this.logger?.warn?.('[PublicGateway] Delegation fallback handling failed', {
          relayKey: session.relayKey,
          connectionKey: session.connectionKey,
          error: error?.message || error
        });
      }
    }
  }

  #updateSessionsForDelegation({ peerKey = null, delegate = false } = {}) {
    if (!delegate) return;
    for (const session of this.sessions.values()) {
      if (!session || session.relayKey !== this.internalRelayKey) continue;
      if (!Array.isArray(session.peers)) {
        session.peers = [];
      }
      if (peerKey && !session.peers.includes(peerKey)) {
        session.peers.push(peerKey);
      }
      if (!session.delegateReqToPeers) {
        session.delegateReqToPeers = true;
      }
      if (session.localOnly && session.peers.length) {
        session.localOnly = false;
      }
      if (Array.isArray(session.pendingDelegatedMessages) && session.pendingDelegatedMessages.length) {
        this.#cancelDelegationFallback(session);
        this.#flushPendingDelegatedMessages(session, peerKey).catch((error) => {
          this.logger?.debug?.('[PublicGateway] Failed to flush pending delegated messages after enabling delegation', {
            relayKey: session.relayKey,
            connectionKey: session.connectionKey,
            error: error?.message || error
          });
        });
      } else {
        this.#cancelDelegationFallback(session);
      }
    }
  }

  async #attachHyperbeeReplication(publicKey, protocol, handshake = {}) {
    if (!this.relayHost?.getCore || typeof this.relayHost.getCore !== 'function') return;
    if (!protocol) return;

    const hostKey = this.relayHost.getPublicKey?.();
    if (hostKey && handshake?.hyperbeeKey && handshake.hyperbeeKey !== hostKey) {
      this.logger?.debug?.('[PublicGateway] Replica handshake hyperbee key mismatch, skipping replication', {
        peer: publicKey,
        expected: hostKey,
        received: handshake.hyperbeeKey
      });
      return;
    }

    const core = this.relayHost.getCore();
    if (!core) {
      this.logger?.warn?.('[PublicGateway] Hyperbee relay core unavailable for replication', { peer: publicKey });
      return;
    }

    if (this.peerHyperbeeReplications.has(publicKey)) {
      this.logger?.debug?.('[PublicGateway] Replication already active for peer', { peer: publicKey });
      return;
    }

    const isInitiator = protocol?.mux?.stream?.isInitiator === true;
    const discoveryKey = this.relayHost.getDiscoveryKey?.();

    try {
      const { channel, stream, remoteHandshake } = await openHyperbeeReplicationChannel({
        protocol,
        hyperbeeKey: hostKey,
        discoveryKey,
        isInitiator,
        role: 'gateway',
        replicationMode: 'upload',
        logger: this.logger
      });

      this.logger?.info?.('[PublicGateway] Outbound Hyperbee replication channel ready', {
        peer: publicKey,
        hyperbeeKey: hostKey,
        isInitiator,
        remoteHandshake
      });

      if (remoteHandshake?.version && remoteHandshake.version !== 1) {
        this.logger?.warn?.('[PublicGateway] Remote replication channel version mismatch', {
          peer: publicKey,
          expected: 1,
          received: remoteHandshake.version
        });
      }

      let replication;
      try {
        replication = core.replicate(isInitiator, {
          live: true,
          download: false,
          upload: true
        });
      } catch (error) {
        try {
          channel.close();
        } catch (_) {}
        throw error;
      }

      replication.on('handshake', () => {
        this.logger?.debug?.('[PublicGateway] Hyperbee replication handshake (outbound)', {
          peer: publicKey,
          isInitiator,
          localLength: core.length,
          remoteLength: core.remoteLength
        });
      });

      replication.on('error', (error) => {
        this.logger?.warn?.('[PublicGateway] Hyperbee replication error (outbound)', {
          peer: publicKey,
          error: error?.message || error
        });
      });
      replication.once('close', () => {
        this.logger?.debug?.('[PublicGateway] Hyperbee replication stream closed (outbound)', {
          peer: publicKey,
          isInitiator
        });
      });

      stream.pipe(replication).pipe(stream);

      this.peerHyperbeeReplications.set(publicKey, { replication, stream, channel, remoteHandshake });

      channel.fullyClosed().then(() => {
        const entry = this.peerHyperbeeReplications.get(publicKey);
        if (entry?.channel === channel) {
          this.peerHyperbeeReplications.delete(publicKey);
        }
      }).catch(() => {});
    } catch (error) {
      this.logger?.warn?.('[PublicGateway] Failed to attach Hyperbee replication stream', {
        peer: publicKey,
        error: error?.message || error
      });
    }
  }

  #detachHyperbeeReplication(publicKey) {
    if (!this.peerHyperbeeReplications.has(publicKey)) return;
    const entry = this.peerHyperbeeReplications.get(publicKey);
    try {
      entry?.replication?.end?.();
      entry?.replication?.destroy?.();
    } catch (_) {}
    try {
      entry?.stream?.destroy?.();
    } catch (_) {}
    try {
      entry?.channel?.close?.();
    } catch (_) {}
    this.peerHyperbeeReplications.delete(publicKey);
  }
}

export default PublicGatewayService;
