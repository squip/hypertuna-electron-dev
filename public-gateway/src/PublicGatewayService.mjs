import http from 'node:http';
import https from 'node:https';
import { randomBytes } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

import {
  EnhancedHyperswarmPool,
  forwardMessageToPeerHyperswarm,
  getEventsFromPeerHyperswarm
} from '../../shared/public-gateway/HyperswarmClient.mjs';
import {
  verifySignature,
  verifyClientToken
} from '../../shared/auth/PublicGatewayTokens.mjs';
import { metricsMiddleware, sessionGauge, peerGauge } from './metrics.mjs';
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

    app.post('/api/relays', (req, res) => this.#handleRelayRegistration(req, res));
    app.delete('/api/relays/:relayKey', (req, res) => this.#handleRelayDeletion(req, res));

    const serverFactory = this.tlsOptions ? https.createServer : http.createServer;
    this.server = serverFactory(this.tlsOptions || {}, app);

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => this.#handleWebSocket(ws, req));
  }

  #handleWebSocket(ws, req) {
    this.#initializeSession(ws, req).catch((error) => {
      this.logger.error?.('Failed to initialize websocket session', { error: error.message });
      try {
        ws.close(1011, 'Internal error');
      } catch (_) {}
      ws.terminate();
    });
  }

  async #initializeSession(ws, req) {
    if (!this.sharedSecret) {
      ws.close(1011, 'Gateway not configured');
      ws.terminate();
      return;
    }

    const { relayKey, token } = this.#parseWebSocketRequest(req);

    if (!relayKey) {
      ws.close(4404, 'Invalid relay key');
      ws.terminate();
      return;
    }

    if (!token) {
      ws.close(4403, 'Token required');
      ws.terminate();
      return;
    }

    const tokenPayload = this.#validateToken(token, relayKey);
    if (!tokenPayload) {
      ws.close(4403, 'Invalid token');
      ws.terminate();
      return;
    }

    const registration = await this.registrationStore.getRelay(relayKey);
    if (!registration) {
      ws.close(4404, 'Relay not registered');
      ws.terminate();
      return;
    }

    const selection = this.#selectPeer(registration);
    if (!selection) {
      ws.close(1013, 'No peers available');
      ws.terminate();
      return;
    }

    const { peerKey, peers, index } = selection;
    const peerIndex = index >= 0 ? index : 0;
    await this.connectionPool.getConnection(peerKey);

    const connectionKey = this.#generateConnectionKey();
    const session = {
      connectionKey,
      relayKey,
      ws,
      token,
      tokenPayload,
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
            session.token
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
            session.token
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
        return result;
      } catch (error) {
        lastError = error;
        this.logger.warn?.('Peer operation failed', {
          relayKey: session.relayKey,
          peerKey,
          error: error.message
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
    if (!payload) return null;
    if (payload.relayKey && payload.relayKey !== relayKey) return null;
    if (payload.expiresAt && payload.expiresAt < Date.now()) return null;
    return payload;
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
