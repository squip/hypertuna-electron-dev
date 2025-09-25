// ./relay-worker/hypertuna-relay-manager-adapter.mjs
// Adapter to integrate legacy RelayManager functionality into Pear worker

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import crypto from 'node:crypto';

// Import the legacy modules (adapted to run in a pure Node/Electron environment)
import { RelayManager } from './hypertuna-relay-manager-bare.mjs';
import { 
    initRelayProfilesStorage, 
    getAllRelayProfiles, 
    getRelayProfileByKey,
    calculateAuthorizedUsers, // NEW IMPORT
    saveRelayProfile, 
    removeRelayProfile,
importLegacyRelayProfiles,
updateRelayMemberSets,
calculateMembers
} from './hypertuna-relay-profile-manager-bare.mjs';

import { ChallengeManager } from './challenge-manager.mjs';
import { normalizeRelayIdentifier } from './relay-identifier-utils.mjs';


// Store active relay managers
const activeRelays = new Map();

// Store relay members keyed by relay key or public identifier
const relayMembers = new Map();
const relayMemberAdds = new Map();
const relayMemberRemoves = new Map();

// Mapping between public identifiers and internal relay keys
const publicToKey = new Map();
const keyToPublic = new Map();

function parseRelayMetadataEvent(event) {
    if (!event) return null;

    const tags = Array.isArray(event.tags) ? event.tags : [];
    const findTagValue = (key) => {
        const tag = tags.find((t) => t[0] === key && t.length > 1);
        return tag ? tag[1] : null;
    };

    const metadata = {
        name: findTagValue('name'),
        description: findTagValue('about'),
        avatarUrl: null,
        isPublic: null,
        createdAt: event.created_at || null,
        updatedAt: event.created_at ? event.created_at * 1000 : null,
        identifier: findTagValue('d') || null,
        eventId: event.id || null
    };

    const pictureTag = tags.find((t) => t[0] === 'picture' && t.length > 1 && typeof t[1] === 'string');
    if (pictureTag) {
        metadata.avatarUrl = pictureTag[1];
    }

    if (tags.some((t) => t[0] === 'public')) {
        metadata.isPublic = true;
    } else if (tags.some((t) => t[0] === 'private')) {
        metadata.isPublic = false;
    }

    return metadata;
}

export async function getRelayMetadata(relayKey, publicIdentifier = null) {
    const manager = activeRelays.get(relayKey);
    if (!manager) return null;

    try {
        const filter = { kinds: [39000], limit: 50 };
        if (publicIdentifier) {
            filter['#d'] = [publicIdentifier];
        }

        const events = await manager.queryEvents(filter);
        if (!Array.isArray(events) || events.length === 0) {
            return null;
        }

        events.sort((a, b) => (b?.created_at || 0) - (a?.created_at || 0));
        const latest = events[0];
        const parsed = parseRelayMetadataEvent(latest);
        if (parsed && !parsed.identifier && publicIdentifier) {
            parsed.identifier = publicIdentifier;
        }
        return parsed;
    } catch (error) {
        console.error(`[RelayAdapter] Failed to load metadata for relay ${relayKey}:`, error);
        return null;
    }
}

function getGatewayWebsocketProtocol(config) {
    return config?.proxy_websocket_protocol === 'ws' ? 'ws' : 'wss';
}

function buildGatewayWebsocketBase(config) {
    const protocol = getGatewayWebsocketProtocol(config);
    const host = config?.proxy_server_address || 'localhost';
    return `${protocol}://${host}`;
}

export function setRelayMapping(relayKey, publicIdentifier) {
    if (!relayKey) return;
    if (publicIdentifier) {
        publicToKey.set(publicIdentifier, relayKey);
        keyToPublic.set(relayKey, publicIdentifier);
    } else {
        const existing = keyToPublic.get(relayKey);
        if (existing) publicToKey.delete(existing);
        keyToPublic.delete(relayKey);
    }
}

export function removeRelayMapping(relayKey, publicIdentifier) {
    const pid = publicIdentifier || keyToPublic.get(relayKey);
    if (pid) publicToKey.delete(pid);
    if (relayKey) keyToPublic.delete(relayKey);
}

export async function loadRelayKeyMappings() {
    await ensureProfilesInitialized(globalUserKey);
    publicToKey.clear();
    keyToPublic.clear();
    const profiles = await getAllRelayProfiles(globalUserKey);
    for (const p of profiles) {
        if (p.relay_key && p.public_identifier) {
            publicToKey.set(p.public_identifier, p.relay_key);
            keyToPublic.set(p.relay_key, p.public_identifier);
        }
    }
    return { publicToKey, keyToPublic };
}

export function setRelayMembers(relayKey, members = [], adds = null, removes = null) {
    relayMembers.set(relayKey, members);
    if (adds) relayMemberAdds.set(relayKey, adds);
    if (removes) relayMemberRemoves.set(relayKey, removes);
}

// Store config reference
let globalConfig = null;
let globalUserKey = null;

// Initialize profile storage on module load
let profilesInitialized = false;

async function ensureProfilesInitialized(userKey = null) {
    if (!profilesInitialized) {
        await initRelayProfilesStorage(userKey || globalUserKey);
        profilesInitialized = true;
    }
}

/**
 * Create a new relay
 * @param {Object} options - Creation options
 * @param {string} options.name - Relay name
 * @param {string} options.description - Relay description
 * @param {string} options.storageDir - Optional storage directory
 * @param {Object} options.config - Configuration object
 * @returns {Promise<Object>} - Result object with relay information
 */
export async function createRelay(options = {}) {
    const { name, description, isPublic = false, isOpen = false, storageDir, config } = options;
    
    // Store config and user key globally if provided
    if (config) {
        globalConfig = config;
        globalUserKey = config.userKey;
    }
    
    try {
        await ensureProfilesInitialized(globalUserKey);
        
        // Generate relay key components
        const timestamp = Date.now();
        const userStorageBase = join(config.storage || './data', 'relays');
        const defaultStorageDir = storageDir || join(userStorageBase, `relay-${timestamp}`);
        
        // Ensure storage directory exists
        await fs.mkdir(defaultStorageDir, { recursive: true });
        
        // Create relay manager instance
        const relayManager = new RelayManager(defaultStorageDir, null);
        await relayManager.initialize();
        
        const relayKey = relayManager.getPublicKey();
        activeRelays.set(relayKey, relayManager);
        
        // Generate public identifier
        const npub = config.nostr_npub || (config.nostr_pubkey_hex ? 
            NostrUtils.hexToNpub(config.nostr_pubkey_hex) : null);
        
        const publicIdentifier = npub && name ? 
            generatePublicIdentifier(npub, name) : null;
        
        // Auth token will be generated and added in pear-relay-server.mjs
        // to ensure a single, consistent token source.
        const authToken = null; // No token generated here.
        const auth_adds = []; // Initially empty.
        
        // Create relay profile with both internal and public identifiers
        const profileInfo = {
            name: name || `Relay ${relayKey.substring(0, 8)}`,
            description: description || `Created on ${new Date().toLocaleString()}`,
            nostr_pubkey_hex: config.nostr_pubkey_hex || generateHexKey(),
            admin_pubkey: config.nostr_pubkey_hex || null,
            members: config.nostr_pubkey_hex ? [config.nostr_pubkey_hex] : [],
            member_adds: config.nostr_pubkey_hex ? [{ pubkey: config.nostr_pubkey_hex, ts: Date.now() }] : [],
            member_removes: [],
            relay_nostr_id: null,
            relay_key: relayKey, // Internal key
            public_identifier: publicIdentifier, // New public-facing identifier
            relay_storage: defaultStorageDir,
            created_at: new Date().toISOString(),
            auto_connect: true,
            is_active: true,
            isPublic,
            isOpen,
            auth_config: {
                requiresAuth: true,
                tokenProtected: true,
                authorizedUsers: auth_adds, // This will be recalculated by saveRelayProfile
                auth_adds: auth_adds,
                auth_removes: []
            }
        };
        
        // Save relay profile
        const saved = await saveRelayProfile(profileInfo);
        if (!saved) {
            console.log('[RelayAdapter] Warning: Failed to save relay profile');
        }

        // Import auth data to the auth store
        if (authToken && config.nostr_pubkey_hex) {
            const { getRelayAuthStore } = await import('./relay-auth-store.mjs');
            const authStore = getRelayAuthStore();
            
            authStore.addAuth(relayKey, config.nostr_pubkey_hex, authToken);
            if (publicIdentifier) {
                authStore.addAuth(publicIdentifier, config.nostr_pubkey_hex, authToken);
            }
            
            console.log('[RelayAdapter] Added auth token to auth store');
        }

        // Load members into in-memory map
        setRelayMembers(relayKey, profileInfo.members || [], profileInfo.member_adds || [], profileInfo.member_removes || []);
        if (publicIdentifier) {
            setRelayMembers(publicIdentifier, profileInfo.members || [], profileInfo.member_adds || [], profileInfo.member_removes || []);
        }
        
        console.log('[RelayAdapter] Created relay:', relayKey);
        const gatewayBase = buildGatewayWebsocketBase(config);
        console.log(`[RelayAdapter] Connect at: ${gatewayBase}/${relayKey}`);
        
        // Build the authenticated relay URL
        const identifierPath = publicIdentifier ? 
            publicIdentifier.replace(':', '/') : 
            relayKey;
        const baseUrl = `${gatewayBase}/${identifierPath}`;
        const authenticatedUrl = authToken ? `${baseUrl}?token=${authToken}` : baseUrl;
        
        // Send relay initialized message for newly created relay
        if (global.sendMessage) {
            console.log(`[RelayAdapter] createRelay() -> Sending relay-initialized for ${relayKey} with URL ${authenticatedUrl}`);
            global.sendMessage({
                type: 'relay-initialized',
                relayKey: relayKey, // Internal key for worker
                publicIdentifier: publicIdentifier, // Public identifier for external use
                gatewayUrl: authenticatedUrl,
                name: profileInfo.name,
                isNew: true,
                timestamp: new Date().toISOString()
            });
        }
        
        return {
            success: true,
            relayKey,
            publicIdentifier,
            connectionUrl: baseUrl, // Base URL without token
            authToken: authToken, // Return the token separately
            relayUrl: authenticatedUrl, // Full authenticated URL
            profile: profileInfo,
            storageDir: defaultStorageDir
        };
        
    } catch (error) {
        console.error('[RelayAdapter] Error creating relay:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// Helper function to generate public identifier
function generatePublicIdentifier(npub, relayName) {
    const camelCaseName = relayName
        .split(' ')
        .map((word, index) => {
            if (index === 0) {
                return word.toLowerCase();
            }
            return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join('');
    
    return `${npub}:${camelCaseName}`;
}

/**
 * Join an existing relay
 * @param {Object} options - Join options
 * @param {string} options.relayKey - The relay key to join
 * @param {string} options.name - Optional name for the relay
 * @param {string} options.description - Optional description
 * @param {string} options.storageDir - Optional storage directory
 * @param {Object} options.config - Configuration object
 * @param {boolean} options.fromAutoConnect - Whether called from auto-connect
 * @returns {Promise<Object>} - Result object with relay information
 */
export async function joinRelay(options = {}) {
    const { relayKey, name, description, publicIdentifier, authToken = null, storageDir, config, fromAutoConnect = false } = options;
    
    // Store config globally if provided
    if (config) {
        globalConfig = config;
        globalUserKey = config.userKey;
    }
    
    if (!relayKey) {
        return {
            success: false,
            error: 'Relay key is required'
        };
    }
    
    try {
        await ensureProfilesInitialized(globalUserKey);
        
        // Check if already connected
        if (activeRelays.has(relayKey)) {
            console.log(`[RelayAdapter] Already connected to relay ${relayKey}`);

            // Load profile to determine auth token
            let userAuthToken = null;
            let profileInfo = await getRelayProfileByKey(relayKey);
            if (profileInfo?.auth_config?.requiresAuth && config.nostr_pubkey_hex) {
                const userAuth = profileInfo.auth_config.authorizedUsers.find(
                    u => u.pubkey === config.nostr_pubkey_hex
                );
                userAuthToken = userAuth?.token || null;
            }

            if (authToken) {
                userAuthToken = authToken;
            }

            const identifierPath = profileInfo?.public_identifier ?
                profileInfo.public_identifier.replace(':', '/') :
                relayKey;
            const baseUrl = `${buildGatewayWebsocketBase(config)}/${identifierPath}`;
            const connectionUrl = userAuthToken ? `${baseUrl}?token=${userAuthToken}` : baseUrl;

            // Still send initialized message since the UI might be waiting
            if (global.sendMessage) {
                console.log(`[RelayAdapter] [1] joinRelay() ->Sending relay-initialized for ${relayKey} with URL ${connectionUrl}`);
                global.sendMessage({
                    type: 'relay-initialized',
                    relayKey: relayKey,
                    publicIdentifier: profileInfo?.public_identifier,
                    gatewayUrl: connectionUrl,
                    connectionUrl,
                    alreadyActive: true,
                    requiresAuth: profileInfo?.auth_config?.requiresAuth || false,
                    userAuthToken: userAuthToken,
                    timestamp: new Date().toISOString()
                });
            }
            
            return {
                success: false,
                error: 'Already connected to this relay'
            };
        }
        
        // Set default storage directory
        const defaultStorageDir = storageDir || join(config.storage || './data', 'relays', relayKey);
        
        // Ensure storage directory exists
        await fs.mkdir(defaultStorageDir, { recursive: true });
        
        // Create relay manager instance
        const relayManager = new RelayManager(defaultStorageDir, relayKey);
        await relayManager.initialize();
        
        activeRelays.set(relayKey, relayManager);
        
        // Check if profile already exists
        let profileInfo = await getRelayProfileByKey(relayKey);
        
        if (!profileInfo) {
            // Create new profile
            profileInfo = {
                name: name || `Joined Relay ${relayKey.substring(0, 8)}`,
                description: description || `Relay joined on ${new Date().toLocaleString()}`,
                nostr_pubkey_hex: config.nostr_pubkey_hex || generateHexKey(),
                admin_pubkey: config.nostr_pubkey_hex || null,
                members: config.nostr_pubkey_hex ? [config.nostr_pubkey_hex] : [],
                member_adds: config.nostr_pubkey_hex ? [{ pubkey: config.nostr_pubkey_hex, ts: Date.now() }] : [],
                member_removes: [],
                relay_nostr_id: null,
                relay_key: relayKey,
                public_identifier: publicIdentifier || null,
                relay_storage: defaultStorageDir,
                joined_at: new Date().toISOString(),
                auto_connect: true,
                is_active: true
            };

            await saveRelayProfile(profileInfo);
        } else {
            // Update existing profile
            profileInfo.relay_storage = defaultStorageDir;
            profileInfo.last_joined_at = new Date().toISOString();
            profileInfo.is_active = true;
            if (name) profileInfo.name = name;
            if (description) profileInfo.description = description;
            if (publicIdentifier && !profileInfo.public_identifier) {
                profileInfo.public_identifier = publicIdentifier;
            }

            await saveRelayProfile(profileInfo);
        }

        // Load members into in-memory map
        setRelayMembers(relayKey, profileInfo.members || [], profileInfo.member_adds || [], profileInfo.member_removes || []);
        if (profileInfo.public_identifier) {
            setRelayMembers(profileInfo.public_identifier, profileInfo.members || [], profileInfo.member_adds || [], profileInfo.member_removes || []);
        }
        
        console.log('[RelayAdapter] Joined relay:', relayKey);
        
        // Send relay initialized message for joined relay ONLY if not from auto-connect
        if (!fromAutoConnect && global.sendMessage) {
            const identifierPath = profileInfo.public_identifier ? profileInfo.public_identifier.replace(':', '/') : relayKey;
            const gatewayBase = buildGatewayWebsocketBase(config);
            const baseGw = `${gatewayBase}/${identifierPath}`;
            const gw = authToken ? `${baseGw}?token=${authToken}` : baseGw;
            console.log(`[RelayAdapter] [3] joinRelay -> Sending relay-initialized for ${relayKey} with URL ${gw}`);
            global.sendMessage({
                type: 'relay-initialized',
                relayKey: relayKey,
                publicIdentifier: profileInfo.public_identifier,
                gatewayUrl: gw,
                name: profileInfo.name,
                connectionUrl: gw,
                isJoined: true,
                timestamp: new Date().toISOString()
            });
        }
        
        const identifierPathReturn = profileInfo.public_identifier ? profileInfo.public_identifier.replace(':', '/') : relayKey;
        const gatewayBaseReturn = buildGatewayWebsocketBase(config);
        const returnBase = `${gatewayBaseReturn}/${identifierPathReturn}`;
        return {
            success: true,
            relayKey,
            publicIdentifier: profileInfo.public_identifier || null,
            connectionUrl: authToken ? `${returnBase}?token=${authToken}` : returnBase,
            profile: profileInfo,
            storageDir: defaultStorageDir
        };
        
    } catch (error) {
        console.error('[RelayAdapter] Error joining relay:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Disconnect from a relay
 * @param {string} relayKey - The relay key to disconnect from
 * @returns {Promise<Object>} - Result object
 */
export async function disconnectRelay(relayKey) {
    if (!relayKey) {
        return {
            success: false,
            error: 'Relay key is required'
        };
    }
    
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
        return {
            success: false,
            error: 'Relay not active'
        };
    }
    
    try {
        await ensureProfilesInitialized();
        
        // Close the relay
        await relayManager.close();
        activeRelays.delete(relayKey);
        
        // Update profile
        relayMembers.delete(relayKey);
        const profileInfo = await getRelayProfileByKey(relayKey);
        if (profileInfo && profileInfo.public_identifier) {
            relayMembers.delete(profileInfo.public_identifier);
        }
        // Update profile
        if (profileInfo) {
            profileInfo.last_disconnected_at = new Date().toISOString();
            profileInfo.is_active = false;
            await saveRelayProfile(profileInfo);
        }
        
        console.log('[RelayAdapter] Disconnected from relay:', relayKey);
        
        return {
            success: true,
            message: `Disconnected from relay ${relayKey}`
        };
        
    } catch (error) {
        console.error('[RelayAdapter] Error disconnecting relay:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

/**
 * Get all relay profiles
 * @returns {Promise<Array>} - Array of relay profiles
 */
export async function getRelayProfiles() {
    await ensureProfilesInitialized(globalUserKey);
    return getAllRelayProfiles(globalUserKey);
}

/**
 * Auto-connect to stored relays
 * @param {Object} config - Configuration object
 * @returns {Promise<Array>} - Array of connected relay keys
 */
export async function autoConnectStoredRelays(config) {
    try {
        // Extract user key from config
        const userKey = config.userKey;
        await ensureProfilesInitialized(userKey);
        
        console.log('[RelayAdapter] Starting auto-connection to stored relays for user:', userKey);
        
        const relayProfiles = await getAllRelayProfiles(userKey);
        if (!relayProfiles || relayProfiles.length === 0) {
            console.log('[RelayAdapter] No stored relay profiles found');
            
            // Notify that there are no relays to initialize
            if (global.sendMessage) {
                global.sendMessage({
                    type: 'all-relays-initialized',
                    count: 0,
                    message: 'No stored relays to initialize'
                });
            }
            return [];
        }
        
        console.log(`[RelayAdapter] Found ${relayProfiles.length} stored relay profiles`);
        
        // Import auth store for loading auth configurations
        const { getRelayAuthStore } = await import('./relay-auth-store.mjs');
        const authStore = getRelayAuthStore();
        
        const connectedRelays = [];
        const failedRelays = [];
        
        // Process each relay profile
        for (const profile of relayProfiles) {
            try {
                // Skip if already active or auto-connect disabled
                if (activeRelays.has(profile.relay_key)) {
                    console.log(`[RelayAdapter] Relay ${profile.relay_key} already active, skipping`);
                    connectedRelays.push(profile.relay_key);
                    
                    // Load auth config for already active relay if it exists
                    if (profile.auth_config && profile.auth_config.requiresAuth) {
                        const authData = {};
                        // Use the calculated authorizedUsers list
                        const authorizedUsers = calculateAuthorizedUsers(
                            profile.auth_config.auth_adds || [],
                            profile.auth_config.auth_removes || []
                        );
                        authorizedUsers.forEach(user => {
                            authData[user.pubkey] = {
                                token: user.token,
                                createdAt: Date.now(),
                                lastUsed: Date.now()
                            };
                        });
                        
                        authStore.importRelayAuth(profile.relay_key, authData);
                        
                        // Also import for public identifier if it exists
                        const canonicalPublicIdentifier = profile.public_identifier ? normalizeRelayIdentifier(profile.public_identifier) : null;
                        if (canonicalPublicIdentifier) {
                            authStore.importRelayAuth(canonicalPublicIdentifier, authData);
                        }
                        
                        console.log(`[RelayAdapter] Loaded auth config for active relay ${profile.relay_key}`);
                    }
                    
                    // Determine if current user has auth token
                    let userAuthToken = null;
                    if (profile.auth_config?.requiresAuth && config.nostr_pubkey_hex) {
                        const authorizedUsers = calculateAuthorizedUsers(
                            profile.auth_config.auth_adds || [],
                            profile.auth_config.auth_removes || []
                        );
                        const userAuth = authorizedUsers.find(
                            u => u.pubkey === config.nostr_pubkey_hex
                        );
                        userAuthToken = userAuth?.token || null;
                        
                        if (userAuthToken) {
                            console.log(`[RelayAdapter] Found auth token for user ${config.nostr_pubkey_hex.substring(0, 8)}... on relay ${profile.relay_key}`);
                        } else {
                            console.log(`[RelayAdapter] No auth token found for user ${config.nostr_pubkey_hex.substring(0, 8)}... on relay ${profile.relay_key}`);
                        }
                    }

                    // Build connection URL including token if available
                    const identifierPath = profile.public_identifier ?
                        profile.public_identifier.replace(':', '/') :
                        profile.relay_key;
                    const baseUrl = `${buildGatewayWebsocketBase(config)}/${identifierPath}`;
                    const connectionUrl = userAuthToken ? `${baseUrl}?token=${userAuthToken}` : baseUrl;
                    console.log(`[RelayAdapter] Built connection URL for ${profile.relay_key}: ${connectionUrl}`);

                    // Send initialized message for already active relay
                    if (global.sendMessage) {
                        console.log(`[RelayAdapter] [1] autoConnectStoredRelays() -> Sending relay-initialized for ${profile.relay_key} with URL ${connectionUrl}`);
                        global.sendMessage({
                            type: 'relay-initialized',
                            relayKey: profile.relay_key,
                            publicIdentifier: profile.public_identifier,
                            gatewayUrl: connectionUrl,
                            name: profile.name,
                            connectionUrl,
                            alreadyActive: true,
                            requiresAuth: profile.auth_config?.requiresAuth || false,
                            userAuthToken: userAuthToken
                        });
                    }
                    continue;
                }
                
                if (profile.auto_connect === false) {
                    console.log(`[RelayAdapter] Auto-connect disabled for relay ${profile.relay_key}, skipping`);
                    continue;
                }
                
                console.log(`[RelayAdapter] Attempting to connect to relay ${profile.relay_key}...`);
                
                // Load auth configuration before connecting
                if (profile.auth_config && profile.auth_config.requiresAuth) {
                    console.log(`[RelayAdapter] Loading auth configuration for relay ${profile.relay_key}`);
                    
                    // Calculate authorizedUsers from auth_adds and auth_removes
                    const authorizedUsers = calculateAuthorizedUsers(
                        profile.auth_config.auth_adds || [],
                        profile.auth_config.auth_removes || []
                    );
                    const authData = {};
                    authorizedUsers.forEach(user => {
                        authData[user.pubkey] = {
                            token: user.token,
                            createdAt: Date.now(),
                            lastUsed: Date.now()
                        };
                    });
                    
                    authStore.importRelayAuth(profile.relay_key, authData);
                    
                    // Also import for public identifier if it exists
                    const canonicalPublicIdentifier = profile.public_identifier ? normalizeRelayIdentifier(profile.public_identifier) : null;
                    if (canonicalPublicIdentifier) {
                        authStore.importRelayAuth(canonicalPublicIdentifier, authData);
                    }
                    
                    console.log(`[RelayAdapter] Imported ${Object.keys(authData).length} auth entries for relay ${profile.relay_key}`);
                }
                
                // Load members into in-memory map before connecting
                setRelayMembers(
                    profile.relay_key, 
                    profile.members || [], 
                    profile.member_adds || [], 
                    profile.member_removes || []
                );
                
                if (profile.public_identifier) {
                    setRelayMembers(
                        profile.public_identifier, 
                        profile.members || [], 
                        profile.member_adds || [], 
                        profile.member_removes || []
                    );
                }
                
                const result = await joinRelay({
                    relayKey: profile.relay_key,
                    name: profile.name,
                    description: profile.description,
                    storageDir: profile.relay_storage,
                    config,
                    fromAutoConnect: true  // Add this flag
                });
                
                
                if (result.success) {
                    connectedRelays.push(profile.relay_key);
                    profile.auto_connected = true;
                    profile.last_connected_at = new Date().toISOString();
                    await saveRelayProfile(profile);
                    
                    console.log(`[RelayAdapter] Successfully connected to relay ${profile.relay_key}`);
                    
                    // Determine if current user has auth token
                    let userAuthToken = null;
                    if (profile.auth_config?.requiresAuth && config.nostr_pubkey_hex) {
                        const authorizedUsers = calculateAuthorizedUsers(
                            profile.auth_config.auth_adds || [],
                            profile.auth_config.auth_removes || []
                        );
                        const userAuth = authorizedUsers.find(
                            u => u.pubkey === config.nostr_pubkey_hex
                        );
                        userAuthToken = userAuth?.token || null;
                        
                        if (userAuthToken) {
                            console.log(`[RelayAdapter] Found auth token for user ${config.nostr_pubkey_hex.substring(0, 8)}... on relay ${profile.relay_key}`);
                        } else {
                            console.log(`[RelayAdapter] No auth token found for user ${config.nostr_pubkey_hex.substring(0, 8)}... on relay ${profile.relay_key}`);
                        }
                    }
                    
                    // Build connection URL including token if available
                    const identifierPath = profile.public_identifier ?
                        profile.public_identifier.replace(':', '/') :
                        profile.relay_key;
                    const baseUrl = `${buildGatewayWebsocketBase(config)}/${identifierPath}`;
                    const connectionUrl = userAuthToken ? `${baseUrl}?token=${userAuthToken}` : baseUrl;

                    // Send relay initialized message with auth info
                    if (global.sendMessage) {
                        console.log(`[RelayAdapter] [2] autoConnectStoredRelays() -> Sending relay-initialized for ${profile.relay_key} with URL ${connectionUrl}`);
                        global.sendMessage({
                            type: 'relay-initialized',
                            relayKey: profile.relay_key,
                            publicIdentifier: profile.public_identifier,
                            gatewayUrl: connectionUrl,
                            name: profile.name || `Relay ${profile.relay_key.substring(0, 8)}`,
                            connectionUrl,
                            requiresAuth: profile.auth_config?.requiresAuth || false,
                            userAuthToken: userAuthToken,
                            timestamp: new Date().toISOString()
                        });
                    }
                } else {
                    console.error(`[RelayAdapter] Failed to connect to relay ${profile.relay_key}: ${result.error}`);
                    failedRelays.push({
                        relayKey: profile.relay_key,
                        error: result.error
                    });
                    
                    // Send relay initialization failed message
                    if (global.sendMessage) {
                        global.sendMessage({
                            type: 'relay-initialization-failed',
                            relayKey: profile.relay_key,
                            error: result.error,
                            timestamp: new Date().toISOString()
                        });
                    }
                }
            } catch (error) {
                console.error(`[RelayAdapter] Error auto-connecting to ${profile.relay_key}:`, error);
                failedRelays.push({
                    relayKey: profile.relay_key,
                    error: error.message
                });
                
                // Send relay initialization failed message
                if (global.sendMessage) {
                    global.sendMessage({
                        type: 'relay-initialization-failed',
                        relayKey: profile.relay_key,
                        error: error.message,
                        timestamp: new Date().toISOString()
                    });
                }
            }
        }
        
        console.log(`[RelayAdapter] Auto-connection complete:`);
        console.log(`[RelayAdapter] - Connected: ${connectedRelays.length} relays`);
        console.log(`[RelayAdapter] - Failed: ${failedRelays.length} relays`);
        
        // Log auth status summary
        const authProtectedCount = relayProfiles.filter(p => p.auth_config?.requiresAuth).length;
        console.log(`[RelayAdapter] - Auth-protected: ${authProtectedCount} relays`);
        
        // Send all-relays-initialized message
        if (global.sendMessage) {
            global.sendMessage({
                type: 'all-relays-initialized',
                count: connectedRelays.length,
                connected: connectedRelays,
                failed: failedRelays,
                total: relayProfiles.length,
                authProtectedCount: authProtectedCount,
                timestamp: new Date().toISOString()
            });
        }
        
        return connectedRelays;
        
    } catch (error) {
        console.error('[RelayAdapter] Error during auto-connection:', error);
        
        // Send error message
        if (global.sendMessage) {
            global.sendMessage({
                type: 'relay-auto-connect-error',
                error: error.message,
                timestamp: new Date().toISOString()
            });
        }
        
        return [];
    }
}

/**
 * Handle relay messages
 * @param {string} relayKey - The relay key
 * @param {Array} message - The NOSTR message
 * @param {Function} sendResponse - Response callback
 * @param {string} connectionKey - Connection identifier
 * @returns {Promise<void>}
 */
export async function handleRelayMessage(relayKey, message, sendResponse, connectionKey) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
        throw new Error(`Relay not found: ${relayKey}`);
    }
    
    return relayManager.handleMessage(message, sendResponse, connectionKey);
}

/**
 * Handle relay subscription
 * @param {string} relayKey - The relay key
 * @param {string} connectionKey - Connection identifier
 * @returns {Promise<Array>}
 */
export async function handleRelaySubscription(relayKey, connectionKey) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
        throw new Error(`Relay not found: ${relayKey}`);
    }
    
    return relayManager.handleSubscription(connectionKey);
}

/**
 * Update relay subscription
 */
export async function updateRelaySubscriptions(relayKey, connectionKey, activeSubscriptionsUpdated) {
    const relayManager = activeRelays.get(relayKey);
    if (!relayManager) {
      throw new Error(`Relay not found: ${relayKey}`);
    }
    
    return relayManager.updateSubscriptions(connectionKey, activeSubscriptionsUpdated);
  }

/**
 * Get the members list for a relay
 * @param {string} relayKey - Relay key
 * @returns {Promise<Array<string>>} - Array of pubkeys
 */
export async function getRelayMembers(relayKey) {
    await ensureProfilesInitialized(globalUserKey);
    if (relayMembers.has(relayKey)) return relayMembers.get(relayKey);

    const profile = await getRelayProfileByKey(relayKey);
    if (profile) {
        const members = calculateMembers(profile.member_adds || [], profile.member_removes || []);
        setRelayMembers(relayKey, members, profile.member_adds || [], profile.member_removes || []);
        if (profile.public_identifier) {
            setRelayMembers(profile.public_identifier, members, profile.member_adds || [], profile.member_removes || []);
        }
        return members;
    }
    return [];
}

/**
 * Get active relays information with full details
 * @returns {Promise<Array>} - Array of active relay information
 */
export async function getActiveRelays() {
    await ensureProfilesInitialized();
    
    const activeRelayList = [];
    const profiles = await getAllRelayProfiles();
    
    for (const [key, manager] of activeRelays.entries()) {
        // Get peer count if available
        let peerCount = 0;
        if (manager && manager.peers && manager.peers.size) {
            peerCount = manager.peers.size;
        }

        // Find the profile for this relay
        const profile = profiles.find(p => p.relay_key === key);

        const identifierPath = profile?.public_identifier
            ? profile.public_identifier.replace(':', '/')
            : key;

        activeRelayList.push({
            relayKey: key,
            publicIdentifier: profile?.public_identifier || null,
            peerCount,
            name: profile?.name || `Relay ${key.substring(0, 8)}`,
            description: profile?.description || '',
            connectionUrl: `${buildGatewayWebsocketBase(globalConfig || { proxy_server_address: 'localhost', proxy_websocket_protocol: 'wss' })}/${identifierPath}`,
            createdAt: profile?.created_at || profile?.joined_at || null,
            isActive: true
        });
    }
    
    return activeRelayList;
}

/**
 * Cleanup all active relays
 * @returns {Promise<void>}
 */
export async function cleanupRelays() {
    console.log('[RelayAdapter] Cleaning up all active relays...');
    
    for (const [key, manager] of activeRelays.entries()) {
        try {
            await manager.close();
            console.log(`[RelayAdapter] Closed relay: ${key}`);
        } catch (error) {
            console.error(`[RelayAdapter] Error closing relay ${key}:`, error);
        }
    }
    
    activeRelays.clear();
}

// Helper function to generate hex keys
function generateHexKey() {
    return crypto.randomBytes(32).toString('hex');
}

// Export the active relays map for direct access if needed
export {
    activeRelays,
    relayMembers,
    relayMemberAdds,
    relayMemberRemoves,
    publicToKey,
    keyToPublic
};
