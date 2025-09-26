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
      onHandshake: this._onProtocolHandshake.bind(this)
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

  _onProtocolHandshake({ publicKey, handshake, context = {} }) {
    if (!handshake) return;
    this.peerHandshakes.set(publicKey, handshake);

    if (handshake.role === 'relay' || handshake.isGateway === false) {
      this.healthState.services.hyperswarmStatus = 'connected';
      this.healthState.services.protocolStatus = 'connected';
      this.emit('status', this.getStatus());
    }
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
    const detectLan = !!config.detectLanAddresses;
    const detectPublicIp = !!config.detectPublicIp;

    this.log('info', `Starting gateway on port ${port}`);

    global.joinSessions = global.joinSessions || new Map();

    this.app = express();
    this.app.use(express.json({ limit: '2mb' }));

    this.gatewayServer = new LocalGatewayServer({
      hostname,
      port,
      listenHost,
      detectLanAddresses: detectLan,
      detectPublicIp
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
      detectLanAddresses: detectLan,
      detectPublicIp,
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
      peerDetails
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
      });
    }

    peer.address = address || null;
    peer.lastSeen = Date.now();

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
    const pathname = url.parse(req.url).pathname || '';
    const parts = pathname.split('/').filter(Boolean);
    const identifier = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : parts[0];
    const parsedUrl = url.parse(req.url, true);
    const authToken = parsedUrl.query.token || null;

    if (this.activeRelays.has(identifier)) {
      this.handleWebSocket(ws, identifier, authToken);
    } else {
      ws.close(1008, 'Invalid relay key');
    }
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
