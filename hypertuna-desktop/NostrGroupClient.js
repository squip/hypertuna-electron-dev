/**
 * NostrGroupClient.js
 * Client for managing nostr groups (NIP-29)
 * With improved filtering to avoid excessive subscription load
 * Enhanced to support Hypertuna relay groups
 */

import WebSocketRelayManager from './WebSocketRelayManager.js';
import NostrEvents from './NostrEvents.js';
import { NostrUtils } from './NostrUtils.js';
import { prepareFileAttachment } from './FileAttachmentHelper.js';

const electronAPI = window.electronAPI || null;
const isElectron = !!electronAPI;

const LOOPBACK_HOST_REGEX = /^(?:127\.0\.0\.1|localhost)$/i;

function sendWorkerMessage(message) {
    if (!isElectron || !electronAPI?.sendToWorker) {
        return Promise.resolve({ success: false, error: 'Worker bridge unavailable' });
    }
    return electronAPI.sendToWorker(message);
}

class NostrGroupClient {
    constructor(debugMode = true) {
        this.relayManager = new WebSocketRelayManager();
        this.user = null;
        this.groups = new Map(); // Map of groupId -> group metadata
        this.groupMembers = new Map(); // Map of groupId -> member list
        this.groupAdmins = new Map(); // Map of groupId -> admin list
        this.groupMessages = new Map(); // Map of groupId -> messages
        this.groupInvites = new Map(); // Map of groupId -> invite codes
        this.eventListeners = new Map(); // Map of event type -> array of callbacks
        this.cachedProfiles = new Map(); // Map of pubkey -> profile metadata
        this.follows = new Set(); // Set of pubkeys the user follows (kind 3)
        this.relevantPubkeys = new Set(); // Set of pubkeys relevant to the user
        this.activeSubscriptions = new Set(); // Keep track of active subscription IDs
        this.eventCallbacks = []; // Array of callbacks for received events
        this.hypertunaGroups = new Map(); // Map of hypertunaId -> groupId
        this.groupHypertunaIds = new Map(); // Map of groupId -> hypertunaId
        this.hypertunaRelayUrls = new Map(); // Map of groupId -> relay URL
        this.userRelayListEvent = null; // latest kind 10009 event
        this.userRelayIds = new Set(); // Set of hypertuna relay ids user belongs to
        this.relayListLoaded = false; // flag indicating relay list has been parsed
        this.debugMode = debugMode;
        this.groupRelayUrls = new Map(); // Map of groupId -> relay URL
        this.isInitialized = false;
        this.pendingRelayConnections = new Map(); // Track pending connections
        this.relayConnectionAttempts = new Map(); // Track retry attempts
        this.maxRetryAttempts = 3;
        this.relayReadyStates = new Map(); // Track readiness info when received early
        // Mapping between public identifiers and internal relay keys (if available)
        this.publicToInternalMap = new Map();
        this.internalToPublicMap = new Map();
        this.relayAuthTokens = new Map(); // Track auth token per relay
        this.publishedMemberLists = new Set(); // Track groups with published member lists
        this.kind9000Sets = new Map(); // Map of groupId -> Map of pubkey -> {ts, roles}
        this.kind9001Sets = new Map(); // Map of groupId -> Map of pubkey -> ts
        this.processedEvents = new Set(); // Track processed events
        this._recomputeTimeouts = {}; // For throttling recomputes
        this._pendingMemberUpdates = new Map(); // Track pending updates
        this.subscriptionsByFilter = new Map(); // Map of filter hash -> subscription IDs
        this.groupSubscriptions = new Map(); // Map of groupId -> Set of subscription IDs
        this.invites = new Map(); // Map of inviteId -> invite data
        this.joinRequests = new Map(); // Map of groupId -> Map of pubkey -> event

        this.gatewayRuntimeBase = null;
        this.gatewayRuntimeHost = null;

        // Setup default event handlers
        this._setupEventHandlers();
        
        // Add debug event handling if debug mode is enabled
        if (this.debugMode) {
            // Add a relay event handler that logs all events
            this.relayManager.onEvent((event, relayUrl) => {
                console.log(`DEBUG - Received event kind ${event.kind} from ${relayUrl}:`, {
                    id: event.id.substring(0, 8) + '...',
                    pubkey: event.pubkey.substring(0, 8) + '...',
                    created_at: event.created_at,
                    tags: event.tags.map(t => t[0]).join(',')
                });
            });
        }
    }

    _getBaseRelayUrl(url) {
        try {
            const u = new URL(url);
            u.searchParams.delete('token');
            return u.toString().replace(/\?$/, '');
        } catch {
            return url.split('?')[0];
        }
    }
    
    /**
     * Initialize the client
     * @param {Object} user - User object with privateKey and pubkey
     * @param {Array} relayUrls - Array of relay URLs to connect to
     * @returns {Promise} - Resolves when initialized
     */
    async init(user, relayUrls) {
        // Save user
        this.user = user;
        
        // Add user's pubkey to relevant pubkeys
        this.relevantPubkeys.add(user.pubkey);
        
        // Connect to relays
        const connPromises = relayUrls.map(url => this.relayManager.addRelay(url));
        await Promise.allSettled(connPromises);
        
        // Get user profile if not set
        if (!user.name && user.pubkey) {
            await this.fetchUserProfile(user.pubkey);
        }
        
        // Fetch user's follows
        await this.fetchUserFollows();

        // Fetch or create the user's relay list event
        await this.fetchUserRelayList();
        
        // Create subscriptions
        this._createSubscriptions();
        
        return this;
    }

    /**
     * Initialize with discovery relays only
     */
    async initWithDiscoveryRelays(user, discoveryRelays) {
        this.user = user;
        this.relevantPubkeys.add(user.pubkey);
        
        // Connect only to discovery relays initially
        for (const url of discoveryRelays) {
            await this.relayManager.addTypedRelay(url, 'discovery');
        }
        
        // Fetch user profile and follows
        await this.fetchUserProfile(user.pubkey);
        await this.fetchUserFollows();
        await this.fetchUserRelayList();
        
        // Setup minimal subscriptions for discovery
        this._createDiscoverySubscriptions();
        
        this.isInitialized = true;
        return this;
    }

    /**
     * Generate a hash for subscription filters to detect duplicates
     * @param {Array} filters - Subscription filters
     * @returns {string} - Hash of the filters
     */
    _hashFilters(filters) {
        return JSON.stringify(filters);
    }

    /**
     * Check if a subscription with the same filters already exists
     * @param {Array} filters - Subscription filters
     * @returns {string|null} - Existing subscription ID or null
     */
    _findExistingSubscription(filters) {
        const filterHash = this._hashFilters(filters);
        return this.subscriptionsByFilter.get(filterHash) || null;
    }

    /**
     * Create discovery-only subscriptions
     */
    _createDiscoverySubscriptions() {
        const discoveryRelays = Array.from(this.relayManager.discoveryRelays);
        
        // Subscribe to user's relay list updates
        this.relayManager.subscribeWithRouting('user-relaylist-discovery', [
            { kinds: [NostrEvents.KIND_USER_RELAY_LIST], authors: [this.user.pubkey], limit: 1 }
        ], (event) => {
            this.userRelayListEvent = event;
            this._parseRelayListEvent(event);
            this._connectToUserRelays(); // Auto-connect to user's relays
        }, { targetRelays: discoveryRelays });
        
        // Subscribe to group metadata for discovery
        this.relayManager.subscribeWithRouting('group-discovery', [
            { kinds: [NostrEvents.KIND_GROUP_METADATA], "#i": ["hypertuna:relay"], limit: 5 },
            { kinds: [NostrEvents.KIND_HYPERTUNA_RELAY], "#i": ["hypertuna:relay"], limit: 5 }
        ], (event) => {
            if (event.kind === NostrEvents.KIND_GROUP_METADATA) {
                this._processGroupMetadataEvent(event);
            } else if (event.kind === NostrEvents.KIND_HYPERTUNA_RELAY) {
                this._processHypertunaRelayEvent(event);
            }
        }, { targetRelays: discoveryRelays });

        // Subscribe to invites addressed to this user
        this.relayManager.subscribeWithRouting('relay-invites', [
            { kinds: [NostrEvents.KIND_GROUP_INVITE_CREATE], '#p': [this.user.pubkey], '#i': ['hypertuna'] }
        ], (event) => {
            this._processInviteEvent(event);
        }, { targetRelays: discoveryRelays });
    }

    /**
     * Connect to user's relay groups from kind 10009
     */
    async _connectToUserRelays() {
        if (!this.userRelayListEvent) return;

        const relayUrls = new Set();
        const identifierMap = new Map(); // Map URL -> public identifier

        // Parse public relays from tags - store base URLs without tokens
        this.userRelayListEvent.tags.forEach(tag => {
            if (tag[0] === 'group' && tag[4] === 'hypertuna:relay') {
                const identifier = tag[1];
                const url = this._getBaseRelayUrl(tag[2]);
                relayUrls.add(url);
                identifierMap.set(url, identifier);
            } else if (tag[0] === 'r' && tag[1] && tag[2] === 'hypertuna:relay') {
                const url = this._getBaseRelayUrl(tag[1]);
                relayUrls.add(url);
                if (!identifierMap.has(url)) {
                    const parts = url.split('/').filter(Boolean);
                    if (parts.length >= 2) {
                        const identifier = `${parts[parts.length - 2]}:${parts[parts.length - 1]}`;
                        identifierMap.set(url, identifier);
                    }
                }
            }
        });
        
        // Parse private relays from content
        if (this.userRelayListEvent.content) {
            try {
                const decrypted = NostrUtils.decrypt(
                    this.user.privateKey,
                    this.user.pubkey,
                    this.userRelayListEvent.content
                );
                const privateTags = JSON.parse(decrypted);

                privateTags.forEach(tag => {
                    if (Array.isArray(tag) && tag[0] === 'group' && tag[4] === 'hypertuna:relay') {
                        const identifier = tag[1];
                        const url = this._getBaseRelayUrl(tag[2]);
                        relayUrls.add(url);
                        identifierMap.set(url, identifier);
                    } else if (Array.isArray(tag) && tag[0] === 'r' && tag[1] && tag[2] === 'hypertuna:relay') {
                        const url = this._getBaseRelayUrl(tag[1]);
                        relayUrls.add(url);
                        if (!identifierMap.has(url)) {
                            const parts = url.split('/').filter(Boolean);
                            if (parts.length >= 2) {
                                const identifier = `${parts[parts.length - 2]}:${parts[parts.length - 1]}`;
                                identifierMap.set(url, identifier);
                            }
                        }
                    }
                });
            } catch (e) {
                console.error('Error parsing private relay list:', e);
            }
        }
        
        console.log(`[NostrGroupClient] Found ${relayUrls.size} relay URLs to connect`);
        console.log('[NostrGroupClient] Relay base URLs:', Array.from(relayUrls));
        
        // Queue all relay connections with their full authenticated URLs
        for (const relayUrl of relayUrls) {
            const identifier = identifierMap.get(relayUrl);
            if (identifier) {
                console.log(`[NostrGroupClient] Queuing connection for ${identifier} at ${relayUrl}`);
                this.queueRelayConnection(identifier, relayUrl);
            }
        }
        
    }

    /**
     * Queue a relay connection attempt
     */
    queueRelayConnection(publicIdentifier, relayUrl) {
        if (!this.pendingRelayConnections.has(publicIdentifier)) {
            const entry = {
                identifier: publicIdentifier,
                relayUrl,  // May be base URL; token appended once initialized
                attempts: 0,
                status: 'pending',
                isInitialized: false,
                isRegistered: false,
                gatewayPath: null,
                originalQuery: '',
                authToken: null,
                baseHost: null,
                isGatewayManaged: undefined
            };
            this.pendingRelayConnections.set(publicIdentifier, entry);
            console.log(`[NostrGroupClient] Queued connection for relay ${publicIdentifier} with URL ${relayUrl}`);
            this._captureGatewayMetadata(entry);
    
            // Apply any readiness state that arrived before queueing
            if (this.relayReadyStates.has(publicIdentifier)) {
                const state = this.relayReadyStates.get(publicIdentifier);
                const connection = this.pendingRelayConnections.get(publicIdentifier);
                
                if (state.isInitialized) {
                    connection.isInitialized = true;
                }
                if (state.relayUrl) {
                    connection.relayUrl = state.relayUrl;
                    this._captureGatewayMetadata(connection);
                }
                if (state.isRegistered) {
                    connection.isRegistered = true;
                }
                if (state.authToken) {
                    this._applyAuthToken(connection, state.authToken);
                }
                
                this._attemptConnectionIfReady(publicIdentifier);
            }
        } else {
            const existing = this.pendingRelayConnections.get(publicIdentifier);
            if (relayUrl && relayUrl !== existing.relayUrl) {
                existing.relayUrl = relayUrl;
                this._captureGatewayMetadata(existing);
            }
        }
    }

    /**
     * Handle relay initialized signal from the app layer.
     * This means the worker has started the relay instance.
     */
    handleRelayInitialized(identifier, gatewayUrl, authToken = null) {
        console.log(`[NostrGroupClient] Relay initialized signal for ${identifier}.`);
        console.log(`[NostrGroupClient] Gateway URL: ${gatewayUrl}, Has token: ${!!authToken}`);
    
        // Map internal relay keys to public identifiers if available
        let targetId = identifier;
        if (!this.pendingRelayConnections.has(targetId) && this.internalToPublicMap.has(identifier)) {
            targetId = this.internalToPublicMap.get(identifier);
            console.log(`[NostrGroupClient] Mapped internal key ${identifier} to public identifier ${targetId}`);
        }
    
        const connection = this.pendingRelayConnections.get(targetId);
        if (connection) {
            connection.isInitialized = true;
            if (gatewayUrl) {
                connection.relayUrl = gatewayUrl;
                this._captureGatewayMetadata(connection);
            }
            if (authToken) {
                this.relayAuthTokens.set(targetId, authToken);
                this._applyAuthToken(connection, authToken);
            } else if (connection.authToken) {
                this._applyAuthToken(connection, connection.authToken);
            }

            console.log(`[NostrGroupClient] Relay ${targetId} is now initialized. Checking readiness...`);
            this._attemptConnectionIfReady(targetId);
        } else {
            // Queue the connection if not already queued
            console.log(`[NostrGroupClient] No pending connection for ${targetId}, queueing now...`);
            this.queueRelayConnection(targetId, gatewayUrl);
        }
    
        // Always store readiness in case the connection hasn't been queued yet
        const existing = this.relayReadyStates.get(targetId) || {};
        this.relayReadyStates.set(targetId, {
            ...existing,
            isInitialized: true,
            relayUrl: gatewayUrl,
            authToken: authToken || existing.authToken || null
        });
    }
    
    // Update _attemptConnectionIfReady to add more logging:
    async _attemptConnectionIfReady(identifier) {
        const connection = this.pendingRelayConnections.get(identifier);

        if (!connection) {
            console.log(`[NostrGroupClient] No pending connection for ${identifier} yet.`);
            return;
        }
    
        console.log(`[NostrGroupClient] Checking readiness for ${identifier}:`, {
            isInitialized: connection.isInitialized,
            isRegistered: connection.isRegistered,
            status: connection.status,
            hasUrl: !!connection.relayUrl,
            hasToken: connection.relayUrl?.includes('?token=')
        });
    
        // Only proceed if we have a valid authenticated URL
        if (connection.isInitialized && connection.isRegistered && 
            connection.status === 'pending' && connection.relayUrl && 
            connection.relayUrl.includes('?token=')) {
            
            console.log(`[NostrGroupClient] All checks passed for ${identifier}. Connecting to ${connection.relayUrl}`);
            connection.status = 'connecting';
            
            try {
                await this.connectToGroupRelay(identifier, connection.relayUrl);
                connection.status = 'connected';
                this.pendingRelayConnections.delete(identifier);
                console.log(`[NostrGroupClient] Successfully connected to ${identifier}`);
            } catch (e) {
                console.error(`[NostrGroupClient] Final connection attempt failed for ${identifier}:`, e);
                connection.status = 'failed';
                // Retry logic could go here
            }
        } else {
            console.log(`[NostrGroupClient] Not ready to connect ${identifier}. Waiting for:`, {
                needsInit: !connection.isInitialized,
                needsRegistration: !connection.isRegistered,
                needsValidUrl: !connection.relayUrl?.includes('?token='),
                wrongStatus: connection.status !== 'pending'
            });
        }
    }

    setGatewayBase(baseUrl) {
        const normalized = this._normalizeBaseUrl(baseUrl);
        if (normalized === this.gatewayRuntimeBase) {
            return;
        }

        const previous = this.gatewayRuntimeBase;
        this.gatewayRuntimeBase = normalized;
        this.gatewayRuntimeHost = this._extractHostFromBase(normalized);

        console.log('[NostrGroupClient] Gateway base updated:', {
            previous,
            next: normalized,
            host: this.gatewayRuntimeHost
        });

        for (const connection of this.pendingRelayConnections.values()) {
            this._captureGatewayMetadata(connection);
            if (!connection.isGatewayManaged) continue;

            this._rebuildGatewayUrl(connection);

            if (connection.status !== 'pending') {
                connection.status = 'pending';
            }

            if (connection.isInitialized && connection.isRegistered) {
                this._attemptConnectionIfReady(connection.identifier);
            }
        }
    }

    /**
     * Handle relay registered signal from the app layer.
     * This is the final signal to proceed with the connection.
     */
    async handleRelayRegistered(identifier) {
        console.log(`[NostrGroupClient] Relay registered signal for ${identifier}.`);

        // Map internal relay keys to public identifiers if available
        let targetId = identifier;
        if (!this.pendingRelayConnections.has(targetId) && this.internalToPublicMap.has(identifier)) {
            targetId = this.internalToPublicMap.get(identifier);
            console.log(`[NostrGroupClient] Mapped internal key ${identifier} to public identifier ${targetId}`);
        }

        const connection = this.pendingRelayConnections.get(targetId);
        if (connection) {
            connection.isRegistered = true;
            console.log(`[NostrGroupClient] Relay ${targetId} is now registered. Checking readiness...`);
            this._attemptConnectionIfReady(targetId);
        }

        const existing = this.relayReadyStates.get(targetId) || {};
        this.relayReadyStates.set(targetId, {
            ...existing,
            isRegistered: true
        });
    }

    async waitForGatewayBase(timeoutMs = 3000) {
        if (this.gatewayRuntimeBase) {
            return this.gatewayRuntimeBase;
        }

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                unsubscribe();
                reject(new Error('Gateway base unavailable'));
            }, timeoutMs);

            const unsubscribe = window.GatewayRuntimeStore?.subscribe?.((info) => {
                if (!info?.wsBaseUrl) return;
                clearTimeout(timeout);
                unsubscribe();
                this.setGatewayBase(info.wsBaseUrl);
                resolve(this.gatewayRuntimeBase);
            }) || (() => {});
        });
    }


    /**
     * Handle all relays ready notification
     */
    handleAllRelaysReady() {
        console.log(`[NostrGroupClient] All stored relays are ready`);

        // Process any remaining pending connections
        this.processRelayConnectionQueue();

        // Emit event that we're fully initialized
        this.emit('relays:ready');
    }

    /**
     * Process all queued relay connections applying any stored readiness info
     */
    processRelayConnectionQueue() {
        for (const [identifier, connection] of this.pendingRelayConnections.entries()) {
            if (this.relayReadyStates.has(identifier)) {
                const state = this.relayReadyStates.get(identifier);
                if (state.isInitialized) {
                    connection.isInitialized = true;
                    connection.relayUrl = state.relayUrl || connection.relayUrl;
                }
                if (state.isRegistered) {
                    connection.isRegistered = true;
                }
                if (state.authToken) {
                    this.relayAuthTokens.set(identifier, state.authToken);
                }
            }

            this._attemptConnectionIfReady(identifier);
        }
    }

    /**
     * Register a mapping between internal relay key and public identifier
     * so that membership updates can be routed correctly.
     * @param {string} relayKey - Internal relay key
     * @param {string} publicIdentifier - Public identifier string
     */
    registerRelayMapping(relayKey, publicIdentifier) {
        if (!relayKey || !publicIdentifier) return;
        this.publicToInternalMap.set(publicIdentifier, relayKey);
        this.internalToPublicMap.set(relayKey, publicIdentifier);
    }

    /**
     * Connect to a specific group relay
     */
    async connectToGroupRelay(publicIdentifier, relayUrl) {
        try {
            let finalUrl = relayUrl;
            if (!finalUrl.includes('token=')) {
                const token = this.relayAuthTokens.get(publicIdentifier);
                if (token) {
                    try {
                        const u = new URL(finalUrl);
                        u.searchParams.set('token', token);
                        finalUrl = u.toString();
                    } catch (e) {
                        console.warn(`[NostrGroupClient] Failed to build authenticated URL for ${publicIdentifier}:`, e);
                    }
                }
            }

            console.log(`[NostrGroupClient] Connecting to group relay ${publicIdentifier} using URL ${finalUrl}`);
            
            // Add with retry logic
            let connected = false;
            let attempts = 0;
            
            while (!connected && attempts < 3) {
                try {
                    await this.relayManager.addTypedRelay(finalUrl, 'group', publicIdentifier);
                    connected = true;
                } catch (e) {
                    attempts++;
                    if (attempts < 3) {
                        console.log(`[NostrGroupClient] Connection attempt ${attempts} failed, retrying...`);
                        await new Promise(resolve => setTimeout(resolve, 2000));
                    } else {
                        throw e;
                    }
                }
            }

            // Listen for auth failures
            this.relayManager.on('auth:failed', ({ relayUrl: failedUrl }) => {
                if (failedUrl === finalUrl) {
                    console.error(`[NostrGroupClient] Authentication failed for relay ${publicIdentifier}`);
                    this.emit('relay:auth:failed', { groupId: publicIdentifier, relayUrl });
                }
            });
            
            this.groupRelayUrls.set(publicIdentifier, finalUrl);
            
            // Subscribe to group-specific events only on this relay
            this._subscribeToGroupOnRelay(publicIdentifier, finalUrl);
            
            console.log(`[NostrGroupClient] Successfully connected to group relay ${publicIdentifier} at ${finalUrl}`);
            
            // Emit event for UI update
            this.emit('relay:connected', { groupId: publicIdentifier, relayUrl: finalUrl });
            
        } catch (e) {
            console.error(`[NostrGroupClient] Failed to connect to group relay ${finalUrl}:`, e);
            
            // Emit failure event
            this.emit('relay:failed', { groupId: publicIdentifier, relayUrl: finalUrl, error: e.message });
            
            throw e;
        }
    }

    /**
     * Subscribe to group events only on the group's relay
     */
    _subscribeToGroupOnRelay(publicIdentifier, relayUrl) {
        // Define the filters for metadata subscription
        const metadataFilters = [
            { kinds: [NostrEvents.KIND_GROUP_METADATA], "#d": [publicIdentifier] },
            { kinds: [NostrEvents.KIND_GROUP_MEMBER_LIST], "#d": [publicIdentifier] },
            { kinds: [NostrEvents.KIND_GROUP_ADMIN_LIST], "#d": [publicIdentifier] }
        ];

        // Check if we already have this subscription
        const existingMetaSub = this._findExistingSubscription(metadataFilters);
        if (existingMetaSub) {
            console.log(`Reusing existing metadata subscription ${existingMetaSub} for ${publicIdentifier}`);
            return;
        }

        // Create unique subscription ID
        const metaSubId = `group-meta-${publicIdentifier}-${Date.now()}`;
        
        // Track the subscription
        const metaFilterHash = this._hashFilters(metadataFilters);
        this.subscriptionsByFilter.set(metaFilterHash, metaSubId);
        
        // Track by group
        if (!this.groupSubscriptions.has(publicIdentifier)) {
            this.groupSubscriptions.set(publicIdentifier, new Set());
        }
        this.groupSubscriptions.get(publicIdentifier).add(metaSubId);

        // Subscribe to group metadata
        this.relayManager.subscribeWithRouting(metaSubId, metadataFilters, (event) => {
            this._processEvent(event, relayUrl);
        }, { targetRelays: [relayUrl] });

        // Define filters for messages
        const messageFilters = [
            { kinds: [NostrEvents.KIND_TEXT_NOTE], "#h": [publicIdentifier] }
        ];

        // Check for existing message subscription
        const existingMsgSub = this._findExistingSubscription(messageFilters);
        if (existingMsgSub) {
            console.log(`Reusing existing message subscription ${existingMsgSub} for ${publicIdentifier}`);
            return;
        }

        const messagesSubId = `group-messages-${publicIdentifier}-${Date.now()}`;
        
        // Track the message subscription
        const msgFilterHash = this._hashFilters(messageFilters);
        this.subscriptionsByFilter.set(msgFilterHash, messagesSubId);
        this.groupSubscriptions.get(publicIdentifier).add(messagesSubId);

        // Subscribe to group messages
        this.relayManager.subscribeWithRouting(messagesSubId, messageFilters, (event) => {
            if (event.kind === NostrEvents.KIND_TEXT_NOTE) {
                this._processGroupMessageEvent(event);
            }
        }, { targetRelays: [relayUrl] });
        
        // Track these subscriptions
        this.activeSubscriptions.add(metaSubId);
        this.activeSubscriptions.add(messagesSubId);
    }
    
    /**
     * Set up event handlers
     * @private
     */
    _setupEventHandlers() {
        // Handle relay connections
        this.relayManager.onConnect((relayUrl) => {
            this.emit('relay:connect', { relayUrl });
        });
        
        // Handle relay disconnections
        this.relayManager.onDisconnect((relayUrl) => {
            this.emit('relay:disconnect', { relayUrl });
        });
        
        // Handle all events
        this.relayManager.onEvent((event, relayUrl) => {
            // Skip processing events from irrelevant pubkeys
            if (this._shouldProcessEvent(event)) {
                this._processEvent(event, relayUrl);
            }
        });
    }

    /**
     * Enhanced NostrGroupClient.js _handleRelayMessage method
     * Replace this method in NostrGroupClient.js for better message logging
     */
    _handleRelayMessage(relayUrl, message) {
        if (!Array.isArray(message)) {
            return;
        }

        const messageType = message[0];
        
        console.log(`Received ${messageType} message from ${relayUrl}`);
        
        if (messageType === 'EVENT') {
            // ["EVENT", <subscription_id>, <event>]
            if (message.length < 3) {
                console.warn(`Invalid EVENT message, missing data`);
                return;
            }
            
            const shortSubId = message[1];
            const event = message[2];
            
            console.log(`Received event kind ${event.kind} for subscription ${shortSubId}`, {
                id: event.id.substring(0, 8) + '...',
                pubkey: event.pubkey.substring(0, 8) + '...',
                created_at: event.created_at
            });
            
            // Find the original subscription ID from the short ID
            let originalSubId = null;
            this.globalSubscriptions.forEach((subData, subId) => {
                if (subData.shortId === shortSubId) {
                    originalSubId = subId;
                }
            });
            
            // If we can't find the subscription, ignore the event
            if (!originalSubId) {
                console.warn(`Unknown subscription ID: ${shortSubId}`);
                return;
            }
            
            console.log(`Mapped short subscription ID ${shortSubId} to original ID ${originalSubId}`);
            
            // Notify global subscription callbacks
            const subscription = this.globalSubscriptions.get(originalSubId);
            if (subscription) {
                const callbackCount = subscription.callbacks.length;
                console.log(`Notifying ${callbackCount} subscription callbacks`);
                
                subscription.callbacks.forEach(callback => {
                    try {
                        callback(event, relayUrl, originalSubId);
                    } catch (e) {
                        console.error('Error in subscription callback:', e);
                    }
                });
            }
            
            // Notify global event listeners
            console.log(`Notifying ${this.eventCallbacks.length} global event listeners`);
            this.eventCallbacks.forEach(callback => {
                try {
                    callback(event, relayUrl, originalSubId);
                } catch (e) {
                    console.error('Error in event callback:', e);
                }
            });
        }
        else if (messageType === 'EOSE') {
            // ["EOSE", <subscription_id>]
            // End of stored events
            console.log(`End of stored events for subscription ${message[1]} from ${relayUrl}`);
        }
        else if (messageType === 'NOTICE') {
            // ["NOTICE", <message>]
            console.log(`Notice from ${relayUrl}: ${message[1]}`);
        }
        else if (messageType === 'OK') {
            // ["OK", <event_id>, <success>, <message>]
            if (message.length >= 3) {
                const eventId = message[1];
                const success = message[2];
                const errorMsg = message.length > 3 ? message[3] : '';
                
                console.log(`Received OK from ${relayUrl} for event ${eventId.substring(0, 8)}... - Success: ${success}${errorMsg ? ', Message: ' + errorMsg : ''}`);
            } else {
                console.log(`Received incomplete OK message from ${relayUrl}:`, message);
            }
        }
    }
    
    /**
     * Fetch the user's follows (kind 3 contact list)
     * @private
     */
    async fetchUserFollows() {
        if (!this.user || !this.user.pubkey) return;
        
        // Create a temporary subscription for the user's contact list
        return new Promise((resolve) => {
            const subId = `contacts-${this.user.pubkey.substring(0, 8)}`;
            
            // Set a timeout for this operation
            const timeoutId = setTimeout(() => {
                this.relayManager.unsubscribe(subId);
                resolve(); // Resolve anyway if timeout occurs
            }, 5000);
            
            // Subscribe to the user's contacts
            this.relayManager.subscribe(subId, [
                { kinds: [3], authors: [this.user.pubkey], limit: 1 }
            ], (event) => {
                if (event.kind === 3 && event.pubkey === this.user.pubkey) {
                    // Extract all followed pubkeys from p tags
                    event.tags.forEach(tag => {
                        if (tag[0] === 'p' && tag[1]) {
                            this.follows.add(tag[1]);
                            this.relevantPubkeys.add(tag[1]);
                        }
                    });
                    
                    // Clean up
                    clearTimeout(timeoutId);
                    this.relayManager.unsubscribe(subId);
                    resolve();
                }
            });
        });
    }

    /**
 * Discover relays from follows
 * @returns {Promise<Map>} - Map of groupId -> {group, followers}
 */
    async discoverRelaysFromFollows() {
        console.log('Starting relay discovery from follows...');
        
        // Get follows excluding current user
        const followsPubkeys = Array.from(this.follows).filter(pubkey => pubkey !== this.user.pubkey);
        
        if (followsPubkeys.length === 0) {
            console.log('No follows found to discover relays from');
            return new Map();
        }
        
        // Step 1: Fetch kind 10009 events from follows
        const relayListSubId = `discover-relay-lists-${Date.now()}`;
        const hypertunaGroupsMap = new Map(); // Map of groupId -> Set of pubkeys
        
        await new Promise((resolve) => {
            let receivedCount = 0;
            const expectedCount = followsPubkeys.length;
            
            const timeoutId = setTimeout(() => {
                this.relayManager.unsubscribe(relayListSubId);
                resolve();
            }, 5000);
            
            this.relayManager.subscribe(relayListSubId, [
                { 
                    kinds: [NostrEvents.KIND_USER_RELAY_LIST], 
                    authors: followsPubkeys,
                    limit: followsPubkeys.length
                }
            ], (event) => {
                receivedCount++;
                
                // Process the relay list event
                event.tags.forEach(tag => {
                    if (tag[0] === 'group' && tag[tag.length - 1] === 'hypertuna:relay') {
                        const groupId = tag[1];
                        if (!hypertunaGroupsMap.has(groupId)) {
                            hypertunaGroupsMap.set(groupId, new Set());
                        }
                        hypertunaGroupsMap.get(groupId).add(event.pubkey);
                    }
                });
                
                if (receivedCount >= expectedCount) {
                    clearTimeout(timeoutId);
                    this.relayManager.unsubscribe(relayListSubId);
                    resolve();
                }
            }, { suppressGlobalEvents: true }); // Add this option
        });
        
        console.log(`Found ${hypertunaGroupsMap.size} unique Hypertuna groups from follows`);
        
        if (hypertunaGroupsMap.size === 0) {
            return new Map();
        }
        
        // Step 2: Fetch profiles for follows
        const profilesMap = await this.fetchMultipleProfiles(followsPubkeys);
        
        // Step 3: Fetch group metadata for discovered groups
        const groupIds = Array.from(hypertunaGroupsMap.keys());
        const discoveredRelays = new Map();
        
        const metadataSubId = `discover-metadata-${Date.now()}`;
        
        await new Promise((resolve) => {
            let groupsProcessed = 0;
            
            const timeoutId = setTimeout(() => {
                this.relayManager.unsubscribe(metadataSubId);
                resolve();
            }, 5000);
            
            this.relayManager.subscribe(metadataSubId, [
                { 
                    kinds: [NostrEvents.KIND_GROUP_METADATA],
                    "#d": groupIds,
                    limit: groupIds.length
                },
                {
                    kinds: [NostrEvents.KIND_HYPERTUNA_RELAY],
                    "#h": groupIds,
                    limit: groupIds.length
                }
            ], (event) => {
                if (event.kind === NostrEvents.KIND_GROUP_METADATA) {
                    const groupData = NostrEvents.parseGroupMetadata(event);
                    if (groupData && hypertunaGroupsMap.has(groupData.id)) {
                        const followerPubkeys = Array.from(hypertunaGroupsMap.get(groupData.id));
                        const followers = followerPubkeys.map(pubkey => ({
                            pubkey,
                            profile: profilesMap.get(pubkey) || { name: `User_${NostrUtils.truncatePubkey(pubkey)}` }
                        }));
                        
                        discoveredRelays.set(groupData.id, {
                            group: groupData,
                            followers: followers,
                            followerCount: followers.length
                        });
                        
                        groupsProcessed++;
                    }
                } else if (event.kind === NostrEvents.KIND_HYPERTUNA_RELAY) {
                    // Process Hypertuna relay event if needed
                    const groupId = NostrEvents._getTagValue(event, 'h');
                    if (groupId && discoveredRelays.has(groupId)) {
                        const relayUrl = NostrEvents._getTagValue(event, 'd');
                        if (relayUrl) {
                            discoveredRelays.get(groupId).relayUrl = relayUrl;
                        }
                    }
                }
                
                if (groupsProcessed >= groupIds.length) {
                    clearTimeout(timeoutId);
                    this.relayManager.unsubscribe(metadataSubId);
                    resolve();
                }
            }, { suppressGlobalEvents: true }); // Add this option
        });
        
        return discoveredRelays;
    }

/**
 * Fetch multiple user profiles
 * @param {Array<string>} pubkeys - Array of pubkeys
 * @returns {Promise<Map>} - Map of pubkey -> profile
 */
async fetchMultipleProfiles(pubkeys) {
    const profilesMap = new Map();
    
    // Check cache first
    pubkeys.forEach(pubkey => {
        if (this.cachedProfiles.has(pubkey)) {
            profilesMap.set(pubkey, this.cachedProfiles.get(pubkey));
        }
    });
    
    // Fetch missing profiles
    const missingPubkeys = pubkeys.filter(pubkey => !profilesMap.has(pubkey));
    
    if (missingPubkeys.length === 0) {
        return profilesMap;
    }
    
    const profileSubId = `profiles-${Date.now()}`;
    
    await new Promise((resolve) => {
        const timeoutId = setTimeout(() => {
            this.relayManager.unsubscribe(profileSubId);
            resolve();
        }, 3000);
        
        this.relayManager.subscribe(profileSubId, [
            { 
                kinds: [NostrEvents.KIND_METADATA], 
                authors: missingPubkeys,
                limit: missingPubkeys.length
            }
        ], (event) => {
            try {
                const profile = JSON.parse(event.content);
                if (Array.isArray(event.tags)) {
                    const pictureTag = event.tags.find(tag => tag[0] === 'picture');
                    if (pictureTag) {
                        profile.pictureTagUrl = pictureTag[1] || null;
                        profile.pictureIsHypertunaPfp = pictureTag.includes('hypertuna:drive:pfp');
                    }
                }
                const fullProfile = {
                    ...profile,
                    pubkey: event.pubkey,
                    updated_at: event.created_at,
                    pictureTagUrl: profile.pictureTagUrl || null,
                    pictureIsHypertunaPfp: profile.pictureIsHypertunaPfp || false
                };
                
                this.cachedProfiles.set(event.pubkey, fullProfile);
                profilesMap.set(event.pubkey, fullProfile);
            } catch (e) {
                console.error('Error parsing profile:', e);
            }
        }, { suppressGlobalEvents: true }); // Add this option for profile fetching too
    });
    
    // Add default profiles for any still missing
    missingPubkeys.forEach(pubkey => {
        if (!profilesMap.has(pubkey)) {
            const defaultProfile = {
                name: `User_${NostrUtils.truncatePubkey(pubkey)}`,
                pubkey
            };
            profilesMap.set(pubkey, defaultProfile);
        }
    });
    
    return profilesMap;
}

    /**
     * Fetch the user's relay list event (kind 10009) or create one if missing
     */
    async fetchUserRelayList() {
        if (!this.user || !this.user.pubkey) return;
    
        return new Promise((resolve) => {
            const subId = `relaylist-${this.user.pubkey.substring(0,8)}`;
            let received = false;
    
            const timeoutId = setTimeout(async () => {
                this.relayManager.unsubscribe(subId);
                if (!received) {
                    await this._createEmptyRelayList();
                }
                console.log('Fetched user relay list event:', this.userRelayListEvent);
                resolve();
            }, 5000);
    
            this.relayManager.subscribe(subId, [
                { kinds: [NostrEvents.KIND_USER_RELAY_LIST], authors: [this.user.pubkey], limit: 1 }
            ], (event) => {
                received = true;
                clearTimeout(timeoutId);
                this.relayManager.unsubscribe(subId);
                this.userRelayListEvent = event;
                this._parseRelayListEvent(event);
                resolve();
            });
        });
    }

    _parseRelayListEvent(event) {
        this.userRelayIds.clear();
        if (!event) return;
        
        event.tags.forEach(t => {
            if (t[0] === 'group' && t[1] && t[t.length - 1] === 'hypertuna:relay') {
                this.userRelayIds.add(t[1]);
            }
        });
    
        if (!event.content) {
            this.relayListLoaded = true;  // ADD THIS LINE
            console.log('Parsed relay list. Current user relay IDs:', Array.from(this.userRelayIds));
            this.emit('relaylist:update', { ids: Array.from(this.userRelayIds) });
            return;
        }
    
        let decoded = null;
        try {
            decoded = NostrUtils.decrypt(this.user.privateKey, this.user.pubkey, event.content);
        } catch (e) {
            try {
                decoded = event.content;
            } catch {}
        }
    
        if (decoded) {
            try {
                const arr = JSON.parse(decoded);
                arr.forEach(t => {
                    if (Array.isArray(t) && t[0] === 'group' && t[1] && t[t.length - 1] === 'hypertuna:relay') {
                        this.userRelayIds.add(t[1]);
                    }
                });
            } catch {}
        }
        
        this.relayListLoaded = true;  // ADD THIS LINE
        console.log('Parsed relay list. Current user relay IDs:', Array.from(this.userRelayIds));
        this.emit('relaylist:update', { ids: Array.from(this.userRelayIds) });
    }

    async _createEmptyRelayList() {
        const event = await NostrEvents.createUserRelayListEvent([], [], this.user.privateKey);
        await this.relayManager.publish(event);
        this.userRelayListEvent = event;
        this.userRelayIds.clear();
        this.relayListLoaded = true;
        this.emit('relaylist:update', { ids: Array.from(this.userRelayIds) });
        console.log('Created empty user relay list event');
    }

    async updateUserRelayList(publicIdentifier, gatewayUrl, isPublic, add = true) {
        if (!this.userRelayListEvent) {
            await this._createEmptyRelayList();
        }
    
        const tags = [...this.userRelayListEvent.tags];
        let contentArr = [];
        if (this.userRelayListEvent.content) {
            try {
                const dec = NostrUtils.decrypt(this.user.privateKey, this.user.pubkey, this.userRelayListEvent.content);
                contentArr = JSON.parse(dec);
            } catch (e) {
                try { contentArr = JSON.parse(this.userRelayListEvent.content); } catch { contentArr = []; }
            }
        }
    
        const groupName = (this.groups.get(publicIdentifier)?.name) || '';

        const baseUrl = this._getBaseRelayUrl(gatewayUrl);

        // Store only base URL in relay list
        const groupTag = ['group', publicIdentifier, baseUrl, groupName, 'hypertuna:relay'];
        const rTag = ['r', baseUrl, 'hypertuna:relay'];
    
        const remove = (arr, tag) => {
            const byIdx = arr.findIndex(t =>
                t[0] === tag[0] &&
                t[1] === tag[1] &&
                t[t.length - 1] === tag[tag.length - 1]
            );
            if (byIdx > -1) {
                arr.splice(byIdx, 1);
                return;
            }
            // Fallback: match by base URL for legacy entries with tokens
            const idx2 = arr.findIndex(t => {
                const urlIdx = tag[0] === 'r' ? 1 : 2;
                return (
                    t[0] === tag[0] &&
                    this._getBaseRelayUrl(t[urlIdx]) === baseUrl &&
                    t[t.length - 1] === tag[tag.length - 1]
                );
            });
            if (idx2 > -1) arr.splice(idx2, 1);
        };
    
        if (add) {
            // First remove any existing entries for this identifier
            if (isPublic) {
                remove(tags, ['group', publicIdentifier, '', '', 'hypertuna:relay']);
                remove(tags, ['r', '', 'hypertuna:relay']);
                tags.push(groupTag, rTag);
            } else {
                remove(contentArr, ['group', publicIdentifier, '', '', 'hypertuna:relay']);
                remove(contentArr, ['r', '', 'hypertuna:relay']);
                contentArr.push(groupTag, rTag);
            }
            this.userRelayIds.add(publicIdentifier);
            console.log('Added relay to user list:', publicIdentifier, { groupTag, rTag });
        } else {
            if (isPublic) {
                remove(tags, groupTag);
                remove(tags, rTag);
            } else {
                remove(contentArr, groupTag);
                remove(contentArr, rTag);
            }
            this.userRelayIds.delete(publicIdentifier);
            console.log('Removed relay from user list:', publicIdentifier);
        }
    
        const newEvent = await NostrEvents.createUserRelayListEvent(tags, contentArr, this.user.privateKey);
        this.userRelayListEvent = newEvent;
        
        // Always publish to discovery relays only
        const discoveryRelays = Array.from(this.relayManager.discoveryRelays);
        await this.relayManager.publishToRelays(newEvent, discoveryRelays);
        
        console.log('Published user relay list to discovery relays');
        
        // If adding a relay, connect to it
        if (add && gatewayUrl) {
            const groupId = this.hypertunaGroups.get(publicIdentifier);
            if (groupId) {
                await this.connectToGroupRelay(publicIdentifier, gatewayUrl);
            }
        }
        
        this.emit('relaylist:update', { ids: Array.from(this.userRelayIds) });
    }
    
    /**
     * Determine if an event should be processed based on relevance
     * @param {Object} event - Nostr event
     * @returns {boolean} - Whether to process this event
     * @private
     */
    _shouldProcessEvent(event) {
        // Always process events from the current user
        if (event.pubkey === this.user.pubkey) {
            return true;
        }
        
        // Process group metadata events (kind 39000) from any pubkey
        if (event.kind === NostrEvents.KIND_GROUP_METADATA) {
            // Check if this is a Hypertuna event
            const hypertunaId = NostrEvents._getTagValue(event, 'hypertuna');
            if (hypertunaId) {
                // Process if it's from the user or someone they follow
                return event.pubkey === this.user.pubkey || this.follows.has(event.pubkey);
            }
            return true;
        }
        
        // Process Hypertuna relay events (kind 30166)
        if (event.kind === NostrEvents.KIND_HYPERTUNA_RELAY) {
            return true;
        }
        
        // Process events from pubkeys we follow
        if (this.follows.has(event.pubkey)) {
            return true;
        }
        
        // Process events from pubkeys in groups the user is a member of
        if (this.relevantPubkeys.has(event.pubkey)) {
            return true;
        }
        
        // Process group membership events if they involve the user
        if ((event.kind === NostrEvents.KIND_GROUP_MEMBER_LIST || 
             event.kind === NostrEvents.KIND_GROUP_ADMIN_LIST) && 
            event.tags.some(tag => tag[0] === 'p' && tag[1] === this.user.pubkey)) {
            return true;
        }
        
        // Skip all other events
        return false;
    }
    
    /**
     * Create subscriptions with appropriate filters
     * @private
     */
    _createSubscriptions() {
        if (!this.user || !this.user.pubkey) return;
        
        // Clean up any existing subscriptions
        this.activeSubscriptions.forEach(subId => {
            this.relayManager.unsubscribe(subId);
        });
        this.activeSubscriptions.clear();
        
        // Subscribe to user's own profile data
        const profileSubId = this.relayManager.subscribe('user-profile', [
            { kinds: [0], authors: [this.user.pubkey] }
        ], (event) => {
            this._processProfileEvent(event);
        });
        this.activeSubscriptions.add(profileSubId);
        
        // Subscribe to Hypertuna group metadata (kind 39000 with identifier tag)
        // Only from the user's pubkey and followed pubkeys
        const followsArray = [...this.follows];
        const authorsToFollow = [this.user.pubkey, ...followsArray];
        
        // Updated to use 'i' tag with 'hypertuna:relay' value
        const hypertunaGroupSubId = this.relayManager.subscribe('hypertuna-groups', [
            { 
                kinds: [NostrEvents.KIND_GROUP_METADATA],
                "#i": ["hypertuna:relay"],
                authors: authorsToFollow
            }
        ], (event) => {
            console.log("Received group metadata event:", {
                id: event.id.substring(0, 8) + "...",
                pubkey: event.pubkey.substring(0, 8) + "...",
                tags: event.tags.map(t => t[0]).join(',')
            });
            
            this._processGroupMetadataEvent(event);
            
            // Extract group ID from this event
            const groupId = event.tags.find(tag => tag[0] === 'd')?.[1];
            if (groupId) {
                // Store the hypertuna ID for this group
                const hypertunaId = event.tags.find(tag => tag[0] === 'hypertuna')?.[1];
                if (hypertunaId) {
                    this.hypertunaGroups.set(hypertunaId, groupId);
                    this.groupHypertunaIds.set(groupId, hypertunaId);
                }
                
                // Subscribe to membership events for this group
                this._subscribeToGroupMembership(groupId);
            }
        });
        this.activeSubscriptions.add(hypertunaGroupSubId);
        
        // Subscribe to Hypertuna relay events (kind 30166)
        // Using the 'i' tag filter instead of 'hypertuna'
        const hypertunaRelaySubId = this.relayManager.subscribe('hypertuna-relays', [
            { kinds: [NostrEvents.KIND_HYPERTUNA_RELAY], "#i": ["hypertuna:relay"], authors: authorsToFollow }
        ], (event) => {
            console.log("Received hypertuna relay event:", {
                id: event.id.substring(0, 8) + "...",
                pubkey: event.pubkey.substring(0, 8) + "...",
                tags: event.tags.map(t => t[0]).join(',')
            });
            
            this._processHypertunaRelayEvent(event);
        });
        this.activeSubscriptions.add(hypertunaRelaySubId);

        // Subscribe to user's relay list (kind 10009)
        const relayListSub = this.relayManager.subscribe('user-relaylist', [
            { kinds: [NostrEvents.KIND_USER_RELAY_LIST], authors: [this.user.pubkey], limit: 1 }
        ], (event) => {
            this.userRelayListEvent = event;
            this._parseRelayListEvent(event);
        });
        this.activeSubscriptions.add(relayListSub);
        
        // Subscribe to group membership changes affecting user
        const membershipSubId = this.relayManager.subscribe('user-groups', [
            { 
                kinds: [
                    NostrEvents.KIND_GROUP_MEMBER_LIST,
                    NostrEvents.KIND_GROUP_ADMIN_LIST
                ],
                "#p": [this.user.pubkey]
            }
        ], (event) => {
            this._processGroupMembershipEvent(event);
            
            // Add all pubkeys from this group to relevant pubkeys
            event.tags.forEach(tag => {
                if (tag[0] === 'p' && tag[1]) {
                    this.relevantPubkeys.add(tag[1]);
                }
            });
            
            // Extract group ID
            const groupId = event.tags.find(tag => tag[0] === 'd')?.[1];
            if (groupId) {
                // Subscribe to this group's events
                this._subscribeToGroupContent(groupId);
            }
        });
        this.activeSubscriptions.add(membershipSubId);
    }
    
    /**
     * Subscribe to group membership events for a specific group
     * @param {string} groupId - Group ID
     * @private
     */
    _subscribeToGroupMembership(publicIdentifier) {
        if (!publicIdentifier) return;
        
        // Define the membership filters
        const membershipFilters = [
            {
                kinds: [
                    NostrEvents.KIND_GROUP_MEMBER_LIST,
                    NostrEvents.KIND_GROUP_ADMIN_LIST
                ],
                "#d": [publicIdentifier]
            },
            {
                kinds: [
                    NostrEvents.KIND_GROUP_PUT_USER,
                    NostrEvents.KIND_GROUP_REMOVE_USER,
                    NostrEvents.KIND_GROUP_JOIN_REQUEST
                ],
                "#h": [publicIdentifier]
            }
        ];
        
        // Check if we already have this subscription
        const existingSubId = this._findExistingSubscription(membershipFilters);
        if (existingSubId) {
            console.log(`Already subscribed to membership for ${publicIdentifier} with ${existingSubId}`);
            return;
        }
        
        // Create unique subscription ID
        const subId = `group-members-${publicIdentifier}-${Date.now()}`;
        
        // Track the subscription
        const filterHash = this._hashFilters(membershipFilters);
        this.subscriptionsByFilter.set(filterHash, subId);
        
        // Track by group
        if (!this.groupSubscriptions.has(publicIdentifier)) {
            this.groupSubscriptions.set(publicIdentifier, new Set());
        }
        this.groupSubscriptions.get(publicIdentifier).add(subId);
        
        // Subscribe to membership events
        const actualSubId = this.relayManager.subscribe(subId, membershipFilters, (event) => {
            // Process membership events
            event.tags.forEach(tag => {
                if (tag[0] === 'p' && tag[1]) {
                    this.relevantPubkeys.add(tag[1]);
                }
            });
            
            switch (event.kind) {
                case NostrEvents.KIND_GROUP_MEMBER_LIST:
                    this._processGroupMemberListEvent(event);
                    break;
                case NostrEvents.KIND_GROUP_ADMIN_LIST:
                    this._processGroupAdminListEvent(event);
                    break;
                case NostrEvents.KIND_GROUP_PUT_USER:
                    this._processGroupAddUserEvent(event);
                    break;
                case NostrEvents.KIND_GROUP_REMOVE_USER:
                    this._processGroupRemoveUserEvent(event);
                    break;
                case NostrEvents.KIND_GROUP_JOIN_REQUEST:
                    this._processJoinRequestEvent(event);
                    break;
            }
        });
        
        this.activeSubscriptions.add(actualSubId);
    }
    
    /**
     * Subscribe to group content for a specific group
     * @param {string} groupId - Group ID
     * @private
     */
    _subscribeToGroupContent(groupId) {
        if (!groupId) return;
        
        const subId = `group-content-${groupId.substring(0, 8)}`;
        
        // Check if we're already subscribed
        if (this.activeSubscriptions.has(subId)) {
            return;
        }
        
        // Get relevant pubkeys for this group
        const members = this.getGroupMembers(groupId);
        const memberPubkeys = members.map(m => m.pubkey);
        
        // Add all members to relevant pubkeys
        memberPubkeys.forEach(pubkey => {
            this.relevantPubkeys.add(pubkey);
        });
        
        // Filter to only include pubkeys we're following or group members
        const relevantAuthors = [...memberPubkeys, this.user.pubkey];
        
        // Subscribe to group messages from relevant authors
        const actualSubId = this.relayManager.subscribe(subId, [
            { 
                kinds: [NostrEvents.KIND_TEXT_NOTE],
                "#h": [groupId],
                authors: relevantAuthors
            }
        ], (event) => {
            this._processGroupMessageEvent(event);
        });
        
        this.activeSubscriptions.add(actualSubId);
    }
    
    /**
     * Process an incoming event
     * @param {Object} event - Nostr event
     * @param {string} relayUrl - Source relay URL
     * @private
     */
    _processEvent(event, relayUrl) {
        console.log(`Processing event kind ${event.kind} with ID ${event.id.substring(0, 8)}...`);
        switch (event.kind) {
            case NostrEvents.KIND_METADATA:
                this._processProfileEvent(event);
                break;
                
            case NostrEvents.KIND_TEXT_NOTE:
                this._processGroupMessageEvent(event);
                break;
                
            case NostrEvents.KIND_GROUP_METADATA:
                this._processGroupMetadataEvent(event);
                break;
                
            case NostrEvents.KIND_GROUP_MEMBER_LIST:
                this._processGroupMemberListEvent(event);
                break;
                
            case NostrEvents.KIND_GROUP_ADMIN_LIST:
                this._processGroupAdminListEvent(event);
                break;

            case NostrEvents.KIND_GROUP_PUT_USER:
                this._processGroupAddUserEvent(event);
                break;

            case NostrEvents.KIND_GROUP_REMOVE_USER:
                this._processGroupRemoveUserEvent(event);
                break;
                
            case NostrEvents.KIND_HYPERTUNA_RELAY:
                this._processHypertunaRelayEvent(event);
                break;

            case NostrEvents.KIND_USER_RELAY_LIST:
                this.userRelayListEvent = event;
                this._parseRelayListEvent(event);
                break;
        }
        
        // Emit event for any listeners
        this.emit('event', { event, relayUrl });
        this.emit(`event:kind:${event.kind}`, { event, relayUrl });
    }
    
    /**
     * Process a profile metadata event with enhanced logging
     * @param {Object} event - Profile event (kind 0)
     * @private
     */
    _processProfileEvent(event) {
        try {
            console.log(`Processing profile event:`, {
                pubkey: event.pubkey.substring(0, 8) + '...',
                created_at: event.created_at,
                content_length: event.content.length
            });
            
            const profile = JSON.parse(event.content);
            if (Array.isArray(event.tags)) {
                const pictureTag = event.tags.find(tag => tag[0] === 'picture');
                if (pictureTag) {
                    profile.pictureTagUrl = pictureTag[1] || null;
                    profile.pictureIsHypertunaPfp = pictureTag.includes('hypertuna:drive:pfp');
                }
            }
            console.log(`Parsed profile data:`, {
                name: profile.name,
                about: profile.about ? profile.about.substring(0, 30) + '...' : undefined,
                picture: profile.picture ? 'present' : undefined
            });
            
            this.cachedProfiles.set(event.pubkey, {
                ...profile,
                pubkey: event.pubkey,
                updated_at: event.created_at,
                pictureTagUrl: profile.pictureTagUrl || null,
                pictureIsHypertunaPfp: profile.pictureIsHypertunaPfp || false
            });
            
            // Update current user if it's our profile
            if (this.user && event.pubkey === this.user.pubkey) {
                console.log(`Updating current user profile`);
                this.user = {
                    ...this.user,
                    ...profile
                };
                this.emit('user:update', { user: this.user });
            }
            
            this.emit('profile:update', { 
                pubkey: event.pubkey, 
                profile 
            });
        } catch (e) {
            console.error('Error processing profile event:', e);
        }
    }
    
    /**
     * Process a group metadata event
     * @param {Object} event - Group metadata event (kind 39000)
     * @private
     */
    _processGroupMetadataEvent(event) {
        console.log(`Processing group metadata event with ID: ${event.id.substring(0, 8)}...`);
        
        const groupData = NostrEvents.parseGroupMetadata(event);
        if (!groupData) {
            console.warn(`Failed to parse group metadata from event`);
            return;
        }

        const publicIdentifier = groupData.id;
        
        // Check if this is a duplicate or older event
        const existingGroup = this.groups.get(publicIdentifier);
        if (existingGroup && existingGroup.createdAt >= groupData.createdAt) {
            console.log(`Skipping older/duplicate metadata event for group ${publicIdentifier}`);
            return;
        }
        
        // Update group data including file sharing flag
        this.groups.set(publicIdentifier, groupData);
        
        // Store hypertuna mapping if available
        if (groupData.hypertunaId) {
            this.hypertunaGroups.set(groupData.hypertunaId, publicIdentifier);
            this.groupHypertunaIds.set(publicIdentifier, groupData.hypertunaId);
        }
        
        // Emit event
        this.emit('group:metadata', { 
            groupId: publicIdentifier,
            group: groupData 
        });
        
        // Only subscribe to membership if not already subscribed
        const membershipFilters = [
            {
                kinds: [
                    NostrEvents.KIND_GROUP_MEMBER_LIST,
                    NostrEvents.KIND_GROUP_ADMIN_LIST
                ],
                "#d": [publicIdentifier]
            },
            {
                kinds: [
                    NostrEvents.KIND_GROUP_PUT_USER,
                    NostrEvents.KIND_GROUP_REMOVE_USER
                ],
                "#h": [publicIdentifier]
            }
        ];
        
        if (!this._findExistingSubscription(membershipFilters)) {
            this._subscribeToGroupMembership(publicIdentifier);
        }
    }
    
    /**
     * Process a Hypertuna relay event
     * @param {Object} event - Hypertuna relay event (kind 30166)
     * @private
     */
    _processHypertunaRelayEvent(event) {
        console.log(`Processing Hypertuna relay event with ID: ${event.id.substring(0, 8)}...`);
        
        // Check for the identifier tag
        const isHypertunaRelay = event.tags.some(tag => tag[0] === 'i' && tag[1] === 'hypertuna:relay');
        console.log(`Has hypertuna:relay identifier: ${isHypertunaRelay}`);
        
        // Extract hypertuna ID from the event
        const hypertunaId = NostrEvents._getTagValue(event, 'hypertuna');
        if (!hypertunaId) {
            console.warn('Hypertuna relay event missing hypertuna tag');
            return;
        }
        
        // Extract group ID from the event
        const groupId = NostrEvents._getTagValue(event, 'h');
        if (!groupId) {
            console.warn('Hypertuna relay event missing h tag');
            return;
        }

        const relayUrl = NostrEvents._getTagValue(event, 'd');
        if (relayUrl) {
            const existing = this.groupRelayUrls.get(groupId);
            if (!existing || !existing.includes('token=')) {
                this.groupRelayUrls.set(groupId, relayUrl);
            }
        }
        
        console.log(`Processing Hypertuna relay event for group ${groupId} with hypertuna ID ${hypertunaId}`);
        
        // Store mappings
        this.hypertunaGroups.set(hypertunaId, groupId);
        this.groupHypertunaIds.set(groupId, hypertunaId);
        
        // Emit event
        this.emit('hypertuna:relay', {
            hypertunaId,
            groupId,
            event
        });
        
        // Force a check for the associated metadata event
        const existingGroups = this.getGroups();
        console.log(`After processing relay event - Current groups: ${existingGroups.length}`);
    }

    /**
     * Process an incoming invite event
     * @param {Object} event - Invite event (kind 9009)
     * @private
     */
    _processInviteEvent(event) {
        const groupId = NostrEvents._getTagValue(event, 'h');
        if (!groupId) return;

        try {
            const dec = NostrUtils.decrypt(this.user.privateKey, event.pubkey, event.content);
            const data = JSON.parse(dec);
            const invite = {
                id: event.id,
                groupId,
                publicIdentifier: groupId,
                inviter: event.pubkey,
                relayUrl: data.relayUrl,
                token: data.token,
                relayKey: data.relayKey,
                isPublic: data.isPublic !== false,
                name: NostrEvents._getTagValue(event, 'name') || '',
                about: NostrEvents._getTagValue(event, 'about') || '',
                fileSharing: NostrEvents._hasTag(event, 'file-sharing-on')
            };

            this.invites.set(event.id, invite);

            // Preload inviter profile
            this.fetchUserProfile(event.pubkey).catch(() => {});

            this.emit('invites:update', { invites: this.getInvites() });
        } catch (e) {
            console.error('Failed to decrypt invite', e);
        }
    }

    /**
     * Process a join request event
     * @param {Object} event - Join request event (kind 9021)
     * @private
     */
    _processJoinRequestEvent(event) {
        const groupId = NostrEvents._getTagValue(event, 'h');
        if (!groupId) return;

        // Ignore if user already a member
        const members = this.getGroupMembers(groupId);
        if (members.some(m => m.pubkey === event.pubkey)) return;

        if (!this.joinRequests.has(groupId)) {
            this.joinRequests.set(groupId, new Map());
        }

        this.joinRequests.get(groupId).set(event.pubkey, event);

        this.fetchUserProfile(event.pubkey).catch(() => {});
        this.emit('joinrequests:update', { groupId, requests: this.getJoinRequests(groupId) });
    }
    
    /**
     * Process a group member list event
     * @param {Object} event - Group member list event (kind 39002)
     * @private
     */
    _processGroupMemberListEvent(event) {
        // Skip if we've already processed this event
        if (this.processedEvents.has(event.id)) {
            console.log(`Skipping duplicate member list event ${event.id}`);
            return;
        }
        this.processedEvents.add(event.id);
        
        // Extract public identifier from 'd' tag
        const publicIdentifier = NostrEvents._getTagValue(event, 'd');
        if (!publicIdentifier) return;
    
        const parsed = NostrEvents.parseGroupMembers(event);
        const addMap = this.kind9000Sets.get(publicIdentifier) || new Map();
        parsed.forEach(m => {
            addMap.set(m.pubkey, { ts: event.created_at, roles: m.roles });
            this.relevantPubkeys.add(m.pubkey);
        });
        this.kind9000Sets.set(publicIdentifier, addMap);
        
        // Use throttled recompute instead of immediate
        this._throttledRecomputeGroupMembers(publicIdentifier);
    
        if (this.user && this.isGroupAdmin(publicIdentifier, this.user.pubkey) && !this.publishedMemberLists.has(publicIdentifier)) {
            // Delay initial publish to avoid conflicts
            setTimeout(() => {
                this.publishMemberList(publicIdentifier);
            }, 1000);
        }
    }
    
    /**
     * Process a group admin list event
     * @param {Object} event - Group admin list event (kind 39001)
     * @private
     */
    _processGroupAdminListEvent(event) {
        const groupId = NostrEvents._getTagValue(event, 'd');
        if (!groupId) return;
        
        const admins = NostrEvents.parseGroupAdmins(event);
        this.groupAdmins.set(groupId, admins);
        
        // Add all admin pubkeys to relevant pubkeys
        admins.forEach(admin => {
            this.relevantPubkeys.add(admin.pubkey);
        });
        
        // Emit events
        this.emit('group:admins', { 
            groupId, 
            admins 
        });
        
        // Check if current user is an admin
        if (this.user) {
            const isAdmin = admins.some(a => a.pubkey === this.user.pubkey);
            this.emit('group:admin', { 
                groupId, 
                isAdmin 
            });

            if (isAdmin && !this.publishedMemberLists.has(groupId)) {
                this.publishMemberList(groupId);
            }
        }
    }
    
    /**
     * Process a group message event
     * @param {Object} event - Message event (kind 1 with h tag)
     * @private
     */
    _processGroupMessageEvent(event) {
        // Check if it's a group message (has h tag)
        const groupId = event.tags.find(tag => tag[0] === 'h')?.[1];
        if (!groupId) return;
        
        // Add to group messages
        if (!this.groupMessages.has(groupId)) {
            this.groupMessages.set(groupId, []);
        }
        
        const messages = this.groupMessages.get(groupId);
        
        // Check if we already have this message
        if (!messages.some(m => m.id === event.id)) {
            messages.push(event);
            messages.sort((a, b) => a.created_at - b.created_at);
            
            // Emit event
            this.emit('group:message', { 
                groupId, 
                message: event 
            });
        }
    }
    
    /**
     * Process any group membership event
     * @param {Object} event - Group membership event
     * @private
     */
    _processGroupMembershipEvent(event) {
        if (event.kind === NostrEvents.KIND_GROUP_MEMBER_LIST) {
            this._processGroupMemberListEvent(event);
        } else if (event.kind === NostrEvents.KIND_GROUP_ADMIN_LIST) {
            this._processGroupAdminListEvent(event);
        } else if (event.kind === NostrEvents.KIND_GROUP_PUT_USER) {
            this._processGroupAddUserEvent(event);
        } else if (event.kind === NostrEvents.KIND_GROUP_REMOVE_USER) {
            this._processGroupRemoveUserEvent(event);
        }
    }

    _processGroupAddUserEvent(event) {
        const groupId = NostrEvents._getTagValue(event, 'h');
        if (!groupId) return;

        const addMap = this.kind9000Sets.get(groupId) || new Map();
        event.tags.forEach(tag => {
            if (tag[0] === 'p' && tag[1]) {
                const pubkey = tag[1];
                const role = tag[2];
                const token = tag[3];
                const actualRoles = [role];

                // If this entry is for the current user and a token is provided
                if (token && this.user && pubkey === this.user.pubkey) {
                    this.relayAuthTokens.set(groupId, token);
                }

                addMap.set(pubkey, { ts: event.created_at, roles: actualRoles });
                this.relevantPubkeys.add(pubkey);

                // Remove any pending join request for this user
                this.removeJoinRequest(groupId, pubkey);

                // If token is present, send to worker for auth data update
                if (token && isElectron) {
                    const relayKey = this.publicToInternalMap.get(groupId) || null;
                    const msg = {
                        type: 'update-auth-data',
                        data: {
                            relayKey,
                            publicIdentifier: groupId,
                            pubkey,
                            token
                        }
                    };
                    sendWorkerMessage(msg).catch((e) => {
                        console.error('Failed to send update-auth-data to worker', e);
                    });
                }
            }
        });
        this.kind9000Sets.set(groupId, addMap);
        this._recomputeGroupMembers(groupId);
    }

    _processGroupRemoveUserEvent(event) {
        const groupId = NostrEvents._getTagValue(event, 'h');
        if (!groupId) return;
        const remMap = this.kind9001Sets.get(groupId) || new Map();
        event.tags.forEach(tag => {
            if (tag[0] === 'p' && tag[1]) {
                const pubkey = tag[1];
                remMap.set(tag[1], event.created_at);
                this.relevantPubkeys.add(tag[1]);

                // NEW: Send message to worker to remove auth data
                if (isElectron) {
                    const relayKey = this.publicToInternalMap.get(groupId) || null;
                    const msg = {
                        type: 'remove-auth-data',
                        data: {
                            relayKey,
                            publicIdentifier: groupId,
                            pubkey
                        }
                    };
                    sendWorkerMessage(msg).catch((e) => {
                        console.error('Failed to send remove-auth-data to worker', e);
                    });
                }
            }
        });
        this.kind9001Sets.set(groupId, remMap);
        this._recomputeGroupMembers(groupId);
    }
    
    /**
     * Subscribe to all events for a specific group
     * @param {string} groupId - Group ID
     * @returns {string} - Subscription ID
     */
    subscribeToGroup(groupId) {
        if (!groupId) return null;
        
        // Subscribe to group metadata, membership and content
        this._subscribeToGroupMembership(groupId);
        this._subscribeToGroupContent(groupId);
        
        return groupId;
    }
    
    /**
     * Unsubscribe from a group
     * @param {string} groupId - Group ID
     */
    unsubscribeFromGroup(groupId) {
        if (!groupId) return;
        
        // Get all subscriptions for this group
        const groupSubs = this.groupSubscriptions.get(groupId);
        if (!groupSubs) return;
        
        // Unsubscribe from each
        groupSubs.forEach(subId => {
            console.log(`Unsubscribing from: ${subId}`);
            this.relayManager.unsubscribe(subId);
            this.activeSubscriptions.delete(subId);
            
            // Clean up filter tracking
            this.subscriptionsByFilter.forEach((storedSubId, filterHash) => {
                if (storedSubId === subId) {
                    this.subscriptionsByFilter.delete(filterHash);
                }
            });
        });
        
        // Remove group tracking
        this.groupSubscriptions.delete(groupId);
    }
    
    /**
     * Fetch user profile with improved handling of profile picture
     * @param {string} pubkey - Public key
     * @returns {Promise<Object>} - Profile data
     */
    async fetchUserProfile(pubkey) {
        // Check cache first
        if (this.cachedProfiles.has(pubkey)) {
            const cachedProfile = this.cachedProfiles.get(pubkey);
            console.log(`Using cached profile for ${pubkey.substring(0, 8)}...`, cachedProfile);
            return cachedProfile;
        }
        
        // Create a temporary subscription for this profile
        const subId = `profile-${pubkey.substring(0, 8)}`;
        
        console.log(`Creating subscription for profile: ${pubkey.substring(0, 8)}...`);
        
        return new Promise((resolve) => {
            let timeoutId;
            
            const handleProfileEvent = (event) => {
                if (event.kind === 0 && event.pubkey === pubkey) {
                    console.log(`Received profile event for ${pubkey.substring(0, 8)}:`, {
                        id: event.id.substring(0, 8) + '...',
                        created_at: event.created_at,
                        content_length: event.content.length
                    });
                    
                    try {
                        const profile = JSON.parse(event.content);
                        if (Array.isArray(event.tags)) {
                            const pictureTag = event.tags.find(tag => tag[0] === 'picture');
                            if (pictureTag) {
                                profile.pictureTagUrl = pictureTag[1] || null;
                                profile.pictureIsHypertunaPfp = pictureTag.includes('hypertuna:drive:pfp');
                            }
                        }
                        console.log(`Parsed profile data for ${pubkey.substring(0, 8)}:`, profile);
                        
                        this.cachedProfiles.set(pubkey, {
                            ...profile,
                            pubkey,
                            updated_at: event.created_at,
                            pictureTagUrl: profile.pictureTagUrl || null,
                            pictureIsHypertunaPfp: profile.pictureIsHypertunaPfp || false
                        });
                        
                        // Clean up
                        clearTimeout(timeoutId);
                        this.relayManager.unsubscribe(subId);
                        
                        resolve(profile);
                    } catch (e) {
                        console.error('Error parsing profile:', e);
                    }
                }
            };
            
            this.relayManager.subscribe(subId, [
                { kinds: [0], authors: [pubkey] }
            ], handleProfileEvent);
            
            // Set a timeout to resolve with default profile if no profile found
            timeoutId = setTimeout(() => {
                this.relayManager.unsubscribe(subId);
                const defaultProfile = { 
                    name: `User_${NostrUtils.truncatePubkey(pubkey)}`,
                    pubkey
                };
                console.log(`Profile fetch timeout for ${pubkey.substring(0, 8)}, using default:`, defaultProfile);
                this.cachedProfiles.set(pubkey, defaultProfile);
                resolve(defaultProfile);
            }, 5000);
        });
    }
    
    /**
     * Get all available groups filtered for Hypertuna groups
     * @returns {Array} - Array of groups
     */
    getGroups() {
        // Get all groups
        const allGroups = Array.from(this.groups.values());
        console.log(`Total groups in map: ${allGroups.length}`);
        
        if (allGroups.length > 0) {
            console.log('Groups in map:', allGroups.map(g => ({
                id: g.id,
                name: g.name,
                hypertunaId: g.hypertunaId,
                content: g.event?.content,
                pubkey: g.event?.pubkey?.substring(0, 8) + '...',
                createdAt: g.createdAt
            })));
        } else {
            console.log('No groups found in the map');
        }
        
        // For debugging, return all groups regardless of filters
        if (allGroups.length === 0) {
            console.log('Returning all groups for debugging');
            return allGroups;
        }
        
        // Filter for Hypertuna groups using the identifier tag
        const hypertunaGroups = allGroups.filter(group => {
            // Check if this is a Hypertuna relay group using the identifier tag
            const isHypertunaRelay = group.isHypertunaRelay || 
                                  (group.event && group.event.tags.some(tag => 
                                      tag[0] === 'i' && tag[1] === 'hypertuna:relay'));
            
            // Check if it has a hypertuna ID
            const hasHypertunaId = !!group.hypertunaId;
            
            console.log(`Group ${group.id}: isHypertunaRelay=${isHypertunaRelay}, hasHypertunaId=${hasHypertunaId}`);
            
            // For debugging, include all groups to see what's available
            return true;
        });
        
        console.log(`Filtered groups: ${hypertunaGroups.length}`);
        
        if (hypertunaGroups.length > 0) {
            console.log('Filtered groups:', hypertunaGroups.map(g => g.name));
        }
        
        // Sort by creation date (newest first)
        hypertunaGroups.sort((a, b) => b.createdAt - a.createdAt);
        
        return hypertunaGroups;
    }
    
    /**
     * Get a specific group by ID
     * @param {string} groupId - Group ID
     * @returns {Object|null} - Group data or null if not found
     */
    getGroupById(groupId) {
        return this.groups.get(groupId) || null;
    }
    
    /**
     * Get members of a group
     * @param {string} groupId - Group ID
     * @returns {Array} - Array of member objects
    */
    getGroupMembers(groupId) {
        if (this.kind9000Sets.has(groupId) || this.kind9001Sets.has(groupId)) {
            this._recomputeGroupMembers(groupId);
        }
        return this.groupMembers.get(groupId) || [];
    }

    _recomputeGroupMembers(groupId) {
        const addMap = this.kind9000Sets.get(groupId) || new Map();
        const removeMap = this.kind9001Sets.get(groupId) || new Map();
        const members = [];
        
        // Build unique member list
        const seenPubkeys = new Set();
        
        for (const [pubkey, info] of addMap.entries()) {
            const rts = removeMap.get(pubkey);
            if ((!rts || info.ts > rts) && !seenPubkeys.has(pubkey)) {
                members.push({ pubkey, roles: info.roles || ['member'] });
                seenPubkeys.add(pubkey);
            }
        }
        
        // Check if members actually changed
        const oldMembers = this.groupMembers.get(groupId) || [];
        const hasChanged = members.length !== oldMembers.length || 
            !members.every(m => oldMembers.some(om => om.pubkey === m.pubkey));
        
        if (!hasChanged) {
            console.log(`No changes to members for group ${groupId}`);
            return;
        }
        
        this.groupMembers.set(groupId, members);
        
        // Only emit if we have listeners to avoid unnecessary work
        if (this.eventListeners.has('group:members')) {
            this.emit('group:members', { groupId, members });
        }
        
        if (this.user && this.eventListeners.has('group:membership')) {
            const isMember = members.some(m => m.pubkey === this.user.pubkey);
            this.emit('group:membership', { groupId, isMember });
        }
        
        this._notifyMemberUpdate(groupId, members);
    }
    
    /**
     * Get admins of a group
     * @param {string} groupId - Group ID
     * @returns {Array} - Array of admin objects
     */
    getGroupAdmins(groupId) {
        return this.groupAdmins.get(groupId) || [];
    }
    
    /**
     * Check if a user is a member of a group
     * @param {string} groupId - Group ID
     * @param {string} pubkey - Public key
     * @returns {boolean} - Whether the user is a member
     */
    isGroupMember(groupId, pubkey) {
        const members = this.groupMembers.get(groupId) || [];
        const isMember = members.some(member => member.pubkey === pubkey);
        
        console.log(`Checking if ${pubkey.substring(0, 8)}... is member of ${groupId.substring(0, 8)}...`, {
            result: isMember,
            totalMembers: members.length,
            memberPubkeys: members.map(m => m.pubkey.substring(0, 8) + '...')
        });
        
        return isMember;
    }
    
    /**
     * Check if a user is an admin of a group
     * @param {string} groupId - Group ID
     * @param {string} pubkey - Public key
     * @returns {boolean} - Whether the user is an admin
     */
    isGroupAdmin(groupId, pubkey) {
        const admins = this.groupAdmins.get(groupId) || [];
        const isAdmin = admins.some(admin => admin.pubkey === pubkey);
        
        console.log(`Checking if ${pubkey.substring(0, 8)}... is admin of ${groupId.substring(0, 8)}...`, {
            result: isAdmin,
            totalAdmins: admins.length,
            adminPubkeys: admins.map(a => a.pubkey.substring(0, 8) + '...')
        });
        
        return isAdmin;
    }
    
    
    /**
     * Get messages for a group
     * @param {string} groupId - Group ID
     * @returns {Array} - Array of message events
     */
    getGroupMessages(groupId) {
        return this.groupMessages.get(groupId) || [];
    }

    getUserRelayGroupIds() {
        return Array.from(this.userRelayIds).filter(Boolean);
    }

    isRelayListReady() {
        return this.relayListLoaded;
    }

    /**
     * Build full member list for a group by combining snapshot and updates
     * @param {string} publicIdentifier - Group public identifier
     * @returns {Promise<Array>} - Array of member pubkeys
     */
    async buildMemberList(publicIdentifier) {
        if (!publicIdentifier) return [];
    
        // Check if we're already building for this group
        const buildingKey = `building-${publicIdentifier}`;
        if (this._pendingMemberUpdates.has(buildingKey)) {
            console.log(`Already building member list for ${publicIdentifier}`);
            return this.groupMembers.get(publicIdentifier) || [];
        }
        
        try {
            // Mark as building
            this._pendingMemberUpdates.set(buildingKey, true);
    
            const admins = this.groupAdmins.get(publicIdentifier) || [];
            const adminPubkey = admins.length > 0 ? admins[0].pubkey : null;
            if (!adminPubkey) return [];
    
            // Cancel any existing subscription for this group
            const existingSubIds = Array.from(this.activeSubscriptions).filter(id => 
                id.startsWith(`member-base-${publicIdentifier}`)
            );
            existingSubIds.forEach(subId => {
                this.relayManager.unsubscribe(subId);
                this.activeSubscriptions.delete(subId);
            });
    
            // Fetch latest member list event from the admin
            const baseEvent = await new Promise(resolve => {
                const subId = `member-base-${publicIdentifier}-${Date.now()}`;
                let timeout;
                
                this.relayManager.subscribe(subId, [
                    { kinds: [NostrEvents.KIND_GROUP_MEMBER_LIST], '#d': [publicIdentifier], authors: [adminPubkey], limit: 1 }
                ], event => {
                    clearTimeout(timeout);
                    this.relayManager.unsubscribe(subId);
                    this.activeSubscriptions.delete(subId);
                    resolve(event);
                });
                
                this.activeSubscriptions.add(subId);
                
                timeout = setTimeout(() => {
                    this.relayManager.unsubscribe(subId);
                    this.activeSubscriptions.delete(subId);
                    resolve(null);
                }, 3000);
            });
    
            if (!baseEvent || !(await NostrEvents.verifyAdminListEvent(baseEvent, adminPubkey))) {
                return [];
            }
    
            const since = baseEvent.created_at;
    
            // Collect membership update events after the snapshot
            const updateEvents = await new Promise(resolve => {
                const subId = `member-updates-${publicIdentifier}-${Date.now()}`;
                const evs = [];
                let timeout;
                
                this.relayManager.subscribe(subId, [
                    { kinds: [NostrEvents.KIND_GROUP_PUT_USER, NostrEvents.KIND_GROUP_REMOVE_USER], '#h': [publicIdentifier], since }
                ], event => {
                    evs.push(event);
                });
                
                this.activeSubscriptions.add(subId);
                
                timeout = setTimeout(() => {
                    this.relayManager.unsubscribe(subId);
                    this.activeSubscriptions.delete(subId);
                    resolve(evs);
                }, 3000);
            });
    
            const baseMembers = NostrEvents.parseGroupMembers(baseEvent);
            const addMap = new Map();
            baseMembers.forEach(m => addMap.set(m.pubkey, { ts: baseEvent.created_at, roles: m.roles }));
    
            const addEvents = updateEvents.filter(e => e.kind === NostrEvents.KIND_GROUP_PUT_USER);
            const removeEvents = updateEvents.filter(e => e.kind === NostrEvents.KIND_GROUP_REMOVE_USER);
    
            addEvents.forEach(ev => {
                ev.tags.forEach(tag => {
                    if (tag[0] === 'p' && tag[1]) {
                        addMap.set(tag[1], { ts: ev.created_at, roles: tag.slice(2) });
                    }
                });
            });
    
            const remMap = new Map();
            removeEvents.forEach(ev => {
                ev.tags.forEach(tag => {
                    if (tag[0] === 'p' && tag[1]) {
                        remMap.set(tag[1], ev.created_at);
                    }
                });
            });
    
            this.kind9000Sets.set(publicIdentifier, addMap);
            this.kind9001Sets.set(publicIdentifier, remMap);
            
            // Use synchronous recompute to avoid timing issues
            this._recomputeGroupMembers(publicIdentifier);
    
            return this.groupMembers.get(publicIdentifier);
            
        } finally {
            // Clear building flag
            this._pendingMemberUpdates.delete(buildingKey);
        }
    }
    
    /**
     * Create a new group
     * @param {Object} groupData - Group data
     * @param {string} groupData.name - Group name
     * @param {string} groupData.about - Group description
     * @param {boolean} groupData.isPublic - Whether the group is public
     * @param {boolean} groupData.isOpen - Whether the group is open to join
     * @param {string} [groupData.authenticatedRelayUrl] - Tokenized relay URL returned by the worker
     * @param {boolean} [groupData.fileSharing] - Whether file sharing is enabled
     * @returns {Promise<Object>} - Collection of created events
     */
    async createGroup(groupData) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }
        // Get npub if not provided
        const npub = groupData.npub || NostrUtils.hexToNpub(this.user.pubkey);
        // Validate groupData
        if (!groupData.name || typeof groupData.name !== 'string') {
            throw new Error('Group name is required and must be a string');
        }
        
        // Normalize groupData to ensure all values are of the expected types
        const normalizedData = {
            name: String(groupData.name),
            about: groupData.about ? String(groupData.about) : '',
            isPublic: Boolean(groupData.isPublic),
            isOpen: Boolean(groupData.isOpen),
            identifier: groupData.identifier || null,
            proxyServer: groupData.proxyServer || '',
            proxyProtocol: groupData.proxyProtocol || 'wss',
            authenticatedRelayUrl: groupData.authenticatedRelayUrl || null,
            fileSharing: Boolean(groupData.fileSharing),
            avatar: groupData.avatar || null
        };
        
        console.log('Creating group with normalized data:', normalizedData);
        
        // Create all three events for the group creation
        const eventsCollection = await NostrEvents.createGroupCreationEvent(
            normalizedData.name,
            normalizedData.about,
            normalizedData.isPublic,
            normalizedData.isOpen,
            normalizedData.fileSharing,
            this.user.privateKey,
            normalizedData.identifier,
            normalizedData.proxyServer,
            npub,
            normalizedData.proxyProtocol,
            { avatar: normalizedData.avatar }
        );
        
        const {
            groupCreateEvent,
            metadataEvent,
            hypertunaEvent,
            groupId,
            hypertunaId
        } = eventsCollection;
        
        // Extract relay URL from hypertuna event
        const relayUrl = NostrEvents._getTagValue(hypertunaEvent, 'd');
        const finalRelayUrl = normalizedData.authenticatedRelayUrl || relayUrl;
        
        if (normalizedData.isPublic) {
            // PUBLIC RELAY: Publish to discovery relays first
            const discoveryRelays = Array.from(this.relayManager.discoveryRelays);
            
            await Promise.all([
                this.relayManager.publishToRelays(groupCreateEvent, discoveryRelays),
                this.relayManager.publishToRelays(metadataEvent, discoveryRelays),
                this.relayManager.publishToRelays(hypertunaEvent, discoveryRelays)
            ]);
            
            console.log('Published public relay events to discovery relays');
        }
        
        // Update user relay list (always goes to discovery relays)
        if (relayUrl && !normalizedData.authenticatedRelayUrl) {
            await this.updateUserRelayList(hypertunaId, relayUrl, normalizedData.isPublic, true);
        }

        // Connect to the new group relay
        if (finalRelayUrl) {
            await this.connectToGroupRelay(groupId, finalRelayUrl);

            // Publish events to the group relay itself
            await Promise.all([
                this.relayManager.publishToRelays(groupCreateEvent, [finalRelayUrl]),
                this.relayManager.publishToRelays(metadataEvent, [finalRelayUrl]),
                this.relayManager.publishToRelays(hypertunaEvent, [finalRelayUrl])
            ]);
            
            console.log('Published relay events to group relay itself');
        }
        
        // Also create and publish member and admin list events
        console.log('Creating admin and member list events');
        
        try {
            // Create admin list event
            const adminEvent = await NostrEvents.createEvent(
                NostrEvents.KIND_GROUP_ADMIN_LIST,
                `Admin list for group: ${groupData.name}`,
                [
                    ['d', groupId],
                    ['hypertuna', groupId],
                    ['p', this.user.pubkey, 'admin']
                ],
                this.user.privateKey
            );
            
            // Create member list event
            const memberEvent = await NostrEvents.createEvent(
                NostrEvents.KIND_GROUP_MEMBER_LIST,
                `Member list for group: ${groupData.name}`,
                [
                    ['d', groupId],
                    ['hypertuna', groupId],
                    ['p', this.user.pubkey, 'admin']
                ],
                this.user.privateKey
            );
            
            // Publish both events
            await Promise.all([
                this.relayManager.publish(adminEvent),
                this.relayManager.publish(memberEvent)
            ]);
            
            console.log('Admin and member list events published');
        } catch (e) {
            console.error('Error publishing admin/member events:', e);
            // Continue even if this fails
        }
        
        // Immediately store the group metadata locally
        const parsedGroup = NostrEvents.parseGroupMetadata(metadataEvent);
        if (parsedGroup) {
            this.groups.set(groupId, parsedGroup);
            this.hypertunaGroups.set(hypertunaId, groupId);
            this.groupHypertunaIds.set(groupId, hypertunaId);
        }

        // Subscribe to this group
        this.subscribeToGroup(groupId);

        if (finalRelayUrl && !normalizedData.authenticatedRelayUrl) {
            await this.updateUserRelayList(hypertunaId, finalRelayUrl, normalizedData.isPublic, true);
        }

        return eventsCollection;
    }

    _throttledRecomputeGroupMembers(groupId) {
        if (this._recomputeTimeouts && this._recomputeTimeouts[groupId]) {
            clearTimeout(this._recomputeTimeouts[groupId]);
        }
        
        if (!this._recomputeTimeouts) {
            this._recomputeTimeouts = {};
        }
        
        this._recomputeTimeouts[groupId] = setTimeout(() => {
            this._recomputeGroupMembers(groupId);
            delete this._recomputeTimeouts[groupId];
        }, 300); // 300ms debounce
    }
    
    
    /**
     * Join a group with authentication flow
     * @param {string} groupId - Group ID
     * @param {string} inviteCode - Optional invite code for closed groups
     * @param {Object} [options] - Additional join options
     * @param {boolean} [options.publish] - Whether to publish the join request
     * @param {boolean} [options.fileSharing] - Enable file sharing for this join
     * @returns {Promise<Object>} - Join request event
     */
    async joinGroup(publicIdentifier, inviteCode = null, options = {}) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }

        const { publish = true } = options;

        // This method is now only used for closed groups with an invite code.
        // The worker-driven flow handles open, authenticated joins.
        // We simply create the join request event.
        const event = await NostrEvents.createGroupJoinRequest(
            publicIdentifier,
            inviteCode,
            this.user.privateKey
        );

        if (publish) {
            // Publish the event directly to the relays
            await this.relayManager.publish(event);
        }

        return event;
    }

    /**
     * Update user relay list with authentication token
     * @param {string} publicIdentifier - Relay public identifier
     * @param {string} authenticatedUrl - Full relay URL including auth token
     * @param {string} authToken - Authentication token
     * @param {boolean|null} [isPublicOverride] - Optional override for relay publicity
     * @private
     */
    async updateUserRelayListWithAuth(publicIdentifier, authenticatedUrl, authToken, isPublicOverride = null) {
        // Get group metadata
        const group = this.groups.get(publicIdentifier);
        const groupName = group?.name || '';
        const isPublic = isPublicOverride !== null ? isPublicOverride : (group?.isPublic || false);
        
        // The authenticatedUrl is passed in directly from the worker's response,
        // which already includes the token.
        
        // Update user relay list
        if (!this.userRelayListEvent) {
            await this._createEmptyRelayList();
        }
        
        const tags = [...this.userRelayListEvent.tags];
        let contentArr = [];
        
        if (this.userRelayListEvent.content) {
            try {
                const dec = NostrUtils.decrypt(this.user.privateKey, this.user.pubkey, this.userRelayListEvent.content);
                contentArr = JSON.parse(dec);
            } catch {
                contentArr = [];
            }
        }
        
        const baseUrl = this._getBaseRelayUrl(authenticatedUrl);

        // Store only base URL in relay list
        const groupTag = ['group', publicIdentifier, baseUrl, groupName, 'hypertuna:relay'];
        const rTag = ['r', baseUrl, 'hypertuna:relay'];
        
        // Add to appropriate list
        if (isPublic) {
            tags.push(groupTag, rTag);
        } else {
            contentArr.push(groupTag, rTag);
        }

        // Create updated relay list event
        const newEvent = await NostrEvents.createUserRelayListEvent(tags, contentArr, this.user.privateKey);
        this.userRelayListEvent = newEvent;
        
        // Publish to discovery relays
        const discoveryRelays = Array.from(this.relayManager.discoveryRelays);
        await this.relayManager.publishToRelays(newEvent, discoveryRelays);
        
        console.log(`[NostrGroupClient] Updated relay list with base URL:`, baseUrl);
        
        // Connect to the authenticated relay
        await this.connectToGroupRelay(publicIdentifier, authenticatedUrl);
    }

    
    /**
     * Leave a group
     * @param {string} groupId - Group ID
     * @returns {Promise<Object>} - Leave request event
     */
    async leaveGroup(groupId) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }
        
        const event = await NostrEvents.createGroupLeaveRequest(
            groupId,
            this.user.privateKey
        );
        
        // Publish the event
        await this.relayManager.publish(event);
        
        // Remove this group from subscriptions
        this.unsubscribeFromGroup(groupId);

        const hypertunaId = this.groupHypertunaIds.get(groupId);
        const relayUrl = this.hypertunaRelayUrls.get(groupId) || '';
        const group = this.groups.get(groupId);
        const isPublic = group ? group.isPublic : true;
        if (hypertunaId && relayUrl) {
            await this.updateUserRelayList(hypertunaId, relayUrl, isPublic, false);
        }

        return event;
    }
    
    /**
     * Send a message to a group
     * @param {string} groupId - Group ID
     * @param {string} content - Message content
     * @returns {Promise<Object>} - Message event
     */
    async sendGroupMessage(groupId, content, filePath = '') {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }
        
        // Check if user is a member
        if (!this.isGroupMember(groupId, this.user.pubkey)) {
            throw new Error('You must be a member of the group to send messages');
        }
        
        // Get previous events for timeline references
        const previousMessages = this.getGroupMessages(groupId);
        const previousRefs = NostrUtils.getPreviousEventRefs(
            previousMessages,
            this.user.pubkey
        );
        
        // Prepare file attachment if provided
        const relayKey = this.publicToInternalMap.get(groupId) || null;
        let attachment = null;
        if (filePath) {
            try {
                // Build file URL using publicIdentifier (groupId)
                attachment = await prepareFileAttachment(filePath, groupId);
            } catch (err) {
                console.error('Failed to prepare file attachment:', err);
            }
        }

        // Create message event
        const { event } = await NostrEvents.createGroupMessage(
            groupId,
            content,
            previousRefs,
            this.user.privateKey,
            attachment,
            relayKey
        );
        
        // Publish only to the group's relay
        const groupRelayUrl = this.groupRelayUrls.get(groupId);
        if (groupRelayUrl) {
            await this.relayManager.publishToRelays(event, [groupRelayUrl]);
        } else {
            throw new Error('Group relay not connected');
        }
        
        return event;
    }
    
    /**
     * Create an invite code for a group
     * @param {string} groupId - Group ID
     * @returns {Promise<Object>} - Invite creation event
     */
    async createGroupInvite(groupId) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }
        
        // Check if user is an admin
        if (!this.isGroupAdmin(groupId, this.user.pubkey)) {
            throw new Error('You must be an admin to create invite codes');
        }
        
        const group = this.groups.get(groupId) || {};
        const event = await NostrEvents.createGroupInviteEvent(
            groupId,
            this.user.privateKey,
            group
        );
        
        // Publish the event
        await this.relayManager.publish(event);
        
        return event;
    }
    
    /**
     * Add a member to a group or update their role
     * @param {string} groupId - Group ID
     * @param {string} pubkey - Public key of the user to add
     * @param {Array} roles - Array of roles to assign
     * @returns {Promise<Object>} - Put user event
     */
    async addGroupMember(publicIdentifier, pubkey, roles = ['member']) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }
        
        // Check if user is an admin using public identifier
        if (!this.isGroupAdmin(publicIdentifier, this.user.pubkey)) {
            throw new Error('You must be an admin to add members');
        }
        
        // Check if there's already a pending update for this member
        const pendingKey = `${publicIdentifier}-${pubkey}`;
        if (this._pendingMemberUpdates.has(pendingKey)) {
            console.log(`Member update already pending for ${pubkey}`);
            return this._pendingMemberUpdates.get(pendingKey);
        }
        
        try {
            // Create the put user event
            const event = await NostrEvents.createPutUserEvent(
                publicIdentifier,
                pubkey,
                roles,
                this.user.privateKey
            );
            
            // Mark this update as pending
            this._pendingMemberUpdates.set(pendingKey, event);
            
            // Add this pubkey to relevant pubkeys
            this.relevantPubkeys.add(pubkey);
            
            // Update local state immediately (optimistic update)
            const addMap = this.kind9000Sets.get(publicIdentifier) || new Map();
            addMap.set(pubkey, { ts: event.created_at, roles });
            this.kind9000Sets.set(publicIdentifier, addMap);
            
            // Use throttled recompute to prevent rapid re-renders
            this._throttledRecomputeGroupMembers(publicIdentifier);
            
            // Publish the event
            await this.relayManager.publish(event);
            
            // Clear the published member lists flag to allow republishing
            this.publishedMemberLists.delete(publicIdentifier);
            
            // Wait a bit to allow any other rapid updates to complete
            await new Promise(resolve => setTimeout(resolve, 500));
            
            // Publish the updated member list only if no other updates are pending
            if (!this._recomputeTimeouts[publicIdentifier]) {
                await this.publishMemberList(publicIdentifier);
            }
            
            // Clear the pending update
            this._pendingMemberUpdates.delete(pendingKey);
            
            return event;
            
        } catch (error) {
            // Clear the pending update on error
            this._pendingMemberUpdates.delete(pendingKey);
            throw error;
        }
    }
    
    /**
     * Remove a member from a group
     * @param {string} groupId - Group ID
     * @param {string} pubkey - Public key of the user to remove
     * @returns {Promise<Object>} - Remove user event
     */
    async removeGroupMember(publicIdentifier, pubkey) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }
        
        // Check if user is an admin
        if (!this.isGroupAdmin(publicIdentifier, this.user.pubkey)) {
            throw new Error('You must be an admin to remove members');
        }
        
        const event = await NostrEvents.createRemoveUserEvent(
            publicIdentifier,
            pubkey,
            this.user.privateKey
        );

        await this.relayManager.publish(event);

        const remMap = this.kind9001Sets.get(publicIdentifier) || new Map();
        remMap.set(pubkey, event.created_at);
        this.kind9001Sets.set(publicIdentifier, remMap);
        this._recomputeGroupMembers(publicIdentifier);

        // Emit update events
        const members = this.groupMembers.get(publicIdentifier);
        this.emit('group:members', { groupId: publicIdentifier, members });
        if (this.user) {
            const isMember = members.some(m => m.pubkey === this.user.pubkey);
            this.emit('group:membership', { groupId: publicIdentifier, isMember });
        }

        // Allow republishing of the member list
        this.publishedMemberLists.delete(publicIdentifier);
        await this.publishMemberList(publicIdentifier);

        return event;
    }
    
    /**
     * Update group metadata
     * @param {string} groupId - Group ID
     * @param {Object} metadata - Updated metadata
     * @returns {Promise<Object>} - Collection of edit metadata events
     */
    async updateGroupMetadata(publicIdentifier, metadata, options = {}) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }
        
        // Check if user is an admin
        if (!this.isGroupAdmin(publicIdentifier, this.user.pubkey)) {
            throw new Error('You must be an admin to update group settings');
        }
        
        const events = await NostrEvents.createGroupMetadataEditEvents(
            publicIdentifier,
            metadata,
            this.user.privateKey,
            options
        );
        
        // Publish both events
        await Promise.all([
            this.relayManager.publish(events.editEvent),
            this.relayManager.publish(events.updatedMetadataEvent)
        ]);
        
        // Process the updated metadata event to update local state
        this._processGroupMetadataEvent(events.updatedMetadataEvent);
        
        return events;
    }
    
    /**
     * Delete a group
     * @param {string} groupId - Group ID
     * @returns {Promise<Object>} - Delete group event
     */
    async deleteGroup(groupId) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }
        
        // Check if user is an admin
        if (!this.isGroupAdmin(groupId, this.user.pubkey)) {
            throw new Error('You must be an admin to delete the group');
        }
        
        const event = await NostrEvents.createGroupDeleteEvent(
            groupId,
            this.user.privateKey
        );
        
        // Publish the event
        await this.relayManager.publish(event);

        // Remove subscriptions for this group
        this.unsubscribeFromGroup(groupId);

        const hypertunaId = this.groupHypertunaIds.get(groupId);
        const relayUrl = this.hypertunaRelayUrls.get(groupId) || '';
        const group = this.groups.get(groupId);
        const isPublic = group ? group.isPublic : true;
        if (hypertunaId && relayUrl) {
            await this.updateUserRelayList(hypertunaId, relayUrl, isPublic, false);
        }

        return event;
    }
    
    /**
     * Update user profile
     * @param {Object} profile - Profile data
     * @returns {Promise<Object>} - Profile event
     */
    async updateProfile(profile, options = {}) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }

        const event = await NostrEvents.createProfileEvent(
            profile,
            this.user.privateKey,
            options
        );
        
        // Publish the event once across all relays
        await this.relayManager.publish(event);

        // Apply the same processing path as remotely received events
        this._processProfileEvent(event);

        return event;
    }

    /**
     * Publish an updated member list for a group and notify the worker
     * @param {string} publicIdentifier - Group ID
     */
    async publishMemberList(publicIdentifier) {
        const members = this.getGroupMembers(publicIdentifier);
        if (!this.user || members.length === 0) return;

        // Track that we've published at least once but allow republishing
        this.publishedMemberLists.add(publicIdentifier);

        try {
            const event = await NostrEvents.createGroupMemberListEvent(
                publicIdentifier,
                members,
                this.user.privateKey
            );

            const relayUrl = this.groupRelayUrls.get(publicIdentifier);
            if (relayUrl) {
                await this.relayManager.publishToRelays(event, [relayUrl]);
            }

            if (isElectron) {
                const relayKey = this.publicToInternalMap.get(publicIdentifier) || null;
                const msg = {
                    type: 'update-members',
                    data: {
                        relayKey,
                        publicIdentifier,
                        members: members.map(m => m.pubkey),
                        member_adds: Array.from((this.kind9000Sets.get(publicIdentifier) || new Map()).entries()).map(([pk, info]) => ({ pubkey: pk, ts: info.ts })),
                        member_removes: Array.from((this.kind9001Sets.get(publicIdentifier) || new Map()).entries()).map(([pk, ts]) => ({ pubkey: pk, ts }))
                    }
                };
                sendWorkerMessage(msg).catch((e) => {
                    console.error('Failed to send member list to worker', e);
                });
            }
        } catch (e) {
            console.error('Error publishing member list', e);
        }
    }

    /**
     * Get all pending invites
     * @returns {Array<Object>}
     */
    getInvites() {
        return Array.from(this.invites.values());
    }

    /**
     * Remove an invite from the list
     * @param {string} inviteId
     */
    removeInvite(inviteId) {
        this.invites.delete(inviteId);
        this.emit('invites:update', { invites: this.getInvites() });
    }

    /**
     * Accept an invite and connect to the relay
     * @param {string} inviteId
     */
    async acceptInvite(inviteId) {
        const invite = this.invites.get(inviteId);
        if (!invite) throw new Error('Invite not found');

        const urlWithToken = invite.relayUrl.includes('token=') ? invite.relayUrl : `${invite.relayUrl}?token=${invite.token}`;

        await this.updateUserRelayListWithAuth(invite.publicIdentifier || invite.groupId, urlWithToken, invite.token, invite.isPublic);

        this.invites.delete(inviteId);
        this.emit('invites:update', { invites: this.getInvites() });

        return invite;
    }

    /**
     * Get pending join requests for a group
     * @param {string} groupId
     * @returns {Array<Object>}
     */
    getJoinRequests(groupId) {
        const map = this.joinRequests.get(groupId) || new Map();
        return Array.from(map.values());
    }

    /**
     * Remove a join request
     * @param {string} groupId
     * @param {string} pubkey
     */
    removeJoinRequest(groupId, pubkey) {
        const map = this.joinRequests.get(groupId);
        if (!map) return;
        map.delete(pubkey);
        if (map.size === 0) this.joinRequests.delete(groupId);
        this.emit('joinrequests:update', { groupId, requests: this.getJoinRequests(groupId) });
    }

    /**
     * Approve a join request
     * @param {string} groupId
     * @param {string} pubkey
     */
    async approveJoinRequest(groupId, pubkey) {
        const token = NostrUtils.generateInviteCode();
        await this.addGroupMember(groupId, pubkey, ['member', token]);

        const storedUrl = this.groupRelayUrls.get(groupId) || '';
        const relayUrl = this._getBaseRelayUrl(storedUrl);
        const relayKey = this.publicToInternalMap.get(groupId) || null;
        const isPublic = this.groups.get(groupId)?.isPublic || false;
        const payload = { relayUrl, token, relayKey, isPublic };
        const encrypted = NostrUtils.encrypt(this.user.privateKey, pubkey, JSON.stringify(payload));

        const group = this.groups.get(groupId) || {};
        const tags = [
            ['h', groupId],
            ['p', pubkey],
            ['i', 'hypertuna'],
            ['name', group.name || ''],
            ['about', group.about || '']
        ];
        if (group.fileSharing) {
            tags.push(['file-sharing-on']);
        } else {
            tags.push(['file-sharing-off']);
        }

        const event = await NostrEvents.createEvent(
            NostrEvents.KIND_GROUP_INVITE_CREATE,
            encrypted,
            tags,
            this.user.privateKey
        );
        const discoveryRelays = Array.from(this.relayManager.discoveryRelays);
        await this.relayManager.publishToRelays(event, discoveryRelays);

        this.removeJoinRequest(groupId, pubkey);
        return event;
    }

    /**
     * Invite multiple members to a group
     * @param {string} groupId - Group ID
     * @param {Array<string>} pubkeys - Array of pubkeys to invite
     * @returns {Promise<Array<Object>>} - Array of invite events
     */
    async inviteMembers(groupId, pubkeys = []) {
        if (!this.user || !this.user.privateKey) {
            throw new Error('User not logged in');
        }

        const group = this.groups.get(groupId);
        if (!group) {
            throw new Error('Group not found');
        }

        const isAdmin = this.isGroupAdmin(groupId, this.user.pubkey);
        const isMember = this.isGroupMember(groupId, this.user.pubkey);

        if (!isAdmin && !(group.isOpen && isMember)) {
            throw new Error('You do not have permission to invite members');
        }

        const inviteEvents = [];
        const groupRelayUrl = this.groupRelayUrls.get(groupId);

        for (const pubkey of pubkeys) {
            const token = NostrUtils.generateInviteCode();

            // ----- kind 9000: add user -----
            const putUserEvent = await NostrEvents.createPutUserEvent(
                groupId,
                pubkey,
                ['member', token],
                this.user.privateKey
            );

            if (groupRelayUrl) {
                await this.relayManager.publishToRelays(putUserEvent, [groupRelayUrl]);
            } else {
                await this.relayManager.publish(putUserEvent);
            }

            // Update local membership state
            this._processGroupAddUserEvent(putUserEvent);

            // ----- kind 9009: invite -----
            const storedUrl = this.groupRelayUrls.get(groupId) || '';
            const relayUrl = this._getBaseRelayUrl(storedUrl);
            const relayKey = this.publicToInternalMap.get(groupId) || null;
            const isPublic = this.groups.get(groupId)?.isPublic || false;
            const payload = { relayUrl, token, relayKey, isPublic };
            const encrypted = NostrUtils.encrypt(
                this.user.privateKey,
                pubkey,
                JSON.stringify(payload)
            );

            const group = this.groups.get(groupId) || {};
            const tags = [
                ['h', groupId],
                ['p', pubkey],
                ['i', 'hypertuna'],
                ['name', group.name || ''],
                ['about', group.about || '']
            ];
            if (group.fileSharing) {
                tags.push(['file-sharing-on']);
            } else {
                tags.push(['file-sharing-off']);
            }

            const inviteEvent = await NostrEvents.createEvent(
                NostrEvents.KIND_GROUP_INVITE_CREATE,
                encrypted,
                tags,
                this.user.privateKey
            );
            const discoveryRelays = Array.from(this.relayManager.discoveryRelays);
            await this.relayManager.publishToRelays(inviteEvent, discoveryRelays);

            inviteEvents.push(inviteEvent);
        }

        return inviteEvents;
    }

    /**
     * Reject a join request
     * @param {string} groupId
     * @param {string} pubkey
     */
    rejectJoinRequest(groupId, pubkey) {
        this.removeJoinRequest(groupId, pubkey);
    }

    _notifyMemberUpdate(publicIdentifier, members = null) {
        if (!isElectron) return;
        const relayKey = this.publicToInternalMap.get(publicIdentifier) || null;
        const memberList = members || this.groupMembers.get(publicIdentifier) || [];
        const msg = {
            type: 'update-members',
            data: {
                relayKey,
                publicIdentifier,
                members: memberList.map(m => m.pubkey),
                member_adds: Array.from((this.kind9000Sets.get(publicIdentifier) || new Map()).entries()).map(([pk, info]) => ({ pubkey: pk, ts: info.ts })),
                member_removes: Array.from((this.kind9001Sets.get(publicIdentifier) || new Map()).entries()).map(([pk, ts]) => ({ pubkey: pk, ts }))
            }
        };
        sendWorkerMessage(msg).catch((e) => {
            console.error('Failed to send member update to worker', e);
        });
    }

    /**
     * Cleanup and disconnect all resources
     */
    cleanup() {
        // Clear all subscriptions
        this.activeSubscriptions.forEach(subId => {
            this.relayManager.unsubscribe(subId);
        });
        this.activeSubscriptions.clear();
        
        // Clear subscription tracking
        this.subscriptionsByFilter.clear()
        
        // Clear all cached data
        this.groups.clear();
        this.groupMembers.clear();
        this.groupAdmins.clear();
        this.groupMessages.clear();
        this.groupInvites.clear();
        this.invites.clear();
        this.cachedProfiles.clear();
        this.follows.clear();
        this.relevantPubkeys.clear();
        this.hypertunaGroups.clear();
        this.groupHypertunaIds.clear();
        this.hypertunaRelayUrls.clear();
        this.userRelayIds.clear();
        this.userRelayListEvent = null;
        
        // Clear event listeners
        this.eventListeners.clear();
        this.eventCallbacks = [];
    }
    
    /**
     * Add event listener
     * @param {string} eventName - Event name
     * @param {Function} callback - Callback function
     */
    on(eventName, callback) {
        if (!this.eventListeners.has(eventName)) {
            this.eventListeners.set(eventName, []);
        }
        
        this.eventListeners.get(eventName).push(callback);
    }
    
    /**
     * Remove event listener
     * @param {string} eventName - Event name
     * @param {Function} callback - Callback function
     */
    off(eventName, callback) {
        if (!this.eventListeners.has(eventName)) {
            return;
        }
        
        const listeners = this.eventListeners.get(eventName);
        const index = listeners.indexOf(callback);
        
        if (index !== -1) {
            listeners.splice(index, 1);
        }
    }
    
    /**
     * Emit an event
     * @param {string} eventName - Event name
     * @param {Object} data - Event data
     * @private
     */
    emit(eventName, data) {
        if (!this.eventListeners.has(eventName)) {
            return;
        }
        
        const listeners = this.eventListeners.get(eventName);
        listeners.forEach(callback => {
            try {
                callback(data);
            } catch (e) {
                console.error(`Error in event listener for ${eventName}:`, e);
            }
        });
    }

    _captureGatewayMetadata(connection) {
        if (!connection || !connection.relayUrl) {
            return;
        }

        try {
            const parsed = new URL(connection.relayUrl);
            connection.gatewayPath = parsed.pathname.replace(/^\/+/, '') || null;
            connection.originalQuery = parsed.search || '';
            connection.baseHost = parsed.host;

            const token = parsed.searchParams.get('token');
            if (token) {
                connection.authToken = token;
            }

            const isManaged = this._isLoopbackHost(parsed.hostname) || (this.gatewayRuntimeHost && parsed.host === this.gatewayRuntimeHost);
            if (isManaged) {
                connection.isGatewayManaged = true;
            } else if (connection.isGatewayManaged === undefined) {
                connection.isGatewayManaged = false;
            }
        } catch (error) {
            console.warn('[NostrGroupClient] Failed to capture gateway metadata:', error);
        }
    }

    _applyAuthToken(connection, token) {
        if (!connection) return;
        connection.authToken = token;

        if (connection.relayUrl) {
            try {
                const url = new URL(connection.relayUrl);
                url.searchParams.set('token', token);
                connection.relayUrl = url.toString();
            } catch (error) {
                console.warn('[NostrGroupClient] Failed to apply auth token to URL:', error);
                const separator = connection.relayUrl.includes('?') ? '&' : '?';
                connection.relayUrl = `${connection.relayUrl}${separator}token=${token}`;
            }
        }

        this._rebuildGatewayUrl(connection);
    }

    _rebuildGatewayUrl(connection) {
        if (!connection || !connection.isGatewayManaged) {
            return;
        }
        if (!this.gatewayRuntimeBase || !connection.gatewayPath) {
            return;
        }

        try {
            const base = this.gatewayRuntimeBase.replace(/\/$/, '');
            const rebuilt = new URL(`${base}/${connection.gatewayPath}`);
            if (connection.authToken) {
                rebuilt.searchParams.set('token', connection.authToken);
            } else if (connection.originalQuery) {
                rebuilt.search = connection.originalQuery;
            }
            connection.relayUrl = rebuilt.toString();
            connection.baseHost = rebuilt.host;
        } catch (error) {
            console.warn('[NostrGroupClient] Failed to rebuild gateway URL:', error);
        }
    }

    _normalizeBaseUrl(baseUrl) {
        if (!baseUrl) return null;
        try {
            const parsed = new URL(baseUrl);
            return `${parsed.protocol}//${parsed.host}`;
        } catch (_) {
            if (typeof baseUrl !== 'string') return null;
            const trimmed = baseUrl.trim();
            if (!trimmed) return null;
            return trimmed.replace(/\/$/, '');
        }
    }

    _extractHostFromBase(base) {
        if (!base) return null;
        try {
            return new URL(base).host;
        } catch (_) {
            return base.replace(/^wss?:\/\//, '').replace(/\/$/, '');
        }
    }

    _isLoopbackHost(hostname) {
        if (!hostname) return false;
        return LOOPBACK_HOST_REGEX.test(hostname.toLowerCase());
    }
}

export default NostrGroupClient;
