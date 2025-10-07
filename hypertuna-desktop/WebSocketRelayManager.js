/**
 * WebSocketRelayManager.js
 * Handles connections to nostr relays and their lifecycle
 */

class WebSocketRelayManager {
    constructor() {
        this.relays = new Map();
        this.globalSubscriptions = new Map();
        this.eventCallbacks = [];
        this.connectCallbacks = [];
        this.eventListeners = new Map(); // NEW: For generic event listeners
        this.disconnectCallbacks = [];
        
        // Add rate limiting
        this.requestQueue = [];
        this.processingQueue = false;
        this.lastRequestTime = 0;
        this.minTimeBetweenRequests = 50;
        this.relayTypes = new Map();
        this.groupRelays = new Map();
        this.discoveryRelays = new Set();
        this.reconnectTimers = new Set();
        this.shutdownRequested = false;

        // NEW: Add subscription ID counter and mapping
        this.subscriptionCounter = 0;
        this.subscriptionIdMap = new Map(); // Maps original ID to unique short ID
        this.reverseSubscriptionMap = new Map(); // Maps short ID back to original
    }

    /**
     * Generate a unique short subscription ID
     * @param {string} subscriptionId - The original subscription ID
     * @returns {string} - A unique short subscription ID
     * @private
     */
    _generateUniqueShortId(subscriptionId) {
        // Check if we already have a mapping for this subscription
        if (this.subscriptionIdMap.has(subscriptionId)) {
            return this.subscriptionIdMap.get(subscriptionId);
        }
        
        // Generate a new unique short ID
        this.subscriptionCounter++;
        const shortId = `sub${this.subscriptionCounter}`;
        
        // Store the bidirectional mapping
        this.subscriptionIdMap.set(subscriptionId, shortId);
        this.reverseSubscriptionMap.set(shortId, subscriptionId);
        
        console.log(`Mapped subscription: ${subscriptionId} -> ${shortId}`);
        
        return shortId;
    }

    /**
     * Get the original subscription ID from a short ID
     * @param {string} shortId - The short subscription ID
     * @returns {string|null} - The original subscription ID or null
     * @private
     */
    _getOriginalSubscriptionId(shortId) {
        return this.reverseSubscriptionMap.get(shortId) || null;
    }

    /**
     * Clean up subscription mappings when unsubscribing
     * @param {string} subscriptionId - The original subscription ID
     * @private
     */
    _cleanupSubscriptionMappings(subscriptionId) {
        const shortId = this.subscriptionIdMap.get(subscriptionId);
        if (shortId) {
            this.subscriptionIdMap.delete(subscriptionId);
            this.reverseSubscriptionMap.delete(shortId);
        }
    }

    /**
     * Add a relay with a specific type
     * @param {string} url - The relay URL
     * @param {string} type - The relay type ('discovery' or 'group')
     * @param {string} groupId - Optional group ID for group relays
     */
    async addTypedRelay(url, type = 'discovery', groupId = null) {
        const { cleanUrl } = this.parseRelayUrl(url);

        // Store the type using the normalized URL (without query params)
        this.relayTypes.set(cleanUrl, type);

        if (type === 'discovery') {
            this.discoveryRelays.add(cleanUrl);
        } else if (type === 'group' && groupId) {
            this.groupRelays.set(groupId, cleanUrl);
        }
        
        console.log(`Adding ${type} relay: ${url}${groupId ? ' for group ' + groupId : ''}`);
        
        try {
            await this.addRelay(url);
        } catch (error) {
            // Clean up on failure
            this.relayTypes.delete(cleanUrl);
            if (type === 'discovery') {
                this.discoveryRelays.delete(cleanUrl);
            } else if (type === 'group' && groupId) {
                this.groupRelays.delete(groupId);
            }
            throw error;
        }
    }

    /**
     * Subscribe with relay routing
     * @param {string} subscriptionId - Subscription ID
     * @param {Array} filters - Filters
     * @param {Function} callback - Callback
     * @param {Object} options - Options including targetRelays
     */
    subscribeWithRouting(subscriptionId, filters, callback, options = {}) {
        const { targetRelays = null, suppressGlobalEvents = false } = options;

        const normalizedTargets = targetRelays && targetRelays.length > 0
            ? targetRelays.map(r => this.parseRelayUrl(r).cleanUrl)
            : null;
        
        // Generate unique short ID for this subscription
        const shortSubId = this._generateUniqueShortId(subscriptionId);
        
        if (normalizedTargets && normalizedTargets.length > 0) {
            this.globalSubscriptions.set(subscriptionId, {
                shortId: shortSubId,
                filters,
                callbacks: callback ? [callback] : [],
                suppressGlobalEvents,
                targetRelays: normalizedTargets
            });

            normalizedTargets.forEach(relayUrl => {
                if (this.relays.has(relayUrl) && this.relays.get(relayUrl).status === 'open') {
                    this._subscribeOnRelay(relayUrl, subscriptionId, filters);
                }
            });
            
            return subscriptionId;
        }
        
        return this.subscribe(subscriptionId, filters, callback, options);
    }

    /**
     * Publish to specific relays only
     * @param {Object} event - The event to publish
     * @param {Array} targetRelays - Optional array of specific relay URLs
     */
    async publishToRelays(event, targetRelays = null) {
        if (targetRelays && targetRelays.length > 0) {
            // Only publish to specified relays
            const normalizedTargets = targetRelays.map(u => this.parseRelayUrl(u).cleanUrl);
            const publishPromises = normalizedTargets.map(url => {
                if (this.relays.has(url) && this.relays.get(url).status === 'open') {
                    return this._publishToSingleRelay(event, url);
                }
                return Promise.resolve({ url, success: false, error: 'Relay not connected' });
            });
            
            return Promise.allSettled(publishPromises);
        }
        
        // Otherwise use normal publish
        return this.publish(event);
    }

    /**
     * Helper to publish to a single relay
     */
    async _publishToSingleRelay(event, relayUrl) {
        const { cleanUrl } = this.parseRelayUrl(relayUrl);
        const relay = this.relays.get(cleanUrl);
        if (!relay || relay.status !== 'open') {
            return { url: cleanUrl, success: false, error: 'Relay not connected' };
        }
        
        const eventMsg = JSON.stringify(['EVENT', event]);
        
        return new Promise((resolve) => {
            const timeout = setTimeout(() => {
                resolve({ url: cleanUrl, success: false, error: 'Timeout' });
            }, 10000);
            
            const okHandler = (msgEvent) => {
                try {
                    const data = JSON.parse(msgEvent.data);
                    if (Array.isArray(data) && data[0] === 'OK' && data[1] === event.id) {
                        clearTimeout(timeout);
                        relay.conn.removeEventListener('message', okHandler);
                        resolve({ url: cleanUrl, success: data[2] === true });
                    }
                } catch (e) {
                    // Ignore parse errors
                }
            };
            
            relay.conn.addEventListener('message', okHandler);
            
            this._queueRequest(() => {
                if (relay.conn.readyState === WebSocket.OPEN) {
                    relay.conn.send(eventMsg);
                }
            });
        });
    }

    parseRelayUrl(relayUrl) {
        try {
            const url = new URL(relayUrl);
            const token = url.searchParams.get('token');

            // Create a clean URL without any search params to use as a map key.
            // This prevents issues with URLs containing '?' but no token.
            const cleanUrl = `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}${url.pathname}`;

            return {
                cleanUrl: cleanUrl,
                token: token
            };
        } catch (e) {
            console.error('Error parsing relay URL:', e);
            return {
                cleanUrl: relayUrl,
                token: null
            };
        }
    }

    /**
     * Register an event listener for custom events.
     * @param {string} eventName - The name of the event to listen for.
     * @param {Function} callback - The callback function to execute when the event is emitted.
     */
    on(eventName, callback) {
        if (typeof callback !== 'function') {
            console.warn(`[WebSocketRelayManager] Callback for event '${eventName}' is not a function.`);
            return;
        }
        if (!this.eventListeners.has(eventName)) {
            this.eventListeners.set(eventName, []);
        }
        this.eventListeners.get(eventName).push(callback);
    }

    /**
     * Emit a custom event.
     * @param {string} eventName - The name of the event to emit.
     * @param {any} data - The data to pass to the event listeners.
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
                console.error(`[WebSocketRelayManager] Error in event listener for '${eventName}':`, e);
            }
        });
    }

    /**
     * Add a relay to the connection pool
     * @param {string} url - The relay URL (e.g., wss://relay.damus.io)
     * @returns {Promise} - Resolves when connected
     */
    async addRelay(url) {
        // Parse the URL to extract token
        const { cleanUrl, token } = this.parseRelayUrl(url);
        
        // Normalize URL
        let normalizedUrl = cleanUrl;
        if (!normalizedUrl.startsWith('wss://') && !normalizedUrl.startsWith('ws://')) {
            normalizedUrl = 'wss://' + normalizedUrl;
        }
    
        // Check if already connected
        if (this.relays.has(normalizedUrl)) {
            const existing = this.relays.get(normalizedUrl);

            // If the token has changed, close the existing connection
            if (token && existing.authToken && token !== existing.authToken) {
                console.log(`Relay ${normalizedUrl} token updated, reconnecting`);
                existing.preventReconnect = true; // avoid automatic reconnect with old token
                try {
                    existing.conn.close();
                } catch (e) {
                    console.warn(`Failed to close existing connection for ${normalizedUrl}`, e);
                }
                this.relays.delete(normalizedUrl);
            } else if (existing.status === 'open' || existing.status === 'connecting') {
                console.log(`Relay ${normalizedUrl} already connected or connecting`);
                return Promise.resolve();
            } else {
                // Remove stale entry to allow reconnection
                this.relays.delete(normalizedUrl);
            }
        }
    
        if (this.shutdownRequested) {
            return Promise.reject(new Error('Relay manager shutting down'));
        }

        return new Promise((resolve, reject) => {
            try {
                if (this.shutdownRequested) {
                    reject(new Error('Relay manager shutting down'));
                    return;
                }
                // If token exists, append it back for the actual connection
                const connectionUrl = token ? `${normalizedUrl}?token=${token}` : normalizedUrl;
                const ws = new WebSocket(connectionUrl);
                
                const relayData = {
                    conn: ws,
                    status: 'connecting',
                    subscriptions: new Map(),
                    pendingMessages: [],
                    type: 'discovery',
                    authToken: token,
                    preventReconnect: false,
                    reconnectTimer: null
                };
                
                this.relays.set(normalizedUrl, relayData);
    
                ws.onopen = () => {
                    console.log(`Connected to relay: ${normalizedUrl} ${token ? '(authenticated)' : ''}`);
                    relayData.status = 'open';
                    
                    // Send any pending messages
                    if (relayData.pendingMessages.length > 0) {
                        relayData.pendingMessages.forEach(msg => {
                            this._queueRequest(() => {
                                if (ws.readyState === WebSocket.OPEN) {
                                    ws.send(msg);
                                }
                            });
                        });
                        relayData.pendingMessages = [];
                    }
                    
                    // Only apply subscriptions that are meant for this relay
                    this._applyRelevantSubscriptions(normalizedUrl);
                    
                    // Notify connect listeners
                    this.connectCallbacks.forEach(callback => callback(url));
                    
                    resolve();
                };

                ws.onclose = (event) => {
                    console.log(`Disconnected from relay: ${normalizedUrl}, code: ${event.code}`);
                    relayData.status = 'closed';
                    
                    // Handle authentication failure (4403 close code)
                    if (event.code === 4403) {
                        console.error(`Authentication failed for relay: ${normalizedUrl}`);
                        this.emit('auth:failed', { relayUrl: normalizedUrl }); // Use the new emit method
                    }
                    
                    // Notify disconnect listeners
                    this.disconnectCallbacks.forEach(callback => callback(url));
                    
                    // Only attempt reconnection if not explicitly prevented
                    if (!relayData.preventReconnect && !this.shutdownRequested) {
                        const timer = setTimeout(() => {
                            this.reconnectTimers.delete(timer);
                            relayData.reconnectTimer = null;
                            if (!this.shutdownRequested) {
                                this.addRelay(url).catch(console.error);
                            }
                        }, 5000);
                        relayData.reconnectTimer = timer;
                        this.reconnectTimers.add(timer);
                    } else {
                        // Clean up the relay from our map
                        this.relays.delete(normalizedUrl);
                        if (relayData.reconnectTimer) {
                            clearTimeout(relayData.reconnectTimer);
                            this.reconnectTimers.delete(relayData.reconnectTimer);
                            relayData.reconnectTimer = null;
                        }
                    }
                };

                ws.onerror = (error) => {
                    console.error(`Error with relay ${url}:`, error);
                    // If still connecting, reject the promise
                    if (relayData.status === 'connecting') {
                        reject(error);
                    }
                };

                ws.onmessage = (event) => {
                    try {
                        const data = JSON.parse(event.data);
                        this._handleRelayMessage(url, data);
                    } catch (e) {
                        console.error(`Error parsing message from ${url}:`, e);
                    }
                };
            } catch (e) {
                console.error(`Error connecting to ${normalizedUrl}:`, e);
                reject(e);
            }
        });
    }

    /**
     * Apply only relevant subscriptions to a relay
     * @private
     */
    _applyRelevantSubscriptions(relayUrl) {
        const { cleanUrl } = this.parseRelayUrl(relayUrl);
        const relayType = this.relayTypes.get(cleanUrl) || 'discovery';
        
        this.globalSubscriptions.forEach((subData, subId) => {
            // Check if this subscription should be applied to this relay
            if (this._shouldApplySubscription(subData, cleanUrl, relayType)) {
                this._subscribeOnRelay(cleanUrl, subId, subData.filters);
            }
        });
    }

    /**
     * Determine if a subscription should be applied to a specific relay
     * @private
     */
    _shouldApplySubscription(subData, relayUrl, relayType) {
        // If subscription has specific target relays, only apply if this relay is one of them
        if (subData.targetRelays && subData.targetRelays.length > 0) {
            return subData.targetRelays.includes(relayUrl);
        }
        
        // For group relays, only apply group-specific subscriptions
        if (relayType === 'group') {
            const groupId = Array.from(this.groupRelays.entries())
                .find(([gid, url]) => url === relayUrl)?.[0];
                
            if (groupId) {
                // Check if this is a group-specific subscription
                const subId = this.reverseSubscriptionMap.get(subData.shortId) || '';
                return subId.includes(groupId);
            }
        }
        
        // For discovery relays, apply non-group-specific subscriptions
        if (relayType === 'discovery') {
            const subId = this.reverseSubscriptionMap.get(subData.shortId) || '';
            // Don't apply group-specific subscriptions to discovery relays
            return !subId.includes('group-meta-') && 
                !subId.includes('group-messages-') && 
                !subId.includes('group-members-');
        }
        
        return false;
    }

    /**
     * Process the request queue with rate limiting
     * @private
     */
    _processQueue() {
        if (this.requestQueue.length === 0) {
            this.processingQueue = false;
            return;
        }

        this.processingQueue = true;
        const now = Date.now();
        const timeSinceLastRequest = now - this.lastRequestTime;
        
        // If we need to wait, schedule the next request
        if (timeSinceLastRequest < this.minTimeBetweenRequests) {
            setTimeout(() => this._processQueue(), 
                this.minTimeBetweenRequests - timeSinceLastRequest);
            return;
        }

        // Process the next request
        const request = this.requestQueue.shift();
        this.lastRequestTime = Date.now();
        
        try {
            request();
        } catch (e) {
            console.error('Error processing request:', e);
        }

        // Continue processing queue if there are more items
        if (this.requestQueue.length > 0) {
            setTimeout(() => this._processQueue(), this.minTimeBetweenRequests);
        } else {
            this.processingQueue = false;
        }
    }

    // Add this method to WebSocketRelayManager class
_validateEvent(event) {
    // Check required fields
    if (!event || !event.id || !event.pubkey || !event.sig) {
        return { valid: false, reason: 'Missing required fields (id, pubkey, or sig)' };
    }
    
    // Check for valid timestamps
    if (!event.created_at || typeof event.created_at !== 'number') {
        return { valid: false, reason: 'Invalid or missing created_at timestamp' };
    }
    
    // Check event kind
    if (typeof event.kind !== 'number') {
        return { valid: false, reason: 'Invalid or missing event kind' };
    }
    
    // Check that tags is an array
    if (!Array.isArray(event.tags)) {
        return { valid: false, reason: 'Tags must be an array' };
    }
    
    // Validate signature length
    if (event.sig.length !== 128) {
        return { valid: false, reason: `Invalid signature length: ${event.sig.length}, expected 128` };
    }
    
    return { valid: true };
}

    /**
     * Queue a request to be sent to a relay with rate limiting
     * @param {Function} request - Function to execute
     * @private
     */
    _queueRequest(request) {
        this.requestQueue.push(request);
        
        if (!this.processingQueue) {
            this._processQueue();
        }
    }

    /**
     * Remove a relay from the connection pool
     * @param {string} url - The relay URL
     */
    removeRelay(url) {
        const { cleanUrl } = this.parseRelayUrl(url);
        const normalizedKey = cleanUrl.startsWith('wss://') || cleanUrl.startsWith('ws://')
            ? cleanUrl
            : `wss://${cleanUrl}`;

        if (!this.relays.has(normalizedKey)) {
            return;
        }

        const relay = this.relays.get(normalizedKey);
        relay.preventReconnect = true;
        if (relay.reconnectTimer) {
            clearTimeout(relay.reconnectTimer);
            this.reconnectTimers.delete(relay.reconnectTimer);
            relay.reconnectTimer = null;
        }
        if (relay.conn && relay.conn.readyState !== WebSocket.CLOSED) {
            relay.conn.close();
        }

        const relayType = this.relayTypes.get(normalizedKey) || this.relayTypes.get(cleanUrl);
        if (relayType === 'discovery') {
            this.discoveryRelays.delete(normalizedKey);
            this.discoveryRelays.delete(cleanUrl);
        } else if (relayType === 'group') {
            for (const [groupId, relayUrl] of this.groupRelays.entries()) {
                if (relayUrl === normalizedKey || relayUrl === cleanUrl) {
                    this.groupRelays.delete(groupId);
                }
            }
        }

        this.relayTypes.delete(normalizedKey);
        this.relayTypes.delete(cleanUrl);

        this.relays.delete(normalizedKey);
    }

    /**
     * Get all connected relays
     * @returns {Array} - Array of relay URLs
     */
    getRelays() {
        return Array.from(this.relays.keys());
    }

    /**
     * Get configured discovery relays
     * @returns {Array}
     */
    getDiscoveryRelays() {
        return Array.from(this.discoveryRelays);
    }

    /**
     * Get relay connection status
     * @param {string} url - The relay URL
     * @returns {string|null} - Status or null if relay not found
     */
    getRelayStatus(url) {
        const { cleanUrl } = this.parseRelayUrl(url);
        if (!this.relays.has(cleanUrl)) {
            return null;
        }
        return this.relays.get(cleanUrl).status;
    }

    cancelAllReconnects() {
        this.reconnectTimers.forEach(timer => clearTimeout(timer));
        this.reconnectTimers.clear();
        this.relays.forEach((relayData) => {
            relayData.preventReconnect = true;
            if (relayData.reconnectTimer) {
                clearTimeout(relayData.reconnectTimer);
                relayData.reconnectTimer = null;
            }
        });
    }

    shutdown({ clearSubscriptions = true } = {}) {
        console.log('[WebSocketRelayManager] Shutdown initiated');
        this.shutdownRequested = true;
        this.cancelAllReconnects();

        this.relays.forEach((relayData) => {
            relayData.preventReconnect = true;
            try {
                if (relayData.conn && relayData.conn.readyState !== WebSocket.CLOSED) {
                    relayData.conn.close();
                }
            } catch (error) {
                console.error('[WebSocketRelayManager] Error closing relay during shutdown:', error);
            }
        });

        this.relays.clear();
        this.relayTypes.clear();
        this.groupRelays.clear();
        this.discoveryRelays.clear();

        this.requestQueue = [];
        this.processingQueue = false;

        if (clearSubscriptions) {
            this.globalSubscriptions.clear();
            this.subscriptionIdMap.clear();
            this.reverseSubscriptionMap.clear();
            this.subscriptionCounter = 0;
        }
    }

    /**
     * Generate a shorter subscription ID based on the original and index
     * @param {string} subscriptionId - The original subscription ID
     * @returns {string} - A shorter subscription ID
     * @private
     */
    _shortenSubscriptionId(subscriptionId) {
        // If already short enough, return as is
        if (subscriptionId.length <= 8) {
            return subscriptionId;
        }
        
        // Otherwise generate a short ID based on the first 8 characters
        return subscriptionId.substring(0, 8);
    }

    /**
     * Create a subscription for events matching the given filters
     * @param {string} subscriptionId - A unique ID for this subscription
     * @param {Array} filters - Array of filter objects
     * @param {Function} callback - Function to call when events arrive
     */
    subscribe(subscriptionId, filters, callback, options = {}) {
        // Generate unique short ID for this subscription
        const shortSubId = this._generateUniqueShortId(subscriptionId);
    
        // Check for existing subscription
        if (this.globalSubscriptions.has(subscriptionId)) {
            const existing = this.globalSubscriptions.get(subscriptionId);
            if (JSON.stringify(existing.filters) === JSON.stringify(filters)) {
                console.log(`Subscription ${subscriptionId} already exists with same filters`);
                if (callback) existing.callbacks.push(callback);
                return subscriptionId;
            }
    
            // Filters changed - unsubscribe first
            this.unsubscribe(subscriptionId);
        }
    
        console.log(`Creating subscription: ${subscriptionId} (${shortSubId})`);
        console.log(`Subscription filters:`, JSON.stringify(filters));
        
        this.globalSubscriptions.set(subscriptionId, {
            shortId: shortSubId,
            filters,
            callbacks: callback ? [callback] : [],
            suppressGlobalEvents: options.suppressGlobalEvents || false
        });
    
        // Apply to all connected relays
        this.relays.forEach((relay, url) => {
            if (relay.status === 'open') {
                this._subscribeOnRelay(url, subscriptionId, filters);
            }
        });
    
        return subscriptionId;
    }
    
    
    /**
     * Internal method to subscribe on a specific relay
     * @private
     */
    _subscribeOnRelay(relayUrl, subscriptionId, filters) {
        const { cleanUrl } = this.parseRelayUrl(relayUrl);
        const relay = this.relays.get(cleanUrl);
        if (!relay || relay.status !== 'open') {
            console.log(`Cannot subscribe to ${cleanUrl}, relay not connected`);
            return;
        }
    
        // Get the unique short ID for this subscription
        const subData = this.globalSubscriptions.get(subscriptionId);
        if (!subData) {
            console.error(`No subscription data found for ${subscriptionId}`);
            return;
        }
        
        const shortSubId = subData.shortId;
    
        // Avoid duplicate subscriptions on the relay
        if (relay.subscriptions.has(subscriptionId)) {
            const existing = relay.subscriptions.get(subscriptionId);
            if (JSON.stringify(existing.filters) === JSON.stringify(filters)) {
                console.log(`Relay ${cleanUrl} already has subscription ${subscriptionId}`);
                return;
            }
        }

        // Create a REQ message with the unique short ID
        const reqMsg = JSON.stringify(['REQ', shortSubId, ...filters]);
        console.log(`REQ message to ${cleanUrl}:`, reqMsg);
        
        this._queueRequest(() => {
            if (relay.status === 'open') {
                relay.conn.send(reqMsg);
                console.log(`Subscription ${subscriptionId} (${shortSubId}) sent to ${cleanUrl}`);
                
                // Track subscription on this relay
                relay.subscriptions.set(subscriptionId, {
                    shortId: shortSubId,
                    filters: filters
                });
            } else {
                console.log(`Relay ${cleanUrl} not open, queueing subscription`);
                relay.pendingMessages.push(reqMsg);
            }
        });
    }

    /**
     * Close a subscription
     * @param {string} subscriptionId - The subscription ID to close
     */
    unsubscribe(subscriptionId) {
        const subData = this.globalSubscriptions.get(subscriptionId);
        if (!subData) return;
        
        const shortSubId = subData.shortId;
        this.globalSubscriptions.delete(subscriptionId);

        // Send CLOSE to all relays that have this subscription
        this.relays.forEach((relay, url) => {
            if (relay.status === 'open' && relay.subscriptions.has(subscriptionId)) {
                const closeMsg = JSON.stringify(['CLOSE', shortSubId]);
                
                this._queueRequest(() => {
                    if (relay.status === 'open') {
                        relay.conn.send(closeMsg);
                    }
                });
                
                relay.subscriptions.delete(subscriptionId);
            }
        });
        
        // Clean up subscription mappings
        this._cleanupSubscriptionMappings(subscriptionId);
    }

    /**
     * Publish an event to all connected relays
     * @param {Object} event - Signed nostr event object
     * @returns {Promise} - Resolves when published to at least one relay
     */
    publish(event) {
        // Validate event has required fields
        const validation = this._validateEvent(event);
        if (!validation.valid) {
            console.error('Invalid event:', validation.reason, event);
            return Promise.reject(new Error(`Invalid event: ${validation.reason}`));
        }
        
        console.log('Publishing event:', {
            id: event.id,
            kind: event.kind,
            created_at: event.created_at,
            pubkey: event.pubkey.substring(0, 8) + '...',
            sig_length: event.sig ? event.sig.length : 0,
            content_length: event.content ? event.content.length : 0,
            tags_count: event.tags ? event.tags.length : 0
        });
        
        // Create EVENT message
        const eventMsg = JSON.stringify(['EVENT', event]);
        const truncatedMsg = eventMsg.length > 200 ? 
            eventMsg.substring(0, 197) + '...' : 
            eventMsg;
        console.log(`EVENT message to publish: ${truncatedMsg}`);
        
        // Create OK promises for each relay
        const publishPromises = [];
    
        this.relays.forEach((relay, url) => {
            console.log(`Attempting to publish to relay: ${url}`);
            
            const publishPromise = new Promise((resolve, reject) => {
                // Create a timeout for this publish
                const timeout = setTimeout(() => {
                    // Remove the one-time event listener if it times out
                    if (okHandler) {
                        relay.conn.removeEventListener('message', okHandler);
                    }
                    console.warn(`Publish to ${url} timed out for event ${event.id.substring(0, 8)}...`);
                    reject(new Error(`Publish to ${url} timed out`));
                }, 10000);
                
                // Create a one-time event handler for the OK response
                const okHandler = (msgEvent) => {
                    try {
                        const data = JSON.parse(msgEvent.data);
                        
                        // Check if this is an OK response for our event
                        if (Array.isArray(data) && data[0] === 'OK' && data[1] === event.id) {
                            console.log(`Received OK from ${url} for event ${event.id.substring(0, 8)}...`, data);
                            
                            clearTimeout(timeout);
                            relay.conn.removeEventListener('message', okHandler);
                            
                            // Resolve with success or error based on relay response
                            if (data.length > 2 && data[2] === true) {
                                console.log(`Success publish to ${url} for event ${event.id.substring(0, 8)}...`);
                                resolve({ url, success: true });
                            } else {
                                const errorMsg = data.length > 3 ? data[3] : 'Unknown error';
                                console.warn(`Failed publish to ${url}: ${errorMsg}`);
                                resolve({ url, success: false, error: errorMsg });
                            }
                        }
                    } catch (e) {
                        console.warn(`Error parsing message from ${url}:`, e, msgEvent.data);
                    }
                };
    
                // Send the event
                if (relay.status === 'open') {
                    try {
                        // Listen for the OK response
                        relay.conn.addEventListener('message', okHandler);
                        
                        // Queue the publish request
                        this._queueRequest(() => {
                            try {
                                if (relay.conn.readyState === WebSocket.OPEN) {
                                    relay.conn.send(eventMsg);
                                    console.log(`Event sent to ${url}`);
                                } else {
                                    // If connection closed while in queue
                                    console.log(`Relay ${url} disconnected, queueing event`);
                                    relay.pendingMessages.push(eventMsg);
                                    resolve({ url, success: true, queued: true });
                                }
                            } catch (err) {
                                console.warn(`Error sending to ${url}:`, err);
                                resolve({ url, success: false, error: err.message });
                            }
                        });
                    } catch (err) {
                        console.warn(`Error setting up publish to ${url}:`, err);
                        resolve({ url, success: false, error: err.message });
                    }
                } else {
                    // Queue the message to be sent when connected
                    console.log(`Relay ${url} not open, queueing message`);
                    relay.pendingMessages.push(eventMsg);
                    resolve({ url, success: true, queued: true });
                }
            });
    
            publishPromises.push(publishPromise);
        });
    
        // Return a promise that resolves when published to at least one relay
        return Promise.allSettled(publishPromises).then(results => {
            const successful = results.filter(r => r.status === 'fulfilled' && (r.value.success || r.value.queued));
            const queued = results.filter(r => r.status === 'fulfilled' && r.value.queued);
            
            if (successful.length > 0) {
                console.log(`Event ${event.id.substring(0, 8)}... published to ${successful.length} relays`);
                return { 
                    success: true, 
                    count: successful.length,
                    relays: successful.map(r => r.value.url),
                    queued: queued.length > 0
                };
            } else {
                // Log failed publish attempts for debugging
                console.error('Failed to publish to any relays, attempts:', 
                    results.map(r => ({
                        status: r.status,
                        value: r.status === 'fulfilled' ? r.value : r.reason
                    }))
                );
                return Promise.reject(new Error('Failed to publish to any relays'));
            }
        });
    }

    /**
     * Add a callback for received events
     * @param {Function} callback - Function to call with the event
     */
    onEvent(callback) {
        if (typeof callback === 'function') {
            this.eventCallbacks.push(callback);
        }
    }

    // Add this function to test basic connectivity
async testPublish() {
    if (this.relays.size === 0) {
        console.error('No relays connected');
        return;
    }
    
    // Create a minimal test event
    const testEvent = {
        id: '0'.repeat(64),  // All zeros, just for testing
        pubkey: '0'.repeat(64),
        created_at: Math.floor(Date.now() / 1000),
        kind: 1,
        tags: [],
        content: 'Test event from relay manager',
        sig: '0'.repeat(128) // Invalid signature, but correct length
    };
    
    console.log('Publishing test event...');
    try {
        await this.publish(testEvent);
        console.log('Test publish completed');
    } catch (error) {
        console.error('Test publish failed:', error);
    }
}

    /**
     * Add a callback for relay connections
     * @param {Function} callback - Function to call with the relay URL
     */
    onConnect(callback) {
        if (typeof callback === 'function') {
            this.connectCallbacks.push(callback);
        }
    }

    /**
     * Add a callback for relay disconnections
     * @param {Function} callback - Function to call with the relay URL
     */
    onDisconnect(callback) {
        if (typeof callback === 'function') {
            this.disconnectCallbacks.push(callback);
        }
    }

    /**
     * Handle message from a relay
     * @private
     */
    _handleRelayMessage(relayUrl, message) {
        if (!Array.isArray(message)) {
            return;
        }
    
        const messageType = message[0];
    
        if (messageType === 'EVENT') {
            if (message.length < 3) return;
            
            const shortSubId = message[1];
            const event = message[2];
            
            // Get the original subscription ID from our mapping
            const originalSubId = this._getOriginalSubscriptionId(shortSubId);
            
            if (!originalSubId) {
                console.warn(`Unknown subscription ID: ${shortSubId}`);
                return;
            }
            
            console.log(`Received event for subscription: ${originalSubId} (${shortSubId})`);
            const eventData = JSON.stringify(event);
            console.log(`event data: ${eventData}`);
            // Get subscription data
            const subscription = this.globalSubscriptions.get(originalSubId);
            if (subscription) {
                // Call subscription-specific callbacks
                subscription.callbacks.forEach(callback => {
                    try {
                        callback(event, relayUrl, originalSubId);
                    } catch (e) {
                        console.error('Error in subscription callback:', e);
                    }
                });
                
                // Only notify global event listeners if not suppressed
                if (!subscription.suppressGlobalEvents) {
                    this.eventCallbacks.forEach(callback => {
                        try {
                            callback(event, relayUrl, originalSubId);
                        } catch (e) {
                            console.error('Error in event callback:', e);
                        }
                    });
                }
            }
        }
        else if (messageType === 'EOSE') {
            // End of stored events
            const shortSubId = message[1];
            const originalSubId = this._getOriginalSubscriptionId(shortSubId);
            console.log(`End of stored events for subscription ${originalSubId || shortSubId}`);
        }
        else if (messageType === 'NOTICE') {
            console.log(`Notice from ${relayUrl}: ${message[1]}`);
        }
        else if (messageType === 'OK') {
            // Handle OK responses
            if (message.length >= 3) {
                const eventId = message[1];
                const success = message[2];
                const errorMsg = message.length > 3 ? message[3] : '';
                console.log(`OK from ${relayUrl}: ${eventId.substring(0, 8)}... - ${success ? 'success' : 'failed'}${errorMsg ? ': ' + errorMsg : ''}`);
            }
        }
    }
}

// Export the class
export default WebSocketRelayManager;
