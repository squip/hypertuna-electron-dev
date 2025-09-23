// pear-hypertuna-gateway.js - Updated gateway server using Hyperswarm
const express = require('express');
const axios = require('axios');
const WebSocket = require('ws');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Hyperswarm = require('hyperswarm');
const Hyperdrive = require('hyperdrive');
const Localdrive = require('localdrive');
const Corestore = require('corestore');
const debounce = require('debounceify');
const b4a = require('b4a');
const stdio = require('pear-stdio');
const { NostrInitializer, createDirectoryUpdater } = require('./gateway-nostr-client');
const { Readable } = require('stream');
const LocalWSSServer = require('./local-wss');

// Import Hyperswarm client functions
const {
  EnhancedHyperswarmPool,
  checkPeerHealthWithHyperswarm,
  forwardRequestToPeer,
  forwardMessageToPeerHyperswarm,
  getEventsFromPeerHyperswarm,
  forwardJoinRequestToPeer,
  forwardCallbackToPeer,
  requestFileFromPeer
} = require('./pear-sec-hypertuna-gateway-client');

let nostrClient = null;
let directoryUpdater = null;


// ============================
// IP Hashing Utilities
// ============================

/**
 * Normalize IP addresses to handle IPv6 localhost and IPv4-mapped IPv6
 * @param {string} ip - Raw IP address
 * @returns {string} - Normalized IP address
 */
function normalizeIp(ip) {
  if (!ip) return '127.0.0.1';
  
  // Handle IPv6 localhost
  if (ip === '::1') return '127.0.0.1';
  
  // Handle IPv4-mapped IPv6 addresses
  if (ip.startsWith('::ffff:')) {
    return ip.replace('::ffff:', '');
  }
  
  return ip;
}

// ============================
// Core Classes (Enhanced for Hyperswarm)
// ============================

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
      console.log(`[${new Date().toISOString()}] Attempting health check for peer: ${peer.publicKey.substring(0, 8)}...`);
      
      // Check if this is a Hyperswarm peer and if we already have a healthy connection
      if (peer.mode === 'hyperswarm') {
        const connection = connectionPool.connections.get(peer.publicKey);
        if (connection && connection.connected) {
          // If we have an active connection, just verify it's still responsive
          console.log(`[${new Date().toISOString()}] Peer ${peer.publicKey.substring(0, 8)} has active connection, performing quick health check`);
          
          try {
            const isHealthy = await checkPeerHealthWithHyperswarm(peer, connectionPool);
            
            console.log(`[${new Date().toISOString()}] Health check response for peer ${peer.publicKey.substring(0, 8)}: ${isHealthy ? 'healthy' : 'unhealthy'}`);
            
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
          } catch (healthError) {
            console.log(`[${new Date().toISOString()}] Health check failed, but connection exists. Will retry connection.`);
            // Don't immediately fail - try to reconnect
          }
        }
      }
      
      // Use Hyperswarm health check
      const isHealthy = await checkPeerHealthWithHyperswarm(peer, connectionPool);
      
      console.log(`[${new Date().toISOString()}] Health check response for peer ${peer.publicKey.substring(0, 8)}: ${isHealthy ? 'healthy' : 'unhealthy'}`);
      
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
      
      await this.recordFailure(peer.publicKey);
      return false;
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Health check failed for peer ${peer.publicKey.substring(0, 8)}:`, error.message);
      this.metrics.failedChecks++;
      this.healthChecks.set(peer.publicKey, {
        lastCheck: now,
        status: 'unhealthy',
        error: error.message,
        errorType: error.code || 'UNKNOWN'
      });
      await this.recordFailure(peer.publicKey);
      return false;
    } finally {
      this.checkLocks.delete(peer.publicKey);
    }
  }

  isPeerHealthy(publicKey) {
    const check = this.healthChecks.get(publicKey);
    if (!check) return false;
    
    const now = Date.now();
    return (
      check.status === 'healthy' && 
      (now - check.lastCheck) < this.cleanupThreshold &&
      !this.isCircuitBroken(publicKey)
    );
  }

  isCircuitBroken(publicKey) {
    const breakerInfo = this.healthChecks.get(publicKey);
    if (!breakerInfo || !breakerInfo.circuitBroken) return false;
    
    if (Date.now() - breakerInfo.circuitBrokenAt > this.circuitBreakerTimeout) {
      delete breakerInfo.circuitBroken;
      delete breakerInfo.circuitBrokenAt;
      this.healthChecks.set(publicKey, breakerInfo);
      return false;
    }
    return true;
  }

  attemptCircuitReset(publicKey) {
    const healthInfo = this.healthChecks.get(publicKey);
    if (!healthInfo || !healthInfo.circuitBroken) return false;
    
    const now = Date.now();
    const breakerAge = now - (healthInfo.circuitBrokenAt || 0);
    
    if (breakerAge >= this.circuitBreakerTimeout) {
      console.log(`[${new Date().toISOString()}] Resetting circuit breaker for peer: ${publicKey.substring(0, 8)} to allow retry`);
      delete healthInfo.circuitBroken;
      delete healthInfo.circuitBrokenAt;
      this.healthChecks.set(publicKey, healthInfo);
      this.failureCount.delete(publicKey);
      return true;
    }
    return false;
  }

  async recordFailure(publicKey) {
    const count = (this.failureCount.get(publicKey) || 0) + 1;
    this.failureCount.set(publicKey, count);
    
    if (count >= this.circuitBreakerThreshold) {
      this.triggerCircuitBreaker(publicKey);
    }
  }

  triggerCircuitBreaker(publicKey) {
    const healthInfo = this.healthChecks.get(publicKey) || {};
    healthInfo.circuitBroken = true;
    healthInfo.circuitBrokenAt = Date.now();
    this.healthChecks.set(publicKey, healthInfo);
    
    console.log(`[${new Date().toISOString()}] Circuit breaker triggered for peer: ${publicKey.substring(0, 8)}`);
  }

  getHealthMetrics() {
    const now = Date.now();
    const healthyPeers = Array.from(this.healthChecks.values())
      .filter(check => check.status === 'healthy').length;
    
    const metrics = {
      ...this.metrics,
      healthyPeers,
      unhealthyPeers: this.healthChecks.size - healthyPeers,
      circuitsBroken: Array.from(this.healthChecks.values())
        .filter(check => check.circuitBroken).length,
      timeSinceLastReset: now - this.metrics.lastMetricsReset
    };

    if (now - this.metrics.lastMetricsReset > 60 * 60 * 1000) {
      this.resetMetrics();
    }

    return metrics;
  }

  resetMetrics() {
    this.metrics = {
      totalChecks: 0,
      failedChecks: 0,
      recoveredPeers: 0,
      lastMetricsReset: Date.now()
    };
  }
}

// ============================
// Server Configuration
// ============================

const app = express();
const gatewayConfig = process.argv[2];

const GATEWAY_PORT = Number(process.env.GATEWAY_PORT) || 8443;
const GATEWAY_HOSTNAME = process.env.GATEWAY_HOSTNAME || 'localhost';
const GATEWAY_LISTEN_HOST = process.env.GATEWAY_LISTEN_HOST || '0.0.0.0';
const DETECT_PUBLIC_IP = process.env.GATEWAY_DETECT_PUBLIC_IP === 'true';

// State Management
let activePeers = [];
const activeRelays = new Map();
const wsConnections = new Map();
const messageQueues = new Map();
const peerHealthManager = new PeerHealthManager();

// Initialize Hyperswarm connection pool
const connectionPool = new EnhancedHyperswarmPool();

// Server Setup via LocalWSSServer
const localWssServer = new LocalWSSServer({
  hostname: GATEWAY_HOSTNAME,
  port: GATEWAY_PORT,
  listenHost: GATEWAY_LISTEN_HOST,
  detectPublicIp: DETECT_PUBLIC_IP,
  requestHandler: app
});

let server = null;
let wss = null;

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

  next();
});


// Root route handler
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    message: 'Hypertuna Gateway Active (Hyperswarm Mode)',
    peers: activePeers.length,
    relays: activeRelays.size,
    timestamp: new Date().toISOString()
  });
});

// ============================
// Hyperdrive Setup (unchanged)
// ============================

const store = new Corestore('./storage');
const swarm = new Hyperswarm();
swarm.on('connection', conn => store.replicate(conn));

const local = new Localdrive('./writer-dir');
const drive = new Hyperdrive(store);

(async () => {
  await drive.ready();
  const discovery = swarm.join(drive.discoveryKey);
  await discovery.flushed();
  console.log('drive key:', b4a.toString(drive.key, 'hex'));
})();

const mirror = debounce(mirrorDrive);

// ============================
// Message Handling with Hyperswarm
// ============================

async function forwardMessageToPeer(peerPublicKey, identifier, message, connectionKey, authToken = null) {
  let peer = activePeers.find(p => p.publicKey === peerPublicKey);
  
  try {
    if (!peer || !peerHealthManager.isPeerHealthy(peerPublicKey)) {
      const healthyPeer = await findHealthyPeerForRelay(identifier);
      if (!healthyPeer) {
        throw new Error('No healthy peers available for this relay');
      }
      peer = healthyPeer;
    }

    // Get connection data
    const wsConnection = wsConnections.get(connectionKey);

    // Use Hyperswarm to forward message
    return await forwardMessageToPeerHyperswarm(
      peer.publicKey,
      identifier,
      message,
      connectionKey,
      connectionPool,
      authToken
    );
  } catch (error) {
    await peerHealthManager.recordFailure(peer.publicKey);
    throw error;
  }
}

// ============================
// WebSocket Handling (mostly unchanged)
// ============================
function handleGatewayWebSocketConnection(ws, req) {
  const pathname = url.parse(req.url).pathname;
  const parts = pathname.split('/').filter(Boolean);
  const identifier = parts.length >= 2 ? `${parts[0]}:${parts[1]}` : parts[0];
  
  // Extract token from query string
  const parsedUrl = url.parse(req.url, true);
  const authToken = parsedUrl.query.token || null;

  console.log(`[${new Date().toISOString()}] New WebSocket connection for relay: ${identifier}`);
  console.log(`[${new Date().toISOString()}] Has auth token: ${!!authToken}`);

  if (activeRelays.has(identifier)) {
    handleWebSocket(ws, req, identifier, authToken);
  } else {
    console.log(`[${new Date().toISOString()}] Invalid relay identifier: ${identifier}. Closing connection.`);
    ws.close(1008, 'Invalid relay key');
  }
}

// Update handleWebSocket to accept and store the auth token
function handleWebSocket(ws, req, identifier, authToken = null) {
  const connectionKey = generateConnectionKey();

  console.log(`[${new Date().toISOString()}] New WebSocket connection established:`, {
    identifier,
    connectionKey,
    hasAuthToken: !!authToken
  });

  wsConnections.set(connectionKey, {
    ws,
    relayKey: identifier,
    authToken // Store the auth token
  });
  
  // Rest of the function remains the same...
  const messageQueue = new MessageQueue();
  messageQueues.set(connectionKey, messageQueue);

  if (ws.readyState !== WebSocket.OPEN) {
    console.error(`[${new Date().toISOString()}] WebSocket not in OPEN state for relay ${identifier}:`,
      { readyState: ws.readyState });
    return;
  }

  // Update the forwardMessageToPeer call in the message handler to include auth
  ws.on('message', async (message) => {
    const processMessage = async (msg) => {
      console.log(`[${new Date().toISOString()}] Processing WebSocket message for relay ${identifier}`);

      const connData = wsConnections.get(connectionKey);
      if (!connData) {
        console.error(`[${new Date().toISOString()}] No connection data found for key ${connectionKey}. Aborting message processing.`);
        ws.send(JSON.stringify(['NOTICE', 'Internal server error: connection data missing']));
        return;
      }
      
      const healthyPeer = await findHealthyPeerForRelay(identifier);
      if (!healthyPeer) {
        console.error(`[${new Date().toISOString()}] No healthy peers found for relay ${identifier}`);
        ws.send(JSON.stringify(['NOTICE', 'No healthy peers available for this relay']));
        return;
      }

      try {
        const responses = await forwardMessageToPeer(
          healthyPeer.publicKey, 
          identifier, 
          msg, 
          connectionKey,
          connData.authToken
        );
        
        for (const response of responses) {
          if (response && response.length > 0) {
            // Check for auth errors in OK responses
            if (response[0] === 'OK' && response[2] === false) {
              const errorMsg = response[3] || '';
              if (errorMsg.includes('Authentication required') || 
                  errorMsg.includes('Invalid authentication')) {
                // Close with 4403 for auth failure
                ws.close(4403, 'Authentication failed');
                return;
              }
            }
            
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(response));
            }
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Error processing message:`, error);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(['NOTICE', `Error: ${error.message}`]));
        }
      }
    };

    await messageQueue.enqueue(message, processMessage);
  });

  ws.on('close', () => {
    console.log(`[${new Date().toISOString()}] WebSocket connection closed for relay ${identifier}`);
    cleanup(connectionKey);
  });

  ws.on('error', (error) => {
    console.error(`[${new Date().toISOString()}] WebSocket error for relay ${identifier}:`, error);
    cleanup(connectionKey);
  });

  startEventChecking(connectionKey);
}

// ============================
// Event Checking with Hyperswarm
// ============================

async function startEventChecking(connectionKey) {
  const MAX_CONSECUTIVE_FAILURES = 5;
  let consecutiveFailures = 0;
  let checkInterval = 10000; // Default 10 seconds

  const checkEvents = async () => {
    const connectionData = wsConnections.get(connectionKey);
    if (!connectionData) {
      console.log(`[${new Date().toISOString()}] Connection ${connectionKey} no longer exists, stopping event checking`);
      return;
    }

    const { ws, relayKey: identifier, authToken } = connectionData;
    
    if (ws.readyState !== WebSocket.OPEN) {
      console.log(`[${new Date().toISOString()}] WebSocket for ${connectionKey} not open (state: ${ws.readyState}), stopping event checking`);
      cleanup(connectionKey);
      return;
    }
    
    let healthyPeer = null;
    
    try {
      healthyPeer = await findHealthyPeerForRelay(identifier, consecutiveFailures >= 3);
      
      if (!healthyPeer) {
        consecutiveFailures++;
        checkInterval = Math.min(30000, checkInterval * 1.5);
        
        console.log(`[${new Date().toISOString()}] No healthy peers found for relay ${identifier} (attempt ${consecutiveFailures}), will retry in ${Math.round(checkInterval/1000)}s`);
        
        if (consecutiveFailures === 1 && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(['NOTICE', 'Event checking temporarily unavailable - no healthy peers, retrying soon']));
        }
        
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.log(`[${new Date().toISOString()}] Max consecutive failures reached, cleaning up connection pool for relay ${identifier}`);
          
          const peersForRelay = activeRelays.get(identifier)?.peers || new Set();
          for (const peerKey of peersForRelay) {
            await connectionPool.closeConnection(peerKey);
          }
          
          for (const peerKey of peersForRelay) {
            peerHealthManager.failureCount.delete(peerKey);
            const healthInfo = peerHealthManager.healthChecks.get(peerKey);
            if (healthInfo) {
              delete healthInfo.circuitBroken;
              delete healthInfo.circuitBrokenAt;
              peerHealthManager.healthChecks.set(peerKey, healthInfo);
            }
          }
        }
        
        if (wsConnections.has(connectionKey)) {
          setTimeout(() => checkEvents(), checkInterval);
        }
        return;
      }

      consecutiveFailures = 0;
      checkInterval = 10000;

      const events = await getEventsFromPeerHyperswarm(
        healthyPeer.publicKey,
        identifier,
        connectionKey,
        connectionPool,
        authToken
      );
      
      if (events && events.length > 0) {
        for (const event of events) {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event));
          } else {
            throw new Error(`WebSocket not in OPEN state (${ws.readyState})`);
          }
        }
        console.log(`[${new Date().toISOString()}] Sent ${events.length} events for connectionKey: ${connectionKey}`);
        
        if (activeRelays.has(identifier)) {
          const relayData = activeRelays.get(identifier);
          relayData.lastSuccessfulMessage = Date.now();
        }
      }
    } catch (error) {
      console.error(`[${new Date().toISOString()}] Event check error for ${connectionKey}:`, error.message);
      
      if (healthyPeer) {
        await peerHealthManager.recordFailure(healthyPeer.publicKey);
      }
      
      consecutiveFailures++;
      checkInterval = Math.min(30000, checkInterval * 1.5);
      
      if (consecutiveFailures === 1 && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(['NOTICE', 'Event checking encountered an error - retrying']));
      }
    } finally {
      if (wsConnections.has(connectionKey)) {
        setTimeout(() => checkEvents(), checkInterval);
      }
    }
  };

  checkEvents();
}

// ============================
// HTTP Endpoints
// ============================

app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    mode: 'hyperswarm',
    timestamp: new Date().toISOString() 
  });
});

app.post('/register', async (req, res) => {
  const { publicKey, relays, relayProfileInfo, mode } = req.body;
  console.log(`[${new Date().toISOString()}] ========================================`);
  console.log(`[${new Date().toISOString()}] REGISTRATION REQUEST RECEIVED`);
  console.log(`[${new Date().toISOString()}] Mode: ${mode || 'legacy'}`);
  console.log(`[${new Date().toISOString()}] Public key: ${publicKey?.substring(0, 8)}...`);
  console.log(`[${new Date().toISOString()}] Full public key: ${publicKey}`);
  console.log(`[${new Date().toISOString()}] Relays count: ${relays?.length}`);
  console.log(`[${new Date().toISOString()}] Has relay profile info: ${!!relayProfileInfo}`);
  console.log(`[${new Date().toISOString()}] ========================================`);

  if (!publicKey) {
    console.log(`[${new Date().toISOString()}] Registration failed: No public key provided`);
    return res.status(400).json({
      error: 'Public key is required',
      timestamp: new Date().toISOString()
    });
  }

  // Handle Hyperswarm mode registration
  if (mode === 'hyperswarm') {
    console.log(`[${new Date().toISOString()}] Hyperswarm mode registration detected`);
    
    // Store peer info for Hyperswarm connection
    let peer = activePeers.find(p => p.publicKey === publicKey);
    if (!peer) {
      peer = { 
        publicKey, 
        lastSeen: Date.now(), 
        relays: new Set(),
        status: 'registered', // Mark as registered but not yet connected
        registeredAt: Date.now(),
        mode: 'hyperswarm'
      };
      activePeers.push(peer);
      console.log(`[${new Date().toISOString()}] New Hyperswarm peer registered:`, peer);
    } else {
      peer.lastSeen = Date.now();
      peer.status = 'registered';
      peer.mode = 'hyperswarm';
      console.log(`[${new Date().toISOString()}] Existing Hyperswarm peer updated:`, peer);
    }

    // Update relay mappings
    if (relays && Array.isArray(relays)) {
      relays.forEach(r => {
        const identifier = typeof r === 'string' ? r : r.identifier;
        if (!identifier) return;

        peer.relays.add(identifier);

        if (!activeRelays.has(identifier)) {
          activeRelays.set(identifier, {
            peers: new Set(),
            relayProfileInfo: null,
            status: 'active',
            createdAt: Date.now(),
            lastActive: Date.now()
          });
        }

        const relayData = activeRelays.get(identifier);
        relayData.peers.add(publicKey);
        relayData.lastActive = Date.now();

        if (relayProfileInfo && relays.length === 1) {
          relayData.relayProfileInfo = relayProfileInfo;
          console.log(`[${new Date().toISOString()}] Updated relay-profile info for relay: ${identifier}`);
          
          if (relayProfileInfo.pubkey) {
            console.log(`[${new Date().toISOString()}] Found relay pubkey in relay-profile info:`, relayProfileInfo.pubkey);
            
            const isPublic = relayProfileInfo.public_status?.public === 1;
            console.log(`[${new Date().toISOString()}] Relay public status:`, isPublic);
            
            if (directoryUpdater && isPublic) {
              try {
                directoryUpdater.updateDirectory(relayProfileInfo.pubkey);
                console.log(`[${new Date().toISOString()}] Successfully updated directory for relay ${identifier}`);
              } catch (error) {
                console.warn(`[${new Date().toISOString()}] Directory update failed for relay ${identifier}:`, error.message);
              }
            } else {
              const reason = !directoryUpdater ? 'Directory updater not available' : 'Relay is not public';
              console.log(`[${new Date().toISOString()}] Skipping directory update: ${reason}`);
            }
          }
        }
      });
    }

    // Mark peer as initially healthy since it just registered
    // This prevents immediate "no healthy peers" errors
    peerHealthManager.healthChecks.set(publicKey, {
      lastCheck: Date.now(),
      status: 'healthy',
      responseTime: 0
    });

    // Attempt to establish Hyperswarm connection
    console.log(`[${new Date().toISOString()}] Attempting to establish Hyperswarm connection to peer ${publicKey.substring(0, 8)}...`);
    
    // Schedule connection attempt (non-blocking) with a delay
    setTimeout(async () => {
      try {
        // Check if we already have a connection from the peer
        const existingConnection = connectionPool.connections.get(publicKey);
        if (existingConnection && existingConnection.protocol) {
          console.log(`[${new Date().toISOString()}] Peer already connected via incoming connection`);
          peer.status = 'connected';
          
          // Perform health check on existing connection
          const isHealthy = await peerHealthManager.checkPeerHealth(peer, connectionPool);
          console.log(`[${new Date().toISOString()}] Health check for existing connection:`, isHealthy);
        } else {
          // Try to establish outgoing connection
          const connection = await connectionPool.getConnection(publicKey);
          if (connection) {
            peer.status = 'connected';
            console.log(`[${new Date().toISOString()}] Successfully connected to Hyperswarm peer ${publicKey.substring(0, 8)}...`);
            
            // Perform initial health check
            const isHealthy = await peerHealthManager.checkPeerHealth(peer, connectionPool);
            console.log(`[${new Date().toISOString()}] Initial health check for Hyperswarm peer:`, isHealthy);
          }
        }
      } catch (error) {
        console.error(`[${new Date().toISOString()}] Failed to connect to Hyperswarm peer:`, error.message);
        peer.status = 'connection_failed';
        
        // Still mark as potentially healthy if it just registered
        // It might connect to us instead
        peerHealthManager.healthChecks.set(publicKey, {
          lastCheck: Date.now(),
          status: 'pending',
          error: 'Outgoing connection failed, waiting for incoming'
        });
      }
    }, 2000); // 2 second delay to allow for incoming connections

    await updateNetworkStats();

    const driveKey = b4a.toString(drive.key, 'hex');
    res.json({
      message: 'Registered successfully (Hyperswarm mode)',
      driveKey,
      status: 'active',
      mode: 'hyperswarm',
      timestamp: new Date().toISOString()
    });
    
    return;
  }

  // Legacy registration handling (for non-Hyperswarm peers)
  let peer = activePeers.find(p => p.publicKey === publicKey);
  if (!peer) {
    peer = { 
      publicKey, 
      lastSeen: Date.now(), 
      relays: new Set(),
      status: 'active',
      registeredAt: Date.now(),
      mode: 'legacy'
    };
    activePeers.push(peer);
    console.log(`[${new Date().toISOString()}] New legacy peer registered:`, peer);
  } else {
    peer.lastSeen = Date.now();
    peer.status = 'active';
    console.log(`[${new Date().toISOString()}] Existing legacy peer updated:`, peer);
  }

  if (relays && Array.isArray(relays)) {
    relays.forEach(r => {
      const identifier = typeof r === 'string' ? r : r.identifier;
      if (!identifier) return;

      peer.relays.add(identifier);

      if (!activeRelays.has(identifier)) {
        activeRelays.set(identifier, {
          peers: new Set(),
          relayProfileInfo: null,
          status: 'active',
          createdAt: Date.now(),
          lastActive: Date.now()
        });
      }

      const relayData = activeRelays.get(identifier);
      relayData.peers.add(publicKey);
      relayData.lastActive = Date.now();

      if (relayProfileInfo && relays.length === 1) {
        relayData.relayProfileInfo = relayProfileInfo;
        console.log(`[${new Date().toISOString()}] Updated relay-profile info for relay: ${identifier}`);
      }
    });
  }

  console.log(`[${new Date().toISOString()}] Registration complete. Active peers: ${activePeers.length}`);
  console.log(`[${new Date().toISOString()}] Active relays:`, 
    Array.from(activeRelays.entries()).map(([key, value]) => ({
      key,
      peers: value.peers.size,
      hasRelayProfileInfo: !!value.relayProfileInfo,
      lastActive: new Date(value.lastActive).toISOString()
    }))
  );

  await updateNetworkStats();

  const driveKey = b4a.toString(drive.key, 'hex');
  res.json({
    message: 'Registered successfully',
    driveKey,
    status: 'active',
    timestamp: new Date().toISOString()
  });
});

// ============================
// Join Relay Endpoint
// ============================

app.post('/post/join/:identifier', async (req, res) => {
  const identifier = req.params.identifier;
  console.log(`[${new Date().toISOString()}] ========================================`);
  console.log(`[${new Date().toISOString()}] JOIN REQUEST RECEIVED`);
  console.log(`[${new Date().toISOString()}] Relay: ${identifier}`);
  
  try {
    // Extract request data
    const { event } = req.body;
    
    if (!event) {
      console.error(`[${new Date().toISOString()}] Missing event in join request`);
      return res.status(400).json({
        error: 'Missing required field: event'
      });
    }
    
    console.log(`[${new Date().toISOString()}] Event kind: ${event.kind}`);
    console.log(`[${new Date().toISOString()}] User pubkey: ${event.pubkey?.substring(0, 8)}...`);
    
    // Find healthy peer for this relay
    const healthyPeer = await findHealthyPeerForRelay(identifier);
    if (!healthyPeer) {
      console.error(`[${new Date().toISOString()}] No healthy peers found for relay ${identifier}`);
      return res.status(503).json({
        error: 'No healthy peers available for this relay'
      });
    }
    
    console.log(`[${new Date().toISOString()}] Selected peer: ${healthyPeer.publicKey.substring(0, 8)}...`);
    
    // Generate callback URLs that route back through the gateway
    const protocol = req.protocol;
    const host = req.get('host');
    const baseUrl = `${protocol}://${host}`;
    
    const callbackUrls = {
      verifyUrl: `${baseUrl}/callback/verify-ownership/${identifier}`,
      finalUrl: `${baseUrl}/callback/finalize-auth/${identifier}`
    };
    
    console.log(`[${new Date().toISOString()}] Callback URLs:`, callbackUrls);
    
    // Forward the join request to the peer
    const requestData = {
      event,
      callbackUrls
    };
    
    const joinResponse = await forwardJoinRequestToPeer(
      healthyPeer,
      identifier,
      requestData,
      connectionPool
    );
    
    // Store peer info for callbacks
    if (!global.joinSessions) {
      global.joinSessions = new Map();
    }
    
    const sessionKey = `${event.pubkey}-${identifier}`;
    global.joinSessions.set(sessionKey, {
      peerPublicKey: healthyPeer.publicKey,
      identifier,
      pubkey: event.pubkey,
      timestamp: Date.now()
    });
    
    // Clean up old sessions
    for (const [key, session] of global.joinSessions) {
      if (Date.now() - session.timestamp > 5 * 60 * 1000) { // 5 minutes
        global.joinSessions.delete(key);
      }
    }
    
    console.log(`[${new Date().toISOString()}] Join session stored: ${sessionKey}`);
    console.log(`[${new Date().toISOString()}] Returning challenge to client`);
    console.log(`[${new Date().toISOString()}] ========================================`);
    
    res.json(joinResponse);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] ========================================`);
    console.error(`[${new Date().toISOString()}] JOIN REQUEST ERROR`);
    console.error(`[${new Date().toISOString()}] Error:`, error.message);
    console.error(`[${new Date().toISOString()}] Stack:`, error.stack);
    console.error(`[${new Date().toISOString()}] ========================================`);
    
    res.status(500).json({
      error: 'Internal server error',
      message: error.message
    });
  }
});

// Add callback endpoints
app.post('/callback/verify-ownership/:identifier', async (req, res) => {
  const identifier = req.params.identifier;
  console.log(`[${new Date().toISOString()}] ========================================`);
  console.log(`[${new Date().toISOString()}] VERIFY OWNERSHIP CALLBACK`);
  console.log(`[${new Date().toISOString()}] Relay: ${identifier}`);
  
  try {
    const { pubkey, ciphertext, iv } = req.body;
    
    if (!pubkey || !ciphertext || !iv) {
      return res.status(400).json({
        error: 'Missing required fields'
      });
    }
    
    console.log(`[${new Date().toISOString()}] Pubkey: ${pubkey.substring(0, 8)}...`);
    
    // Get session info
    const sessionKey = `${pubkey}-${identifier}`;
    const session = global.joinSessions?.get(sessionKey);
    console.log(`[${new Date().toISOString()}] Session key: ${sessionKey}`);
    
    if (!session) {
      console.error(`[${new Date().toISOString()}] No session found for ${sessionKey}`);
      return res.status(400).json({
        error: 'Session not found or expired'
      });
    }

    console.log(`[${new Date().toISOString()}] Found session for peer: ${session.peerPublicKey.substring(0, 8)}...`);
    
    // Find the peer
    const peer = activePeers.find(p => p.publicKey === session.peerPublicKey);
    if (!peer) {
      console.error(`[${new Date().toISOString()}] Peer no longer active`);
      return res.status(503).json({
        error: 'Peer no longer available'
      });
    }
    
    // Forward to peer
    const result = await forwardCallbackToPeer(
      peer,
      '/verify-ownership',
      { pubkey, ciphertext, iv },
      connectionPool
    );

    console.log(`[${new Date().toISOString()}] Callback result:`, result);
    
    if (result.success) {
      // Update session with token
      session.token = result.token;
      console.log(`[${new Date().toISOString()}] Verification successful, token generated`);
    }
    
    console.log(`[${new Date().toISOString()}] ========================================`);
    
    res.json(result);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Verify ownership error:`, error);
    res.status(500).json({
      error: 'Verification failed',
      message: error.message
    });
  }
});

app.post('/callback/finalize-auth/:identifier', async (req, res) => {
  const identifier = req.params.identifier;
  console.log(`[${new Date().toISOString()}] ========================================`);
  console.log(`[${new Date().toISOString()}] FINALIZE AUTH CALLBACK`);
  console.log(`[${new Date().toISOString()}] Relay: ${identifier}`);
  
  try {
    const { pubkey } = req.body;
    
    if (!pubkey) {
      return res.status(400).json({
        error: 'Missing pubkey'
      });
    }
    
    // Get session info
    const sessionKey = `${pubkey}-${identifier}`;
    const session = global.joinSessions?.get(sessionKey);
    
    if (!session || !session.token) {
      console.error(`[${new Date().toISOString()}] No valid session found`);
      return res.status(400).json({
        error: 'Session not found or verification not completed'
      });
    }
    
    console.log(`[${new Date().toISOString()}] Finalizing auth for ${pubkey.substring(0, 8)}...`);
    
    // Find the peer
    const peer = activePeers.find(p => p.publicKey === session.peerPublicKey);
    if (!peer) {
      console.error(`[${new Date().toISOString()}] Peer no longer active`);
      return res.status(503).json({
        error: 'Peer no longer available'
      });
    }
    
    // Forward to peer for finalization
    const result = await forwardCallbackToPeer(
      peer,
      '/finalize-auth',
      {
        pubkey,
        token: session.token,
        identifier
      },
      connectionPool
    );
    
    // Clean up session
    global.joinSessions.delete(sessionKey);
    
    console.log(`[${new Date().toISOString()}] Auth finalized, returning to client`);
    console.log(`[${new Date().toISOString()}] ========================================`);
    
    res.json(result);
    
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Finalize auth error:`, error);
    res.status(500).json({
      error: 'Finalization failed',
      message: error.message
    });
  }
});

app.get('/drive/:identifier/:file', async (req, res) => {
  const { identifier, file } = req.params;
  try {
    const peer = await findHealthyPeerForRelay(identifier);
    if (!peer) {
      return res.status(503).json({ error: 'No healthy peers available for this relay' });
    }

    const stream = await requestFileFromPeer(peer, identifier, file, connectionPool);

    Object.entries(stream.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });

    res.status(stream.statusCode);
    stream.pipe(res);

    peer.lastSeen = Date.now();
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Drive file error:`, error.message);
    res.status(500).json({ error: 'Internal Server Error', message: error.message });
  }
});

// HTTP Request Handling for non-WebSocket paths
app.use(async (req, res, next) => {
  if (req.path === '/health' || req.path === '/register') {
    return next();
  }

  if (req.path === '/') {
    console.log(`[${new Date().toISOString()}] ROOT PATH REQUEST RECEIVED`);
  }

  console.log(`[${new Date().toISOString()}] Received request for: ${req.url}`);

  console.log(`[${new Date().toISOString()}] Active peers: ${activePeers.length}`);
  activePeers.forEach(peer => {
    if (peer && peer.publicKey) {
      console.log(`  - ${peer.publicKey.substring(0, 8)} (last seen: ${new Date(peer.lastSeen)}, mode: ${peer.mode || 'legacy'})`);
    }
  });

  if (activePeers.length === 0) {
    console.log(`[${new Date().toISOString()}] No peers available`);
    return res.status(503).json({
      status: 'error',
      message: 'No peers available',
      timestamp: new Date().toISOString()
    });
  }

  // Filter for Hyperswarm peers for HTTP forwarding
  const hyperswarmPeers = activePeers.filter(p => p && p.publicKey && p.lastSeen && p.mode === 'hyperswarm');
  
  if (hyperswarmPeers.length === 0) {
    console.log(`[${new Date().toISOString()}] No Hyperswarm peers available for HTTP forwarding`);
    return res.status(503).json({
      status: 'error',
      message: 'No Hyperswarm peers available',
      timestamp: new Date().toISOString()
    });
  }

  const peer = hyperswarmPeers[Math.floor(Math.random() * hyperswarmPeers.length)];
  console.log(`[${new Date().toISOString()}] Selected Hyperswarm peer: ${peer.publicKey.substring(0, 8)}`);

  try {
    const result = await handleRequestWithPeer(peer, req, res);
    if (!result) {
      res.status(502).json({
        status: 'error',
        message: 'Unable to process request',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error with peer ${peer.publicKey.substring(0, 8)}: ${error.message}`);
    res.status(500).json({
      status: 'error',
      message: 'Internal Server Error',
      timestamp: new Date().toISOString()
    });
  }
});

async function handleRequestWithPeer(peer, req, res) {
  try {
    console.log(`[${new Date().toISOString()}] Getting connection for peer ${peer.publicKey.substring(0, 8)}...`);
    
    const response = await forwardRequestToPeer(peer, req, connectionPool);
    
    console.log(`[${new Date().toISOString()}] Received response from peer with status: ${response.statusCode}`);

    // Set the response headers
    Object.entries(response.headers).forEach(([key, value]) => {
      res.setHeader(key, value);
    });

    // Send the response body
    res.status(response.statusCode).send(response.body);
    console.log(`[${new Date().toISOString()}] Response sent to client`);

    peer.lastSeen = Date.now();
    return true;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Error details:`, {
      message: error.message,
      code: error.code
    });
    throw error;
  }
}

app.get('/debug/connections', (req, res) => {
  console.log('[Debug] ========================================');
  console.log('[Debug] CONNECTION DIAGNOSTICS');
  console.log('[Debug] Timestamp:', new Date().toISOString());
  
  const diagnostics = {
    timestamp: new Date().toISOString(),
    gateway: {
      status: 'running',
      port: GATEWAY_PORT,
      configFile: gatewayConfig || 'not set'
    },
    hyperswarm: {
      poolInitialized: connectionPool.initialized,
      gatewayPublicKey: connectionPool.swarmKeyPair ? 
        connectionPool.swarmKeyPair.publicKey.toString('hex') : 
        'not initialized',
      activeConnections: connectionPool.connections ? connectionPool.connections.size : 0,
      connections: connectionPool.connections ? 
        Array.from(connectionPool.connections.keys()).map(k => ({
          publicKey: k,
          connected: connectionPool.connections.get(k).connected,
          connecting: connectionPool.connections.get(k).connecting,
          connectionAttempts: connectionPool.connections.get(k).connectionAttempts
        })) : []
    },
    peers: {
      totalActive: activePeers.length,
      list: activePeers.map(p => ({
        publicKey: p.publicKey,
        lastSeen: new Date(p.lastSeen).toISOString(),
        status: p.status,
        mode: p.mode || 'legacy',
        relayCount: p.relays ? p.relays.size : 0
      }))
    },
    relays: {
      totalActive: activeRelays.size,
      list: Array.from(activeRelays.entries()).map(([key, value]) => ({
        key,
        peerCount: value.peers.size,
        lastActive: new Date(value.lastActive).toISOString()
      }))
    },
    health: {
      metrics: peerHealthManager.getHealthMetrics()
    }
  };
  
  console.log('[Debug] Diagnostics:', JSON.stringify(diagnostics, null, 2));
  console.log('[Debug] ========================================');
  
  res.json(diagnostics);
});

// ============================
// Helper Functions
// ============================

function generateConnectionKey() {
  return crypto.randomBytes(16).toString('hex');
}

async function findHealthyPeerForRelay(identifier, forceRecheck = false) {
  console.log(`[${new Date().toISOString()}] Finding healthy peer for relay ${identifier}`);

  const relayData = activeRelays.get(identifier);
  if (!relayData || relayData.peers.size === 0) {
    console.log(`[${new Date().toISOString()}] No relay data or peers found for relay ${identifier}`);
    return null;
  }

  const peers = Array.from(relayData.peers)
    .map(peerKey => activePeers.find(p => p.publicKey === peerKey))
    .filter(p => p && p.mode === 'hyperswarm'); // Only use Hyperswarm peers
  
  console.log(`[${new Date().toISOString()}] Found ${peers.length} potential Hyperswarm peers for relay ${identifier}`);

  if (!forceRecheck) {
    for (const peer of peers) {
      if (peerHealthManager.isPeerHealthy(peer.publicKey)) {
        console.log(`[${new Date().toISOString()}] Found already healthy peer ${peer.publicKey.substring(0, 8)} for relay ${identifier}`);
        return peer;
      }
    }
  }

  for (const peer of peers) {
    if (peerHealthManager.attemptCircuitReset(peer.publicKey)) {
      console.log(`[${new Date().toISOString()}] Attempting to recover circuit-broken peer ${peer.publicKey.substring(0, 8)}`);
      if (await peerHealthManager.checkPeerHealth(peer, connectionPool)) {
        console.log(`[${new Date().toISOString()}] Successfully recovered peer ${peer.publicKey.substring(0, 8)} for relay ${identifier}`);
        return peer;
      }
    }
  }

  for (const peer of peers) {
    console.log(`[${new Date().toISOString()}] Checking health of peer ${peer.publicKey.substring(0, 8)}`);
    if (await peerHealthManager.checkPeerHealth(peer, connectionPool)) {
      console.log(`[${new Date().toISOString()}] Found healthy peer ${peer.publicKey.substring(0, 8)} for relay ${identifier}`);
      return peer;
    }
  }

  console.log(`[${new Date().toISOString()}] No healthy peers found for relay ${identifier}`);
  return null;
}

function removePeerFromAllRelays(peer) {
  for (const [identifier, relayData] of activeRelays.entries()) {
    relayData.peers.delete(peer.publicKey);
    if (relayData.peers.size === 0) {
      activeRelays.delete(identifier);
    }
  }
}

async function cleanupInactivePeers() {
  const initialCount = activePeers.length;
  
  for (const peer of [...activePeers]) {
    if (!peerHealthManager.isPeerHealthy(peer.publicKey)) {
      const isHealthy = await peerHealthManager.checkPeerHealth(peer, connectionPool);
      if (!isHealthy) {
        removePeerFromAllRelays(peer);
        await connectionPool.closeConnection(peer.publicKey);
        activePeers = activePeers.filter(p => p.publicKey !== peer.publicKey);
      }
    }
  }

  if (activePeers.length < initialCount) {
    console.log(`[${new Date().toISOString()}] Removed ${initialCount - activePeers.length} inactive peers. Current count: ${activePeers.length}`);
    await updateNetworkStats();
  }
}

function cleanup(connectionKey) {
  const connection = wsConnections.get(connectionKey);
  if (connection) {
    connection.ws.close();
    wsConnections.delete(connectionKey);
  }
  
  const queue = messageQueues.get(connectionKey);
  if (queue) {
    queue.clear();
    messageQueues.delete(connectionKey);
  }
}

// ============================
// Message Queue Class
// ============================

class MessageQueue {
  constructor() {
    this.queue = [];
    this.processing = false;
    this.retryCount = 0;
    this.maxRetries = 3;
  }

  async enqueue(message, processFunction) {
    this.queue.push({ message, processFunction, attempts: 0 });
    await this.processQueue();
  }

  async processQueue() {
    if (this.processing || this.queue.length === 0) {
      return;
    }

    this.processing = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue[0];
        
        if (item.attempts >= this.maxRetries) {
          console.log(`[${new Date().toISOString()}] Message dropped after ${this.maxRetries} failed attempts`);
          this.queue.shift();
          continue;
        }

        try {
          item.attempts++;
          await item.processFunction(item.message);
          this.queue.shift();
        } catch (error) {
          console.error(`[${new Date().toISOString()}] Error processing message (attempt ${item.attempts}/${this.maxRetries}):`, error);
          if (item.attempts >= this.maxRetries) {
            this.queue.shift();
          } else {
            this.queue.push(this.queue.shift());
          }
          await new Promise(resolve => setTimeout(resolve, 1000 * item.attempts));
        }
      }
    } finally {
      this.processing = false;
    }
  }

  clear() {
    this.queue = [];
    this.processing = false;
  }
}

// ============================
// Network Stats and Drive Mirroring
// ============================

async function updateNetworkStats() {
  try {
    const configData = JSON.parse(fs.readFileSync(gatewayConfig, 'utf8'));
    const healthMetrics = peerHealthManager.getHealthMetrics();

    const stats = {
      active_relays: activeRelays.size,
      peers_online: activePeers.length,
      health_metrics: healthMetrics,
      relays: {},
      gateway_npub: configData.npub,
      gateway_pubkey_hex: configData.pubkeyhex,
      gateway_kind_10002_relays: configData.gateway_kind_10002_relays,
      gateway_kind_30000_directory_id: configData.gateway_kind_30000_directory_id,
      last_update: new Date().toISOString()
    };

    for (const [identifier, relayData] of activeRelays.entries()) {
      const healthyPeers = Array.from(relayData.peers)
        .filter(peer => peerHealthManager.isPeerHealthy(peer));

      stats.relays[identifier] = {
        status: healthyPeers.length > 0 ? 'online' : 'degraded',
        preferred_relays: [],
        total_peers: relayData.peers.size,
        healthy_peers: healthyPeers.length,
        relayProfileInfo: relayData.relayProfileInfo,
        health_percentage: (healthyPeers.length / relayData.peers.size) * 100,
        last_successful_message: relayData.lastSuccessfulMessage || null
      };
    }

    const jsonPath = path.join('./writer-dir', 'network_stats.json');
    await fs.promises.writeFile(jsonPath, JSON.stringify(stats, null, 2));
    
    const mirrorTimeout = 30000;
    try {
      await Promise.race([
        mirror(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Drive mirror timeout')), mirrorTimeout)
        )
      ]);
    } catch (mirrorError) {
      console.error(`[${new Date().toISOString()}] Drive mirror error:`, mirrorError.message);
    }

    return stats;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Stats update error:`, error.message);
    return null;
  }
}

async function mirrorDrive() {
  console.log(`[${new Date().toISOString()}] Starting drive mirror...`);
  
  try {
    const mirrorInstance = local.mirror(drive);
    await Promise.race([
      mirrorInstance.done(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Drive mirror timeout')), 30000)
      )
    ]);
    
    console.log(`[${new Date().toISOString()}] Mirror complete:`, mirrorInstance.count);
    return mirrorInstance.count;
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Mirror error:`, error.message);
    throw error;
  }
}

// ============================
// Maintenance and Initialization
// ============================

setInterval(async () => {
  try {
    await cleanupInactivePeers();
    
    // Cleanup unused connections
    const now = Date.now();
    for (const peer of activePeers) {
      const connection = connectionPool.connections.get(peer.publicKey);
      if (connection && connection.lastUsed < now - 10 * 60 * 1000) {
        await connectionPool.closeConnection(peer.publicKey);
      }
    }
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Maintenance cycle error:`, error);
  }
}, 60000);

stdio.in.setEncoding('utf-8');
stdio.in.on('data', (data) => {
  if (!data.match('\n')) return;
  mirror();
});

setInterval(async () => {
  console.log(`[${new Date().toISOString()}] Running periodic health check for all peers...`);
  for (const peer of activePeers.filter(p => p.mode === 'hyperswarm')) {
    if (peerHealthManager.isCircuitBroken(peer.publicKey)) {
      peerHealthManager.attemptCircuitReset(peer.publicKey);
    }
    
    const isHealthy = await peerHealthManager.checkPeerHealth(peer, connectionPool);
    console.log(`[${new Date().toISOString()}] Health check for peer ${peer.publicKey.substring(0, 8)}: ${isHealthy ? 'healthy' : 'unhealthy'}`);
  }
}, 30000);

// Initialize directory updater
async function initializeDirectoryUpdater(configFile) {
  try {
    if (!configFile) {
      throw new Error('Config file not provided to directory updater');
    }
    directoryUpdater = await createDirectoryUpdater(configFile);
    console.log('Directory updater initialized successfully');
  } catch (error) {
    console.error('Failed to initialize directory updater:', error.message);
    throw error;
  }
}

// Server initialization
async function initializeServer() {
  try {
    console.log(`[${new Date().toISOString()}] Starting gateway initialization...`);
    
    if (!gatewayConfig) {
      throw new Error('Gateway configuration file not provided');
    }
    
    // Initialize connection pool
    await connectionPool.initialize();
    console.log(`[${new Date().toISOString()}] Hyperswarm connection pool initialized`);
    
    // Initialize NOSTR and store the instance
    try {
      const nostrClient = await NostrInitializer.createInstance(gatewayConfig);
      console.log('NOSTR initialization complete');
    } catch (error) {
      console.error('NOSTR initialization failed:', error);
      throw error;
    }
    
    // Initialize directory updater with better error handling
    try {
      const updater = await createDirectoryUpdater(gatewayConfig);
      if (updater && typeof updater.updateDirectory === 'function') {
        directoryUpdater = updater;
        console.log('Directory updater initialized successfully');
      } else {
        console.warn('Warning: Directory updater missing required methods - continuing without directory updates');
      }
    } catch (error) {
      console.warn('Directory updater initialization failed - continuing without directory updates:', error.message);
    }
    
    await updateNetworkStats();
    return true;
  } catch (error) {
    console.error('Server initialization failed:', error);
    throw error;
  }
}

async function startGatewayServer() {
  try {
    await localWssServer.init();

    console.log(`[${new Date().toISOString()}] Starting gateway server using LocalWSS transport`);

    const { server: httpServer, wss: webSocketServer } = localWssServer.startServer(
      handleGatewayWebSocketConnection,
      null,
      async ({ urls }) => {
        try {
          await initializeServer();
          console.log(`[${new Date().toISOString()}] Gateway server running on port ${GATEWAY_PORT} (Hyperswarm mode)`);

          if (urls) {
            console.log('Available WebSocket endpoints:');
            console.log(`- Hostname: ${urls.hostname}`);
            if (Array.isArray(urls.local) && urls.local.length > 0) {
              urls.local.forEach(localUrl => console.log(`- Local: ${localUrl}`));
            }
            if (urls.public) {
              console.log(`- Public: ${urls.public}`);
            }
          }
        } catch (error) {
          console.error('Server initialization failed:', error);
          process.exit(1);
        }
      }
    );

    server = httpServer;
    wss = webSocketServer;
  } catch (error) {
    console.error('Gateway server initialization failed:', error);
    process.exit(1);
  }
}

startGatewayServer();

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('Initiating graceful shutdown...');
  
  messageQueues.clear();
  
  for (const { ws } of wsConnections.values()) {
    ws.close();
  }
  wsConnections.clear();
  
  await connectionPool.destroy();
  
  try {
    await swarm.destroy();
    await drive.close();
    
    if (wss) {
      await new Promise(resolve => wss.close(resolve));
      wss = null;
    }

    if (server) {
      server.close(() => {
        console.log('Server shutdown complete');
        process.exit(0);
      });
    } else {
      console.log('Server shutdown complete');
      process.exit(0);
    }
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
});

// Export for testing
module.exports = {
  peerHealthManager,
  activeRelays,
  activePeers,
  wsConnections,
  connectionPool,
  messageQueues
};
