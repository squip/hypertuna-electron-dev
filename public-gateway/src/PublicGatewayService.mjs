import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
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
import {
  verifySignature,
  verifyClientToken
} from '../../shared/auth/PublicGatewayTokens.mjs';
import { metricsMiddleware, sessionGauge, peerGauge, requestCounter } from './metrics.mjs';
import MemoryRegistrationStore from './stores/MemoryRegistrationStore.mjs';
import MessageQueue from './utils/MessageQueue.mjs';

class PublicGatewayService {
  constructor({ config, logger, tlsOptions = null, registrationStore }) {
    this.config = config;
    this.logger = logger;
    this.tlsOptions = tlsOptions;
    this.registrationStore = registrationStore || new MemoryRegistrationStore(config.registration?.cacheTtlSeconds);
    this.sharedSecret = config.registration?.sharedSecret || null;

    this.app = express();
    this.server = null;
    this.wss = null;
    this.connectionPool = new EnhancedHyperswarmPool({
      logger: this.logger,
      onProtocol: this.#onProtocolCreated.bind(this),
      onHandshake: this.#onProtocolHandshake.bind(this)
    });

    this.sessions = new Map();
    this.healthInterval = null;
    this.pruneInterval = null;
    this.eventCheckTimers = new Map();
    this.relayPeerIndex = new Map();
  }

  async init() {
    this.#setupHttpServer();
    await this.connectionPool.initialize();
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

    await this.connectionPool.destroy();
    await this.registrationStore?.disconnect?.();
  }

  #setupHttpServer() {
    const app = this.app;
    app.disable('x-powered-by');
    app.use(helmet());
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

    const serverFactory = this.tlsOptions ? https.createServer : http.createServer;
    this.server = serverFactory(this.tlsOptions || {}, app);

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this.#handleWebSocket(ws, req));
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

    if (!token) {
      this.logger.warn?.('WebSocket rejected: token missing', { relayKey });
      ws.close(4403, 'Token required');
      ws.terminate();
      return;
    }

    const tokenValidation = this.#validateToken(token, relayKey);
    if (!tokenValidation) {
      this.logger.warn?.('WebSocket rejected: token validation failed', { relayKey });
      ws.close(4403, 'Invalid token');
      ws.terminate();
      return;
    }

    const { payload: tokenPayload, relayAuthToken, pubkey: tokenPubkey, scope: tokenScope } = tokenValidation;

    const registration = await this.registrationStore.getRelay(relayKey);
    if (!registration) {
      this.logger.warn?.('WebSocket rejected: relay not registered', { relayKey });
      ws.close(4404, 'Relay not registered');
      ws.terminate();
      return;
    }

    const availablePeers = this.#getPeersFromRegistration(registration);
    this.logger.info?.('Initializing websocket session - relay registration fetched', {
      relayKey,
      peerCount: availablePeers.length,
      peers: availablePeers
    });

    const selection = this.#selectPeer({ ...registration, peers: availablePeers });
    if (!selection) {
      this.logger.warn?.('WebSocket rejected: no peers available', { relayKey });
      ws.close(1013, 'No peers available');
      ws.terminate();
      return;
    }

    const { peerKey, peers, index } = selection;
    const peerIndex = index >= 0 ? index : 0;
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

    const connectionKey = this.#generateConnectionKey();
    const session = {
      connectionKey,
      relayKey,
      ws,
      clientToken: token,
      tokenPayload,
      relayAuthToken,
      clientPubkey: tokenPubkey || null,
      clientScope: tokenScope || null,
      peerKey,
      peers,
      peerIndex,
      messageQueue: new MessageQueue(),
      openedAt: Date.now()
    };

    this.sessions.set(connectionKey, session);
    sessionGauge.set(this.sessions.size);

    ws.on('message', (message) => this.#handleClientMessage(session, message));
    ws.on('close', () => this.#cleanupSession(connectionKey));
    ws.on('error', () => this.#cleanupSession(connectionKey));

    this.#startEventChecking(session);

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

      try {
        const responses = await this.#withPeer(session, async (peerKey) => {
          requestCounter.inc({ relay: session.relayKey });
          return forwardMessageToPeerHyperswarm(
            peerKey,
            session.relayKey,
            msg,
            session.connectionKey,
            this.connectionPool,
            session.relayAuthToken
          );
        });

        if (!Array.isArray(responses)) return;
        for (const response of responses) {
          if (!response) continue;
          if (session.ws.readyState === WebSocket.OPEN) {
            session.ws.send(JSON.stringify(response));
          }
        }
      } catch (error) {
        this.logger.warn?.('Forwarding message failed', { relayKey: session.relayKey, error: error.message });
        if (session.ws.readyState === WebSocket.OPEN) {
          session.ws.send(JSON.stringify(['NOTICE', `Error: ${error.message}`]));
        } else {
          this.#cleanupSession(session.connectionKey);
        }
      }
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

    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      try { session.ws.close(); } catch (_) {}
    }

    sessionGauge.set(this.sessions.size);
  }

  #startEventChecking(session) {
    const run = async () => {
      if (!this.sessions.has(session.connectionKey)) {
        this.eventCheckTimers.delete(session.connectionKey);
        return;
      }

      try {
        const registration = await this.registrationStore.getRelay(session.relayKey);
        if (registration) {
          session.peers = this.#getPeersFromRegistration(registration);
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

  async #withPeer(session, handler) {
    if (!session.peers?.length) {
      throw new Error('No peers registered for relay');
    }

    let attempts = 0;
    let lastError = null;

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
      return res.json({ status: 'ok' });
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

  #validateToken(token, relayKey) {
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

    const metadata = {
      pubkey: payload.pubkey || null,
      scope: payload.scope || null,
      issuedAt: payload.issuedAt || null,
      expiresAt: payload.expiresAt || null,
      lastValidatedAt: Date.now()
    };

    try {
      const maybePromise = this.registrationStore?.storeTokenMetadata?.(relayKey, metadata);
      if (typeof maybePromise?.catch === 'function') {
        maybePromise.catch((error) => {
          this.logger.debug?.('Failed to persist token metadata', {
            relayKey,
            error: error?.message || error
          });
        });
      }
    } catch (error) {
      this.logger.debug?.('Token metadata persistence threw synchronously', {
        relayKey,
        error: error?.message || error
      });
    }

    this.logger.info?.('Token validated for relay session', {
      relayKey,
      scope: payload.scope || null,
      pubkey: payload.pubkey ? `${payload.pubkey.slice(0, 16)}...` : null,
      expiresAt: payload.expiresAt || null
    });

    return {
      payload,
      relayAuthToken: payload.relayAuthToken,
      pubkey: payload.pubkey || null,
      scope: payload.scope || null
    };
  }

  #onProtocolCreated() {
    // Placeholder for protocol setup hooks
  }

  #onProtocolHandshake() {
    // Placeholder for handshake accounting
  }

  #collectMetrics() {
    sessionGauge.set(this.sessions.size);
    peerGauge.set(this.connectionPool.connections.size);
  }
}

export default PublicGatewayService;
