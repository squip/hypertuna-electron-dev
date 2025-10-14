import Hyperswarm from 'hyperswarm';
import crypto from 'hypercore-crypto';
import * as c from 'compact-encoding';
import { Readable } from 'node:stream';
import RelayProtocol from './RelayProtocol.mjs';

class HyperswarmConnection {
  constructor(publicKey, swarm, pool, logger = console) {
    this.publicKey = publicKey;
    this.swarm = swarm;
    this.pool = pool;
    this.logger = logger;
    this.protocol = null;
    this.stream = null;
    this.connected = false;
    this.connecting = false;
    this.connectPromise = null;
    this.lastUsed = Date.now();
    this.connectionAttempts = 0;
  }
  
  async connect() {
    if (this.connected) {
      return;
    }

    if (this.connectPromise) {
      this.logger?.info?.('Hyperswarm connection already in progress', { peer: this.publicKey });
      return this.connectPromise;
    }

    this.connectionAttempts++;
    this.connecting = true;
    this.logger?.info?.('Hyperswarm connect initiating', {
      peer: this.publicKey,
      attempt: this.connectionAttempts
    });

    this.connectPromise = (async () => {
      try {
        this.logger?.info?.('Ensuring topic joined before dialing peer', { peer: this.publicKey });
        await this.pool.ensureTopicJoined();
        const connection = await this._waitForOrCreateConnection(this.publicKey);
        if (!connection) {
          throw new Error('Failed to connect to peer - no connection established');
        }

        this.stream = connection;
        const handshakeData = this.pool._buildHandshakeData(false, {
          publicKey: this.publicKey,
          connection,
          wrapper: this
        });
        this.protocol = new RelayProtocolWithGateway(connection, false, handshakeData);
        this.pool._configureProtocol(this.publicKey, this.protocol, { isServer: false, connection: this });
        this.logger?.info?.('Protocol instance created for peer', { peer: this.publicKey });

        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Protocol handshake timeout'));
          }, 15000);

          const cleanup = () => {
            clearTimeout(timeout);
            this.protocol.removeListener('open', onOpen);
            this.protocol.removeListener('close', onClose);
            this.protocol.removeListener('error', onError);
          };

          const onOpen = () => {
            cleanup();
            this.connected = true;
            this.connecting = false;
            this.logger?.info?.('Protocol handshake open', { peer: this.publicKey });
            resolve();
          };

          const onClose = () => {
            cleanup();
            this.connected = false;
            this.connecting = false;
            this.logger?.warn?.('Protocol closed during handshake', { peer: this.publicKey });
            reject(new Error('Protocol closed during handshake'));
          };

          const onError = (err) => {
            cleanup();
            this.connected = false;
            this.connecting = false;
            this.logger?.error?.('Protocol error during handshake', {
              peer: this.publicKey,
              error: err?.message || err
            });
            reject(err);
          };

          this.protocol.once('open', onOpen);
          this.protocol.once('close', onClose);
          this.protocol.once('error', onError);
        });

        await this._identifyAsGateway();
      } catch (err) {
        this.connected = false;
        if (this.protocol) {
          this.protocol.destroy();
          this.protocol = null;
        }
        if (this.stream) {
          this.stream.destroy();
          this.stream = null;
        }
        this.logger?.error?.('Hyperswarm connect failed', {
          peer: this.publicKey,
          attempt: this.connectionAttempts,
          error: err?.message || err
        });
        throw err;
      } finally {
        this.connecting = false;
      }
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
      this.logger?.info?.('Hyperswarm connect finished', {
        peer: this.publicKey,
        connected: this.connected
      });
    }
  }
  
  async _identifyAsGateway() {
    if (!this.protocol) return;
    try {
      this.logger?.info?.('Sending gateway identification', { peer: this.publicKey });
      const identityPayload = this.pool._buildHandshakeData(false, {
        publicKey: this.publicKey,
        connection: this.stream,
        wrapper: this
      }) || {};
      if (!identityPayload.role) {
        identityPayload.role = identityPayload.gatewayReplica ? 'gateway-replica' : 'gateway';
      }
      await this.protocol.sendRequest({
        method: 'POST',
        path: '/identify-gateway',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          status: 'identified',
          payload: identityPayload,
          peer: this.pool?.getPublicKey?.() || null,
          timestamp: Date.now()
        }))
      });
      this.logger?.info?.('Gateway identification acknowledged', { peer: this.publicKey });
    } catch (err) {
      this.connected = false;
      this.logger?.error?.('Gateway identification request failed', {
        peer: this.publicKey,
        error: err?.message || err
      });
      throw err;
    }
  }
  
  _waitForOrCreateConnection(targetPublicKey) {
    return new Promise((resolve, reject) => {
      let targetBuffer;
      try {
        targetBuffer = Buffer.from(targetPublicKey, 'hex');
      } catch (error) {
        const err = new Error('Invalid peer key encountered (non-hex value)');
        this.logger?.error?.({ peer: targetPublicKey, error: error?.message || error }, 'Failed to parse peer key');
        reject(err);
        return;
      }

      if (!targetBuffer || targetBuffer.length !== 32) {
        const err = new Error(`Invalid peer key length (${targetBuffer?.length ?? 0}), expected 32 bytes`);
        this.logger?.error?.({ peer: targetPublicKey }, 'Peer key failed validation');
        reject(err);
        return;
      }

      const existing = this.pool.connections.get(targetPublicKey);
      if (existing && existing !== this && existing.stream) {
        this.logger?.info?.({ peer: targetPublicKey }, 'Reusing existing stream for peer');
        resolve(existing.stream);
        return;
      }

      for (const conn of this.pool.swarm?.connections || []) {
        if (conn.remotePublicKey && conn.remotePublicKey.equals(targetBuffer)) {
          this.logger?.info?.({ peer: targetPublicKey }, 'Found active swarm connection for peer');
          resolve(conn);
          return;
        }
      }

      let settled = false;

      const cleanup = () => {
        settled = true;
        clearTimeout(timeout);
        this.swarm.removeListener('connection', onConnection);
        this.pool._releasePeerDiscovery?.(targetPublicKey, targetBuffer);
      };

      const succeed = (stream) => {
        if (settled) return;
        cleanup();
        this.logger?.info?.({ peer: targetPublicKey }, 'Hyperswarm dial succeeded');
        resolve(stream);
      };

      const fail = (error) => {
        if (settled) return;
        cleanup();
        this.logger?.warn?.({
          peer: targetPublicKey,
          error: error?.message || error
        }, 'Hyperswarm dial failed');
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const timeout = setTimeout(() => {
        fail(new Error('Connection timeout'));
      }, 15000);

      const startTime = Date.now();
      const onConnection = (conn, peerInfo) => {
        if (peerInfo.publicKey.equals(targetBuffer)) {
          const elapsed = Date.now() - startTime;
          this.logger?.info?.({ peer: targetPublicKey, elapsedMs: elapsed }, 'Received incoming hyperswarm connection for peer');
          succeed(conn);
        }
      };

      this.logger?.info?.({ peer: targetPublicKey }, 'Waiting for hyperswarm connection event');
      this.swarm.on('connection', onConnection);

      try {
        this.pool._ensurePeerDiscovery?.(targetPublicKey, targetBuffer);
      } catch (error) {
        fail(error);
        return;
      }

      // Flush to expedite discovery and holepunching attempts
      this.swarm.flush().catch((error) => {
        this.logger?.debug?.({
          peer: targetPublicKey,
          error: error?.message || error
        }, 'Hyperswarm flush failed');
      });
    });
  }
  
  async sendRequest(request) {
    if (!this.connected) {
      await this.connect();
    }
    this.lastUsed = Date.now();
    return this.protocol.sendRequest(request);
  }
  
  async healthCheck() {
    if (!this.connected) {
      await this.connect();
    }
    this.lastUsed = Date.now();
    return this.protocol.sendHealthCheck();
  }

  async sendTelemetry(payload) {
    if (!this.connected) {
      await this.connect();
    }
    this.lastUsed = Date.now();
    return this.protocol.sendTelemetry(payload);
  }
  
  destroy() {
    this.logger?.info?.('Destroying hyperswarm connection', {
      peer: this.publicKey,
      connected: this.connected
    });
    if (this.protocol) {
      this.protocol.destroy();
    }
    if (this.stream) {
      this.stream.destroy();
    }
    this.connected = false;
    this.connecting = false;
  }
}

class RelayProtocolWithGateway extends RelayProtocol {
  _setupChannel() {
    this.channel = this.mux.createChannel({
      protocol: 'hypertuna-relay-v2',
      id: null,
      handshake: c.json,
      onopen: this._onopen.bind(this),
      onclose: this._onclose.bind(this),
      ondestroy: this._ondestroy.bind(this)
    });

    if (!this.channel) {
      throw new Error('Failed to create channel - duplicate protocol?');
    }

    this.channel.addMessage({ encoding: c.json, onmessage: this._onrequest.bind(this) });
    this.channel.addMessage({ encoding: c.json, onmessage: this._onresponse.bind(this) });
    this.channel.addMessage({ encoding: c.json, onmessage: this._onwsframe.bind(this) });
    this.channel.addMessage({ encoding: c.json, onmessage: this._onhealthcheck.bind(this) });
    this.channel.addMessage({ encoding: c.json, onmessage: this._onhealthresponse.bind(this) });
    this.channel.addMessage({ encoding: c.json, onmessage: this._ontelemetry.bind(this) });

    const handshake = {
      version: '2.0',
      isServer: this.isServer,
      isGateway: false,
      role: this.isServer ? 'server' : 'client',
      capabilities: ['http', 'websocket', 'health', 'telemetry']
    };

    if (this.handshakeData && typeof this.handshakeData === 'object') {
      Object.assign(handshake, this.handshakeData);
    }

    this.channel.open(handshake);
  }

  _ontelemetry(message) {
    this.emit('telemetry', message);
  }
}

class EnhancedHyperswarmPool {
  constructor(options = {}) {
    this.connections = new Map();
    this.swarm = null;
    this.initialized = false;
    this.swarmKeyPair = null;
    this.topicDiscovery = null;
    this.peerDiscoveries = new Map();
    this.options = options || {};
    this.logger = options.logger || console;
  }

  async initialize() {
    if (this.initialized) return;

    const seed = crypto.randomBytes(32);
    this.swarmKeyPair = crypto.keyPair(seed);
    this.swarm = new Hyperswarm({ keyPair: this.swarmKeyPair });
    this.logger?.info?.('Hyperswarm pool initialized with new swarm keypair');

    this.swarm.on('connection', (connection, peerInfo) => {
      const publicKey = peerInfo.publicKey.toString('hex');
      const existing = this.connections.get(publicKey);
      if (existing) {
        if (existing.connecting && !existing.connected) {
          this.logger?.debug?.('Swarm connection matched pending dial', { peer: publicKey });
          return;
        }

        const existingStream = existing.stream;
        const streamHealthy = existingStream
          && existingStream.destroyed !== true
          && existingStream.closed !== true;
        const existingActive = existing.connected && streamHealthy;

        if (existingActive) {
          this.logger?.debug?.('Duplicate inbound hyperswarm connection ignored – existing stream still active', {
            peer: publicKey
          });
          try {
            connection.destroy();
          } catch (_) {}
          return;
        }

        this.logger?.info?.('Replacing existing hyperswarm connection from swarm event', {
          peer: publicKey,
          reason: existing.connected ? 'existing-stream-closed' : 'existing-connection-inactive'
        });
        existing.destroy();
      }
      const conn = new HyperswarmConnection(publicKey, this.swarm, this, this.logger);
      conn.stream = connection;
      const handshakeData = this._buildHandshakeData(true, {
        publicKey,
        peerInfo,
        connection,
        wrapper: conn
      });
      conn.protocol = new RelayProtocolWithGateway(connection, true, handshakeData);
      conn.connected = true;
      this._configureProtocol(publicKey, conn.protocol, { isServer: true, peerInfo, connection: conn });
      this.connections.set(publicKey, conn);
      this.logger?.info?.('Registered inbound hyperswarm connection', { peer: publicKey });
    });

    const topic = crypto.hash(Buffer.from('hypertuna-relay-network'));
    this.topicDiscovery = this.swarm.join(topic, { server: false, client: true });
    await this.topicDiscovery.flushed();
    this.logger?.info?.('Hyperswarm topic joined', { topic: 'hypertuna-relay-network' });
    this.initialized = true;
  }
  
  async ensureTopicJoined() {
    if (!this.initialized) await this.initialize();
    if (!this.topicDiscovery) {
      const topic = crypto.hash(Buffer.from('hypertuna-relay-network'));
      this.topicDiscovery = this.swarm.join(topic, { server: false, client: true });
      await this.topicDiscovery.flushed();
      this.logger?.info?.('Hyperswarm topic rejoined', { topic: 'hypertuna-relay-network' });
    }
  }
  
  async getConnection(publicKey) {
    if (!this.initialized) await this.initialize();
    this.logger?.info?.('Requesting hyperswarm connection', { peer: publicKey });
    let connection = this.connections.get(publicKey);
    if (!connection) {
      this.logger?.info?.('Creating new connection wrapper for peer', { peer: publicKey });
      connection = new HyperswarmConnection(publicKey, this.swarm, this, this.logger);
      this.connections.set(publicKey, connection);
    }
    await connection.connect();
    this.logger?.info?.('Hyperswarm connection ready', {
      peer: publicKey,
      connected: connection.connected
    });
    return connection;
  }

  _ensurePeerDiscovery(publicKey, keyBuffer) {
    if (this.peerDiscoveries.has(publicKey)) {
      this.logger?.debug?.('Reusing existing peer discovery', { peer: publicKey });
      return true;
    }

    try {
      this.swarm.joinPeer(keyBuffer);
      this.peerDiscoveries.set(publicKey, keyBuffer);
      this.logger?.info?.('Joined peer for holepunch support', { peer: publicKey });
    } catch (error) {
      this.logger?.warn?.('Failed to join peer for holepunch support', {
        peer: publicKey,
        error: error?.message || error
      });
      throw error;
    }

    return true;
  }

  _releasePeerDiscovery(publicKey, keyBuffer) {
    const stored = this.peerDiscoveries.get(publicKey);
    if (!stored) return;
    try {
      const buffer = stored instanceof Uint8Array ? stored : keyBuffer;
      this.swarm.leavePeer?.(buffer);
    } catch (error) {
      this.logger?.debug?.('leavePeer not supported or failed', {
        peer: publicKey,
        error: error?.message || error
      });
    }
    this.peerDiscoveries.delete(publicKey);
    this.logger?.debug?.('Peer discovery released', { peer: publicKey });
  }

  _configureProtocol(publicKey, protocol, context = {}) {
    if (!protocol) return;

    if (this.options.onProtocol) {
      try {
        this.options.onProtocol({ publicKey, protocol, context });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[EnhancedHyperswarmPool] onProtocol handler error:', err);
      }
    }

    protocol.on('telemetry', (payload) => {
      if (this.options.onTelemetry) {
        try {
          this.options.onTelemetry({ publicKey, payload, context });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[EnhancedHyperswarmPool] onTelemetry handler error:', err);
        }
      }
    });

    if (this.options.onHandshake) {
      const emitHandshake = (stage, handshake) => {
        try {
          this.options.onHandshake({ publicKey, protocol, handshake, context, stage });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[EnhancedHyperswarmPool] onHandshake handler error:', err);
        }
      };
      protocol.once('opening', emitHandshake.bind(null, 'opening'));
      protocol.once('open', emitHandshake.bind(null, 'open'));
    }
  }

  _buildHandshakeData(isServer, context = {}) {
    if (typeof this.options.handshakeBuilder !== 'function') {
      return {};
    }
    try {
      const result = this.options.handshakeBuilder({
        isServer,
        ...context
      });
      if (!result || typeof result !== 'object') {
        return {};
      }
      return result;
    } catch (error) {
      this.logger?.warn?.('handshakeBuilder failed', {
        error: error?.message || error
      });
      return {};
    }
  }

  async destroy() {
    this.logger?.info?.('Destroying hyperswarm pool, closing connections', {
      connectionCount: this.connections.size
    });
    for (const connection of this.connections.values()) {
      connection.destroy();
    }
    this.connections.clear();
    this.peerDiscoveries.clear();
    if (this.topicDiscovery) {
      try { await this.topicDiscovery.destroy(); } catch (_) {}
      this.topicDiscovery = null;
    }
    if (this.swarm) {
      try { await this.swarm.destroy(); } catch (_) {}
      this.swarm = null;
    }
    this.logger?.info?.('Hyperswarm pool destroyed');
    this.initialized = false;
  }

  getPublicKey() {
    if (this.swarmKeyPair?.publicKey) {
      return Buffer.from(this.swarmKeyPair.publicKey).toString('hex');
    }
    return null;
  }
}

async function checkPeerHealthWithHyperswarm(peer, connectionPool) {
  try {
    const connection = await connectionPool.getConnection(peer.publicKey);
    const response = await connection.healthCheck();
    return response?.status === 'healthy';
  } catch (err) {
    return false;
  }
}

async function forwardRequestToPeer(peer, request, connectionPool) {
  const connection = await connectionPool.getConnection(peer.publicKey);
  const response = await connection.sendRequest(request);
  return response;
}

async function forwardMessageToPeerHyperswarm(peerPublicKey, identifier, message, connectionKey, connectionPool, authToken) {
  const connection = await connectionPool.getConnection(peerPublicKey);
  const headers = { 'content-type': 'application/json' };
  if (authToken) {
    headers['x-auth-token'] = authToken;
  }

  const response = await connection.sendRequest({
    method: 'POST',
    path: `/post/relay/${identifier}`,
    headers,
    body: Buffer.from(JSON.stringify({ message, connectionKey }))
  });

  if (response.statusCode !== 200) {
    throw new Error(`Peer returned status ${response.statusCode}`);
  }

  return response.body.toString().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function forwardJoinRequestToPeer(peer, identifier, requestData, connectionPool) {
  const connection = await connectionPool.getConnection(peer.publicKey);
  const response = await connection.sendRequest({
    method: 'POST',
    path: `/post/join/${identifier}`,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(requestData))
  });

  if (response.statusCode !== 200) {
    const errorBody = response.body.toString();
    throw new Error(`Peer returned status ${response.statusCode}: ${errorBody}`);
  }

  return JSON.parse(response.body.toString());
}

async function forwardCallbackToPeer(peer, path, requestData, connectionPool) {
  const connection = await connectionPool.getConnection(peer.publicKey);
  const response = await connection.sendRequest({
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify(requestData))
  });

  if (response.statusCode !== 200) {
    throw new Error(`Callback failed: ${response.body.toString()}`);
  }

  return JSON.parse(response.body.toString());
}

async function requestFileFromPeer(peer, identifier, file, connectionPool) {
  const connection = await connectionPool.getConnection(peer.publicKey);
  const response = await connection.sendRequest({
    method: 'GET',
    path: `/drive/${identifier}/${file}`
  });

  const stream = Readable.from(response.body);
  stream.headers = response.headers;
  stream.statusCode = response.statusCode;
  return stream;
}

async function requestPfpFromPeer(peer, owner, file, connectionPool) {
  const connection = await connectionPool.getConnection(peer.publicKey);
  const ownerSegment = owner ? `/${encodeURIComponent(owner)}` : '';
  const response = await connection.sendRequest({
    method: 'GET',
    path: `/pfp${ownerSegment}/${encodeURIComponent(file)}`
  });

  const stream = Readable.from(response.body);
  stream.headers = response.headers;
  stream.statusCode = response.statusCode;
  return stream;
}

async function getEventsFromPeerHyperswarm(peerPublicKey, relayKey, connectionKey, connectionPool, authToken = null) {
  const connection = await connectionPool.getConnection(peerPublicKey);

  const headers = { accept: 'application/json' };
  if (authToken) {
    headers['x-auth-token'] = authToken;
  }

  const response = await connection.sendRequest({
    method: 'GET',
    path: `/get/relay/${relayKey}/${connectionKey}`,
    headers
  });

  if (response.statusCode !== 200) {
    throw new Error(`Peer returned status ${response.statusCode}`);
  }

  return JSON.parse(response.body.toString());
}

export {
  EnhancedHyperswarmPool,
  checkPeerHealthWithHyperswarm,
  forwardRequestToPeer,
  forwardMessageToPeerHyperswarm,
  getEventsFromPeerHyperswarm,
  forwardJoinRequestToPeer,
  forwardCallbackToPeer,
  requestFileFromPeer,
  requestPfpFromPeer
};
