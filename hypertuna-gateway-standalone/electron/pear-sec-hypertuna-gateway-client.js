// pear-hypertuna-gateway-client.js - Gateway client with proper identification
const Hyperswarm = require('hyperswarm');
const crypto = require('hypercore-crypto');
const c = require('compact-encoding');
const { Readable } = require('stream');
const RelayProtocol = require('./pear-sec-hypertuna-gateway-protocol.js');

class HyperswarmConnection {
  constructor(publicKey, swarm, pool) {
    this.publicKey = publicKey;
    this.swarm = swarm;
    this.pool = pool; // Reference to the pool for topic management
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
      console.log(`[HyperswarmConnection] Already connected to ${this.publicKey.substring(0, 8)}...`);
      return;
    }

    if (this.connectPromise) {
      console.log(`[HyperswarmConnection] Awaiting existing connection attempt to ${this.publicKey.substring(0, 8)}...`);
      return this.connectPromise;
    }

    this.connectionAttempts++;
    this.connecting = true;

    this.connectPromise = (async () => {
      try {
      console.log(`[HyperswarmConnection] ========================================`);
      console.log(`[HyperswarmConnection] CONNECTION ATTEMPT #${this.connectionAttempts}`);
      console.log(`[HyperswarmConnection] Target peer: ${this.publicKey}`);
      console.log(`[HyperswarmConnection] Timestamp: ${new Date().toISOString()}`);
      
      // Ensure we're actively looking for this peer
      await this.pool.ensureTopicJoined();
      
      // Try to connect directly to the peer's public key
      console.log(`[HyperswarmConnection] Attempting direct connection to peer...`);
      
      // Create a connection promise with longer timeout
      const connectionPromise = this._waitForOrCreateConnection(this.publicKey);
      
      // Wait for connection with timeout
      const connection = await Promise.race([
        connectionPromise,
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Connection timeout')), 20000) // Increase timeout
        )
      ]);
      
      if (!connection) {
        throw new Error('Failed to connect to peer - no connection established');
      }
      
      console.log(`[HyperswarmConnection] Stream established with peer`);
      this.stream = connection;
      
      // Create protocol with gateway identification in handshake
      console.log(`[HyperswarmConnection] Creating RelayProtocol with gateway handshake...`);
      this.protocol = new RelayProtocolWithGateway(connection, false);
      
      // Wait for protocol handshake with proper error handling
      console.log(`[HyperswarmConnection] Waiting for protocol handshake...`);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          console.error(`[HyperswarmConnection] Protocol handshake TIMEOUT`);
          reject(new Error('Protocol handshake timeout'));
        }, 15000); // Increase handshake timeout
        
        const cleanup = () => {
          clearTimeout(timeout);
          this.protocol.removeListener('open', onOpen);
          this.protocol.removeListener('close', onClose);
          this.protocol.removeListener('error', onError);
        };
        
        const onOpen = (handshake) => {
          cleanup();
          this.connected = true;
          this.connecting = false;
          console.log(`[HyperswarmConnection] ----------------------------------------`);
          console.log(`[HyperswarmConnection] PROTOCOL HANDSHAKE COMPLETE`);
          console.log(`[HyperswarmConnection] Connected to peer: ${this.publicKey.substring(0, 8)}...`);
          console.log(`[HyperswarmConnection] Received handshake:`, JSON.stringify(handshake, null, 2));
          console.log(`[HyperswarmConnection] ----------------------------------------`);
          resolve();
        };
        
        const onClose = () => {
          cleanup();
          this.connected = false;
          this.connecting = false;
          console.error(`[HyperswarmConnection] Protocol closed during handshake`);
          reject(new Error('Protocol closed during handshake'));
        };
        
        const onError = (err) => {
          cleanup();
          this.connected = false;
          this.connecting = false;
          console.error(`[HyperswarmConnection] Protocol error during handshake:`, err);
          reject(err);
        };
        
        this.protocol.once('open', onOpen);
        this.protocol.once('close', onClose);
        this.protocol.once('error', onError);
      });
      
      // Send gateway identification after handshake completes
      console.log(`[HyperswarmConnection] Sending gateway identification...`);
      await this._identifyAsGateway();
      
      // Wait a bit to ensure the peer has processed our identification
      await new Promise(resolve => setTimeout(resolve, 500));

      console.log(`[HyperswarmConnection] Connection fully established`);
      console.log(`[HyperswarmConnection] ======================================`);

    } catch (err) {
      console.error(`[HyperswarmConnection] =====================================`);
      console.error(`[HyperswarmConnection] CONNECTION FAILED`);
      console.error(`[HyperswarmConnection] Error:`, err.message);
      console.error(`[HyperswarmConnection] Stack:`, err.stack);
      console.error(`[HyperswarmConnection] =====================================`);
      this.connected = false;

      // Clean up on failure
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
    try {
      console.log(`[HyperswarmConnection] Sending /identify-gateway request...`);
      const response = await this.protocol.sendRequest({
        method: 'POST',
        path: '/identify-gateway',
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({
          type: 'gateway',
          timestamp: new Date().toISOString()
        }))
      });
      
      const data = JSON.parse(response.body.toString());
      console.log(`[HyperswarmConnection] Gateway identification response:`, data);
      console.log(`[HyperswarmConnection] Gateway identification SUCCESSFUL`);
    } catch (err) {
      console.error(`[HyperswarmConnection] Gateway identification FAILED:`, err.message);
      // Non-fatal - continue anyway
    }
  }
  
  async _waitForOrCreateConnection(targetPublicKey) {
    const targetBuffer = Buffer.from(targetPublicKey, 'hex');
    
    // Check existing connections first
    for (const conn of this.swarm.connections) {
      if (conn.remotePublicKey && conn.remotePublicKey.equals(targetBuffer)) {
        console.log(`[HyperswarmConnection] Already connected to target`);
        return conn;
      }
    }
    
    return new Promise((resolve, reject) => {
      console.log(`[HyperswarmConnection] Setting up connection listener...`);
      
      const timeout = setTimeout(() => {
        console.error(`[HyperswarmConnection] Connection timeout after 15 seconds`);
        this.swarm.removeListener('connection', onConnection);
        reject(new Error('Connection timeout'));
      }, 15000);
      
      const onConnection = (conn, peerInfo) => {
        const connKey = peerInfo.publicKey.toString('hex');
        console.log(`[HyperswarmConnection] New swarm connection: ${connKey}`);
        
        if (peerInfo.publicKey.equals(targetBuffer)) {
          console.log(`[HyperswarmConnection] >>> TARGET PEER FOUND! <<<`);
          clearTimeout(timeout);
          this.swarm.removeListener('connection', onConnection);
          resolve(conn);
        } else {
          console.log(`[HyperswarmConnection] Not our target (looking for ${targetPublicKey}), continuing to wait...`);
        }
      };
      
      this.swarm.on('connection', onConnection);
      
      // Actively try to connect
      console.log(`[HyperswarmConnection] Actively connecting to peer...`);
      
      // The peer should be discoverable on the same topic
      this.swarm.flush().then(() => {
        console.log(`[HyperswarmConnection] Topic flushed, peer should be discoverable`);
      }).catch(err => {
        console.error(`[HyperswarmConnection] Flush error:`, err);
      });
    });
  }
  
  async sendRequest(request) {
    if (!this.connected) {
      console.log(`[HyperswarmConnection] Not connected, establishing connection first...`);
      await this.connect();
    }
    
    this.lastUsed = Date.now();
    console.log(`[HyperswarmConnection] Sending request: ${request.method} ${request.path}`);
    return this.protocol.sendRequest(request);
  }
  
  async healthCheck() {
    if (!this.connected) {
      console.log(`[HyperswarmConnection] Not connected, establishing connection first...`);
      await this.connect();
    }
    
    this.lastUsed = Date.now();
    console.log(`[HyperswarmConnection] Sending health check...`);
    return this.protocol.sendHealthCheck();
  }
  
  destroy() {
    console.log(`[HyperswarmConnection] Destroying connection to ${this.publicKey.substring(0, 8)}...`);
    
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

// Extended protocol class that identifies as gateway
class RelayProtocolWithGateway extends RelayProtocol {
  _setupChannel() {
    console.log(`[RelayProtocolGateway] Setting up channel with gateway identification...`);
    
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
    
    // Set up messages
    this.channel.addMessage({ encoding: c.json, onmessage: this._onrequest.bind(this) });
    this.channel.addMessage({ encoding: c.json, onmessage: this._onresponse.bind(this) });
    this.channel.addMessage({ encoding: c.json, onmessage: this._onwsframe.bind(this) });
    this.channel.addMessage({ encoding: c.json, onmessage: this._onhealthcheck.bind(this) });
    this.channel.addMessage({ encoding: c.json, onmessage: this._onhealthresponse.bind(this) });
    
    // Open the channel with gateway identification
    const handshake = {
      version: '2.0',
      isServer: this.isServer,
      isGateway: true, // Identify as gateway
      capabilities: ['http', 'websocket', 'health']
    };
    
    console.log(`[RelayProtocolGateway] Opening channel with handshake:`, handshake);
    this.channel.open(handshake);
  }
}

// Enhanced connection pool for Hyperswarm
class EnhancedHyperswarmPool {
  constructor() {
    this.connections = new Map();
    this.swarm = null;
    this.initialized = false;
    this.swarmKeyPair = null;
    this.topicDiscovery = null;
    this.peerDiscoveries = new Map();
  }
  
  async initialize() {
    if (this.initialized) {
      console.log(`[HyperswarmPool] Already initialized`);
      return;
    }
    
    console.log(`[HyperswarmPool] ========================================`);
    console.log(`[HyperswarmPool] INITIALIZING HYPERSWARM`);
    console.log(`[HyperswarmPool] Timestamp: ${new Date().toISOString()}`);
    
    // Create swarm with a unique key pair for the gateway
    const seed = crypto.randomBytes(32);
    console.log(`[HyperswarmPool] Generated random seed for gateway`);
    
    // Use DHT keypair generation
    const DHT = require('hyperdht');
    this.swarmKeyPair = DHT.keyPair(seed);
    
    console.log(`[HyperswarmPool] Gateway public key: ${this.swarmKeyPair.publicKey.toString('hex')}`);
    
    this.swarm = new Hyperswarm({
      keyPair: this.swarmKeyPair
    });
    
    this.swarm.on('error', (err) => {
      console.error(`[HyperswarmPool] Swarm error:`, err.message);
    });
    
    this.swarm.on('connection', (conn, peerInfo) => {
      const peerKey = peerInfo.publicKey.toString('hex');
      console.log(`[HyperswarmPool] New swarm connection event: ${peerKey}`);
    });
    
    this.initialized = true;
    console.log(`[HyperswarmPool] Hyperswarm initialized successfully`);
    console.log(`[HyperswarmPool] ========================================`);
  }
  
  async ensureTopicJoined() {
    if (!this.topicDiscovery) {
      const topicString = 'hypertuna-relay-network';
      const topic = crypto.hash(Buffer.from(topicString));
      
      console.log(`[HyperswarmPool] Joining relay network topic...`);
      console.log(`[HyperswarmPool] Topic string: ${topicString}`);
      console.log(`[HyperswarmPool] Topic hash: ${topic.toString('hex')}`);
      
      // Join as client to discover servers
      this.topicDiscovery = this.swarm.join(topic, { server: false, client: true });
      
      // Wait for initial flush
      await this.topicDiscovery.flushed();
      console.log(`[HyperswarmPool] Topic joined and flushed`);
    }
  }

  _ensurePeerJoined(publicKey) {
    if (this.peerDiscoveries.has(publicKey)) return;
    try {
      const discovery = this.swarm.joinPeer(Buffer.from(publicKey, 'hex'));
      this.peerDiscoveries.set(publicKey, discovery);
    } catch (err) {
      console.error(`[HyperswarmPool] Failed to join peer ${publicKey.substring(0,8)}:`, err.message);
    }
  }

  _leavePeer(publicKey) {
    const discovery = this.peerDiscoveries.get(publicKey);
    if (discovery) {
      discovery.destroy().catch(() => {});
      this.peerDiscoveries.delete(publicKey);
    }
  }
  
  async getConnection(publicKey) {
    if (!this.initialized) {
      console.log(`[HyperswarmPool] Pool not initialized, initializing now...`);
      await this.initialize();
    }
    
    let connection = this.connections.get(publicKey);

    if (!connection) {
      console.log(`[HyperswarmPool] Creating new connection for peer ${publicKey.substring(0, 8)}...`);
      connection = new HyperswarmConnection(publicKey, this.swarm, this);
      this.connections.set(publicKey, connection);
    }

    this._ensurePeerJoined(publicKey);
    
    // Check if connection is stale
    const now = Date.now();
    const staleTime = 10 * 60 * 1000; // 10 minutes
    if (now - connection.lastUsed > staleTime) {
      console.log(`[HyperswarmPool] Connection for peer ${publicKey.substring(0, 8)} is stale (unused for ${Math.round((now - connection.lastUsed) / 1000)}s), recreating...`);
      await this.closeConnection(publicKey);
      connection = new HyperswarmConnection(publicKey, this.swarm, this);
      this.connections.set(publicKey, connection);
    }
    
    if (!connection.connected) {
      console.log(`[HyperswarmPool] Connection not active, connecting now...`);
      await connection.connect();
    }
    
    return connection;
  }
  
  async closeConnection(publicKey) {
    console.log(`[HyperswarmPool] Closing connection for peer ${publicKey.substring(0, 8)}...`);
    const connection = this.connections.get(publicKey);
    if (connection) {
      connection.destroy();
      this.connections.delete(publicKey);
    }
    this._leavePeer(publicKey);
  }
  
  async destroy() {
    console.log(`[HyperswarmPool] ========================================`);
    console.log(`[HyperswarmPool] DESTROYING CONNECTION POOL`);
    console.log(`[HyperswarmPool] Active connections: ${this.connections.size}`);

    for (const [key, connection] of this.connections) {
      console.log(`[HyperswarmPool] Destroying connection: ${key.substring(0, 8)}...`);
      connection.destroy();
    }
    this.connections.clear();

    for (const key of this.peerDiscoveries.keys()) {
      this._leavePeer(key);
    }

    if (this.swarm) {
      console.log(`[HyperswarmPool] Destroying Hyperswarm instance...`);
      await this.swarm.destroy();
      this.swarm = null;
    }
    
    this.initialized = false
    console.log(`[HyperswarmPool] Destruction complete`);
    console.log(`[HyperswarmPool] ========================================`);
  }
 }
 
 // Export the same functions with updated implementations
 async function checkPeerHealthWithHyperswarm(peer, connectionPool) {
  try {
    console.log(`[HealthCheck] ========================================`);
    console.log(`[HealthCheck] HEALTH CHECK START`);
    console.log(`[HealthCheck] Peer: ${peer.publicKey}`);
    console.log(`[HealthCheck] Timestamp: ${new Date().toISOString()}`);
    
    const connection = await connectionPool.getConnection(peer.publicKey);
    console.log(`[HealthCheck] Sending health check request...`);
    
    const response = await connection.healthCheck();
    
    console.log(`[HealthCheck] Response received:`, response);
    const isHealthy = response.status === 'healthy';
    
    console.log(`[HealthCheck] Result: ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'}`);
    console.log(`[HealthCheck] ========================================`);
    
    return isHealthy;
  } catch (err) {
    console.error(`[HealthCheck] ========================================`);
    console.error(`[HealthCheck] HEALTH CHECK FAILED`);
    console.error(`[HealthCheck] Peer: ${peer.publicKey.substring(0, 8)}...`);
    console.error(`[HealthCheck] Error:`, err.message);
    console.error(`[HealthCheck] ========================================`);
    return false;
  }
 }
 
 async function forwardRequestToPeer(peer, request, connectionPool) {
  try {
    console.log(`[ForwardRequest] Forwarding ${request.method} ${request.url} to peer ${peer.publicKey.substring(0, 8)}...`);
    
    const connection = await connectionPool.getConnection(peer.publicKey);
    
    // Read request body if present
    let body = Buffer.alloc(0);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      body = await new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => resolve(Buffer.concat(chunks)));
        request.on('error', reject);
      });
      console.log(`[ForwardRequest] Request body size: ${body.length} bytes`);
    }
    
    const response = await connection.sendRequest({
      method: request.method,
      path: request.url,
      headers: request.headers,
      body: body
    });
    
    console.log(`[ForwardRequest] Response received: ${response.statusCode}`);
    return response;
  } catch (err) {
    console.error(`[ForwardRequest] Failed for peer ${peer.publicKey.substring(0, 8)}:`, err.message);
    throw err;
  }
 }
 
async function forwardMessageToPeerHyperswarm(peerPublicKey, identifier, message, connectionKey, connectionPool, authToken) {
  try {
    console.log(`[ForwardMessage] ========================================`);
    console.log(`[ForwardMessage] FORWARDING RELAY MESSAGE`);
    console.log(`[ForwardMessage] Relay: ${identifier}`);
    console.log(`[ForwardMessage] Connection: ${connectionKey}`);
    console.log(`[ForwardMessage] Peer: ${peerPublicKey.substring(0, 8)}...`);
    console.log(`[ForwardMessage] Has auth: ${!!authToken}`);
    
    const connection = await connectionPool.getConnection(peerPublicKey);
    
    // Build headers
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
    
    console.log(`[ForwardMessage] Response status: ${response.statusCode}`);
    
    if (response.statusCode !== 200) {
      throw new Error(`Peer returned status ${response.statusCode}`);
    }
    
    // Parse response lines
    const lines = response.body.toString().split('\n').filter(line => line.trim() !== '');
    console.log(`[ForwardMessage] Response contains ${lines.length} lines`);
    console.log(`[ForwardMessage] ========================================`);
    
    return lines.map(line => JSON.parse(line));
      
  } catch (error) {
    console.error(`[ForwardMessage] ========================================`);
    console.error(`[ForwardMessage] FORWARD FAILED`);
    console.error(`[ForwardMessage] Error:`, error.message);
    console.error(`[ForwardMessage] ========================================`);
    throw error;
  }
}

 async function forwardJoinRequestToPeer(peer, identifier, requestData, connectionPool) {
  try {
    console.log(`[ForwardJoin] ========================================`);
    console.log(`[ForwardJoin] FORWARDING JOIN REQUEST`);
    console.log(`[ForwardJoin] Relay: ${identifier}`);
    console.log(`[ForwardJoin] Peer: ${peer.publicKey.substring(0, 8)}...`);
    console.log(`[ForwardJoin] Has event: ${!!requestData.event}`);
    
    const connection = await connectionPool.getConnection(peer.publicKey);
    
    const response = await connection.sendRequest({
      method: 'POST',
      path: `/post/join/${identifier}`,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(requestData))
    });
    
    console.log(`[ForwardJoin] Response status: ${response.statusCode}`);
    
    if (response.statusCode !== 200) {
      const errorBody = response.body.toString();
      console.error(`[ForwardJoin] Join request failed: ${errorBody}`);
      throw new Error(`Peer returned status ${response.statusCode}: ${errorBody}`);
    }
    
    const joinResponse = JSON.parse(response.body.toString());
    console.log(`[ForwardJoin] Response received:`, {
      hasChallenge: !!joinResponse.challenge,
      hasRelayPubkey: !!joinResponse.relayPubkey,
      verifyUrl: joinResponse.verifyUrl,
      finalUrl: joinResponse.finalUrl
    });
    
    console.log(`[ForwardJoin] ========================================`);
    
    return joinResponse;
    
  } catch (error) {
    console.error(`[ForwardJoin] ========================================`);
    console.error(`[ForwardJoin] FORWARD FAILED`);
    console.error(`[ForwardJoin] Error:`, error.message);
    console.error(`[ForwardJoin] ========================================`);
    throw error;
  }
}

// Add callback endpoint forwarding
async function forwardCallbackToPeer(peer, path, requestData, connectionPool) {
  try {
    console.log(`[ForwardCallback] Forwarding ${path} to peer ${peer.publicKey.substring(0, 8)}...`);
    
    const connection = await connectionPool.getConnection(peer.publicKey);
    
    const response = await connection.sendRequest({
      method: 'POST',
      path: path,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify(requestData))
    });
    
    console.log(`[ForwardCallback] Response status: ${response.statusCode}`);
    
    if (response.statusCode !== 200) {
      const errorBody = response.body.toString();
      throw new Error(`Callback failed: ${errorBody}`);
    }
    
    return JSON.parse(response.body.toString());
    
  } catch (error) {
    console.error(`[ForwardCallback] Error:`, error.message);
    throw error;
  }
}

async function requestFileFromPeer(peer, identifier, file, connectionPool) {
  try {
    console.log(`[RequestFile] Requesting ${identifier}/${file} from peer ${peer.publicKey.substring(0, 8)}...`);

    const connection = await connectionPool.getConnection(peer.publicKey);

    const response = await connection.sendRequest({
      method: 'GET',
      path: `/drive/${identifier}/${file}`
    });

    const stream = Readable.from(response.body);
    stream.headers = response.headers;
    stream.statusCode = response.statusCode;
    return stream;
  } catch (error) {
    console.error(`[RequestFile] Error:`, error.message);
    throw error;
  }
}

async function getEventsFromPeerHyperswarm(peerPublicKey, relayKey, connectionKey, connectionPool, authToken = null) {
  try {
    console.log(`[GetEvents] Checking for events - relay: ${relayKey}, connection: ${connectionKey}`);
    
    const connection = await connectionPool.getConnection(peerPublicKey);
    
    const headers = { 'accept': 'application/json' };
    if (authToken) {
      headers['x-auth-token'] = authToken;
    }

    const response = await connection.sendRequest({
      method: 'GET',
      path: `/get/relay/${relayKey}/${connectionKey}`,
      headers: headers
    });
    
    if (response.statusCode !== 200) {
      throw new Error(`Peer returned status ${response.statusCode}`);
    }
    
    const events = JSON.parse(response.body.toString());
    console.log(`[GetEvents] Received ${events.length} events`);
    
    return events;
    
  } catch (error) {
    console.error(`[GetEvents] Error with peer ${peerPublicKey.substring(0, 8)}:`, error.message);
    throw error;
  }
 }
 
 module.exports = {
  EnhancedHyperswarmPool,
  checkPeerHealthWithHyperswarm,
  forwardRequestToPeer,
  forwardMessageToPeerHyperswarm,
  getEventsFromPeerHyperswarm,
  forwardJoinRequestToPeer,
  forwardCallbackToPeer,
  requestFileFromPeer
};
 