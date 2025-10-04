// ./hypertuna-worker/pear-relay-server.mjs - Enhanced relay server with comprehensive debug logging
import Hyperswarm from 'hyperswarm';
import { RelayProtocol } from './relay-protocol-enhanced.mjs';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import crypto from 'hypercore-crypto';
import { setTimeout, setInterval, clearInterval } from 'node:timers';
import b4a from 'b4a';
import { URL } from 'node:url';
import { initializeChallengeManager, getChallengeManager } from './challenge-manager.mjs';
import { getRelayAuthStore } from './relay-auth-store.mjs';
import { nobleSecp256k1 } from './pure-secp256k1-bare.js';
import { NostrUtils } from './nostr-utils.js';
import { updateRelayAuthToken } from './hypertuna-relay-profile-manager-bare.mjs';
import { applyPendingAuthUpdates } from './pending-auth.mjs';
import {
  createRelay as createRelayManager,
  joinRelay as joinRelayManager,
  disconnectRelay as disconnectRelayManager,
  getRelayProfiles,
  autoConnectStoredRelays,
  handleRelayMessage,
  handleRelaySubscription,
  getActiveRelays,
  cleanupRelays,
  updateRelaySubscriptions,
  getRelayMembers,
  getRelayMetadata
} from './hypertuna-relay-manager-adapter.mjs';

import {
  findRelayByPublicIdentifier,
  getRelayKeyFromPublicIdentifier,
  isRelayActiveByPublicIdentifier,
  normalizeRelayIdentifier
} from './relay-lookup-utils.mjs';

import {
  updateRelayMemberSets,
  getRelayProfileByKey,
  getRelayProfileByPublicIdentifier,
  saveRelayProfile,
  calculateAuthorizedUsers
} from './hypertuna-relay-profile-manager-bare.mjs';

import { getFile, getPfpFile } from './hyperdrive-manager.mjs';
import { loadGatewaySettings, getCachedGatewaySettings } from '../shared/config/GatewaySettings.mjs';


// Global state
let config = null;
let swarm = null;
let gatewayRegistrationInterval = null;
let gatewayConnection = null;
let pendingRegistrations = []; // Queue registrations until gateway connects
let connectedPeers = new Map(); // Track all connected peers
let pendingPeerProtocols = new Map(); // Awaiters for outbound connections
const peerJoinHandles = new Map(); // Persistent joinPeer handles

// Enhanced health state tracking
let healthState = {
  startTime: Date.now(),
  lastCheck: Date.now(),
  status: 'initializing',
  activeRelaysCount: 0,
  metrics: {
    totalRequests: 0,
    successfulRequests: 0,
    failedRequests: 0,
    lastMetricsReset: Date.now()
  },
  services: {
    hyperswarmStatus: 'initializing',
    protocolStatus: 'initializing',
    gatewayStatus: 'disconnected'
  }
};

function getGatewayWebsocketProtocol(cfg = config) {
  const protocol = cfg?.proxy_websocket_protocol === 'ws' ? 'ws' : 'wss';
  return protocol;
}

function buildGatewayWebsocketBase(cfg = config) {
  const protocol = getGatewayWebsocketProtocol(cfg);
  const host = cfg?.proxy_server_address || 'localhost';
  return `${protocol}://${host}`;
}

// Initialize with enhanced config
export async function initializeRelayServer(customConfig = {}) {
  console.log('[RelayServer] ========================================');
  console.log('[RelayServer] Initializing with Hyperswarm support...');
  console.log('[RelayServer] Timestamp:', new Date().toISOString());
  
  const fallbackGatewaySettings = getCachedGatewaySettings();
  let gatewaySettings = fallbackGatewaySettings;
  try {
    gatewaySettings = await loadGatewaySettings();
  } catch (error) {
    console.error('[RelayServer] Failed to load gateway settings, using cached defaults:', error);
  }

  const defaultGatewayUrl = gatewaySettings.gatewayUrl || fallbackGatewaySettings.gatewayUrl;
  const defaultProxyHost = gatewaySettings.proxyHost || fallbackGatewaySettings.proxyHost;
  const defaultProxyProtocol = gatewaySettings.proxyWebsocketProtocol || fallbackGatewaySettings.proxyWebsocketProtocol;

  // Merge with defaults
  config = {
    userKey: customConfig.userKey,  // Preserve user key
    port: 1945,
    nostr_pubkey_hex: customConfig.nostr_pubkey_hex || generateHexKey(),
    nostr_nsec_hex: customConfig.nostr_nsec_hex || generateHexKey(),
    proxy_privateKey: customConfig.proxy_privateKey || generateHexKey(),
    proxy_publicKey: customConfig.proxy_publicKey || generateHexKey(),
    proxy_seed: customConfig.proxy_seed || generateHexKey(),
    proxy_server_address: customConfig.proxy_server_address || defaultProxyHost,
    proxy_websocket_protocol: customConfig.proxy_websocket_protocol || defaultProxyProtocol,
    gatewayUrl: customConfig.gatewayUrl || defaultGatewayUrl,
    registerWithGateway: customConfig.registerWithGateway ?? true,
    registerInterval: customConfig.registerInterval || 60000,
    relays: customConfig.relays || [],
    storage: customConfig.storage || global.userConfig?.storage || process.env.STORAGE_DIR || join(process.cwd(), 'data'),
    // Add gateway public key if known (optional)
    gatewayPublicKey: customConfig.gatewayPublicKey || null,
    pfpDriveKey: customConfig.pfpDriveKey || null,
    ...customConfig
  };
  
  console.log('[RelayServer] Configuration:', {
    proxy_server_address: config.proxy_server_address,
    gatewayUrl: config.gatewayUrl,
    registerWithGateway: config.registerWithGateway,
    registerInterval: config.registerInterval,
    gatewayPublicKey: config.gatewayPublicKey ? config.gatewayPublicKey.substring(0, 8) + '...' : 'not set',
    storage: config.storage,
    userKey: config.userKey ? config.userKey.substring(0, 8) + '...' : 'not set'
  });
  
  // Save config to storage
  await saveConfig(config);
  
  // Start Hyperswarm server
  await startHyperswarmServer();

  // Initialize challenge manager with relay private key
  console.log('[RelayServer] Initializing challenge manager...');
  initializeChallengeManager(config.nostr_nsec_hex);
  
  // Initialize auth store
  const authStore = getRelayAuthStore();
  console.log('[RelayServer] Auth store initialized');
  
  // Auto-connect to stored relays
  try {
    console.log('[RelayServer] Starting auto-connection to stored relays...');
    const connectedRelays = await autoConnectStoredRelays(config);
    console.log(`[RelayServer] Auto-connected to ${connectedRelays.length} relays`);
    
    // Update health state after auto-connect
    await updateHealthState();
    
    // If we have relays and gateway registration is enabled, register them
    if (connectedRelays.length > 0 && config.registerWithGateway) {
        console.log('[RelayServer] Registering auto-connected relays with gateway...');
        
        // Register each connected relay
        for (const relayKey of connectedRelays) {
            try {
                const profile = await getRelayProfileByKey(relayKey);
                if (profile) {
                  await registerWithGateway(profile);

                  // Determine auth token for current user if required
                  let userAuthToken = null;
                  if (profile.auth_config?.requiresAuth && config.nostr_pubkey_hex) {
                      const authorizedUsers = calculateAuthorizedUsers(
                          profile.auth_config.auth_adds || [],
                          profile.auth_config.auth_removes || []
                      );
                      const userAuth = authorizedUsers.find(u => u.pubkey === config.nostr_pubkey_hex);
                      userAuthToken = userAuth?.token || null;
                  }
              
                  // Build connection URL including public identifier and token
                  const identifierPath = profile.public_identifier ?
                      profile.public_identifier.replace(':', '/') :
                      relayKey;
                  const baseUrl = `${buildGatewayWebsocketBase(config)}/${identifierPath}`;
                  const connectionUrl = userAuthToken ? `${baseUrl}?token=${userAuthToken}` : baseUrl;
              
                  // Send registration complete message with CORRECT URL
                  if (global.sendMessage) {
                      global.sendMessage({
                          type: 'relay-registration-complete',
                          relayKey: relayKey,
                          publicIdentifier: profile.public_identifier,
                          gatewayUrl: connectionUrl,  // Use the full authenticated URL
                          authToken: userAuthToken,
                          timestamp: new Date().toISOString()
                      });
                  }
              }
            } catch (regError) {
                console.error(`[RelayServer] Failed to register relay ${relayKey}:`, regError);
            }
        }
    }
} catch (error) {
    console.error('[RelayServer] Error during auto-connection:', error);
}
  
  // Start internal health monitoring
  startHealthMonitoring();
  
  // Set up periodic registration attempts if enabled
  if (config.registerWithGateway) {
    console.log('[RelayServer] Gateway registration is ENABLED');
    
    // Try to register immediately if we have pending registrations
    processPendingRegistrations();
    
    // Set up periodic registration
    gatewayRegistrationInterval = setInterval(() => {
      console.log('[RelayServer] Periodic registration check...');
      if (gatewayConnection) {
        console.log('[RelayServer] Gateway connected, performing registration');
        registerWithGateway().catch((error) => {
          console.error('[RelayServer] Periodic gateway registration failed:', error.message);
        });
      } else {
        console.log('[RelayServer] No gateway connection for periodic registration');
        console.log('[RelayServer] Connected peers:', Array.from(connectedPeers.keys()).map(k => k.substring(0, 8) + '...'));
      }
    }, config.registerInterval);
  } else {
    console.log('[RelayServer] Gateway registration is DISABLED');
  }
  
  console.log('[RelayServer] Initialization complete');
  console.log('[RelayServer] ========================================');
  
  // Trigger initial registration via Hyperswarm after a delay
  setTimeout(async () => {
    console.log('[RelayServer] Performing initial Hyperswarm registration with gateway...');
    try {
      await registerWithGateway();
    } catch (error) {
      console.error('[RelayServer] Initial gateway registration failed:', error.message);
    }
  }, 2000); // Give everything time to stabilize
  
  return true;
}

function generateHexKey() {
  return crypto.randomBytes(32).toString('hex');
}

async function saveConfig(configData) {
  const configPath = join(config.storage || '.', 'relay-config.json');
  await fs.writeFile(configPath, JSON.stringify(configData, null, 2));
  console.log('[RelayServer] Config saved to:', configPath);
}

// Start Hyperswarm server
async function startHyperswarmServer() {
  try {
    console.log('[RelayServer] ----------------------------------------');
    console.log('[RelayServer] Starting Hyperswarm server...');
    
    // Create key pair from seed
    const keyPair = crypto.keyPair(b4a.from(config.proxy_seed, 'hex'));
    config.swarmPublicKey = keyPair.publicKey.toString('hex');
    // Persist the generated public key so it can be read on next start
    await saveConfig(config);
    
    console.log('[RelayServer] Generated keypair from seed:', config.proxy_seed);
    console.log('[RelayServer] Hyperswarm Peer Public key:', config.swarmPublicKey);
    
    // Initialize Hyperswarm
    swarm = new Hyperswarm({
      keyPair,
      // Limit connections for stability
      maxPeers: 64,
      maxClientConnections: 32,
      maxServerConnections: 32
    });
    
    console.log('[RelayServer] Hyperswarm instance created with options:', {
      maxPeers: 64,
      maxClientConnections: 32,
      maxServerConnections: 32
    });
    
    // Handle incoming connections
    swarm.on('connection', (stream, peerInfo) => {
      const peerKey = peerInfo.publicKey.toString('hex');
      console.log('[RelayServer] ========================================');
      console.log('[RelayServer] NEW PEER CONNECTION RECEIVED');
      console.log('[RelayServer] Peer public key:', peerKey);
      console.log('[RelayServer] Connection time:', new Date().toISOString());
      console.log('[RelayServer] Total connected peers:', connectedPeers.size + 1);
      handlePeerConnection(stream, peerInfo);
    });
    
    // Join the swarm with a well-known topic
    const topicString = 'hypertuna-relay-network';
    const topic = crypto.hash(b4a.from(topicString));
    console.log('[RelayServer] Joining swarm with topic:', topicString);
    console.log('[RelayServer] Topic hash:', topic.toString('hex'));
    
    const discovery = swarm.join(topic, { server: true, client: false });
    console.log('[RelayServer] Waiting for topic announcement...');
    
    await discovery.flushed();
    
    console.log('[RelayServer] Topic fully announced to DHT');
    console.log('[RelayServer] Hyperswarm server started successfully');
    console.log('[RelayServer] Listening for connections...');
    console.log('[RelayServer] ----------------------------------------');
    
    healthState.services.hyperswarmStatus = 'connected';
    
    // Update worker status
    if (global.sendMessage) {
      console.log('[RelayServer] Notifying worker of Hyperswarm status');
      global.sendMessage({
        type: 'status',
        message: 'Hyperswarm server connected',
        swarmKey: config.swarmPublicKey
      });
    }
    
  } catch (error) {
    console.error('[RelayServer] Failed to start Hyperswarm server:', error);
    console.error('[RelayServer] Error stack:', error.stack);
    healthState.services.hyperswarmStatus = 'error';
    throw error;
  }
}

function ensurePeerJoinHandle(publicKey) {
  if (!swarm) {
    throw new Error('Hyperswarm swarm not initialized');
  }

  const normalized = publicKey.toLowerCase();
  if (peerJoinHandles.has(normalized)) {
    return peerJoinHandles.get(normalized);
  }

  let keyBuffer;
  try {
    keyBuffer = Buffer.from(normalized, 'hex');
  } catch (error) {
    throw new Error(`Invalid peer public key: ${publicKey}`);
  }
  const handle = swarm.joinPeer(keyBuffer);
  peerJoinHandles.set(normalized, handle);
  return handle;
}

function toBuffer(body) {
  if (!body) return Buffer.alloc(0);
  if (Buffer.isBuffer(body)) return body;
  if (Array.isArray(body)) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body);
  return Buffer.alloc(0);
}

function parseJsonBody(body) {
  const buffer = toBuffer(body);
  if (!buffer.length) return null;
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch (error) {
    throw new Error(`Failed to parse JSON response: ${error.message}`);
  }
}

async function waitForPeerProtocol(publicKey, timeoutMs = 20000) {
  const normalized = publicKey.toLowerCase();
  const existing = connectedPeers.get(normalized);
  if (existing?.protocol && existing.protocol.channel && !existing.protocol.channel.closed) {
    return existing.protocol;
  }

  ensurePeerJoinHandle(normalized);

  return new Promise((resolve, reject) => {
    const pending = pendingPeerProtocols.get(normalized) || [];
    const timeout = setTimeout(() => {
      const list = pendingPeerProtocols.get(normalized) || [];
      const filtered = list.filter(entry => entry !== pendingEntry);
      if (filtered.length) {
        pendingPeerProtocols.set(normalized, filtered);
      } else {
        pendingPeerProtocols.delete(normalized);
      }
      reject(new Error('Timed out waiting for peer connection'));
    }, timeoutMs);

    const pendingEntry = {
      resolve(protocol) {
        clearTimeout(timeout);
        resolve(protocol);
      },
      reject(err) {
        clearTimeout(timeout);
        reject(err);
      }
    };

    pending.push(pendingEntry);
    pendingPeerProtocols.set(normalized, pending);
  });
}

// Handle incoming peer connections
function handlePeerConnection(stream, peerInfo) {
  const publicKey = peerInfo.publicKey.toString('hex');
  const normalizedKey = publicKey.toLowerCase();
  console.log('[RelayServer] Setting up protocol for peer:', publicKey);
  
  // Track the peer
  connectedPeers.set(normalizedKey, {
    connectedAt: Date.now(),
    peerInfo,
    protocol: null,
    identified: false,
    stream: stream, // Keep reference to stream
    keepAliveInterval: null, // Add keepalive tracking
    publicKey
  });
  
  const handshakeInfo = {
    role: 'relay',
    relayPublicKey: config?.swarmPublicKey,
    relayCount: healthState?.activeRelaysCount || 0,
    proxyAddress: config?.proxy_server_address || null
  };

  // Create relay protocol handler
  const protocol = new RelayProtocol(stream, true, handshakeInfo);
  
  // Store protocol reference
  const peerData = connectedPeers.get(normalizedKey);
  peerData.protocol = protocol;
  
  // Set up keepalive for gateway connections
  protocol.on('open', (handshake) => {
    console.log('[RelayServer] ----------------------------------------');
    console.log('[RelayServer] PROTOCOL OPENED');
    console.log('[RelayServer] Peer:', publicKey.substring(0, 8) + '...');
    console.log('[RelayServer] Handshake received:', JSON.stringify(handshake, null, 2));
    
    healthState.services.protocolStatus = 'connected';
    
    // Check if this is the gateway
    const isGatewayHandshake = handshake && (handshake.role === 'gateway' || handshake.isGateway);

    if (isGatewayHandshake) {
      console.log('[RelayServer] >>> GATEWAY IDENTIFIED FROM HANDSHAKE <<<');
      if (!config.gatewayPublicKey) {
        config.gatewayPublicKey = publicKey;
      }
      setGatewayConnection(protocol, publicKey);
      
      // Start keepalive for gateway connection
      startKeepAlive(publicKey);
    }
    else if (config.gatewayPublicKey && publicKey.toLowerCase() === config.gatewayPublicKey.toLowerCase()) {
      console.log('[RelayServer] >>> GATEWAY IDENTIFIED BY PUBLIC KEY <<<');
      setGatewayConnection(protocol, publicKey);
      
      // Start keepalive for gateway connection
      startKeepAlive(publicKey);
    } else {
      console.log('[RelayServer] Regular peer connection (not gateway)');
    }
    console.log('[RelayServer] ----------------------------------------');

    const pending = pendingPeerProtocols.get(normalizedKey);
    if (pending && pending.length) {
      pendingPeerProtocols.delete(normalizedKey);
      for (const entry of pending) {
        try {
          entry.resolve(protocol);
        } catch (err) {
          console.warn('[RelayServer] Failed to resolve pending peer protocol:', err.message);
        }
      }
    }
  });
  
  protocol.on('close', () => {
    console.log('[RelayServer] ----------------------------------------');
    console.log('[RelayServer] PROTOCOL CLOSED');
    console.log('[RelayServer] Peer:', publicKey.substring(0, 8) + '...');
    
    // Clean up keepalive
    const peer = connectedPeers.get(normalizedKey);
    if (peer && peer.keepAliveInterval) {
      clearInterval(peer.keepAliveInterval);
    }
    
    // Remove from connected peers
    connectedPeers.delete(normalizedKey);

    const pending = pendingPeerProtocols.get(normalizedKey);
    if (pending && pending.length) {
      pendingPeerProtocols.delete(normalizedKey);
      for (const entry of pending) {
        try {
          entry.reject(new Error('Peer connection closed'));
        } catch (_) {}
      }
    }

    if (gatewayConnection === protocol) {
      console.log('[RelayServer] >>> GATEWAY CONNECTION LOST <<<');
      gatewayConnection = null;
      healthState.services.gatewayStatus = 'disconnected';
    }
    
    console.log('[RelayServer] Remaining connected peers:', connectedPeers.size);
    console.log('[RelayServer] ----------------------------------------');
  });
  
  // Set up request handlers
  setupProtocolHandlers(protocol);
  
  // Handle gateway identification via registration endpoint
  protocol.on('request', (request) => {
    console.log('[RelayServer] Generic request received:', request.method, request.path);
    
    // If this is a registration request from the gateway, identify it
    if (request.path === '/identify-gateway') {
      if (gatewayConnection && gatewayConnection !== protocol) {
        console.log('[RelayServer] >>> REPLACING EXISTING GATEWAY CONNECTION <<<');
        try {
          gatewayConnection.destroy?.();
        } catch (_) {}
      }

      console.log('[RelayServer] >>> GATEWAY IDENTIFICATION REQUEST RECEIVED <<<');
      setGatewayConnection(protocol, publicKey);

      protocol.sendResponse({
        id: request.id,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ 
          status: 'identified',
          relayPublicKey: config.swarmPublicKey,
          timestamp: new Date().toISOString()
        }))
      });
    }
  });
}

// Add keepalive function
function startKeepAlive(publicKey) {
  const normalizedKey = publicKey.toLowerCase();
  const peer = connectedPeers.get(normalizedKey);
  if (!peer || !peer.protocol) return;
  
  console.log(`[RelayServer] Starting keepalive for ${publicKey.substring(0, 8)}...`);
  
  // Send periodic health responses to keep connection alive
  peer.keepAliveInterval = setInterval(async () => {
    try {
      if (peer.protocol && peer.protocol.channel && !peer.protocol.channel.closed) {
        // Just check if the connection is still valid
        console.log(`[RelayServer] Keepalive check for ${publicKey.substring(0, 8)}...`);
      } else {
        console.log(`[RelayServer] Connection lost for ${publicKey.substring(0, 8)}, stopping keepalive`);
        clearInterval(peer.keepAliveInterval);
        connectedPeers.delete(normalizedKey);
      }
    } catch (error) {
      console.error(`[RelayServer] Keepalive error for ${publicKey.substring(0, 8)}:`, error.message);
    }
  }, 15000); // Every 15 seconds
}

// Set gateway connection and process pending registrations
function setGatewayConnection(protocol, publicKey) {
  gatewayConnection = protocol;
  healthState.services.gatewayStatus = 'connected';
  
  // Mark peer as identified
  const normalizedKey = publicKey.toLowerCase();
  const peer = connectedPeers.get(normalizedKey);
  if (peer) {
    peer.identified = true;
    peer.isGateway = true;
  }
  
  console.log('[RelayServer] ========================================');
  console.log('[RelayServer] GATEWAY CONNECTION ESTABLISHED');
  console.log('[RelayServer] Gateway public key:', publicKey);
  console.log('[RelayServer] Connection time:', new Date().toISOString());
  console.log('[RelayServer] ========================================');
  
  // Update worker status
  if (global.sendMessage) {
    console.log('[RelayServer] Notifying worker of gateway connection');
    global.sendMessage({
      type: 'gateway-connected',
      gatewayPublicKey: publicKey
    });
  }
  
  // Process any pending registrations
  processPendingRegistrations();
}

// Process pending registrations
async function processPendingRegistrations() {
  if (!gatewayConnection) {
    console.log('[RelayServer] Cannot process pending registrations - no gateway connection');
    return;
  }
  
  if (pendingRegistrations.length === 0) {
    console.log('[RelayServer] No pending registrations to process');
    return;
  }
  
  console.log('[RelayServer] ----------------------------------------');
  console.log(`[RelayServer] Processing ${pendingRegistrations.length} pending registrations`);
  
  let processedCount = 0;
  while (pendingRegistrations.length > 0) {
    const registration = pendingRegistrations.shift();
    console.log('[RelayServer] Processing pending registration:', registration ? 'with profile' : 'general update');
    try {
      await registerWithGateway(registration, { skipQueue: true });
      processedCount++;
    } catch (error) {
      console.error('[RelayServer] Pending registration failed:', error.message);
      pendingRegistrations.unshift(registration);
      console.log('[RelayServer] Will retry pending registrations later');
      return;
    }
  }
  
  if (processedCount > 0) {
    console.log('[RelayServer] Sending fresh registration with current state');
    try {
      await registerWithGateway(null, { skipQueue: true });
    } catch (error) {
      console.error('[RelayServer] Failed to send catch-up registration:', error.message);
      pendingRegistrations.unshift(null);
    }
  }

  console.log('[RelayServer] ----------------------------------------');
}

// Setup protocol handlers for all endpoints
function setupProtocolHandlers(protocol) {
  console.log('[RelayServer] Setting up protocol handlers');
  
  // Health endpoint
  protocol.handle('/health', async () => {
    console.log('[RelayServer] Health check requested');
    await updateHealthState();
    
    const activeRelays = await getActiveRelays();
    
    // Always return healthy if we're connected
    const healthResponse = {
        status: 'healthy', // Force healthy status when responding
        uptime: Date.now() - healthState.startTime,
        lastCheck: healthState.lastCheck,
        activeRelays: {
            count: healthState.activeRelaysCount,
            keys: activeRelays.map(r => r.relayKey)
        },
        services: {
            ...healthState.services,
            // Ensure protocol status is connected when we're responding
            protocolStatus: 'connected',
            hyperswarmStatus: 'connected'
        },
        metrics: {
            ...healthState.metrics,
            successRate: healthState.metrics.totalRequests === 0 ? 100 : 
              (healthState.metrics.successfulRequests / healthState.metrics.totalRequests) * 100
        },
        config: {
            port: config.port,
            proxy_server_address: config.proxy_server_address,
            gatewayUrl: config.gatewayUrl,
            publicKey: config.swarmPublicKey
        },
        timestamp: new Date().toISOString()
    };
    
    updateMetrics(true);
    
    console.log('[RelayServer] Sending health response:', {
        status: healthResponse.status,
        activeRelays: healthResponse.activeRelays.count
    });
    
    return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify(healthResponse))
    };
});
  
  // Get relay list
  protocol.handle('/relays', async () => {
    console.log('[RelayServer] Relay list requested');
    try {
        const activeRelays = await getActiveRelays();
        const profiles = await getRelayProfiles();
        
        const gatewayBase = buildGatewayWebsocketBase(config);
        const relayList = activeRelays.map(relay => {
            const profile = profiles.find(p => p.relay_key === relay.relayKey) || {};
            
            // Use public identifier in the connection URL if available
            const connectionUrl = profile.public_identifier ? 
                `${gatewayBase}/${profile.public_identifier.replace(':', '/')}` :
                `${gatewayBase}/${relay.relayKey}`;
            
            return {
                relayKey: relay.relayKey, // Still include for backward compatibility
                publicIdentifier: profile.public_identifier || null, // Include public identifier
                connectionUrl: connectionUrl,
                name: profile.name || 'Unnamed Relay',
                description: profile.description || '',
                createdAt: profile.created_at || profile.joined_at || null,
                peerCount: relay.peerCount || 0
            };
        });
        
        console.log(`[RelayServer] Returning ${relayList.length} relays`);
        updateMetrics(true);
        return {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: b4a.from(JSON.stringify({
                relays: relayList,
                count: relayList.length
            }))
        };
    } catch (error) {
        console.error('[RelayServer] Error getting relay list:', error);
        updateMetrics(false);
        return {
            statusCode: 500,
            headers: { 'content-type': 'application/json' },
            body: b4a.from(JSON.stringify({ error: error.message }))
        };
    }
});
  
  // Create relay
  protocol.handle('/relay/create', async (request) => {
    console.log('[RelayServer] Create relay requested');
    const body = JSON.parse(request.body.toString());
    const { name, description, isPublic = false, isOpen = false, fileSharing = false } = body;

    console.log('[RelayServer] Creating relay:', { name, description, isPublic, isOpen, fileSharing });
    
    if (!name) {
      updateMetrics(false);
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ error: 'Relay name is required' }))
      };
    }
    
    try {
      const result = await createRelayManager({
        name,
        description,
        isPublic,
        isOpen,
        fileSharing,
        config
      });
      
      if (result.success) {
        console.log('[RelayServer] Relay created successfully:', result.relayKey);
        await updateHealthState();
        
        // Send update to parent if connected
        if (global.sendMessage) {
          const activeRelays = await getActiveRelays();
          global.sendMessage({
            type: 'relay-update',
            relays: activeRelays
          });
        }
        
        // ALWAYS register with gateway via Hyperswarm if enabled
        if (config.registerWithGateway) {
          console.log('[RelayServer] Registering new relay with gateway via Hyperswarm');
          try {
            await registerWithGateway(result.profile);
            console.log('[RelayServer] Successfully registered new relay with gateway');
          } catch (regError) {
            console.error('[RelayServer] Failed to register new relay with gateway:', regError.message);
            // Don't fail the relay creation, just log the error
          }
        }
        
        updateMetrics(true);
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify(result))
        };
      } else {
        console.error('[RelayServer] Failed to create relay:', result.error);
        updateMetrics(false);
        return {
          statusCode: 500,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: result.error }))
        };
      }
    } catch (error) {
      console.error('[RelayServer] Error creating relay:', error);
      updateMetrics(false);
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ error: error.message }))
      };
    }
  });
  
  // Join relay
  protocol.handle('/relay/join', async (request) => {
    console.log('[RelayServer] Join relay requested');
    const body = JSON.parse(request.body.toString());
    const { relayKey, name, description, fileSharing = false } = body;

    console.log('[RelayServer] Joining relay:', { relayKey, name, description, fileSharing });
    
    if (!relayKey) {
      updateMetrics(false);
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ error: 'Relay key is required' }))
      };
    }
    
    try {
      const result = await joinRelayManager({
        relayKey,
        name,
        description,
        fileSharing,
        config
      });
      
      if (result.success) {
        console.log('[RelayServer] Joined relay successfully');
        await updateHealthState();
        
        // Send update to parent
        if (global.sendMessage) {
          const activeRelays = await getActiveRelays();
          global.sendMessage({
            type: 'relay-update',
            relays: activeRelays
          });
        }
        
        // ALWAYS register with gateway via Hyperswarm if enabled
        if (config.registerWithGateway) {
          console.log('[RelayServer] Registering joined relay with gateway via Hyperswarm');
          try {
            // For join, we register all relays since we don't have specific profile for joined relay
            await registerWithGateway();
            console.log('[RelayServer] Successfully registered joined relay with gateway');
          } catch (regError) {
            console.error('[RelayServer] Failed to register joined relay with gateway:', regError.message);
            // Don't fail the relay join, just log the error
          }
        }
        
        updateMetrics(true);
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify(result))
        };
      } else {
        console.error('[RelayServer] Failed to join relay:', result.error);
        updateMetrics(false);
        return {
          statusCode: 500,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: result.error }))
        };
      }
    } catch (error) {
      console.error('[RelayServer] Error joining relay:', error);
      updateMetrics(false);
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ error: error.message }))
      };
    }
  });

  // Handle join requests
  protocol.handle('/post/join/:identifier', async (request) => {
    const rawIdentifier = request.params.identifier;
    const identifier = normalizeRelayIdentifier(rawIdentifier);
    console.log(`[RelayServer] Join request for relay: ${rawIdentifier}`);
    if (rawIdentifier !== identifier) {
      console.log(`[RelayServer] Normalized identifier: ${identifier}`);
    }

    try {
      const body = JSON.parse(request.body.toString());
      const { event } = body;

      if (!event) {
        updateMetrics(false);
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: 'Missing required fields' }))
        };
      }
      
      // Verify this is a kind 9021 event
      if (event.kind !== 9021) {
        updateMetrics(false);
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: 'Invalid event kind' }))
        };
      }

      // Load relay profile using the public identifier
      const profile = await getRelayProfileByPublicIdentifier(identifier);
      if (!profile) {
        updateMetrics(false);
        return {
          statusCode: 404,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: 'Relay not found' }))
        };
      }

      try {
        await publishEventToRelay(identifier, event);
        console.log(`[RelayServer] Published kind 9021 join request event`);
      } catch (publishError) {
        console.error(`[RelayServer] Failed to publish join request:`, publishError);
        // Continue anyway - the auth process can still work
      }

      if (profile.isOpen === false) {
        updateMetrics(true);
        return {
          statusCode: 200,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ status: 'pending' }))
        };
      }

      // Generate challenge
      const challengeManager = getChallengeManager();
      const { challenge, relayPubkey } = challengeManager.createChallenge(event.pubkey, identifier);
      
      console.log(`[RelayServer] Generated challenge for ${event.pubkey.substring(0, 8)}...`);
      
      // Prepare response with challenge information only
      const response = {
        challenge,
        relayPubkey
      };
      
      updateMetrics(true);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify(response))
      };
      
    } catch (error) {
      console.error(`[RelayServer] Error processing join request:`, error);
      updateMetrics(false);
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ error: error.message }))
      };
    }
  });

  // Handle verify ownership
  protocol.handle('/verify-ownership', async (request) => {
    console.log(`[RelayServer] ========================================`);
    console.log(`[RelayServer] VERIFY OWNERSHIP REQUEST`);
    
    try {
      const body = JSON.parse(request.body.toString());
      const { pubkey, ciphertext, iv } = body;
      
      if (!pubkey || !ciphertext || !iv) {
        console.error(`[RelayServer] Missing required fields`);
        updateMetrics(false);
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: 'Missing required fields' }))
        };
      }
      
      console.log(`[RelayServer] Verifying for pubkey: ${pubkey.substring(0, 8)}...`);
      console.log(`[RelayServer] Ciphertext length: ${ciphertext.length}`);
      console.log(`[RelayServer] IV length: ${iv.length}`);
      
      // Verify the challenge
      const challengeManager = getChallengeManager();
      const result = await challengeManager.verifyChallenge(pubkey, ciphertext, iv);
      
      if (!result.success) {
        console.error(`[RelayServer] Verification failed: ${result.error}`);
        updateMetrics(false);
        return {
          statusCode: 400,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: result.error }))
        };
      }
      
      console.log(`[RelayServer] Verification SUCCESSFUL`);
      console.log(`[RelayServer] Token: ${result.token.substring(0, 16)}...`);
      console.log(`[RelayServer] Identifier: ${result.identifier}`);

      // Finalize authentication locally (replaces /finalize-auth)

      const canonicalIdentifier = normalizeRelayIdentifier(result.identifier);
      let internalRelayKey = canonicalIdentifier;
      const resolvedKey = await getRelayKeyFromPublicIdentifier(canonicalIdentifier);
      if (resolvedKey) {
        internalRelayKey = resolvedKey;
      }

      const authStore = getRelayAuthStore();
      authStore.addAuth(internalRelayKey, pubkey, result.token);
      if (internalRelayKey !== canonicalIdentifier) {
        authStore.addAuth(canonicalIdentifier, pubkey, result.token);
      }

      let profile = await getRelayProfileByKey(internalRelayKey);
      if (!profile) {
        profile = await getRelayProfileByPublicIdentifier(canonicalIdentifier);
      }

      if (profile) {
        await updateRelayAuthToken(internalRelayKey, pubkey, result.token);
        const currentAdds = profile.member_adds || [];
        const currentRemoves = profile.member_removes || [];
        const memberAdd = { pubkey, ts: Date.now() };
        const existingIndex = currentAdds.findIndex(m => m.pubkey === pubkey);
        if (existingIndex >= 0) currentAdds[existingIndex] = memberAdd;
        else currentAdds.push(memberAdd);
        await updateRelayMemberSets(internalRelayKey, currentAdds, currentRemoves);
        await publishMemberAddEvent(canonicalIdentifier, pubkey, result.token);
      }

      const relayUrl = `${buildGatewayWebsocketBase(config)}/${canonicalIdentifier.replace(':', '/')}?token=${result.token}`;

      console.log(`[RelayServer] Auth finalized successfully`);
      updateMetrics(true);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({
          success: true,
          relayKey: internalRelayKey,
          publicIdentifier: canonicalIdentifier,
          authToken: result.token,
          relayUrl
        }))
      };
      
    } catch (error) {
      console.error(`[RelayServer] ========================================`);
      console.error(`[RelayServer] VERIFY OWNERSHIP ERROR`);
      console.error(`[RelayServer] Error:`, error.message);
      console.error(`[RelayServer] Stack:`, error.stack);
      console.error(`[RelayServer] ========================================`);
      
      updateMetrics(false);
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ error: error.message }))
      };
    }
  });

  // Removed finalize-auth and authorize handlers (handled during verification)

  // Disconnect from relay
  protocol.handle('/relay/:identifier/disconnect', async (request) => {
    const rawIdentifier = request.params.identifier;
    const identifier = normalizeRelayIdentifier(rawIdentifier);
    console.log('[RelayServer] Disconnect relay requested for identifier:', rawIdentifier);
    if (rawIdentifier !== identifier) {
      console.log(`[RelayServer] Normalized identifier: ${identifier}`);
    }
    
    try {
        // Resolve public identifier to relay key if needed
        let relayKey = await getRelayKeyFromPublicIdentifier(identifier) || identifier;
        if (relayKey !== identifier) {
            console.log(`[RelayServer] Resolved public identifier ${identifier} to relay key ${relayKey.substring(0, 8)}...`);
        } else if (!/^[a-f0-9]{64}$/i.test(relayKey)) {
            console.warn(`[RelayServer] No relay found for public identifier: ${identifier}`);
            updateMetrics(false);
            return {
                statusCode: 404,
                headers: { 'content-type': 'application/json' },
                body: b4a.from(JSON.stringify({ error: 'Relay not found' }))
            };
        }
        
        const result = await disconnectRelayManager(relayKey);
        
        if (result.success) {
            console.log('[RelayServer] Disconnected from relay successfully');
            await updateHealthState();
            
            // Send update to parent
            if (global.sendMessage) {
                const activeRelays = await getActiveRelays();
                global.sendMessage({
                    type: 'relay-update',
                    relays: activeRelays
                });
            }
            
            // Update gateway if connected
            if (config.registerWithGateway && gatewayConnection) {
                console.log('[RelayServer] Updating gateway after relay disconnect');
                try {
                    await registerWithGateway();
                } catch (regError) {
                    console.error('[RelayServer] Failed to notify gateway of relay disconnect:', regError.message);
                }
            }
            
            updateMetrics(true);
            return {
                statusCode: 200,
                headers: { 'content-type': 'application/json' },
                body: b4a.from(JSON.stringify(result))
            };
        } else {
            console.error('[RelayServer] Failed to disconnect relay:', result.error);
            updateMetrics(false);
            return {
                statusCode: 404,
                headers: { 'content-type': 'application/json' },
                body: b4a.from(JSON.stringify({ error: result.error }))
            };
        }
    } catch (error) {
        console.error('[RelayServer] Error disconnecting relay:', error);
        updateMetrics(false);
        return {
            statusCode: 500,
            headers: { 'content-type': 'application/json' },
            body: b4a.from(JSON.stringify({ error: error.message }))
        };
    }
});
  
  // Handle relay messages (from gateway)
  protocol.handle('/post/relay/:identifier', async (request) => {
    const rawIdentifier = request.params.identifier;
    const identifier = normalizeRelayIdentifier(rawIdentifier);
    const { message, connectionKey } = JSON.parse(request.body.toString());

    console.log(`[RelayServer] Relay message for identifier: ${rawIdentifier}, connectionKey: ${connectionKey}`);
    if (rawIdentifier !== identifier) {
      console.log(`[RelayServer] Normalized identifier: ${identifier}`);
    }
    
    try {
      // Extract auth token from request headers
      let authToken = request.headers['x-auth-token'];
      if (!authToken && request.query?.token) {
        authToken = request.query.token;
      }

      console.log(`[RelayServer] Auth token present: ${!!authToken}`);
      
      // Check if identifier is a public identifier or relay key
      let relayKey = await getRelayKeyFromPublicIdentifier(identifier) || identifier;
      if (relayKey !== identifier) {
        console.log(`[RelayServer] Resolved public identifier ${identifier} to relay key ${relayKey.substring(0, 8)}...`);
      } else if (!/^[a-f0-9]{64}$/i.test(relayKey)) {
        console.error(`[RelayServer] No relay found for public identifier: ${identifier}`);
        updateMetrics(false);
        return {
          statusCode: 404,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: 'Relay not found' }))
        };
      }
      
      // Parse the message
      let nostrMessage;
      if (message && message.type === 'Buffer' && Array.isArray(message.data)) {
        const messageStr = b4a.from(message.data).toString('utf8');
        try {
          nostrMessage = JSON.parse(messageStr);
        } catch (parseError) {
          throw new Error(`Failed to parse NOSTR message: ${parseError.message}`);
        }
      } else {
        nostrMessage = message;
      }
  
      if (!Array.isArray(nostrMessage)) {
        throw new Error('Invalid NOSTR message format - expected array');
      }
  
      console.log(`[RelayServer] Processing ${nostrMessage[0]} message`);
  
      // Get auth store and check if relay is protected
      const authStore = getRelayAuthStore();
      const authorizedPubkeys = authStore.getAuthorizedPubkeys(relayKey);
      
      // Get relay profile to check auth configuration
      let profile = await getRelayProfileByKey(relayKey);
      if (!profile && identifier !== relayKey) {
        profile = await getRelayProfileByPublicIdentifier(identifier);
      }
      
      const requiresAuth = authorizedPubkeys.length > 0 || 
                          profile?.auth_config?.requiresAuth || 
                          false;
      
      console.log(`[RelayServer] Relay ${identifier} requires auth: ${requiresAuth}`);
      console.log(`[RelayServer] Authorized pubkeys count: ${authorizedPubkeys.length}`);

      // Handle authentication for protected relays
      if (requiresAuth) {
        // For REQ (subscription) messages, check if read access requires auth
        if (nostrMessage[0] === 'REQ') {
          // Some relays might allow public read access
          // You can customize this based on your requirements
          if (profile?.auth_config?.publicRead !== true) {
            if (!authToken) {
              console.warn(`[RelayServer] Missing auth token for REQ on protected relay`);
              updateMetrics(false);
              return {
                statusCode: 403,
                headers: { 'content-type': 'application/json' },
                body: b4a.from(JSON.stringify([
                  ['NOTICE', 'Authentication required for read access']
                ]))
              };
            }

            // Verify auth for REQ
            const auth = authStore.verifyAuth(relayKey, authToken);
            if (!auth) {
              console.warn(`[RelayServer] Invalid auth for REQ`);
              updateMetrics(false);
              return {
                statusCode: 403,
                headers: { 'content-type': 'application/json' },
                body: b4a.from(JSON.stringify([
                  ['NOTICE', 'Invalid authentication']
                ]))
              };
            }
            
            console.log(`[RelayServer] REQ authenticated for ${auth.pubkey.substring(0, 8)}...`);
          }
        }
        
        // For EVENT messages, always require auth
        if (nostrMessage[0] === 'EVENT') {
          const event = nostrMessage.length === 2 ? nostrMessage[1] : nostrMessage[2];
          
          if (!authToken) {
            console.warn(`[RelayServer] Missing auth token for EVENT`);
            updateMetrics(false);

            // Return proper NOSTR OK response with auth error
            const okResponse = ['OK', event?.id || '', false, 'error: authentication required'];
            return {
              statusCode: 200, // Still 200 because it's a valid NOSTR response
              headers: { 'content-type': 'application/json' },
              body: b4a.from(JSON.stringify(okResponse))
            };
          }
          
          // Verify the auth
          const auth = authStore.verifyAuth(relayKey, authToken);
          if (!auth) {
            console.warn(`[RelayServer] Invalid auth token`);
            updateMetrics(false);
            
            const okResponse = ['OK', event?.id || '', false, 'error: invalid authentication'];
            return {
              statusCode: 200,
              headers: { 'content-type': 'application/json' },
              body: b4a.from(JSON.stringify(okResponse))
            };
          }
          
          // Check if the event pubkey matches the authenticated user
          if (event && event.pubkey !== auth.pubkey) {
            console.warn(`[RelayServer] Event pubkey ${event.pubkey} doesn't match auth pubkey ${auth.pubkey}`);
            updateMetrics(false);
            
            const okResponse = ['OK', event.id, false, 'error: pubkey mismatch - event must be signed by authenticated user'];
            return {
              statusCode: 200,
              headers: { 'content-type': 'application/json' },
              body: b4a.from(JSON.stringify(okResponse))
            };
          }
          
          // Get current member list to verify membership
          const members = await getRelayMembers(relayKey);
          if (!members.includes(auth.pubkey)) {
            console.warn(`[RelayServer] Authenticated pubkey ${auth.pubkey} is not a member`);
            updateMetrics(false);
            
            const okResponse = ['OK', event.id, false, 'error: not a member of this relay'];
            return {
              statusCode: 200,
              headers: { 'content-type': 'application/json' },
              body: b4a.from(JSON.stringify(okResponse))
            };
          }
          
          console.log(`[RelayServer] EVENT authenticated and authorized for ${auth.pubkey.substring(0, 8)}...`);
          
          // Update last used timestamp
          auth.lastUsed = Date.now();
        }
      } else {
        // For non-protected relays, still check member list for EVENT messages
        if (nostrMessage[0] === 'EVENT') {
          const event = nostrMessage.length === 2 ? nostrMessage[1] : nostrMessage[2];
          const members = await getRelayMembers(relayKey);
          
          // If relay has members defined, check membership
          if (members.length > 0 && event && !members.includes(event.pubkey)) {
            console.warn(`[RelayServer] Non-member ${event.pubkey} attempting to publish to relay with member list`);
            updateMetrics(false);
            
            const okResponse = ['OK', event.id, false, 'error: not a member of this relay'];
            return {
              statusCode: 200,
              headers: { 'content-type': 'application/json' },
              body: b4a.from(JSON.stringify(okResponse))
            };
          }
        }
      }
      
      // Process the message through relay manager
      const responses = [];
      const sendResponse = (response) => {
        console.log(`[RelayServer] Queueing response for relay ${relayKey}:`, 
          Array.isArray(response) ? `${response[0]} message` : 'unknown response');
        responses.push(response);
      };
      
      await handleRelayMessage(relayKey, nostrMessage, sendResponse, connectionKey);
      
      console.log(`[RelayServer] Handled message, ${responses.length} responses queued`);
      
      // Format responses for return
      const responseBody = responses.length > 0 
        ? responses.map(r => JSON.stringify(r)).join('\n')
        : '';
      
      updateMetrics(true);
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(responseBody)
      };
      
    } catch (error) {
      console.error(`[RelayServer] Error processing message:`, error);
      console.error(`[RelayServer] Stack trace:`, error.stack);
      updateMetrics(false);
      
      // Return NOTICE with error
      return {
        statusCode: 200, // Still 200 for valid NOSTR error response
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify([
          ['NOTICE', `Error: ${error.message}`]
        ]))
      };
    }
  });
  
  // Handle relay subscriptions (from gateway)
  protocol.handle('/get/relay/:identifier/:connectionKey', async (request) => {
    const rawIdentifier = request.params.identifier;
    const identifier = normalizeRelayIdentifier(rawIdentifier);
    // Extract auth token from request headers
    let authToken = request.headers['x-auth-token'];
    if (!authToken && request.query?.token) {
      authToken = request.query.token;
    }
    const connectionKey = request.params.connectionKey;

    console.log(`[RelayServer] Checking subscriptions for identifier: ${rawIdentifier}, connectionKey: ${connectionKey}`);
    if (rawIdentifier !== identifier) {
      console.log(`[RelayServer] Normalized identifier: ${identifier}`);
    }
    
    try {
        // Resolve public identifier to relay key if needed
        let relayKey = await getRelayKeyFromPublicIdentifier(identifier) || identifier;
        if (relayKey !== identifier) {
            console.log(`[RelayServer] Resolved public identifier ${identifier} to relay key ${relayKey.substring(0, 8)}...`);
        } else if (!/^[a-f0-9]{64}$/i.test(relayKey)) {
            console.error(`[RelayServer] No relay found for public identifier: ${identifier}`);
            updateMetrics(false);
            return {
                statusCode: 404,
                headers: { 'content-type': 'application/json' },
                body: b4a.from(JSON.stringify(['NOTICE', 'Relay not found']))
            };
        }

        // Get auth store and check if relay is protected
        const authStore = getRelayAuthStore();
        const authorizedPubkeys = authStore.getAuthorizedPubkeys(relayKey);

        // Get relay profile to check auth configuration
        let profile = await getRelayProfileByKey(relayKey);
        if (!profile && identifier !== relayKey) {
        profile = await getRelayProfileByPublicIdentifier(identifier);
      }

      const requiresAuth = authorizedPubkeys.length > 0 ||
                          profile?.auth_config?.requiresAuth ||
                          false;

      console.log(`[RelayServer] Relay ${identifier} requires auth for read: ${requiresAuth}`);
      console.log(`[RelayServer] Authorized pubkeys count: ${authorizedPubkeys.length}`);

      // Handle authentication for protected relays
      if (requiresAuth) {
        // This endpoint is implicitly for REQ messages (fetching events for a subscription)
        // Check if public read access is explicitly allowed
          if (profile?.auth_config?.publicRead !== true) {
            if (!authToken) {
              console.warn(`[RelayServer] Missing auth token for read access on protected relay`);
              updateMetrics(false);
              return {
                statusCode: 200, // Return 200 for valid NOSTR NOTICE response
                headers: { 'content-type': 'application/json' },
                body: b4a.from(JSON.stringify([
                  ['NOTICE', 'Authentication required for read access']
                ]))
              };
            }

            // Verify auth
            const auth = authStore.verifyAuth(relayKey, authToken);
            if (!auth) {
              console.warn(`[RelayServer] Invalid auth for read access`);
              updateMetrics(false);
              return {
                statusCode: 200, // Return 200 for valid NOSTR NOTICE response
                headers: { 'content-type': 'application/json' },
                body: b4a.from(JSON.stringify([
                  ['NOTICE', 'Invalid authentication']
                ]))
              };
            }

            console.log(`[RelayServer] Read access authenticated for ${auth.pubkey.substring(0, 8)}...`);
            // Update last used timestamp
            auth.lastUsed = Date.now();
          } else {
            console.log(`[RelayServer] Relay ${identifier} allows public read access despite requiring auth.`);
          }
        }
        
        const [events, activeSubscriptionsUpdated] = await handleRelaySubscription(relayKey, connectionKey);
        
        if (!Array.isArray(events)) {
            console.log(`[RelayServer] Invalid response format from handleSubscription`);
            updateMetrics(false);
            return {
                statusCode: 500,
                headers: { 'content-type': 'application/json' },
                body: b4a.from(JSON.stringify(['NOTICE', 'Internal server error: Invalid response format']))
            };
        }
  
        console.log(`[RelayServer] Found ${events.length} events for connectionKey: ${connectionKey}`);
        
        // Update subscriptions if needed
        if (activeSubscriptionsUpdated) {
            try {
                console.log(`[RelayServer] Updating subscriptions for connectionKey: ${connectionKey}`);
                await updateRelaySubscriptions(relayKey, connectionKey, activeSubscriptionsUpdated);
                console.log(`[RelayServer] Successfully updated subscriptions for connectionKey: ${connectionKey}`);
            } catch (updateError) {
                console.log(`[RelayServer] Warning: Failed to update subscriptions for connectionKey: ${connectionKey}:`, updateError.message);
            }
        }
        
        updateMetrics(true);
        return {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: b4a.from(JSON.stringify(events))
        };
        
    } catch (error) {
        console.error(`[RelayServer] Error processing subscription:`, error);
        updateMetrics(false);
        return {
            statusCode: 500,
            headers: { 'content-type': 'application/json' },
            body: b4a.from(JSON.stringify(['NOTICE', `Error: ${error.message}`]))
        };
    }
});

  
  // Registration endpoint (for gateway to call)
  protocol.handle('/register', async (request) => {
    const registrationData = JSON.parse(request.body.toString());
    console.log('[RelayServer] Registration endpoint called by gateway');
    console.log('[RelayServer] Registration data:', registrationData);
    
    // Handle any registration response from gateway
    updateMetrics(true);
    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: b4a.from(JSON.stringify({ 
        status: 'acknowledged',
        timestamp: new Date().toISOString()
      }))
    };
  });

  // Serve files stored in Hyperdrive
  protocol.handle('/drive/:identifier/:file', async (request) => {
    const rawIdentifier = request.params.identifier;
    const identifier = normalizeRelayIdentifier(rawIdentifier);
    const fileId = request.params.file;

    console.log(`[RelayServer] Drive file requested: ${rawIdentifier}/${fileId}`);
    if (rawIdentifier !== identifier) {
      console.log(`[RelayServer] Normalized identifier: ${identifier}`);
    }

    try {
      const hash = fileId.split('.')[0];
      // Prefer new layout using publicIdentifier path; fall back to legacy relayKey path
      let fileBuffer = await getFile(identifier, hash);
      if (!fileBuffer) {
        const relayKey = await getRelayKeyFromPublicIdentifier(identifier);
        if (!fileBuffer && !relayKey && !/^[a-f0-9]{64}$/i.test(identifier)) {
          updateMetrics(false);
          return {
            statusCode: 404,
            headers: { 'content-type': 'application/json' },
            body: b4a.from(JSON.stringify({ error: 'Relay not found' }))
          };
        }
        if (relayKey) {
          fileBuffer = await getFile(relayKey, hash);
        }
      }
      if (!fileBuffer) {
        updateMetrics(false);
        return {
          statusCode: 404,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: 'File not found' }))
        };
      }

      // Determine content type from file extension
      let contentType = 'application/octet-stream';
      if (fileId.includes('.')) {
        const ext = fileId.split('.').pop().toLowerCase();
        const mimeTypes = {
          'jpg': 'image/jpeg',
          'jpeg': 'image/jpeg',
          'png': 'image/png',
          'gif': 'image/gif',
          'pdf': 'application/pdf',
          'txt': 'text/plain'
        };
        contentType = mimeTypes[ext] || contentType;
      }

      updateMetrics(true);
      return {
        statusCode: 200,
        headers: {
          'content-type': contentType,
          'content-length': fileBuffer.length.toString()
        },
        body: b4a.from(fileBuffer)
      };
    } catch (error) {
      console.error('[RelayServer] Error fetching drive file:', error);
      updateMetrics(false);
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ error: error.message }))
      };
    }
  });

  async function handlePfpRequest(request, ownerParam = null) {
    const rawOwner = ownerParam || request.params.owner || null;
    const fileId = request.params.file;

    if (!fileId) {
      updateMetrics(false);
      return {
        statusCode: 400,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ error: 'Missing file identifier' }))
      };
    }

    try {
      const hash = fileId.split('.')[0];
      const ownerKey = rawOwner ? rawOwner.trim() : '';
      const fileBuffer = await getPfpFile(ownerKey, hash);

      if (!fileBuffer) {
        updateMetrics(false);
        return {
          statusCode: 404,
          headers: { 'content-type': 'application/json' },
          body: b4a.from(JSON.stringify({ error: 'Avatar not found' }))
        };
      }

      const ext = fileId.includes('.') ? fileId.split('.').pop().toLowerCase() : '';
      const mimeTypes = {
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        gif: 'image/gif',
        webp: 'image/webp'
      };
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      updateMetrics(true);
      return {
        statusCode: 200,
        headers: {
          'content-type': contentType,
          'cache-control': 'public, max-age=60'
        },
        body: b4a.from(fileBuffer)
      };
    } catch (error) {
      console.error('[RelayServer] PFP handler error:', error);
      updateMetrics(false);
      return {
        statusCode: 500,
        headers: { 'content-type': 'application/json' },
        body: b4a.from(JSON.stringify({ error: 'Internal Server Error', message: error.message }))
      };
    }
  }

  protocol.handle('/pfp/:file', (request) => handlePfpRequest(request, null));
  protocol.handle('/pfp/:owner/:file', (request) => handlePfpRequest(request));
  
  console.log('[RelayServer] Protocol handlers setup complete');
}

// Helper function to publish member add event (kind 9000)
// role can be 'admin' when the creator is automatically authorized during relay creation
async function publishMemberAddEvent(identifier, pubkey, token, subnetHashes = [], role = 'member') {
  try {
    console.log(`[RelayServer] Publishing kind 9000 event for ${pubkey.substring(0, 8)}...`);
    const canonicalIdentifier = normalizeRelayIdentifier(identifier);

    // Create the event
    let event = {
      kind: 9000,
      content: `Adding user ${pubkey} with auth token`,
      created_at: Math.floor(Date.now() / 1000),
      tags: [
        ['h', canonicalIdentifier],
        ['p', pubkey, role, token, ...subnetHashes] // Spread all subnet hashes
      ],
      pubkey: config.nostr_pubkey_hex
    };
    
    // Use NostrUtils to sign the event, which also generates the ID
    event = await NostrUtils.signEvent(event, config.nostr_nsec_hex);
    
    // Publish to the relay
    await publishEventToRelay(canonicalIdentifier, event);
    
    console.log(`[RelayServer] Published kind 9000 event: ${event.id.substring(0, 8)}...`);
    
  } catch (error) {
    console.error(`[RelayServer] Error publishing member add event:`, error);
  }
}

async function isRelayAuthProtected(identifier) {
  try {
    const canonicalIdentifier = normalizeRelayIdentifier(identifier);
    // Check auth store first
    const authStore = getRelayAuthStore();
    let relayKey = await getRelayKeyFromPublicIdentifier(canonicalIdentifier) || canonicalIdentifier;
    
    const authorizedPubkeys = authStore.getAuthorizedPubkeys(relayKey);
    if (authorizedPubkeys.length > 0) {
      return true;
    }
    
    // Check profile configuration
    let profile = await getRelayProfileByKey(relayKey);
    if (!profile) {
      profile = await getRelayProfileByPublicIdentifier(canonicalIdentifier);
    }
    
    return profile?.auth_config?.requiresAuth || false;
  } catch (error) {
    console.error(`[RelayServer] Error checking auth status:`, error);
    return false;
  }
}

// Helper function to publish event to relay
async function publishEventToRelay(identifier, event) {
  try {
    const canonicalIdentifier = normalizeRelayIdentifier(identifier);
    console.log(`[RelayServer] Publishing event to relay ${canonicalIdentifier}:`, event);
    
    // Resolve public identifier to relay key if needed
    let relayKey = await getRelayKeyFromPublicIdentifier(canonicalIdentifier) || canonicalIdentifier;
    if (!/^[a-f0-9]{64}$/i.test(relayKey)) {
      throw new Error(`No relay found for identifier: ${canonicalIdentifier}`);
    }
    
    // Get the relay manager from activeRelays (imported from adapter)
    const { activeRelays } = await import('./hypertuna-relay-manager-adapter.mjs');
    const relayManager = activeRelays.get(relayKey);
    
    if (!relayManager) {
      throw new Error(`Relay manager not found for key: ${relayKey}`);
    }
    
    // Publish the event
    const result = await relayManager.publishEvent(event);
    console.log(`[RelayServer] Event published successfully:`, result);
    
    return result;
  } catch (error) {
    console.error(`[RelayServer] Error publishing event to relay:`, error);
    throw error;
  }
}

// Wait for a relay to become writable before attempting writes
async function waitForRelayWritable(relayKey, timeout = 10000) {
  const { activeRelays } = await import('./hypertuna-relay-manager-adapter.mjs');
  const relayManager = activeRelays.get(relayKey);
  if (!relayManager) return;

  const start = Date.now();
  while (!relayManager.relay?.writable) {
    if (Date.now() - start > timeout) {
      console.warn(`[RelayServer] Timeout waiting for relay ${relayKey} to become writable`);
      break;
    }
    await new Promise(res => setTimeout(res, 200));
  }
}

// Update health state
async function updateHealthState() {
  const now = Date.now();
  healthState.lastCheck = now;
  const activeRelays = await getActiveRelays(); // Added await
  healthState.activeRelaysCount = activeRelays.length;
  
  if (healthState.activeRelaysCount > 0 && healthState.services.hyperswarmStatus === 'connected') {
    healthState.status = 'healthy';
  } else if (healthState.services.hyperswarmStatus === 'connected') {
    healthState.status = 'ready';
  } else {
    healthState.status = 'degraded';
  }
  
  console.log('[RelayServer] Health state updated:', {
    status: healthState.status,
    activeRelays: healthState.activeRelaysCount,
    services: healthState.services
  });
}

// Start health monitoring
function startHealthMonitoring() {
  console.log('[RelayServer] Starting health monitoring (30s interval)');
  
  setInterval(async () => { // Made async
    await updateHealthState(); // Added await
    
    // Check if health state is stale
    const now = Date.now();
    if (now - healthState.lastCheck > 30000) {
      healthState.status = 'warning';
    }
    
    console.log('[RelayServer] Periodic health check:', {
      status: healthState.status,
      activeRelays: healthState.activeRelaysCount,
      services: healthState.services,
      connectedPeers: connectedPeers.size,
      gatewayConnected: !!gatewayConnection
    });
    
    // Send health update to parent
    if (global.sendMessage) {
      global.sendMessage({
        type: 'health-update',
        healthState
      });
    }
  }, 30000); // Every 30 seconds
}

// Update metrics
function updateMetrics(success = true) {
  healthState.metrics.totalRequests++;
  if (success) {
    healthState.metrics.successfulRequests++;
  } else {
    healthState.metrics.failedRequests++;
  }
  
  // Reset metrics every hour
  if (Date.now() - healthState.metrics.lastMetricsReset > 60 * 60 * 1000) {
    console.log('[RelayServer] Resetting hourly metrics');
    healthState.metrics.totalRequests = 0;
    healthState.metrics.successfulRequests = 0;
    healthState.metrics.failedRequests = 0;
    healthState.metrics.lastMetricsReset = Date.now();
  }
}

// Register with gateway using Hyperswarm
async function registerWithGateway(relayProfileInfo = null, options = {}) {
  const { skipQueue = false } = options || {};

  console.log('[RelayServer] ========================================');
  console.log('[RelayServer] GATEWAY REGISTRATION ATTEMPT (Hyperswarm)');
  console.log('[RelayServer] Timestamp:', new Date().toISOString());

  if (!config.registerWithGateway) {
    console.log('[RelayServer] Gateway registration is DISABLED in config');
    console.log('[RelayServer] ========================================');
    return { skipped: true };
  }

  const publicKey = config.swarmPublicKey;
  if (!publicKey) {
    console.warn('[RelayServer] Cannot register with gateway - swarm public key unavailable');
    return { skipped: true };
  }

  try {
    const activeRelays = await getActiveRelays();
    const profiles = await getRelayProfiles();

    const profilesByRelayKey = new Map();
    const profilesByIdentifier = new Map();
    for (const profile of profiles) {
      profilesByRelayKey.set(profile.relay_key, profile);
      if (profile.public_identifier) {
        profilesByIdentifier.set(profile.public_identifier, profile);
      }
    }

    const toTimestamp = (value) => {
      if (!value) return null;
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    };

    const resolveProfileAvatar = (profile) => {
      if (!profile) return null;
      const candidates = [
        profile.avatarUrl,
        profile.avatar_url,
        profile.avatar,
        profile.pictureTagUrl,
        profile.picture_tag_url,
        profile.pictureUrl,
        profile.picture_url,
        profile.picture
      ];
      const value = candidates.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
      return value || null;
    };

    const metadataCache = new Map();
    const relayList = [];

    for (const relay of activeRelays) {
      const profile =
        profilesByRelayKey.get(relay.relayKey) ||
        (relay.publicIdentifier ? profilesByIdentifier.get(relay.publicIdentifier) : null) ||
        null;

      const publicIdentifier = String(
        profile?.public_identifier || relay.publicIdentifier || relay.relayKey
      );

      let metadata = metadataCache.get(relay.relayKey);
      if (metadata === undefined) {
        metadata = await getRelayMetadata(relay.relayKey, publicIdentifier);
        metadataCache.set(relay.relayKey, metadata || null);
      }
      const resolvedMetadata = metadata || null;

      const resolvedName =
        resolvedMetadata?.name ||
        profile?.name ||
        relay.name ||
        `Relay ${relay.relayKey.substring(0, 8)}`;

      const resolvedDescription =
        resolvedMetadata?.description ||
        profile?.description ||
        relay.description ||
        '';

      const resolvedAvatar = resolvedMetadata?.avatarUrl || resolveProfileAvatar(profile);

      let resolvedIsPublic;
      if (typeof resolvedMetadata?.isPublic === 'boolean') {
        resolvedIsPublic = resolvedMetadata.isPublic;
      } else if (typeof profile?.isPublic === 'boolean') {
        resolvedIsPublic = profile.isPublic;
      } else if (typeof profile?.is_public === 'boolean') {
        resolvedIsPublic = profile.is_public;
      } else {
        resolvedIsPublic = true;
      }

      const identifierPath = publicIdentifier.includes(':')
        ? publicIdentifier.replace(':', '/')
        : publicIdentifier;

      relayList.push({
        identifier: publicIdentifier,
        name: resolvedName,
        description: resolvedDescription,
        avatarUrl: resolvedAvatar || null,
        isPublic: resolvedIsPublic,
        metadataUpdatedAt: resolvedMetadata?.updatedAt || toTimestamp(profile?.updated_at),
        metadataEventId: resolvedMetadata?.eventId || null,
        gatewayPath: identifierPath
      });
    }

    const advertisedAddress = config.proxy_server_address && config.proxy_server_address.includes(':')
      ? config.proxy_server_address
      : `${config.proxy_server_address}:${config.port}`;

    const registrationData = {
      publicKey,
      relays: relayList,
      address: advertisedAddress,
      mode: 'hyperswarm',
      timestamp: new Date().toISOString(),
      nostrPubkeyHex: config.nostr_pubkey_hex || null,
      pfpDriveKey: config.pfpDriveKey || null
    };

    if (relayProfileInfo) {
      const newRelayIdentifier = String(
        relayProfileInfo.public_identifier || relayProfileInfo.relay_key
      );

      let newRelayMetadata = metadataCache.get(relayProfileInfo.relay_key);
      if (newRelayMetadata === undefined) {
        newRelayMetadata = await getRelayMetadata(
          relayProfileInfo.relay_key,
          newRelayIdentifier
        );
        metadataCache.set(relayProfileInfo.relay_key, newRelayMetadata || null);
      }
      const resolvedNewMetadata = newRelayMetadata || null;

      const profileAvatar = resolveProfileAvatar(relayProfileInfo);

      let newRelayIsPublic;
      if (typeof resolvedNewMetadata?.isPublic === 'boolean') {
        newRelayIsPublic = resolvedNewMetadata.isPublic;
      } else if (typeof relayProfileInfo.isPublic === 'boolean') {
        newRelayIsPublic = relayProfileInfo.isPublic;
      } else if (typeof relayProfileInfo.is_public === 'boolean') {
        newRelayIsPublic = relayProfileInfo.is_public;
      } else {
        newRelayIsPublic = true;
      }

      const identifierPath = newRelayIdentifier.includes(':')
        ? newRelayIdentifier.replace(':', '/')
        : newRelayIdentifier;

      registrationData.newRelay = {
        identifier: newRelayIdentifier,
        name: resolvedNewMetadata?.name || relayProfileInfo.name,
        description: resolvedNewMetadata?.description || relayProfileInfo.description || '',
        avatarUrl: resolvedNewMetadata?.avatarUrl || profileAvatar || null,
        isPublic: newRelayIsPublic,
        metadataUpdatedAt: resolvedNewMetadata?.updatedAt || toTimestamp(relayProfileInfo.updated_at),
        metadataEventId: resolvedNewMetadata?.eventId || null,
        gatewayPath: identifierPath
      };
    }

    if (!gatewayConnection) {
      console.log('[RelayServer] Gateway connection unavailable - queuing registration for later processing');
      if (!skipQueue) {
        pendingRegistrations.push(relayProfileInfo || null);
        console.log(`[RelayServer] Pending registrations queued: ${pendingRegistrations.length}`);
      }
      console.log('[RelayServer] ========================================');
      return { queued: true };
    }

    console.log('[RelayServer] Sending Hyperswarm registration payload to gateway');
    console.log('[RelayServer] Registration data:', {
      publicKey: publicKey.substring(0, 8) + '...',
      relayCount: registrationData.relays.length,
      address: registrationData.address,
      hasNewRelay: !!registrationData.newRelay,
      mode: registrationData.mode
    });

    const response = await gatewayConnection.sendRequest({
      method: 'POST',
      path: '/gateway/register',
      headers: { 'content-type': 'application/json' },
      body: b4a.from(JSON.stringify(registrationData))
    });

    if (response.statusCode !== 200) {
      throw new Error(`Gateway responded with status ${response.statusCode}`);
    }

    let ack = null;
    const responseBody = response.body?.length ? response.body.toString() : '';
    if (responseBody) {
      try {
        ack = JSON.parse(responseBody);
      } catch (parseError) {
        console.warn('[RelayServer] Failed to parse gateway registration acknowledgement:', parseError.message);
      }
    }

    console.log('[RelayServer] Gateway registration acknowledged:', ack || { statusCode: response.statusCode });

    if (ack && ack.subnetHash) {
      config.subnetHash = ack.subnetHash;
      await saveConfig(config);
      console.log(`[RelayServer] Stored subnet hash: ${config.subnetHash.substring(0, 8)}...`);
    }

    if (global.sendMessage) {
      global.sendMessage({
        type: 'gateway-registered',
        data: ack || { statusCode: response.statusCode }
      });
    }

    console.log('[RelayServer] Registration SUCCESSFUL');
    console.log('[RelayServer] ========================================');
    return { acknowledged: true, ack };
  } catch (error) {
    console.error('[RelayServer] Gateway registration via Hyperswarm FAILED:', error.message);
    if (!skipQueue) {
      pendingRegistrations.push(relayProfileInfo || null);
      console.log('[RelayServer] Registration re-queued due to failure');
    }
    console.log('[RelayServer] ========================================');
    throw error;
  }
}

// Export relay management functions for worker access
export async function createRelay(options) {
  // The subnetHash is no longer passed in, it's retrieved from the config
  const { name, description, isPublic = false, isOpen = false, fileSharing = false } = options;
  console.log('[RelayServer] Creating relay via adapter:', { name, description, isPublic, isOpen, fileSharing });

  const result = await createRelayManager({
    name,
    description,
    isPublic,
    isOpen,
    fileSharing,
    config
  });
  
  if (result.success) {
    // This is now the single source of truth for token generation on creation.
    await updateHealthState();
    
    // Auto-authorize the creator
    // Use nostr_pubkey_hex to check if an admin exists to be authorized.
    if (config.nostr_pubkey_hex) {
      try {
        const adminPubkey = config.nostr_pubkey_hex;
        const challengeManager = getChallengeManager();
        const authToken = challengeManager.generateAuthToken(adminPubkey);
        const authStore = getRelayAuthStore();
        
        // The subnet hash might not be available immediately, but we can still create the token.
        const subnetHashes = config.subnetHash ? [config.subnetHash] : [];

        // Add auth to the in-memory store for both internal and public identifiers
        authStore.addAuth(result.relayKey, adminPubkey, authToken);
        const canonicalPublicIdentifier = normalizeRelayIdentifier(result.publicIdentifier);
        if (canonicalPublicIdentifier && canonicalPublicIdentifier !== result.relayKey) {
          authStore.addAuth(canonicalPublicIdentifier, adminPubkey, authToken);
        }
        
        // Persist the token to the relay's profile on disk.
        // This now adds the first auth entry.
        const updatedProfile = await updateRelayAuthToken(result.relayKey, adminPubkey, authToken);

        // CRITICAL: Update the profile in the result object to ensure consistency.
        if (updatedProfile) {
          result.profile = updatedProfile;
        }
        
        // Update the result object with the definitive token and URL.
        result.authToken = authToken;
        result.relayUrl = `${buildGatewayWebsocketBase(config)}/${result.publicIdentifier.replace(':', '/')}?token=${authToken}`;

        await publishMemberAddEvent(result.publicIdentifier, adminPubkey, authToken, subnetHashes, 'admin');
        console.log(`[RelayServer] Auto-authorized creator ${adminPubkey.substring(0, 8)}...`);
      } catch (authError) {
        console.error('[RelayServer] Failed to auto-authorize creator:', authError);
        result.registrationError = (result.registrationError || '') + ` | Auth Error: ${authError.message}`;
      }
    }

    // ALWAYS register with gateway via Hyperswarm if enabled
    let registrationStatus = 'disabled';
    if (config.registerWithGateway) {
      try {
        await registerWithGateway(result.profile);
        registrationStatus = 'success';
      } catch (regError) {
        registrationStatus = 'failed';
        result.registrationError = regError.message;
      }
    }
    result.gatewayRegistration = registrationStatus;
  }
  
  return result;
}

export async function joinRelay(options) {
  const { fileSharing = false } = options;
  console.log('[RelayServer] Joining relay via adapter:', { ...options, fileSharing });
  const result = await joinRelayManager({
    ...options,
    fileSharing,
    config
  });
  
  if (result.success) {
    await updateHealthState();
    
    // ALWAYS register with gateway via Hyperswarm if enabled
    let registrationStatus = 'disabled';
    if (config.registerWithGateway) {
      try {
        await registerWithGateway(result.profile);
        registrationStatus = 'success';
      } catch (regError) {
        registrationStatus = 'failed';
        result.registrationError = regError.message;
      }
    }
    result.gatewayRegistration = registrationStatus;
  }
  
  return result;
}

/**
 * Helper function to create a kind 9021 join request event.
 * This replicates the logic from the desktop's NostrEvents class.
 * @param {string} publicIdentifier - The public identifier of the relay to join.
 * @param {string} privateKey - The user's hex-encoded private key for signing.
 * @returns {Promise<Object>} - A signed Nostr event.
 */
async function createGroupJoinRequest(publicIdentifier, privateKey) {
  const pubkey = NostrUtils.getPublicKey(privateKey);
  const event = {
    kind: 9021, // KIND_GROUP_JOIN_REQUEST
    content: 'Request to join the group',
    tags: [['h', publicIdentifier]],
    created_at: Math.floor(Date.now() / 1000),
    pubkey
  };
  return NostrUtils.signEvent(event, privateKey);
}

export async function startJoinAuthentication(options) {
  const { publicIdentifier, fileSharing = false, hostPeers: hostPeerList = [] } = options;
  const userNsec = config.nostr_nsec_hex;
  const userPubkey = NostrUtils.getPublicKey(userNsec);
  if (config.nostr_pubkey_hex && userPubkey !== config.nostr_pubkey_hex) {
    console.warn('[RelayServer] Derived pubkey does not match configured pubkey');
  }

  console.log(`[RelayServer] Starting join authentication for: ${publicIdentifier}`);
  console.log(`[RelayServer] Using user pubkey: ${userPubkey.substring(0, 8)}...`);
  console.log(`[RelayServer] File sharing enabled: ${fileSharing}`);

  if (!publicIdentifier || !userPubkey || !userNsec) {
    const errorMsg = 'Missing publicIdentifier or user credentials for join flow.';
    console.error(`[RelayServer] ${errorMsg}`);
    if (global.sendMessage) {
      global.sendMessage({
        type: 'join-auth-error',
        data: {
          publicIdentifier,
          error: errorMsg
        }
      });
    }
    return;
  }

  try {
    // Send initial progress message to the desktop UI
    if (global.sendMessage) {
      global.sendMessage({
        type: 'join-auth-progress',
        data: {
          publicIdentifier,
          status: 'request'
        }
      });
    }
    
    // 1. Construct the kind 9021 event
    console.log('[RelayServer] Creating kind 9021 join request event...');
    const joinEvent = await createGroupJoinRequest(publicIdentifier, userNsec);
    console.log(`[RelayServer] Created join event ID: ${joinEvent.id.substring(0, 8)}...`);
    
    const hostPeers = Array.isArray(hostPeerList)
      ? hostPeerList.map((key) => String(key || '').trim().toLowerCase()).filter(Boolean)
      : [];

    if (!hostPeers.length) {
      throw new Error('No hosting peers discovered for this relay');
    }

    let challengePayload = null;
    let relayPubkey = null;
    let selectedPeerKey = null;
    let joinProtocol = null;
    let lastJoinError = null;

    for (const hostPeerKey of hostPeers) {
      try {
        console.log(`[RelayServer] Attempting direct join via peer ${hostPeerKey.substring(0, 8)}...`);
        const protocol = await waitForPeerProtocol(hostPeerKey, 20000);
        const joinResponse = await protocol.sendRequest({
          method: 'POST',
          path: `/post/join/${publicIdentifier}`,
          headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ event: joinEvent }))
        });

        if ((joinResponse.statusCode || 200) >= 400) {
          const responseBody = toBuffer(joinResponse.body).toString('utf8');
          throw new Error(`Peer returned status ${joinResponse.statusCode}: ${responseBody}`);
        }

        const parsed = parseJsonBody(joinResponse.body) || {};
        if (!parsed.challenge || !parsed.relayPubkey) {
          throw new Error('Invalid join response from peer');
        }

        challengePayload = parsed;
        relayPubkey = parsed.relayPubkey;
        selectedPeerKey = hostPeerKey;
        joinProtocol = protocol;
        break;
      } catch (error) {
        console.error(`[RelayServer] Direct join attempt failed for ${hostPeerKey.substring(0, 8)}:`, error.message);
        lastJoinError = error;
      }
    }

    if (!challengePayload || !relayPubkey || !joinProtocol) {
      throw lastJoinError || new Error('Failed to contact relay host');
    }

    console.log('[RelayServer] Received challenge from peer:', challengePayload);

    const { challenge } = challengePayload;

    console.log(`[RelayServer] Challenge: ${challenge.substring(0, 16)}...`);

    if (!challenge || !relayPubkey) {
      throw new Error('Invalid challenge response from relay host. Missing required fields.');
    }

    // Send 'verify' progress update to the desktop UI
    if (global.sendMessage) {
      global.sendMessage({
        type: 'join-auth-progress',
        data: { publicIdentifier, status: 'verify' }
      });
    }

    // Compute the shared secret using ECDH
    console.log('[RelayServer] Computing shared secret for ECDH...');
    let sharedSecret = await nobleSecp256k1.getSharedSecret(
      userNsec,
      '02' + relayPubkey, // Add compression prefix for noble-secp256k1
      true
    );
    // noble-secp256k1 may return a 33 byte buffer with a leading 0x00.
    // Trim it so both sides derive the same 32 byte AES key.
    if (sharedSecret.length === 33) sharedSecret = sharedSecret.slice(1);
    const keyBuffer = b4a.from(sharedSecret);
    console.log(`[RelayServer] Shared key computed: ${keyBuffer.toString('hex').substring(0, 8)}...`);

    // Encrypt the challenge using AES-256-CBC
    const iv = crypto.randomBytes(16);
    const encrypted = nobleSecp256k1.aes.encrypt(challenge, keyBuffer, iv);
    const ciphertext = b4a.from(encrypted).toString('base64');
    const ivBase64 = b4a.from(iv).toString('base64');
    console.log('[RelayServer] Challenge encrypted.');
    console.log(`[RelayServer] Ciphertext length: ${ciphertext.length}`);
    console.log(`[RelayServer] IV base64: ${ivBase64}`);

    console.log(`[RelayServer] Sending verification request directly to peer ${selectedPeerKey.substring(0, 8)}...`);

    const verifyResponseRaw = await joinProtocol.sendRequest({
      method: 'POST',
      path: `/verify-ownership`,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        pubkey: userPubkey,
        ciphertext,
        iv: ivBase64
      }))
    });

    if ((verifyResponseRaw.statusCode || 200) >= 400) {
      const responseBody = toBuffer(verifyResponseRaw.body).toString('utf8');
      throw new Error(`Peer verification failed with status ${verifyResponseRaw.statusCode}: ${responseBody}`);
    }

    const verifyResponse = parseJsonBody(verifyResponseRaw.body) || {};

    console.log('[RelayServer] Received verification response from peer:', verifyResponse);
    if (verifyResponse && verifyResponse.success === false) {
      console.log(`[RelayServer] Verification failed: ${verifyResponse.error}`);
    }

    // Treat verify response as the final result
    if (global.sendMessage) {
      global.sendMessage({
        type: 'join-auth-progress',
        data: { publicIdentifier, status: 'complete' }
      });
    }

    const { authToken, relayUrl, relayKey, publicIdentifier: returnedIdentifier } = verifyResponse;
    const finalIdentifier = returnedIdentifier || publicIdentifier;
    if (!authToken || !relayUrl || !relayKey) {
      throw new Error('Final response from relay host missing authToken, relayKey, or relayUrl');
    }

    // Join the relay locally so we have a profile and key mapping
    await joinRelayManager({ relayKey, config, fileSharing });
    await applyPendingAuthUpdates(updateRelayAuthToken, relayKey, finalIdentifier);

    // Ensure the joined relay profile has the public identifier recorded
    let joinedProfile = await getRelayProfileByKey(relayKey);
    if (joinedProfile && !joinedProfile.public_identifier) {
      joinedProfile.public_identifier = finalIdentifier;
      await saveRelayProfile(joinedProfile);
    }

    // Persist the auth token and subnet hash to the local relay profile
    console.log(`[RelayServer] Persisting auth token for ${userPubkey.substring(0, 8)}...`);
    await updateRelayAuthToken(relayKey, userPubkey, authToken);

    // Wait for the relay to become writable before announcing membership
    await waitForRelayWritable(relayKey);

    // Publish kind 9000 event to announce the new member
    console.log('[RelayServer] Publishing kind 9000 member add event...');
    await publishMemberAddEvent(finalIdentifier, userPubkey, authToken);

    // Notify the desktop UI of success
    if (global.sendMessage) {
      global.sendMessage({
        type: 'join-auth-success',
        data: { publicIdentifier: finalIdentifier, relayKey, authToken, relayUrl, hostPeer: selectedPeerKey }
      });
    }

    console.log(`[RelayServer] Join flow for ${finalIdentifier} completed successfully.`);

  } catch (error) {
    console.error(`[RelayServer] Error during join authentication for ${publicIdentifier}:`, error);
    if (global.sendMessage) {
      global.sendMessage({
        type: 'join-auth-error',
        data: {
          publicIdentifier,
          error: error.message
        }
      });
    }
  }
}

export async function disconnectRelay(relayKey) {
  console.log('[RelayServer] Disconnecting relay via adapter:', relayKey);
  const result = await disconnectRelayManager(relayKey);
  
  if (result.success) {
    await updateHealthState(); // Added await
    
    // Update gateway if connected
    if (config.registerWithGateway && gatewayConnection) {
      try {
        await registerWithGateway();
      } catch (regError) {
        console.error('[RelayServer] Failed to notify gateway after relay disconnect (adapter):', regError.message);
      }
    }
  }
  
  return result;
}

export async function shutdownRelayServer() {
  console.log('[RelayServer] ========================================');
  console.log('[RelayServer] SHUTTING DOWN');
  console.log('[RelayServer] Timestamp:', new Date().toISOString());
  
  // Clear registration interval
  if (gatewayRegistrationInterval) {
    clearInterval(gatewayRegistrationInterval);
    gatewayRegistrationInterval = null;
  }
  
  // Clean up all active relays
  await cleanupRelays();
  
  // Destroy swarm
  if (swarm) {
    console.log('[RelayServer] Destroying Hyperswarm instance');
    await swarm.destroy();
    swarm = null;
  }
  
  console.log('[RelayServer] Shutdown complete');
  console.log('[RelayServer] ========================================');
}

// Export for testing
export { config, healthState, getActiveRelays };
