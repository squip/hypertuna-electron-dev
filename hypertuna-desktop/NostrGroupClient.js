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
import ReplicationSecretManager from './ReplicationSecretManager.js';
import { getCachedPublicGatewaySettings } from '../shared/config/PublicGatewaySettings.mjs';
import EncryptedReplicationStore from './EncryptedReplicationStore.js';

const GROUP_METADATA_CACHE_KEY = 'hypertuna_group_metadata_cache_v1';

function markProfileSeed(profile) {
    if (!profile || typeof profile !== 'object') {
        return profile;
    }
    if (profile.__seed) {
        return profile;
    }
    Object.defineProperty(profile, '__seed', {
        value: true,
        enumerable: false,
        configurable: true
    });
    return profile;
}

function isSeedProfile(profile) {
    return !!(profile && profile.__seed);
}

const electronAPI = window.electronAPI || null;
const isElectron = !!electronAPI;

function sendWorkerMessage(message, options = {}) {
    if (typeof window.sendWorkerCommand === 'function') {
        return window.sendWorkerCommand(message, options);
    }
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
        this.secretSubscriptions = new Map();

        this.gatewayReady = false;
        this.connectionRetryTimers = new Map();
        this.defaultRetryDelay = 1500;
        this.maxRetryDelay = 30000;
        this._authFailureListenerRegistered = false;
        this.shutdownRequested = false;
        this.cancelled = false;
        // TODO: phase 2 – unsubscribe secret subscriptions on group leave/destroy to avoid leaks.

        // Discovery bootstrap state
        this.discoveryPending = false;
        this.discoveryBootstrapPromise = null;
        this.discoverySubscriptionsReady = false;
        this.replicationSecrets = new ReplicationSecretManager();
        this.secretSubscriptions = new Map(); // TODO: phase 2 – use secrets in replication publish/decrypt flows; unsubscribe on leave/destroy.
        this.replicationStore = typeof indexedDB !== 'undefined' ? new EncryptedReplicationStore() : null;
        this.replicationCursors = new Map();

        this._registerAuthFailureListener();

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

        this.metadataCache = new Map();
        this._loadMetadataCache();
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

    _registerAuthFailureListener() {
        if (this._authFailureListenerRegistered) {
            return;
        }

        if (!this.relayManager || typeof this.relayManager.on !== 'function') {
            return;
        }

        this.relayManager.on('auth:failed', ({ relayUrl: failedUrl }) => {
            const match = Array.from(this.groupRelayUrls.entries())
                .find(([, url]) => url === failedUrl);
            if (!match) {
                return;
            }

            const [groupId] = match;
            console.error(`[NostrGroupClient] Authentication failed for relay ${groupId}`);

            const connection = this.pendingRelayConnections.get(groupId);
            if (connection) {
                connection.status = 'pending';
                connection.attempts = (connection.attempts || 0) + 1;
                this._scheduleRelayRetry(groupId, 'auth-failed', 5000);
            }

            this.emit('relay:auth:failed', { groupId, relayUrl: failedUrl });
        });

        this._authFailureListenerRegistered = true;
    }

    _loadMetadataCache() {
        if (typeof localStorage === 'undefined') {
            return;
        }

        try {
            const raw = localStorage.getItem(GROUP_METADATA_CACHE_KEY);
            if (!raw) return;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return;
            const entries = Array.isArray(parsed.entries) ? parsed.entries : []; 
            entries.forEach((entry) => {
                if (!entry || !entry.id) return;
                this.metadataCache.set(entry.id, entry);
            });
        } catch (error) {
            console.warn('[NostrGroupClient] Failed to load group metadata cache:', error);
        }
    }

    _saveMetadataCache() {
        if (typeof localStorage === 'undefined') {
            return;
        }

        try {
            const serialized = JSON.stringify({ entries: Array.from(this.metadataCache.values()) });
            localStorage.setItem(GROUP_METADATA_CACHE_KEY, serialized);
        } catch (error) {
            console.warn('[NostrGroupClient] Failed to persist group metadata cache:', error);
        }
    }

    _cacheGroupMetadata(groupData = null) {
        if (!groupData || !groupData.id) return;

        const { event, ...rest } = groupData;
        const cached = this.metadataCache.get(groupData.id) || {};
        const nextEntry = {
            ...cached,
            ...rest,
            createdAt: groupData.createdAt || cached.createdAt || null
        };

        this.metadataCache.set(groupData.id, nextEntry);
        this._saveMetadataCache();
    }

    _hydrateCachedMetadata() {
        if (!this.metadataCache || this.metadataCache.size === 0) {
            return;
        }

        this.metadataCache.forEach((entry, groupId) => {
            if (!entry || !groupId) return;
            if (!this.groups.has(groupId)) {
                this.groups.set(groupId, entry);
            }
            if (entry.hypertunaId) {
                this.hypertunaGroups.set(entry.hypertunaId, groupId);
                this.groupHypertunaIds.set(groupId, entry.hypertunaId);
            }
        });
    }

    /**
     * Initialize the client
     * @param {Object} user - User object with privateKey and pubkey
     * @param {Array} relayUrls - Array of relay URLs to connect to
     * @returns {Promise} - Resolves when initialized
     */
    async init(user, relayUrls) {
        this.cancelled = false;
        this.shutdownRequested = false;
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
    async initWithDiscoveryRelays(user, discoveryRelays, options = {}) {
        const {
            deferDiscovery = false,
            seedProfile = null
        } = options;

        this.cancelled = false;
        this.shutdownRequested = false;
        this.user = user;
        this.relevantPubkeys.add(user.pubkey);

        // Connect only to discovery relays initially
        this._hydrateCachedMetadata();

        for (const url of discoveryRelays) {
            if (this.shutdownRequested || this.cancelled) {
                throw new Error('Discovery relay initialization cancelled');
            }
            await this.relayManager.addTypedRelay(url, 'discovery');
        }
        // Seed profile cache when supplied so UI has immediate data
        if (seedProfile && typeof seedProfile === 'object') {
            const seededProfile = {
                pubkey: user.pubkey,
                name: seedProfile.name ?? user.name ?? null,
                about: seedProfile.about ?? user.about ?? '',
                picture: seedProfile.picture ?? null,
                pictureTagUrl: seedProfile.pictureTagUrl ?? null,
                pictureIsHypertunaPfp: !!seedProfile.pictureIsHypertunaPfp
            };
            this.cachedProfiles.set(user.pubkey, markProfileSeed(seededProfile));
        } else if ((user?.name || user?.about) && !this.cachedProfiles.has(user.pubkey)) {
            const seededProfile = {
                pubkey: user.pubkey,
                name: user.name || null,
                about: user.about || ''
            };
            this.cachedProfiles.set(user.pubkey, markProfileSeed(seededProfile));
        }

        this.discoveryPending = true;

        if (deferDiscovery) {
            this.isInitialized = true;
            return this;
        }

        await this.resumeDiscovery({ force: true });
        this.isInitialized = true;
        return this;
    }

    async resumeDiscovery({ force = false } = {}) {
        if (!this.user) {
            return;
        }

        if (this.discoveryBootstrapPromise) {
            return this.discoveryBootstrapPromise;
        }

        if (!force && !this.discoveryPending) {
            return;
        }

        this.discoveryPending = true;

        this.discoveryBootstrapPromise = this._bootstrapDiscovery()
            .catch((error) => {
                this.discoveryPending = false;
                console.error('[NostrGroupClient] Discovery bootstrap failed:', error);
                throw error;
            })
            .finally(() => {
                this.discoveryBootstrapPromise = null;
                if (this.discoveryPending) {
                    this.discoveryPending = false;
                }
            });

        return this.discoveryBootstrapPromise;
    }

    async _bootstrapDiscovery() {
        if (!this.user) {
            this.discoveryPending = false;
            return;
        }

        const steps = [
            () => this.fetchUserProfile(this.user.pubkey),
            () => this.fetchUserFollows(),
            () => this.fetchUserRelayList()
        ];

        const names = ['profile', 'follows', 'relayList'];

        const results = await Promise.allSettled(steps.map((fn) => fn()));
        results.forEach((result, index) => {
            if (result.status === 'rejected') {
                console.warn(`[NostrGroupClient] Discovery step failed (${names[index]}):`, result.reason);
            }
        });

        if (!this.discoverySubscriptionsReady) {
            this._createDiscoverySubscriptions();
            this.discoverySubscriptionsReady = true;
        }

        this.discoveryPending = false;
        this.isInitialized = true;
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
        ], async (event) => {
            this.userRelayListEvent = event;
            await this._parseRelayListEvent(event);
            await this._connectToUserRelays(); // Auto-connect to user's relays
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
        ], async (event) => {
            await this._processInviteEvent(event);
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
                const decrypted = await NostrUtils.decrypt(
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
        if (this.shutdownRequested || this.cancelled) {
            return;
        }
        if (!this.pendingRelayConnections.has(publicIdentifier)) {
            this.pendingRelayConnections.set(publicIdentifier, {
                identifier: publicIdentifier,
                relayUrl,  // May be base URL; token appended once initialized
                originalUrl: relayUrl,
                attempts: 0,
                status: 'pending',
                isInitialized: false,
                isRegistered: false,
                requiresAuth: false
            });
            console.log(`[NostrGroupClient] Queued connection for relay ${publicIdentifier} with URL ${relayUrl}`);
    
            // Apply any readiness state that arrived before queueing
            if (this.relayReadyStates.has(publicIdentifier)) {
                const state = this.relayReadyStates.get(publicIdentifier);
                const connection = this.pendingRelayConnections.get(publicIdentifier);
                
                if (state.isInitialized) {
                    connection.isInitialized = true;
                    // Prefer the URL from state if it has a token
                    if (state.relayUrl && state.relayUrl.includes('?token=')) {
                        connection.relayUrl = state.relayUrl;
                    }
                }
                if (state.isRegistered) {
                    connection.isRegistered = true;
                }
                if (state.requiresAuth != null) {
                    connection.requiresAuth = !!state.requiresAuth;
                }
                if (state.authToken && !connection.relayUrl.includes('?token=')) {
                    // Append token if not already present
                    try {
                        const u = new URL(connection.relayUrl);
                        u.searchParams.set('token', state.authToken);
                        connection.relayUrl = u.toString();
                    } catch (e) {
                        console.warn('Failed to append token to URL:', e);
                    }
                }
                
                this._attemptConnectionIfReady(publicIdentifier);
            }
        }
    }

    /**
     * Handle relay initialized signal from the app layer.
     * This means the worker has started the relay instance.
     */
    handleRelayInitialized(identifier, gatewayUrl, authToken = null, metadata = {}) {
        if (this.shutdownRequested || this.cancelled) {
            return;
        }
        console.log(`[NostrGroupClient] Relay initialized signal for ${identifier}.`);
        console.log(`[NostrGroupClient] Gateway URL: ${gatewayUrl}, Has token: ${!!authToken}`);
    
        // Map internal relay keys to public identifiers if available
        let targetId = identifier;
        if (!this.pendingRelayConnections.has(targetId) && this.internalToPublicMap.has(identifier)) {
            targetId = this.internalToPublicMap.get(identifier);
            console.log(`[NostrGroupClient] Mapped internal key ${identifier} to public identifier ${targetId}`);
        }

        const requiresAuth = metadata?.requiresAuth ?? this.relayReadyStates.get(targetId)?.requiresAuth ?? false;

        // Always prefer URLs with tokens
        const connection = this.pendingRelayConnections.get(targetId);
        if (connection) {
            // Only update URL if the new one has a token or the existing one doesn't
            const newUrlHasToken = gatewayUrl && gatewayUrl.includes('?token=');
            const existingUrlHasToken = connection.relayUrl && connection.relayUrl.includes('?token=');
            
            if (newUrlHasToken || !existingUrlHasToken) {
                connection.relayUrl = gatewayUrl;
                console.log(`[NostrGroupClient] Updated relay URL for ${targetId} to: ${gatewayUrl}`);
            }
            
            connection.isInitialized = true;
            connection.requiresAuth = requiresAuth;
            if (authToken) {
                this.relayAuthTokens.set(targetId, authToken);
            }
            
            console.log(`[NostrGroupClient] Relay ${targetId} is now initialized. Checking readiness...`);
            this._clearRetryTimer(targetId);
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
            authToken: authToken || existing.authToken || null,
            requiresAuth
        });

        if (gatewayUrl) {
            this.groupRelayUrls.set(targetId, gatewayUrl);
        }
    }
    
    async _attemptConnectionIfReady(identifier) {
        if (this.shutdownRequested || this.cancelled) {
            return;
        }
        const connection = this.pendingRelayConnections.get(identifier);

        if (!connection) {
            console.log(`[NostrGroupClient] No pending connection for ${identifier} yet.`);
            return;
        }

        const state = this.relayReadyStates.get(identifier) || {};

        if (!connection.isInitialized && state.isInitialized) {
            connection.isInitialized = true;
        }
        if (!connection.isRegistered && state.isRegistered) {
            connection.isRegistered = true;
        }
        if (connection.requiresAuth == null && state.requiresAuth != null) {
            connection.requiresAuth = !!state.requiresAuth;
        }

        if (!connection.isInitialized || !connection.isRegistered) {
            console.log(`[NostrGroupClient] Relay ${identifier} not fully ready`, {
                initialized: connection.isInitialized,
                registered: connection.isRegistered
            });
            this._scheduleRelayRetry(identifier, 'relay-not-ready', 1500);
            return;
        }

        if (!this.gatewayReady) {
            console.log(`[NostrGroupClient] Gateway not ready, delaying connection for ${identifier}`);
            this._scheduleRelayRetry(identifier, 'gateway-not-ready', 1500);
            return;
        }

        const resolvedUrl = this._resolveRelayUrl(connection, identifier, state);
        if (!resolvedUrl) {
            console.log(`[NostrGroupClient] Relay URL unavailable for ${identifier}, retrying soon`);
            this._scheduleRelayRetry(identifier, 'url-unavailable', 2000);
            return;
        }

        const requiresAuth = connection.requiresAuth ?? state.requiresAuth ?? false;
        if (requiresAuth && !resolvedUrl.includes('token=')) {
            console.log(`[NostrGroupClient] Relay ${identifier} requires auth but token missing, retrying`);
            this._scheduleRelayRetry(identifier, 'missing-token', 2000);
            return;
        }

        this._clearRetryTimer(identifier);

        if (connection.status !== 'pending' && connection.status !== 'failed') {
            connection.status = 'pending';
        }

        console.log(`[NostrGroupClient] Attempting connection to ${identifier} using ${resolvedUrl}`);
        connection.status = 'connecting';

        try {
            await this.connectToGroupRelay(identifier, resolvedUrl);
            connection.status = 'connected';
            connection.attempts = 0;
            this.pendingRelayConnections.delete(identifier);
            this._clearRetryTimer(identifier);
            console.log(`[NostrGroupClient] Successfully connected to ${identifier}`);
        } catch (e) {
            console.error(`[NostrGroupClient] Connection attempt failed for ${identifier}:`, e);
            connection.status = 'pending';
            connection.attempts = (connection.attempts || 0) + 1;
            this._scheduleRelayRetry(identifier, 'connection-error');
        }
    }

    async handleRelayRegistered(identifier, details = {}) {
        if (this.shutdownRequested || this.cancelled) {
            return;
        }
        console.log(`[NostrGroupClient] Relay registered signal for ${identifier}.`, details);

        let targetId = identifier;
        if (!this.pendingRelayConnections.has(targetId) && this.internalToPublicMap.has(identifier)) {
            targetId = this.internalToPublicMap.get(identifier);
            console.log(`[NostrGroupClient] Mapped internal key ${identifier} to public identifier ${targetId}`);
        }

        const state = this.relayReadyStates.get(targetId) || {};
        const incomingUrl = details.gatewayUrl || state.relayUrl || null;
        const requiresAuth = details.requiresAuth != null ? !!details.requiresAuth : state.requiresAuth;
        const authToken = details.authToken || state.authToken || null;

        const connection = this.pendingRelayConnections.get(targetId);
        if (connection) {
            connection.isRegistered = true;
            if (incomingUrl) {
                connection.relayUrl = incomingUrl;
            }
            if (requiresAuth != null) {
                connection.requiresAuth = requiresAuth;
            }
        }

        if (!connection && incomingUrl) {
            console.log(`[NostrGroupClient] No pending connection for ${targetId}, queueing after registration.`);
            this.queueRelayConnection(targetId, incomingUrl);
        }

        if (incomingUrl) {
            this.groupRelayUrls.set(targetId, incomingUrl);
        }

        if (authToken) {
            this.relayAuthTokens.set(targetId, authToken);
        }

        // Update readiness state
        this.relayReadyStates.set(targetId, {
            ...state,
            isRegistered: true,
            relayUrl: incomingUrl || state.relayUrl || null,
            requiresAuth,
            authToken
        });

        if (authToken) {
            // Force the relay connection to use the latest tokenised URL
            const currentUrl = this.groupRelayUrls.get(targetId) || incomingUrl || state.relayUrl || (connection && connection.originalUrl) || null;
            if (currentUrl) {
                this.relayManager.removeRelay(currentUrl);
                this.queueRelayConnection(targetId, currentUrl);
            }
        }

        this._clearRetryTimer(targetId);
        this._attemptConnectionIfReady(targetId);
    }

    _resolveRelayUrl(connection, identifier, state = {}) {
        let candidate = connection.relayUrl || state.relayUrl || connection.originalUrl || null;
        if (!candidate) {
            return null;
        }

        if (candidate.includes('?token=')) {
            connection.relayUrl = candidate;
            return connection.relayUrl;
        }

        const baseUrl = this._getBaseRelayUrl(candidate);
        const authToken = this._resolveAuthToken(identifier, state);

        if (authToken) {
            const withToken = this._appendTokenToUrl(baseUrl, authToken);
            if (withToken) {
                connection.relayUrl = withToken;
                this.relayAuthTokens.set(identifier, authToken);
                return connection.relayUrl;
            }
        }

        connection.relayUrl = baseUrl;
        return connection.relayUrl;
    }

    _resolveAuthToken(identifier, state = {}) {
        if (this.relayAuthTokens.has(identifier)) {
            return this.relayAuthTokens.get(identifier);
        }
        return state.authToken || null;
    }

    _appendTokenToUrl(url, token) {
        if (!url || !token) {
            return url;
        }

        if (url.includes('token=')) {
            return url;
        }

        try {
            const u = new URL(url);
            u.searchParams.set('token', token);
            return u.toString();
        } catch (_) {
            const separator = url.includes('?') ? '&' : '?';
            return `${url}${separator}token=${token}`;
        }
    }

    _scheduleRelayRetry(identifier, reason, delayOverride) {
        if (this.shutdownRequested || this.cancelled) {
            return;
        }
        const connection = this.pendingRelayConnections.get(identifier);
        if (!connection) {
            return;
        }

        const attempts = connection.attempts || 0;
        const delay = delayOverride != null
            ? Math.max(0, delayOverride)
            : Math.min(this.maxRetryDelay, this.defaultRetryDelay * Math.max(1, attempts + 1));

        this._clearRetryTimer(identifier);

        console.log(`[NostrGroupClient] Scheduling retry for ${identifier} in ${delay}ms (${reason})`);

        const timer = setTimeout(() => {
            if (this.shutdownRequested || this.cancelled) {
                this.connectionRetryTimers.delete(identifier);
                return;
            }
            this.connectionRetryTimers.delete(identifier);
            if (!this.pendingRelayConnections.has(identifier)) {
                return;
            }
            this._attemptConnectionIfReady(identifier);
        }, delay);

        this.connectionRetryTimers.set(identifier, timer);
    }

    _clearRetryTimer(identifier) {
        const timer = this.connectionRetryTimers.get(identifier);
        if (timer) {
            clearTimeout(timer);
            this.connectionRetryTimers.delete(identifier);
        }
    }

    setGatewayReady(isReady) {
        const ready = !!isReady;
        if (this.gatewayReady === ready) {
            return;
        }

        this.gatewayReady = ready;

        if (ready) {
            console.log('[NostrGroupClient] Gateway reported ready – retrying pending relay connections');
            for (const identifier of this.pendingRelayConnections.keys()) {
                this._scheduleRelayRetry(identifier, 'gateway-ready', 0);
            }
        } else {
            console.log('[NostrGroupClient] Gateway became unavailable – deferring relay connection attempts');
        }
    }


    /**
     * Handle all relays ready notification
     */
    handleAllRelaysReady() {
        if (this.shutdownRequested || this.cancelled) {
            return;
        }
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
        if (this.shutdownRequested || this.cancelled) {
            return;
        }
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
                if (state.requiresAuth != null) {
                    connection.requiresAuth = !!state.requiresAuth;
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
        if (this.shutdownRequested || this.cancelled) {
            throw new Error('NostrGroupClient shutting down');
        }
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
            const defaultProfile = markProfileSeed({
                name: `User_${NostrUtils.truncatePubkey(pubkey)}`,
                pubkey
            });
            profilesMap.set(pubkey, defaultProfile);
            if (!this.cachedProfiles.has(pubkey)) {
                this.cachedProfiles.set(pubkey, defaultProfile);
            }
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

            const timeoutId = setTimeout(() => {
                this.relayManager.unsubscribe(subId);
                if (!received) {
                    console.warn('[NostrGroupClient] Relay list fetch timed out; using stored state');
                    this.relayListLoaded = true;
                    this.emit('relaylist:update', { ids: Array.from(this.userRelayIds) });
                }
                resolve();
            }, 5000);

            this.relayManager.subscribe(subId, [
                { kinds: [NostrEvents.KIND_USER_RELAY_LIST], authors: [this.user.pubkey], limit: 1 }
            ], async (event) => {
                received = true;
                clearTimeout(timeoutId);
                this.relayManager.unsubscribe(subId);
                this.userRelayListEvent = event;
                await this._parseRelayListEvent(event);
                resolve();
            });
        });
    }

    async _parseRelayListEvent(event) {
        const ids = new Set(this.userRelayIds);
        if (!event) {
            this.userRelayIds = ids;
            this.relayListLoaded = true;
            this.emit('relaylist:update', { ids: Array.from(this.userRelayIds) });
            return;
        }

        event.tags.forEach(t => {
            if (t[0] === 'group' && t[1] && t[t.length - 1] === 'hypertuna:relay') {
                ids.add(t[1]);
            }
        });

        if (event.content) {
            let decoded = null;
            try {
                decoded = await NostrUtils.decrypt(this.user.privateKey, this.user.pubkey, event.content);
            } catch (e) {
                try {
                    decoded = event.content;
                } catch (_) {}
            }

            if (decoded) {
                try {
                    const arr = JSON.parse(decoded);
                    arr.forEach(t => {
                        if (Array.isArray(t) && t[0] === 'group' && t[1] && t[t.length - 1] === 'hypertuna:relay') {
                            ids.add(t[1]);
                        }
                    });
                } catch (_) {}
            }
        }

        this.userRelayIds = ids;
        this.relayListLoaded = true;
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

    async ingestStoredRelays(relayEntries = []) {
        if (!Array.isArray(relayEntries)) {
            return;
        }

        if (relayEntries.length === 0) {
            if (!this.relayListLoaded) {
                this.relayListLoaded = true;
                this.emit('relaylist:update', { ids: Array.from(this.userRelayIds) });
            }
            return;
        }

        const publicTags = [];
        const privateTags = [];
        let shouldPublishSnapshot = false;

        for (const relay of relayEntries) {
            if (!relay) continue;
            const identifier = relay.publicIdentifier || relay.relayKey;
            if (!identifier) continue;

            const isGatewayReplica = relay.isGatewayReplica === true
                || (relay.metadata && relay.metadata.isGatewayReplica === true)
                || identifier === 'public-gateway:hyperbee';
            if (isGatewayReplica || !relay.publicIdentifier) {
                continue;
            }

            const requiresAuth = typeof relay.requiresAuth === 'boolean' ? relay.requiresAuth : false;
            const connectionUrl = relay.connectionUrl || relay.gatewayUrl || null;
            const baseUrl = connectionUrl ? this._getBaseRelayUrl(connectionUrl) : null;
            const relayName = relay.name || '';
            const authToken = relay.userAuthToken || relay.authToken || null;

            this.userRelayIds.add(identifier);
            if (connectionUrl) {
                this.groupRelayUrls.set(identifier, connectionUrl);
            }

            if (authToken) {
                this.relayAuthTokens.set(identifier, authToken);
            }

            const readiness = this.relayReadyStates.get(identifier) || {};
            this.relayReadyStates.set(identifier, {
                ...readiness,
                isInitialized: true,
                isRegistered: true,
                relayUrl: connectionUrl || readiness.relayUrl || null,
                requiresAuth,
                authToken: authToken || readiness.authToken || null
            });

            if (!this.pendingRelayConnections.has(identifier)) {
                if (connectionUrl) {
                    this.queueRelayConnection(identifier, connectionUrl);
                } else if (baseUrl) {
                    this.queueRelayConnection(identifier, baseUrl);
                }
            } else {
                const connection = this.pendingRelayConnections.get(identifier);
                if (connection) {
                    connection.isInitialized = true;
                    connection.isRegistered = true;
                    connection.requiresAuth = requiresAuth;
                    if (connectionUrl) {
                        connection.relayUrl = connectionUrl;
                    }
                }
            }

            if (baseUrl) {
                const groupTag = ['group', identifier, baseUrl, relayName, 'hypertuna:relay'];
                const rTag = ['r', baseUrl, 'hypertuna:relay'];
                publicTags.push(groupTag, rTag);
                if (requiresAuth) {
                    privateTags.push(groupTag, rTag);
                }
                shouldPublishSnapshot = true;
            }
        }

        this.relayListLoaded = true;
        this.emit('relaylist:update', { ids: Array.from(this.userRelayIds) });

        if (!this.user || !this.user.privateKey || !shouldPublishSnapshot) {
            return;
        }

        const existingIdsCount = Array.isArray(this.userRelayListEvent?.tags)
            ? this.userRelayListEvent.tags.filter(tag => tag[0] === 'group' && tag[tag.length - 1] === 'hypertuna:relay').length
            : 0;

        const needsSnapshot =
            !this.userRelayListEvent ||
            (!existingIdsCount && (publicTags.length || privateTags.length));

        if (needsSnapshot) {
            try {
                const snapshotEvent = await NostrEvents.createUserRelayListEvent(publicTags, privateTags, this.user.privateKey);
                this.userRelayListEvent = snapshotEvent;
                const rawDiscovery = this.relayManager?.discoveryRelays;
                const discoveryRelays = rawDiscovery
                    ? (Array.isArray(rawDiscovery) ? rawDiscovery : Array.from(rawDiscovery))
                    : [];
                if (discoveryRelays.length) {
                    await this.relayManager.publishToRelays(snapshotEvent, discoveryRelays);
                }
                console.log('[NostrGroupClient] Published relay list snapshot derived from stored relays');
            } catch (error) {
                console.warn('[NostrGroupClient] Failed to publish relay list snapshot:', error);
            }
        }
    }

    async updateUserRelayList(publicIdentifier, gatewayUrl, isPublic, add = true) {
        if (!this.userRelayListEvent) {
            await this._createEmptyRelayList();
        }
    
        const tags = [...this.userRelayListEvent.tags];
        let contentArr = [];
        if (this.userRelayListEvent.content) {
            try {
                const dec = await NostrUtils.decrypt(this.user.privateKey, this.user.pubkey, this.userRelayListEvent.content);
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
        ], async (event) => {
            this.userRelayListEvent = event;
            await this._parseRelayListEvent(event);
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

        this._subscribeToReplicationFallback(groupId);
        // Replay any cached replication events for this group
        this._replayReplicationCache(groupId).catch((err) => {
            console.warn('[NostrGroupClient] replay replication cache failed', err?.message || err);
        });
    }

    async _subscribeToReplicationFallback(groupId) {
        try {
            if (!this.replicationStore) return;
            const group = this.getGroupById(groupId) || {};
            if (group.encryptedReplication === false) return;
            const secret = this.replicationSecrets.getSecret(groupId);
            if (!secret) return;

            const relayHash = await NostrUtils.computeRelayHash(groupId);
            const gatewayUrl = this._getGatewayRelayUrl(groupId);
            if (!gatewayUrl) return;

            const subId = `repl-${groupId.substring(0, 8)}`;
            if (this.activeSubscriptions.has(subId)) return;

            const filters = [{
                relayID: relayHash
            }];

            const actualSubId = this.relayManager.subscribeWithRouting(
                subId,
                filters,
                async (event) => {
                    await this.ingestReplicationEvents(groupId, [event]);
                },
                { targetRelays: [gatewayUrl], suppressGlobalEvents: true }
            );

            this.activeSubscriptions.add(actualSubId);
            this._trackSubscription(groupId, actualSubId, filters);
            // Initial broad fetch
            this._fetchReplicationSnapshot(groupId).catch((err) => {
                console.warn('[NostrGroupClient] replication snapshot fetch failed', err?.message || err);
            });
        } catch (err) {
            console.warn('[NostrGroupClient] replication fallback subscribe failed', err?.message || err);
        }
    }

    async _fetchReplicationSnapshot(groupId) {
        if (!this.replicationStore) return;
        const relayHash = await NostrUtils.computeRelayHash(groupId);
        const gatewayUrl = this._getGatewayRelayUrl(groupId);
        if (!gatewayUrl) return;
        const since = this._getReplicationCursor(groupId) || 0;
        const subId = `repl-snap-${groupId.substring(0, 8)}-${Date.now()}`;
        const filters = [{ relayID: relayHash, since }];
        const collected = [];

        const handler = async (event) => {
            collected.push(event);
        };

        this.relayManager.subscribeWithRouting(subId, filters, handler, { targetRelays: [gatewayUrl], suppressGlobalEvents: true });

        await new Promise((resolve) => setTimeout(resolve, 2000));
        this.relayManager.unsubscribe(subId);

        if (collected.length) {
            await this.ingestReplicationEvents(groupId, collected);
        }
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
                this._parseRelayListEvent(event).catch((err) => {
                    console.error('Failed to parse relay list event', err);
                });
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
    async _processInviteEvent(event) {
        const groupId = NostrEvents._getTagValue(event, 'h');
        if (!groupId) return;

        try {
            const dec = await NostrUtils.decrypt(this.user.privateKey, event.pubkey, event.content);
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
        this._subscribeToReplicationFallback(groupId);
        
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
    async fetchUserProfile(pubkey, options = {}) {
        const { forceRefresh = false } = options;

        // Check cache first
        if (this.cachedProfiles.has(pubkey)) {
            const cachedProfile = this.cachedProfiles.get(pubkey);
            if (!forceRefresh && !isSeedProfile(cachedProfile)) {
                console.log(`Using cached profile for ${pubkey.substring(0, 8)}...`, cachedProfile);
                return cachedProfile;
            }
            if (!forceRefresh && isSeedProfile(cachedProfile)) {
                console.log(`Cached profile for ${pubkey.substring(0, 8)} is placeholder, refreshing...`);
            }
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
                const defaultProfile = markProfileSeed({ 
                    name: `User_${NostrUtils.truncatePubkey(pubkey)}`,
                    pubkey
                });
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
            avatar: groupData.avatar || null,
            encryptedReplicationEnabled: groupData.encryptedReplicationEnabled !== false
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
            {
                avatar: normalizedData.avatar,
                encryptedReplicationEnabled: normalizedData.encryptedReplicationEnabled
            }
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
        const relayUrlForList = this._getBaseRelayUrl(
            normalizedData.authenticatedRelayUrl || finalRelayUrl || relayUrl
        );
        
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
        if (relayUrlForList) {
            await this.updateUserRelayList(hypertunaId, relayUrlForList, normalizedData.isPublic, true);
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

        return eventsCollection;
    }

    ensureSecretSubscription(relayId) {
        if (!relayId || !this.user?.privateKey) return null;
        if (this.secretSubscriptions.has(relayId)) return this.secretSubscriptions.get(relayId);

        const subscriptionId = `secret-${relayId}`;
        const filters = [{
            kinds: [30078],
            '#h': [relayId],
            '#p': [this.user.pubkey]
        }];

        const handler = async (event) => {
            try {
                const secret = await NostrUtils.decrypt(this.user.privateKey, event.pubkey, event.content);
                if (secret) {
                    this.replicationSecrets.setSecret(relayId, secret, (event.created_at || 0) * 1000);
                    // Mirror the secret envelope into replication dataset so web/gateway can recover offline.
                    this._publishSecretReplicationEnvelope(relayId, event).catch((err) => {
                        console.warn('[NostrGroupClient] secret replication mirror failed', err?.message || err);
                    });
                }
            } catch (_) {
                // ignore decrypt failures
            }
        };

        const gatewayUrl = this._getGatewayRelayUrl(relayId);
        if (gatewayUrl) {
            this.relayManager.subscribeWithRouting(subscriptionId, filters, handler, { targetRelays: [gatewayUrl] });
        } else {
            this.relayManager.subscribe(subscriptionId, filters, handler);
        }

        this.secretSubscriptions.set(relayId, subscriptionId);
        // Best-effort snapshot fetch so secrets are available when no peers are online.
        this._fetchSecretSnapshot(relayId).catch((err) => {
            console.warn('[NostrGroupClient] secret snapshot fetch failed', err?.message || err);
        });
        return subscriptionId;
    }

    async _fetchSecretSnapshot(relayId) {
        if (!relayId || !this.user?.privateKey) return;
        const gatewayUrl = this._getGatewayRelayUrl(relayId);
        if (!gatewayUrl) return;
        const subId = `secret-snap-${relayId.substring(0, 8)}-${Date.now()}`;
        const filters = [{
            kinds: [30078],
            '#h': [relayId],
            '#p': [this.user.pubkey],
            limit: 1
        }];

        return new Promise((resolve) => {
            const handler = async (event) => {
                try {
                    const secret = await NostrUtils.decrypt(this.user.privateKey, event.pubkey, event.content);
                    if (secret) {
                        this.replicationSecrets.setSecret(relayId, secret, (event.created_at || 0) * 1000);
                        this._publishSecretReplicationEnvelope(relayId, event).catch((err) => {
                            console.warn('[NostrGroupClient] secret replication mirror failed', err?.message || err);
                        });
                        if (this.telemetry) {
                            this.telemetry.secretSnapshots = (this.telemetry.secretSnapshots || 0) + 1;
                        }
                    }
                } catch (_) {
                    // ignore
                }
            };

            this.relayManager.subscribeWithRouting(subId, filters, async (event) => {
                await handler(event);
                this.relayManager.unsubscribe(subId);
                resolve();
            }, { targetRelays: [gatewayUrl], suppressGlobalEvents: true });

            // Timeout safety
            setTimeout(() => {
                this.relayManager.unsubscribe(subId);
                resolve();
            }, 4000);
        });
    }

    async publishReplicationEvent(event, relayId) {
        try {
            const group = this.getGroupById(relayId) || {};
            if (group.encryptedReplication === false) return;

            const secret = this.replicationSecrets.getSecret(relayId);
            if (!secret) return;

            const relayHash = await NostrUtils.computeRelayHash(relayId);
            const gatewayUrl = this._getGatewayRelayUrl(relayId);
            if (!gatewayUrl) return;

            const fileKey = event.tags?.find((t) => t[0] === 'filekey')?.[1] || null;
            const driveKey = event.tags?.find((t) => t[0] === 'drivekey')?.[1] || null;
            const ciphertext = await this._encryptReplicationPayload(event, secret);
            if (!ciphertext) return;

            const replicationEvent = {
                id: event.id,
                relayID: relayHash,
                kind: event.kind,
                created_at: event.created_at,
                fileKey: fileKey || undefined,
                driveKey: driveKey || undefined,
                eventData: ciphertext
            };

            await this.relayManager.publishToRelays(replicationEvent, [gatewayUrl]);
        } catch (err) {
            console.warn('[NostrGroupClient] publishReplicationEvent error', err?.message || err);
        }
    }

    _getGatewayRelayUrl(relayId) {
        try {
            const settings = getCachedPublicGatewaySettings();
            const base = settings?.baseUrl || settings?.preferredBaseUrl || 'https://hypertuna.com';
            const token = this.relayAuthTokens.get(relayId) || null;
            const url = base.replace(/\/$/, '') + '/relay';
            if (token) {
                return this._appendTokenToUrl(url, token);
            }
            return url;
        } catch (err) {
            console.warn('[NostrGroupClient] Failed to build gateway relay URL', err?.message || err);
            return null;
        }
    }

    async _encryptReplicationPayload(event, secret) {
        try {
            const payload = JSON.stringify(event);
            const keyBytes = this._deriveAesKeyBytes(secret);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
            const enc = new TextEncoder();
            const cipherBuf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(payload));
            const combined = new Uint8Array(iv.byteLength + cipherBuf.byteLength);
            combined.set(iv, 0);
            combined.set(new Uint8Array(cipherBuf), iv.byteLength);
            return btoa(String.fromCharCode(...combined));
        } catch (err) {
            console.warn('[NostrGroupClient] Encrypt replication payload failed', err?.message || err);
            return null;
        }
    }

    _deriveAesKeyBytes(secret) {
        const enc = new TextEncoder();
        const bytes = enc.encode(typeof secret === 'string' ? secret : String(secret));
        if (bytes.length >= 32) return bytes.slice(0, 32);
        const out = new Uint8Array(32);
        out.set(bytes);
        return out;
    }

    async _publishSecretReplicationEnvelope(relayId, secretEvent) {
        try {
            if (!relayId || !secretEvent) return;
            const group = this.getGroupById(relayId) || {};
            if (group.encryptedReplication === false) return;
            const gatewayUrl = this._getGatewayRelayUrl(relayId);
            if (!gatewayUrl) return;
            const relayHash = await NostrUtils.computeRelayHash(relayId);
            const eventData = btoa(JSON.stringify(secretEvent));
            const replicationEvent = {
                id: secretEvent.id,
                relayID: relayHash,
                kind: secretEvent.kind || 30078,
                created_at: secretEvent.created_at,
                eventData
            };
            await this.relayManager.publishToRelays(replicationEvent, [gatewayUrl]);
        } catch (error) {
            console.warn('[NostrGroupClient] _publishSecretReplicationEnvelope failed', error?.message || error);
        }
    }

    async _decryptReplicationPayload(ciphertext, secret) {
        try {
            const buf = Uint8Array.from(atob(ciphertext), c => c.charCodeAt(0));
            const iv = buf.slice(0, 12);
            const data = buf.slice(12);
            const keyBytes = this._deriveAesKeyBytes(secret);
            const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
            const plainBuf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
            const dec = new TextDecoder();
            return JSON.parse(dec.decode(plainBuf));
        } catch (err) {
            console.warn('[NostrGroupClient] Decrypt replication payload failed', err?.message || err);
            return null;
        }
    }

    async ingestReplicationEvents(relayId, events = []) {
        if (!Array.isArray(events) || !events.length) return;
        const secret = this.replicationSecrets.getSecretForTimestamp(relayId, Date.now());
        const decrypted = [];
        for (const ev of events) {
            if (!ev?.eventData) continue;
            if (ev.relayID && ev.relayID !== relayId) continue;
            if (ev.kind === 30078) {
                // Secret envelopes mirrored as-is (already encrypted per member)
                try {
                    const raw = atob(ev.eventData);
                    const parsed = JSON.parse(raw);
                    const secretValue = await NostrUtils.decrypt(this.user?.privateKey, parsed.pubkey, parsed.content);
                    if (secretValue) {
                        this.replicationSecrets.setSecret(relayId, secretValue, (parsed.created_at || ev.created_at || 0) * 1000);
                    }
                } catch (error) {
                    console.warn('[NostrGroupClient] replication secret ingest failed', error?.message || error);
                }
                continue;
            }
            if (!secret) continue;
            const plain = await this._decryptReplicationPayload(ev.eventData, secret);
            if (plain) {
                decrypted.push({
                    ...plain,
                    relayId,
                    replicated_at: ev.created_at
                });
            }
        }
        if (this.replicationStore && decrypted.length) {
            await this.replicationStore.putEvents(relayId, decrypted);
            const maxTs = decrypted.reduce((acc, ev) => Math.max(acc, Number(ev.created_at || 0)), this._getReplicationCursor(relayId) || 0);
            this._setReplicationCursor(relayId, maxTs);
            await this._replayReplicationCache(relayId);
        }
    }

    _getReplicationCursor(relayId) {
        return this.replicationCursors.get(relayId) || 0;
    }

    _setReplicationCursor(relayId, ts) {
        if (!relayId || !Number.isFinite(ts)) return;
        this.replicationCursors.set(relayId, Math.max(0, Math.floor(ts)));
    }

    async _replayReplicationCache(relayId, opts = {}) {
        if (!this.replicationStore) return;
        const since = this._getReplicationCursor(relayId) || 0;
        const filters = {
            since,
            until: opts.until || 9999999999,
            kinds: opts.kinds || null
        };
        const cached = await this.replicationStore.getEvents(relayId, filters);
        for (const ev of cached) {
            // Basic filter: ensure group tag matches
            const hTag = Array.isArray(ev.tags) ? ev.tags.find(t => t[0] === 'h') : null;
            if (hTag && hTag[1] === relayId) {
                if (ev.kind === NostrEvents.KIND_TEXT_NOTE) {
                    this._processGroupMessageEvent(ev);
                } else {
                    this._processContentEvent(ev);
                }
            }
        }
        if (cached.length) {
            const maxTs = cached.reduce((acc, ev) => Math.max(acc, Number(ev.created_at || 0)), since);
            this._setReplicationCursor(relayId, maxTs);
        }
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
                const dec = await NostrUtils.decrypt(this.user.privateKey, this.user.pubkey, this.userRelayListEvent.content);
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

        // Best-effort replication publish to gateway Hyperbee
        this.publishReplicationEvent(event, groupId).catch((err) => {
            console.warn('[NostrGroupClient] Replication publish failed', err?.message || err);
        });
        
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
        const encrypted = await NostrUtils.encrypt(this.user.privateKey, pubkey, JSON.stringify(payload));

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
            const encrypted = await NostrUtils.encrypt(
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

    cancelPending(reason = 'cancelled') {
        console.log(`[NostrGroupClient] Cancelling pending operations (${reason})`);
        this.cancelled = true;
        this.pendingRelayConnections.forEach((connection) => {
            connection.status = 'cancelled';
        });
        this.pendingRelayConnections.clear();

        this.connectionRetryTimers.forEach((timer) => clearTimeout(timer));
        this.connectionRetryTimers.clear();

        if (this.relayManager && typeof this.relayManager.cancelAllReconnects === 'function') {
            this.relayManager.cancelAllReconnects();
        }

        Object.values(this._recomputeTimeouts || {}).forEach(timer => clearTimeout(timer));
        this._recomputeTimeouts = {};

        if (this._pendingMemberUpdates && typeof this._pendingMemberUpdates.forEach === 'function') {
            this._pendingMemberUpdates.forEach((timer) => clearTimeout(timer));
            this._pendingMemberUpdates.clear();
        }
    }

    shutdown({ clearState = false } = {}) {
        if (this.shutdownRequested) {
            return;
        }
        console.log('[NostrGroupClient] Shutdown requested');
        this.shutdownRequested = true;
        this.cancelled = true;
        this.cancelPending('shutdown');

        if (this.relayManager && typeof this.relayManager.shutdown === 'function') {
            this.relayManager.shutdown({ clearSubscriptions: true });
        }

        if (clearState) {
            this.user = null;
            this.isInitialized = false;
            this.userRelayListEvent = null;
            this.groups.clear();
            this.groupMembers.clear();
            this.groupAdmins.clear();
            this.groupMessages.clear();
            this.groupInvites.clear();
            this.invites.clear();
            this.joinRequests.clear();
            this.groupSubscriptions.clear();
            this.subscriptionsByFilter.clear();
            this.relayReadyStates.clear();
            this.relayAuthTokens.clear();
            this.publicToInternalMap.clear();
            this.internalToPublicMap.clear();
            this.relayConnectionAttempts.clear();
            this.pendingRelayConnections.clear();
            this.follows.clear();
            this.relevantPubkeys.clear();
            this.userRelayIds.clear();
            this.eventListeners.clear();
            this.eventCallbacks = [];
        }
    }
}

export default NostrGroupClient;
