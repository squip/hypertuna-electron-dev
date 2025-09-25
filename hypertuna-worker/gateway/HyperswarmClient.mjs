import Hyperswarm from 'hyperswarm';
import crypto from 'hypercore-crypto';
import * as c from 'compact-encoding';
import { Readable } from 'node:stream';
import RelayProtocol from './GatewayProtocol.mjs';

class HyperswarmConnection {
  constructor(publicKey, swarm, pool) {
    this.publicKey = publicKey;
    this.swarm = swarm;
    this.pool = pool;
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
      return this.connectPromise;
    }

    this.connectionAttempts++;
    this.connecting = true;

    this.connectPromise = (async () => {
      try {
        await this.pool.ensureTopicJoined();
        const connection = await this._waitForOrCreateConnection(this.publicKey);
        if (!connection) {
          throw new Error('Failed to connect to peer - no connection established');
        }

        this.stream = connection;
        this.protocol = new RelayProtocolWithGateway(connection, false);
        this.pool._configureProtocol(this.publicKey, this.protocol, { isServer: false, connection: this });

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
            resolve();
          };

          const onClose = () => {
            cleanup();
            this.connected = false;
            this.connecting = false;
            reject(new Error('Protocol closed during handshake'));
          };

          const onError = (err) => {
            cleanup();
            this.connected = false;
            this.connecting = false;
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
        throw err;
      } finally {
        this.connecting = false;
      }
    })();

    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }
  
  async _identifyAsGateway() {
    if (!this.protocol) return;
    try {
      await this.protocol.sendRequest({
        method: 'POST',
        path: '/identify',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ role: 'gateway' }))
      });
    } catch (err) {
      this.connected = false;
      throw err;
    }
  }
  
  _waitForOrCreateConnection(targetPublicKey) {
    const targetBuffer = Buffer.from(targetPublicKey, 'hex');
    return new Promise((resolve, reject) => {
      const direct = this.swarm.get(targetBuffer);
      if (direct && direct.stream) {
        resolve(direct.stream);
        return;
      }

      const timeout = setTimeout(() => {
        this.swarm.removeListener('connection', onConnection);
        reject(new Error('Connection timeout'));
      }, 15000);

      const onConnection = (conn, peerInfo) => {
        const connKey = peerInfo.publicKey.toString('hex');
        if (peerInfo.publicKey.equals(targetBuffer)) {
          clearTimeout(timeout);
          this.swarm.removeListener('connection', onConnection);
          resolve(conn);
        } else {
          // not the target
        }
      };

      this.swarm.on('connection', onConnection);
      this.swarm.flush().catch(() => {});
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
  
  destroy() {
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

    const handshake = {
      version: '2.0',
      isServer: this.isServer,
      isGateway: true,
      role: 'gateway',
      capabilities: ['http', 'websocket', 'health']
    };
    this.channel.open(handshake);
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
  }
  
  async initialize() {
    if (this.initialized) return;

    const seed = crypto.randomBytes(32);
    this.swarmKeyPair = crypto.keyPair(seed);
    this.swarm = new Hyperswarm({ keyPair: this.swarmKeyPair });

    this.swarm.on('connection', (connection, peerInfo) => {
      const publicKey = peerInfo.publicKey.toString('hex');
      const existing = this.connections.get(publicKey);
      if (existing) {
        existing.destroy();
      }
      const conn = new HyperswarmConnection(publicKey, this.swarm, this);
      conn.stream = connection;
      conn.protocol = new RelayProtocolWithGateway(connection, true);
      conn.connected = true;
      this._configureProtocol(publicKey, conn.protocol, { isServer: true, peerInfo, connection: conn });
      this.connections.set(publicKey, conn);
    });

    const topic = crypto.hash(Buffer.from('hypertuna-relay-network'));
    this.topicDiscovery = this.swarm.join(topic, { server: false, client: true });
    await this.topicDiscovery.flushed();
    this.initialized = true;
  }
  
  async ensureTopicJoined() {
    if (!this.initialized) await this.initialize();
    if (!this.topicDiscovery) {
      const topic = crypto.hash(Buffer.from('hypertuna-relay-network'));
      this.topicDiscovery = this.swarm.join(topic, { server: false, client: true });
      await this.topicDiscovery.flushed();
    }
  }
  
  async getConnection(publicKey) {
    if (!this.initialized) await this.initialize();
    let connection = this.connections.get(publicKey);
    if (!connection) {
      connection = new HyperswarmConnection(publicKey, this.swarm, this);
      this.connections.set(publicKey, connection);
    }
    await connection.connect();
    return connection;
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

    if (this.options.onHandshake) {
      const onOpen = (handshake) => {
        try {
          this.options.onHandshake({ publicKey, protocol, handshake, context });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[EnhancedHyperswarmPool] onHandshake handler error:', err);
        }
      };
      protocol.once('open', onOpen);
    }
  }
  
  async destroy() {
    for (const connection of this.connections.values()) {
      connection.destroy();
    }
    this.connections.clear();
    if (this.topicDiscovery) {
      try { await this.topicDiscovery.destroy(); } catch (_) {}
      this.topicDiscovery = null;
    }
    if (this.swarm) {
      try { await this.swarm.destroy(); } catch (_) {}
      this.swarm = null;
    }
    this.initialized = false;
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
