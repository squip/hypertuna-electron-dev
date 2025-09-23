// this is the script for fishy-gateway-nostr-client.js

const WebSocket = require('ws');
const fs = require('fs');
const nobleSecp256k1 = require('noble-secp256k1');
const { createHash } = require('crypto');
const { bech32, bech32m } = require('bech32');
const crypto = require('crypto');

class NostrInitializer {
    constructor(configFilePath) {
        if (!configFilePath) {
            throw new Error('Configuration file path must be provided to NostrInitializer');
        }
        this.configFile = configFilePath;
        this.relayConnections = new Map();
        this.relayResponses = new Set();
        this.subscriptions = new Map();
        this.initialized = false;
    }

    // Utility functions remain unchanged
    hexToBytes(hex) {
        if (typeof hex !== 'string') {
            throw new Error('hexToBytes: expected string, got ' + typeof hex);
        }
        if (hex.length % 2 !== 0) {
            throw new Error('hexToBytes: string must have even length');
        }
        const matches = hex.match(/.{1,2}/g) || [];
        return new Uint8Array(matches.map(byte => parseInt(byte, 16)));
    }

    bytesToHex(bytes) {
        if (bytes instanceof Uint8Array) {
            return Array.from(bytes)
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('');
        }
        
        if (Buffer.isBuffer(bytes)) {
            return bytes.toString('hex');
        }
        
        if (Array.isArray(bytes) || ArrayBuffer.isView(bytes)) {
            return Array.from(bytes)
                .map(byte => byte.toString(16).padStart(2, '0'))
                .join('');
        }

        throw new Error('bytesToHex: unsupported input type: ' + typeof bytes);
    }

    generateSubscriptionId() {
        return crypto.randomBytes(16).toString('hex').slice(0, 16);
    }

    async sha256(input) {
        if (typeof input === 'string') {
            input = new TextEncoder().encode(input);
        }
        const buffer = await nobleSecp256k1.utils.sha256(input);
        return this.bytesToHex(buffer);
    }

    // Key conversion methods remain unchanged
    convertBase32ToHex(key) {
        const base32Chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        const isBase32 = [...key.toUpperCase()].every(char => base32Chars.includes(char));
        
        if (isBase32) {
            let bits = '';
            for (const char of key.toUpperCase()) {
                const value = base32Chars.indexOf(char);
                bits += value.toString(2).padStart(5, '0');
            }
            bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, '0');
            
            const bytes = [];
            for (let i = 0; i < bits.length; i += 8) {
                const byte = bits.slice(i, i + 8);
                bytes.push(parseInt(byte, 2));
            }
            
            const hex = Buffer.from(bytes).toString('hex');
            return hex.slice(0, 64);
        }
        return null;
    }

    convertPublicKey(key) {
        try {
            if (key.match(/^[0-9a-fA-F]{64}$/)) {
                return key.toLowerCase();
            }

            if (key.startsWith('npub1')) {
                const { words } = bech32.decode(key, 1000);
                const bytes = bech32.fromWords(words);
                return Buffer.from(bytes).toString('hex');
            }

            const hexKey = this.convertBase32ToHex(key);
            if (hexKey) {
                return hexKey;
            }

            throw new Error('Unsupported public key format');
        } catch (error) {
            console.error('[ERROR] Error converting public key:', error);
            throw error;
        }
    }

    convertPrivateKey(key) {
        try {
            if (key.match(/^[0-9a-fA-F]{64}$/)) {
                return key.toLowerCase();
            }

            if (key.startsWith('nsec1')) {
                const { words } = bech32.decode(key, 1000);
                const bytes = bech32.fromWords(words);
                return Buffer.from(bytes).toString('hex');
            }

            const hexKey = this.convertBase32ToHex(key);
            if (hexKey) {
                return hexKey;
            }

            throw new Error('Unsupported private key format');
        } catch (error) {
            console.error('[ERROR] Error converting private key:', error);
            throw error;
        }
    }

    // Enhanced event creation and publishing
    async createNostrEvent(kind, content, tags = [], pubkey, privkey) {
        try {
            console.log(`[EVENT] Creating kind:${kind} event`);
            const event = {
                kind,
                created_at: Math.floor(Date.now() / 1000),
                pubkey,
                content,
                tags
            };

            const eventData = JSON.stringify([
                0,
                event.pubkey,
                event.created_at,
                event.kind,
                event.tags,
                event.content
            ]);

            const eventHash = createHash('sha256')
                .update(eventData)
                .digest('hex');
            
            event.id = eventHash;
            event.sig = await nobleSecp256k1.schnorr.sign(eventHash, privkey);

            console.log('[EVENT] Created event:', {
                id: event.id,
                kind: event.kind,
                pubkey: event.pubkey,
                tags: event.tags,
                content: event.content,
                created_at: new Date(event.created_at * 1000).toISOString()
            });

            return event;
        } catch (error) {
            console.error('[ERROR] Failed to create NOSTR event:', error);
            throw error;
        }
    }

    async updateSubscriptionFilters(subId, newAuthors) {
        try {
            console.log(`[SUB] Updating subscription filters for ${subId}`);
            
            // Get existing subscription details
            const subscription = this.subscriptions.get(subId);
            if (!subscription) {
                throw new Error(`No subscription found for ID: ${subId}`);
            }
    
            // Get existing authors array or initialize empty array
            const existingAuthors = subscription.filter.authors || [];
            
            // Combine existing and new authors, removing duplicates
            const updatedAuthors = [...new Set([...existingAuthors, ...newAuthors])];
            
            // Create updated filter object
            const updatedFilter = {
                ...subscription.filter,
                authors: updatedAuthors
            };
    
            // Update subscription in memory
            this.subscriptions.set(subId, {
                ...subscription,
                filter: updatedFilter,
                timestamp: Date.now()
            });
    
            // Publish updated subscription to all active relays
            for (const [relayUrl, ws] of this.relayConnections.entries()) {
                if (ws.readyState === WebSocket.OPEN) {
                    console.log(`[RELAY:${relayUrl}] Publishing updated subscription`);
                    this.publishSubscription(ws, subId, updatedFilter, relayUrl);
                }
            }
    
            console.log(`[SUB] Successfully updated subscription ${subId} with new authors:`, newAuthors);
            return true;
        } catch (error) {
            console.error('[ERROR] Failed to update subscription filters:', error);
            throw error;
        }
    }

    // Add new Kind 10002 event handling
    async handleKind10002Events(hexPubkey, privkey, relayUrl) {
        try {
            console.log('[EVENT:10002] Starting relay list event handling');
            
            // Read current config
            const configData = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
            
            // Get all relevant pubkeys to filter events
            const relevantPubkeys = [
                hexPubkey,
                ...(configData.gateway_kind_30000_directory_relays || [])
            ];
    
            // Filter kind:10002 events for all relevant pubkeys
            const matchingEvents = Array.from(this.relayResponses)
                .filter(event => 
                    event.kind === 10002 && 
                    relevantPubkeys.includes(event.pubkey)
                );
    
            if (matchingEvents.length === 0) {
                console.log('[EVENT:10002] No existing relay list events found, publishing new event');
                
                await this.publishRelayListEvent(
                    hexPubkey, 
                    privkey, 
                    configData.gateway_kind_10002_relays
                );
                
            } else {
                // Group events by pubkey and find most recent for each
                const latestEventsByPubkey = new Map();
                
                matchingEvents.forEach(event => {
                    const currentLatest = latestEventsByPubkey.get(event.pubkey);
                    if (!currentLatest || event.created_at > currentLatest.created_at) {
                        latestEventsByPubkey.set(event.pubkey, event);
                    }
                });
    
                console.log('[EVENT:10002] Found latest events by pubkey:', {
                    count: latestEventsByPubkey.size,
                    pubkeys: Array.from(latestEventsByPubkey.keys())
                });
    
                // Process all latest events
                for (const [pubkey, event] of latestEventsByPubkey) {
                    // Extract and process relay URLs
                    const relayUrls = event.tags
                        .filter(tag => tag[0] === 'r')
                        .map(tag => tag[1]);
    
                    console.log(`[EVENT:10002] Processing new relays for pubkey ${pubkey}:`, relayUrls);
    
                    // Update stats with preferred relays for this pubkey
                    await this.updateNetworkStatsRelays(
                        configData.gateway_kind_10002_relays,
                        pubkey,
                        relayUrls
                    );
    
                    // Update config relays list
                    const updatedRelays = [...new Set([
                        ...configData.gateway_kind_10002_relays,
                        ...relayUrls
                    ])];
    
                    // Connect to new relays
                    for (const url of relayUrls) {
                        if (!this.relayConnections.has(url)) {
                            console.log(`[RELAY] Connecting to new relay: ${url}`);
                            const ws = new WebSocket(url);
                            this.setupWebSocketHandlers(
                                ws, 
                                url, 
                                hexPubkey, 
                                privkey,
                                configData.name,
                                configData.about,
                                updatedRelays,
                                configData.gateway_kind_30000_directory_id
                            );
                        }
                    }
    
                    // Update config
                    configData.gateway_kind_10002_relays = updatedRelays;
                }
                
                // Update subscription filters with new directory relays
                if (configData.gateway_kind_30000_directory_relays?.length > 0) {
                    await this.updateSubscriptionFilters(
                        subId10002,
                        configData.gateway_kind_30000_directory_relays
                    );
                }
                
                // Create and publish updated event
                await this.publishRelayListEvent(hexPubkey, privkey, configData.gateway_kind_10002_relays);
            }
        } catch (error) {
            console.error('[ERROR:10002] Failed to process relay list events:', error);
            throw error;
        }
    }

    // Add new Kind 30000 event handling
    async handleKind30000Events(hexPubkey, privkey, relayUrl) {
        try {
            console.log('[EVENT:30000] Starting directory event handling');
            
            const configData = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
            const lastUpdate = configData.gateway_kind_30000_lastUpdate || 0;
    
            const matchingEvents = Array.from(this.relayResponses)
                .filter(event => 
                    event.kind === 30000 && 
                    event.pubkey === hexPubkey &&
                    event.tags.some(tag => 
                        tag[0] === 'd' && 
                        tag[1] === configData.gateway_kind_30000_directory_id
                    )
                );
    
            // Find the kind 10002 subscription ID - we'll need this in multiple places
            const subId10002 = Array.from(this.subscriptions.keys())
                .find(id => this.subscriptions.get(id).filter.kinds?.includes(10002));
    
            if (matchingEvents.length === 0) {
                if (configData.gateway_kind_30000_directory_relays?.length > 0) {
                    console.log('[EVENT:30000] No existing directory events found, publishing new event');
                    
                    // Update subscription filters with initial directory relays
                    if (subId10002) {
                        console.log('[SUB] Updating subscription filters with initial directory relays');
                        await this.updateSubscriptionFilters(
                            subId10002, 
                            configData.gateway_kind_30000_directory_relays
                        );
                    }
                    
                    await this.publishDirectoryEvent(
                        hexPubkey,
                        privkey,
                        configData.name,
                        configData.about,
                        configData.gateway_kind_30000_directory_id,
                        configData.gateway_kind_30000_directory_relays
                    );
                }
            } else {
                const latestEvent = matchingEvents.reduce((latest, current) => 
                    (current.created_at > latest.created_at) ? current : latest
                );
    
                console.log('[EVENT:30000] Found existing directory events', {
                    count: matchingEvents.length,
                    latestTimestamp: new Date(latestEvent.created_at * 1000).toISOString()
                });
    
                if (lastUpdate >= 0 && latestEvent.created_at > lastUpdate) {
                    const newPubkeys = latestEvent.tags
                        .filter(tag => tag[0] === 'p')
                        .map(tag => tag[1]);
    
                    console.log('[EVENT:30000] Processing new pubkeys:', newPubkeys);
    
                    // Get current relays and determine which pubkeys are actually new
                    const currentRelays = configData.gateway_kind_30000_directory_relays || [];
                    const actuallyNewPubkeys = newPubkeys.filter(pk => !currentRelays.includes(pk));
                    const updatedRelays = [...new Set([...currentRelays, ...newPubkeys])];
    
                    // Only update subscription if we have new pubkeys
                    if (actuallyNewPubkeys.length > 0 && subId10002) {
                        console.log('[SUB] Updating subscription filters with new directory pubkeys:', actuallyNewPubkeys);
                        await this.updateSubscriptionFilters(subId10002, actuallyNewPubkeys);
                    }
    
                    configData.gateway_kind_30000_directory_relays = updatedRelays;
    
                    await this.publishDirectoryEvent(
                        hexPubkey,
                        privkey,
                        configData.name,
                        configData.about,
                        configData.gateway_kind_30000_directory_id,
                        updatedRelays
                    );
                }
            }
        } catch (error) {
            console.error('[ERROR:30000] Failed to process directory events:', error);
            throw error;
        }
    }

    async publishRelayListEvent(hexPubkey, privkey, relays) {
        try {
            console.log('[EVENT:10002] Creating new relay list event');
            
            const event = await this.createNostrEvent(
                10002,
                "",
                relays.map(url => ["r", url]),
                hexPubkey,
                privkey
            );

            // Update config with new timestamp
            const configData = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
            configData.gateway_kind_10002_lastUpdate = event.created_at;
            fs.writeFileSync(this.configFile, JSON.stringify(configData, null, 2));

            // Publish to all connected relays
            for (const [relayUrl, ws] of this.relayConnections.entries()) {
                if (ws.readyState === WebSocket.OPEN) {
                    this.publishEvent(ws, event, relayUrl);
                }
            }

            return event;
        } catch (error) {
            console.error('[ERROR:10002] Failed to publish relay list event:', error);
            throw error;
        }
    }

    async publishDirectoryEvent(hexPubkey, privkey, name, about, directoryId, relays) {
        try {
            console.log('[EVENT:30000] Creating new directory event');
            
            const tags = [
                ["d", directoryId],
                ["title", name],
                ["description", about],
                ...relays.map(pubkey => ["p", pubkey])
            ];

            const event = await this.createNostrEvent(
                30000,
                "",
                tags,
                hexPubkey,
                privkey
            );

            // Update config with new timestamp
            const configData = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
            configData.gateway_kind_30000_lastUpdate = event.created_at;
            fs.writeFileSync(this.configFile, JSON.stringify(configData, null, 2));

            // Publish to all connected relays
            for (const [relayUrl, ws] of this.relayConnections.entries()) {
                if (ws.readyState === WebSocket.OPEN) {
                    this.publishEvent(ws, event, relayUrl);
                }
            }

            return event;
        } catch (error) {
            console.error('[ERROR:30000] Failed to publish directory event:', error);
            throw error;
        }
    }

    publishEvent(ws, event, relayUrl) {
        try {
            console.log(`[RELAY:${relayUrl}] Publishing event kind:${event.kind}`);
            const message = ["EVENT", event];
            const messageString = JSON.stringify(message);
            ws.send(messageString);
            console.log(`[RELAY:${relayUrl}] Event published successfully`, {
                id: event.id,
                kind: event.kind,
                created_at: new Date(event.created_at * 1000).toISOString()
            });
        } catch (error) {
            console.error(`[ERROR:${relayUrl}] Failed to publish event:`, error);
            throw error;
        }
    }

    // Enhanced subscription handling
    publishSubscription(ws, subId, filter, relayUrl) {
        try {
            // Validate required parameters
            if (!ws || !subId || !filter || !relayUrl) {
                throw new Error('Missing required parameters for subscription');
            }
    
            console.log(`[RELAY:${relayUrl}] Creating subscription ${subId}:`, filter);
    
            // Properly stringify the filter object first
            const filterString = JSON.stringify(filter);
            // Parse it back to ensure proper formatting
            const message = ["REQ", subId, JSON.parse(filterString)];
            const messageString = JSON.stringify(message);
            
            console.log(`[RELAY:${relayUrl}] Publishing subscription:`, messageString);
            ws.send(messageString);
            
            // Get existing subscription data if it exists
            const existingSubscription = this.subscriptions.get(subId);
            
            // Store subscription details, preserving any existing metadata
            this.subscriptions.set(subId, {
                ...existingSubscription,
                filter,
                relayUrl,
                timestamp: Date.now()
            });
    
            return true;
        } catch (error) {
            console.error(`[ERROR:${relayUrl}] Failed to publish subscription:`, error);
            throw error; // Propagate error to caller
        }
    }

    // Enhanced WebSocket handlers
    setupWebSocketHandlers(ws, relayUrl, pubkey, privkey, gatewayName, gatewayAbout, relayList, gatewayDirectoryId) {
        ws.on('open', async () => {
            try {
                console.log(`[RELAY:${relayUrl}] Connection established`);
                this.relayConnections.set(relayUrl, ws);
    
                // Publish profile event only
                const profileEvent = await this.createNostrEvent(
                    0,
                    JSON.stringify({ name: gatewayName, about: gatewayAbout }),
                    [],
                    pubkey,
                    privkey
                );
                this.publishEvent(ws, profileEvent, relayUrl);
    
                // Set up subscriptions first
                await this.setupSubscriptions(ws, pubkey, gatewayDirectoryId, relayUrl);
                
                // Process events after subscriptions are set up
                await this.handleKind10002Events(pubkey, privkey, relayUrl);
                await this.handleKind30000Events(pubkey, privkey, relayUrl);
            } catch (error) {
                console.error(`[ERROR:${relayUrl}] Failed in WebSocket open handler:`, error);
            }
        });
    
        ws.on('message', (data) => {
            try {
                const message = JSON.parse(data);
                const [messageType, ...messageContent] = message;
                
                console.log(`[RELAY:${relayUrl}] Received ${messageType}`);
                this.handleRelayMessage(message, relayUrl);
            } catch (error) {
                console.error(`[ERROR:${relayUrl}] Message processing error:`, error);
                console.error('[ERROR] Raw message:', data.toString());
            }
        });
    
        ws.on('error', (error) => {
            console.error(`[ERROR:${relayUrl}] WebSocket error:`, error);
        });
    
        ws.on('close', () => {
            console.log(`[RELAY:${relayUrl}] Connection closed`);
            this.relayConnections.delete(relayUrl);
        });
    }



    // Enhanced subscription setup
    setupSubscriptions(ws, pubkey, gatewayDirectoryId, relayUrl) {
        try {
            console.log(`[RELAY:${relayUrl}] Setting up subscriptions`);

            // Kind 10002 subscription
            const subId10002 = this.generateSubscriptionId();
            const filter10002 = {
                authors: [pubkey],
                kinds: [10002],
                limit: 1
            };
            this.publishSubscription(ws, subId10002, filter10002, relayUrl);

            // Kind 30000 subscription
            const subId30000 = this.generateSubscriptionId();
            const filter30000 = {
                authors: [pubkey],
                kinds: [30000],
                '#d': [gatewayDirectoryId]
            };
            this.publishSubscription(ws, subId30000, filter30000, relayUrl);
        } catch (error) {
            console.error(`[ERROR:${relayUrl}] Failed to setup subscriptions:`, error);
        }
    }

    // Enhanced message handling
    handleRelayMessage(message, relayUrl) {
        try {
            const [messageType, ...messageContent] = message;
            console.log(`[RELAY:${relayUrl}] Received ${messageType}`);
    
            switch (messageType) {
                case 'EVENT':
                    const event = messageContent[1] || messageContent[0];
                    if (!event) {
                        throw new Error('No event data in message');
                    }
                    this.handleEventMessage(event, relayUrl);
                    break;
                case 'EOSE':
                    console.log(`[RELAY:${relayUrl}] End of stored events for subscription ${messageContent[0]}`);
                    break;
                case 'OK':
                    const [eventId, success, msg] = messageContent;
                    console.log(`[RELAY:${relayUrl}] Event ${eventId} ${success ? 'accepted' : 'rejected'}: ${msg || ''}`);
                    break;
                case 'NOTICE':
                    console.log(`[RELAY:${relayUrl}] Notice: ${messageContent[0]}`);
                    break;
                default:
                    console.log(`[RELAY:${relayUrl}] Unhandled message type: ${messageType}`);
            }
        } catch (error) {
            console.error(`[ERROR:${relayUrl}] Message processing error:`, {
                error: error.message,
                rawMessage: JSON.stringify(message)
            });
        }
    }

    // Update handling for specific events
    handleEventMessage(event, relayUrl) {
        try {
            if (!event || typeof event !== 'object') {
                throw new Error('Invalid event object');
            }
    
            // Ensure created_at is a valid number
            const timestamp = typeof event.created_at === 'number' 
                ? event.created_at * 1000
                : Date.now();
    
            console.log(`[RELAY:${relayUrl}] Processing event:`, {
                kind: event.kind,
                id: event.id,
                pubkey: event.pubkey,
                created_at: new Date(timestamp).toISOString()
            });
    
            // Store valid events in relayResponses
            if ((event.kind === 10002 || event.kind === 30000) && 
                !Array.from(this.relayResponses).some(resp => resp.id === event.id)) {
                this.relayResponses.add(event);
            }
        } catch (error) {
            console.error(`[ERROR:${relayUrl}] Error processing event:`, {
                error: error.message,
                eventId: event?.id,
                kind: event?.kind,
                created_at: event?.created_at
            });
        }
    }


    // network_stats file update methods 
    async updateNetworkStatsRelays(relays, pubkey = null, preferredRelays = null) {
        try {
            console.log('[STATS] Updating network stats');
            const statsPath = './writer-dir/network_stats.json';
            let statsData = {};
            
            if (fs.existsSync(statsPath)) {
                statsData = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
            }
    
            // Initialize relays object if it doesn't exist
            statsData.relays = statsData.relays || {};
            
            // Update global relay list
            if (relays) {
                statsData.gateway_kind_10002_relays = relays;
            }
    
            // Update pubkey-specific preferred relays if provided
            if (pubkey && preferredRelays) {
                statsData.relays[pubkey] = statsData.relays[pubkey] || {};
                statsData.relays[pubkey].preferred_relays = preferredRelays;
                console.log(`[STATS] Updated preferred relays for pubkey ${pubkey}:`, preferredRelays);
            }
    
            fs.writeFileSync(statsPath, JSON.stringify(statsData, null, 2));
            console.log('[STATS] Successfully updated network stats');
        } catch (error) {
            console.error('[ERROR] Failed to update network stats:', error);
            throw error;
        }
    }

    async updateGatewayConfig(pubkey, directoryData) {
        try {
            console.log('[CONFIG] Updating gateway config with directory data');
            
            // Use the stored config file path instead of constructing a new one
            if (!this.configFile) {
                throw new Error('No gateway configuration file available');
            }
    
            if (!fs.existsSync(this.configFile)) {
                throw new Error(`Config file ${this.configFile} not found`);
            }
    
            let configData = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
            
            // Verify the pubkey matches our config (convert if necessary)
            const configPubkeyHex = this.convertPublicKey(configData.npub);
            const receivedPubkeyHex = pubkey.toLowerCase();
    
            if (configPubkeyHex !== receivedPubkeyHex) {
                console.log('[CONFIG] Received event from different pubkey, skipping update', {
                    expected: configPubkeyHex,
                    received: receivedPubkeyHex
                });
                return false;
            }
    
            configData.gateway_kind_30000_directory_data = directoryData;
            fs.writeFileSync(this.configFile, JSON.stringify(configData, null, 2));
            console.log('[CONFIG] Successfully updated gateway config with directory data:', directoryData);
            return true;
        } catch (error) {
            console.error('[ERROR] Failed to update gateway config:', error);
            throw error;
        }
    }

    async updateGatewayDirectory(relayPubkey) {
        try {
            console.log('[DIRECTORY] Starting gateway directory update for relay:', relayPubkey);
            
            if (!this.initialized) {
                throw new Error('NostrInitializer not initialized');
            }
    
            // Read current config
            const configData = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
            
            // Convert relay pubkey if needed
            const hexPubkey = this.convertPublicKey(relayPubkey);
            
            // Check if this relay pubkey is already in our directory
            const currentRelays = configData.gateway_kind_30000_directory_relays || [];
            if (currentRelays.includes(hexPubkey)) {
                console.log('[DIRECTORY] Relay already in directory:', hexPubkey);
                return true;
            }
    
            // Add the new relay pubkey to our directory
            const updatedRelays = [...new Set([...currentRelays, hexPubkey])];
            configData.gateway_kind_30000_directory_relays = updatedRelays;
    
            // Save updated config
            fs.writeFileSync(this.configFile, JSON.stringify(configData, null, 2));
    
            // Find the kind 10002 subscription ID
            const subId10002 = Array.from(this.subscriptions.keys())
                .find(id => this.subscriptions.get(id).filter.kinds?.includes(10002));
            
            if (subId10002) {
                console.log('[SUB] Updating subscription filters with new directory relay pubkey');
                await this.updateSubscriptionFilters(subId10002, [hexPubkey]);
            } else {
                console.log('[SUB] No kind 10002 subscription found for update');
            }
    
            // Create and publish updated directory event
            const hexPrivkey = this.convertPrivateKey(configData.nsec);
            const ownerPubkey = this.convertPublicKey(configData.npub);
    
            await this.publishDirectoryEvent(
                ownerPubkey,
                hexPrivkey,
                configData.name,
                configData.about,
                configData.gateway_kind_30000_directory_id,
                updatedRelays
            );
    
            console.log('[DIRECTORY] Successfully updated gateway directory with new relay:', hexPubkey);
            return true;
        } catch (error) {
            console.error('[ERROR] Failed to update gateway directory:', error);
            throw error;
        }
    }



// Initialize method remains largely unchanged but with enhanced logging
async initialize() {
    try {
        // Prevent duplicate initialization
        if (this.initialized) {
            console.log('[INIT] NostrInitializer already initialized, skipping...');
            return true;
        }

        console.log('[INIT] Starting initialization process');
        
        if (!this.configFile) {
            throw new Error('No gateway configuration file provided');
        }

        if (!fs.existsSync(this.configFile)) {
            throw new Error(`Configuration file not found at: ${this.configFile}`);
        }

        const configData = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
        const { npub, nsec, name, about, gateway_kind_10002_relays: relayList, gateway_kind_30000_directory_id: gatewayDirectoryId } = configData;

        if (!npub || !nsec || !name || !about || !relayList || !Array.isArray(relayList) || relayList.length === 0 || !gatewayDirectoryId) {
            console.error('[CONFIG] Invalid configuration values:', {
                hasNpub: !!npub,
                hasNsec: !!nsec,
                hasName: !!name,
                hasAbout: !!about,
                hasRelayList: !!relayList,
                relayListIsArray: Array.isArray(relayList),
                relayCount: relayList?.length,
                hasDirectoryId: !!gatewayDirectoryId
            });
            return false;
        }

        // Convert keys
        const hexPubkey = this.convertPublicKey(npub);
        const hexPrivkey = this.convertPrivateKey(nsec);
        
        console.log('[CONFIG] Configuration loaded successfully:', {
            configFile: this.configFile,
            hexPubkeyLength: hexPubkey.length,
            hexPrivkeyLength: hexPrivkey.length,
            relayCount: relayList.length,
            gatewayName: name
        });

        if (hexPubkey.length !== 64 || hexPrivkey.length !== 64) {
            throw new Error('Invalid key length after conversion');
        }

        // Connect to relays
        console.log('[RELAYS] Establishing relay connections...');
        for (const relayUrl of relayList) {
            // Skip if already connected
            if (this.relayConnections.has(relayUrl)) {
                console.log(`[RELAY:${relayUrl}] Connection already exists, skipping...`);
                continue;
            }

            console.log(`[RELAY:${relayUrl}] Initiating connection`);
            const ws = new WebSocket(relayUrl);
            this.setupWebSocketHandlers(ws, relayUrl, hexPubkey, hexPrivkey, name, about, relayList, gatewayDirectoryId);
        }

        // Mark as initialized
        this.initialized = true;
        return true;
    } catch (error) {
        console.error('[ERROR] Initialization failed:', error);
        return false;
    }
}

static async createInstance(configFile) {
    // Use a static instance tracking variable
    if (!NostrInitializer._instance) {
        NostrInitializer._instance = new NostrInitializer(configFile);
        await NostrInitializer._instance.initialize();
    }
    return NostrInitializer._instance;
}


// Enhanced periodic checks
startPeriodicChecks(hexPubkey, hexPrivkey, name, about, relayList, gatewayDirectoryId) {
    console.log('[MONITOR] Starting periodic connection checks');
    setInterval(() => {
        console.log('[MONITOR] Running connection health check');
        for (const [url, ws] of this.relayConnections.entries()) {
            if (ws.readyState === WebSocket.CLOSED) {
                console.log(`[RELAY:${url}] Detected closed connection, attempting reconnection`);
                this.relayConnections.delete(url);
                const newWs = new WebSocket(url);
                this.setupWebSocketHandlers(newWs, url, hexPubkey, hexPrivkey, name, about, relayList, gatewayDirectoryId);
            }
        }
        this.logConnectionStatus();
    }, 60000);
}

// New method to log connection status
logConnectionStatus() {
    console.log('\n[STATUS] Current Connection Status:');
    let active = 0, connecting = 0, closed = 0, closing = 0;

    for (const [url, ws] of this.relayConnections.entries()) {
        const status = ws.readyState;
        const statusText = this.getWebSocketState(status);
        console.log(`[STATUS] ${url}: ${statusText}`);
        
        switch (status) {
            case WebSocket.OPEN: active++; break;
            case WebSocket.CONNECTING: connecting++; break;
            case WebSocket.CLOSED: closed++; break;
            case WebSocket.CLOSING: closing++; break;
        }
    }

    console.log('[STATUS] Summary:', {
        active,
        connecting,
        closing,
        closed,
        total: this.relayConnections.size
    });
}

getWebSocketState(state) {
    switch (state) {
        case WebSocket.CONNECTING: return 'CONNECTING';
        case WebSocket.OPEN: return 'OPEN';
        case WebSocket.CLOSING: return 'CLOSING';
        case WebSocket.CLOSED: return 'CLOSED';
        default: return 'UNKNOWN';
    }
}

// Update the module exports
}

module.exports = {
    NostrInitializer,
    createDirectoryUpdater: async (configFile) => {
        try {
            console.log('[UPDATER] Initializing directory updater');
            if (!configFile) {
                throw new Error('Configuration file path must be provided to createDirectoryUpdater');
            }

            // Use the singleton instance
            const initializer = await NostrInitializer.createInstance(configFile);
            if (!initializer) {
                throw new Error('Failed to create NostrInitializer instance');
            }
            
            console.log('[UPDATER] Directory updater initialized successfully');
            
            return {
                updateDirectory: async (npub) => {
                    try {
                        if (!npub) {
                            throw new Error('No pubkey provided to updateDirectory');
                        }
                        
                        console.log('[UPDATER] Processing directory update for pubkey:', npub);
                        
                        if (!initializer.updateGatewayDirectory) {
                            throw new Error('updateGatewayDirectory method not found on initializer');
                        }
                        
                        const result = await initializer.updateGatewayDirectory(npub);
                        console.log('[UPDATER] Directory update completed successfully');
                        return result;
                    } catch (error) {
                        console.error('[UPDATER] Directory update failed:', error.message);
                        throw error; // Re-throw to allow proper error handling upstream
                    }
                }
            };
        } catch (error) {
            console.error('[ERROR] Failed to create directory updater:', error);
            throw error;
        }
    }
};
