/**
 * NostrIntegration.js
 * Integrates the existing UI with the NostrGroupClient
 * This serves as a bridge between the old App logic and the new NostrGroupClient
 * With improved filtering to reduce relay traffic
 * Enhanced to support Hypertuna relay groups
 */

import NostrGroupClient from './NostrGroupClient.js';
import { NostrUtils } from './NostrUtils.js';

const electronAPI = window.electronAPI || null;
const isElectron = !!electronAPI;

function sendWorkerMessage(message) {
    if (!isElectron || !electronAPI?.sendToWorker) {
        return Promise.resolve({ success: false, error: 'Worker bridge unavailable' });
    }
    return electronAPI.sendToWorker(message);
}

class NostrIntegration {
    constructor(app) {
        this.app = app; // Reference to the existing App object
        this.client = new NostrGroupClient();
        this.relayUrls = [
            // Default relays - can be configured by the user
            'wss://relay.nostr.band'
        ];
        
        // Track last update to prevent excessive updates
        this.lastGroupUpdateTime = 0;
        this.updateThrottleTime = 1000; // 1 second throttle
    
        // Prevent repeated connection attempts
        this.connecting = false;
        
        // Add timeout trackers for debouncing
        this._memberUpdateTimeout = null;
        this._workerUpdateTimeout = null;

        // Track whether we've populated the groups list at least once
        this._initialGroupsLoaded = false;
    }
    
    /**
     * Initialize the nostr integration
     * @param {Object} user - User object with privateKey and pubkey
     * @returns {Promise} - Resolves when initialized
     */
    async init(user) {
        // Set up event listeners
        this._setupEventListeners();
        
        // Initialize client with discovery relays only
        await this.client.initWithDiscoveryRelays(user, this.relayUrls);
        
        // Update relay status in UI
        this._updateRelayStatus();
        
        return this;
    }
    
    // Add method to check if connected to a group's relay
    isConnectedToGroupRelay(groupId) {
        return this.client.groupRelayUrls.has(groupId);
    }
    
    // Add method to manually connect to a group relay
    async connectToGroupRelay(groupId, relayUrl) {
        await this.client.connectToGroupRelay(groupId, relayUrl);
    }

    registerRelayMapping(relayKey, publicIdentifier) {
        this.client.registerRelayMapping(relayKey, publicIdentifier);
    }

    /**
     * Handle relay ready notification from worker
     */
    handleRelayInitialized(identifier, gatewayUrl, authToken = null) {
        if (this.client) {
            this.client.handleRelayInitialized(identifier, gatewayUrl, authToken);
        }
    }

    /**
     * Handle relay registered notification from worker
     */
    handleRelayRegistered(identifier) {
        if (this.client) {
            this.client.handleRelayRegistered(identifier);
        }
    }
    
    /**
     * Handle all relays ready notification
     */
    handleAllRelaysReady() {
        if (this.client) {
            this.client.handleAllRelaysReady();
        }
    }

    /**
     * Wait for relays to be ready before loading groups
     */
    async waitForRelaysAndLoadGroups() {
        return new Promise((resolve) => {
            let timeout;
            
            const checkAndLoad = () => {
                if (this.app.currentPage === 'groups') {
                    this.app.loadGroups();
                    resolve();
                }
            };
            
            // Listen for relays ready event
            this.client.once('relays:ready', () => {
                clearTimeout(timeout);
                checkAndLoad();
            });
            
            // Set a timeout to load anyway after 10 seconds
            timeout = setTimeout(() => {
                console.log('[NostrIntegration] Timeout waiting for relays, loading groups anyway');
                checkAndLoad();
            }, 10000);
        });
    }

    /**
     * Set up event listeners for the client
     * @private
     */
    _setupEventListeners() {
        // Relay connection events
        this.client.on('event', ({ event }) => {
            console.log(`Received event: kind=${event.kind}, id=${event.id.substring(0, 8)}...`);
        });

        this.client.on('relay:connect', ({ relayUrl }) => {
            console.log(`Connected to relay: ${relayUrl}`);
            this._updateRelayStatus();
            if (typeof this.app.renderDiscoveryRelays === 'function') {
                this.app.renderDiscoveryRelays();
            }
        });
        
        this.client.on('relay:disconnect', ({ relayUrl }) => {
            console.log(`Disconnected from relay: ${relayUrl}`);
            this._updateRelayStatus();
            if (typeof this.app.renderDiscoveryRelays === 'function') {
                this.app.renderDiscoveryRelays();
            }
        });
        
        // Group events - with throttling to prevent excessive updates
        this.client.on('group:metadata', ({ groupId, group }) => {
            console.log(`Updated group metadata for: ${groupId}`);
            this._throttledGroupUpdate();
        });
        
        this.client.on('group:members', ({ groupId, members }) => {
            console.log(`Updated group members for: ${groupId}`);
            
            // Only update if viewing this specific group
            if (this.app.currentPage === 'group-detail' && 
                this.app.currentGroupId === groupId) {
                
                // Clear any pending member update
                if (this._memberUpdateTimeout) {
                    clearTimeout(this._memberUpdateTimeout);
                }
                
                // Debounce the update to prevent rapid re-renders
                this._memberUpdateTimeout = setTimeout(() => {
                    // Use loadGroupMembers instead of renderMembersList
                    // This ensures proper cleanup and re-initialization
                    this.app.loadGroupMembers();
                    delete this._memberUpdateTimeout;
                }, 300);
            }
            
            // Still throttle general group updates
            this._throttledGroupUpdate();
        
            // Send update to worker if available
            if (isElectron) {
                // Debounce worker updates too
                if (this._workerUpdateTimeout) {
                    clearTimeout(this._workerUpdateTimeout);
                }
                
                this._workerUpdateTimeout = setTimeout(() => {
                    const relayKey = this.client.publicToInternalMap?.get(groupId) || null;
                    const msg = {
                        type: 'update-members',
                        data: {
                            relayKey,
                            publicIdentifier: groupId,
                            members: members.map(m => m.pubkey)
                        }
                    };
                    sendWorkerMessage(msg).catch((err) => {
                        console.error('Failed to send update-members message:', err);
                    });
                    delete this._workerUpdateTimeout;
                }, 500); // Slightly longer delay for worker updates
            }
        });
        
        this.client.on('group:admins', ({ groupId, admins }) => {
            console.log(`Updated group admins for: ${groupId}`);
            this._throttledGroupUpdate();
        });
        
        this.client.on('group:message', ({ groupId, message }) => {
            console.log(`New message in group: ${groupId}`);
            
            // Only refresh messages if viewing this group
            if (this.app.currentPage === 'group-detail' && this.app.currentGroupId === groupId) {
                // Use setTimeout to batch updates
                setTimeout(() => {
                    this.app.loadGroupMessages();
                }, 500);
            }
        });
        
        // Profile updates
        this.client.on('profile:update', ({ pubkey, profile }) => {
            console.log(`Updated profile for: ${pubkey}`);
            // If it's the current user, update the profile display
            if (this.app.currentUser && pubkey === this.app.currentUser.pubkey) {
                this.app.updateProfileDisplay();
            }
        });
        
        // Hypertuna events
        this.client.on('hypertuna:relay', ({ hypertunaId, groupId }) => {
            console.log(`Received Hypertuna relay event for group ${groupId} with ID ${hypertunaId}`);
            this._throttledGroupUpdate();
        });

        this.client.on('relaylist:update', ({ ids }) => {
            console.log('User relay list updated:', ids);
            const shouldRefresh = this.app.currentPage === 'groups' || !this._initialGroupsLoaded;
            if (shouldRefresh && typeof this.app.loadGroups === 'function') {
                this._initialGroupsLoaded = true;
                this.app.loadGroups();
            }
        });

        // Invite updates
        this.client.on('invites:update', ({ invites }) => {
            if (typeof this.app.updateInviteSummary === 'function') {
                this.app.updateInviteSummary(invites);
            }
        });

        // Join request updates
        this.client.on('joinrequests:update', ({ groupId, requests }) => {
            if (typeof this.app.updateJoinRequests === 'function') {
                this.app.updateJoinRequests(groupId, requests);
            }
        });
    }
    
    /**
     * Throttle group updates to prevent excessive refreshes
     * @private
     */
    _throttledGroupUpdate() {
        const now = Date.now();
        if (now - this.lastGroupUpdateTime > this.updateThrottleTime) {
            this.lastGroupUpdateTime = now;

            const shouldRefreshGroups = this.app.currentPage === 'groups' || !this._initialGroupsLoaded;
            if (shouldRefreshGroups && typeof this.app.loadGroups === 'function') {
                this._initialGroupsLoaded = true;
                this.app.loadGroups();
            }
            
            // Refresh group details if viewing a group
            if (this.app.currentPage === 'group-detail') {
                this.app.loadGroupDetails();
            }
        }
    }
    
    /**
     * Update relay status display in the UI
     * @private
     */
    _updateRelayStatus() {
        const relayStatus = document.getElementById('relay-status');
        if (!relayStatus) return;
        
        const connectedRelays = this.client.relayManager.getRelays().filter(url => 
            this.client.relayManager.getRelayStatus(url) === 'open'
        );
        
        if (connectedRelays.length > 0) {
            relayStatus.className = 'alert alert-success';
            relayStatus.innerHTML = `Connected to ${connectedRelays.length} relay(s):<br>
                ${connectedRelays.join('<br>')}`;
        } else {
            relayStatus.className = 'alert alert-error';
            relayStatus.textContent = 'Not connected to any relays';
        }
    }
    
    /**
     * Add or update relay URLs for connection
     * @param {Array} urls - Array of relay URLs
     * @returns {Promise} - Resolves when connected
     */
    async updateRelays(urls) {
        // Store the new relay URLs
        this.relayUrls = urls;
        
        // First, disconnect from any relays not in the new list
        const relayManager = this.client.relayManager;
        const desiredMap = new Map();

        urls.forEach((entry) => {
            const { cleanUrl } = relayManager.parseRelayUrl(entry);
            let connectionUrl = entry;

            if (!/^wss?:\/\//i.test(connectionUrl)) {
                connectionUrl = cleanUrl.startsWith('wss://') || cleanUrl.startsWith('ws://')
                    ? cleanUrl
                    : `wss://${cleanUrl}`;
            }

            const normalizedKey = cleanUrl.startsWith('wss://') || cleanUrl.startsWith('ws://')
                ? cleanUrl
                : `wss://${cleanUrl}`;

            desiredMap.set(normalizedKey, connectionUrl);
        });

        const currentRelays = relayManager.getRelays();
        currentRelays.forEach(url => {
            if (!desiredMap.has(url)) {
                relayManager.removeRelay(url);
            }
        });

        const connectPromises = [];
        desiredMap.forEach((connectionUrl) => {
            connectPromises.push(relayManager.addTypedRelay(connectionUrl, 'discovery'));
        });

        await Promise.allSettled(connectPromises);
        
        this._updateRelayStatus();
    }

    /**
     * Get only joined groups (not discovered)
     * @returns {Array} - Array of groups user has joined
     */
    getJoinedGroups() {
        return this.client.getJoinedGroups();
    }
    
    /**
     * Connect to relays
     * @returns {Promise} - Resolves when connected
     */
    async connectRelay() {
        if (!this.app.currentUser) {
            throw new Error('User not logged in');
        }
        if (this.connecting) {
            console.log('Already connecting to relays, aborting duplicate call');
            return;
        }

        const connected = this.client.relayManager.getRelays().some(url =>
            this.client.relayManager.getRelayStatus(url) === 'open'
        );
        if (connected) {
            console.log('Relays already connected');
            return;
        }

        this.connecting = true;
        try {
            await this.client.init(this.app.currentUser, this.relayUrls);
        } finally {
            this.connecting = false;
        }
        this._updateRelayStatus();
    }
    
    /**
     * Get all available groups
     * @returns {Array} - Array of groups
     */
    getGroups() {
        return this.client.getGroups();
    }
    
    /**
     * Get a specific group by ID
     * @param {string} groupId - Group ID
     * @returns {Object|null} - Group data or null if not found
     */
    getGroupById(groupId) {
        return this.client.getGroupById(groupId);
    }
    
    /**
     * Get members of a group
     * @param {string} groupId - Group ID
     * @returns {Array} - Array of member objects
     */
    getGroupMembers(groupId) {
        return this.client.getGroupMembers(groupId);
    }
    
    /**
     * Get admins of a group
     * @param {string} groupId - Group ID
     * @returns {Array} - Array of admin objects
     */
    getGroupAdmins(groupId) {
        return this.client.getGroupAdmins(groupId);
    }
    
    /**
     * Check if a user is a member of a group
     * @param {string} groupId - Group ID
     * @param {string} pubkey - Public key
     * @returns {boolean} - Whether the user is a member
     */
    isGroupMember(groupId, pubkey) {
        return this.client.isGroupMember(groupId, pubkey);
    }
    
    /**
     * Check if a user is an admin of a group
     * @param {string} groupId - Group ID
     * @param {string} pubkey - Public key
     * @returns {boolean} - Whether the user is an admin
     */
    isGroupAdmin(groupId, pubkey) {
        return this.client.isGroupAdmin(groupId, pubkey);
    }
    
    /**
     * Get messages for a group
     * @param {string} groupId - Group ID
     * @returns {Array} - Array of message events
     */
    getGroupMessages(groupId) {
        return this.client.getGroupMessages(groupId);
    }

    getUserRelayGroupIds() {
        return this.client.getUserRelayGroupIds();
    }

    areRelayIdsReady() {
        return this.client.isRelayListReady();
    }
    
    /**
     * Create a new group
     * @param {string} name - Group name
     * @param {string} about - Group description
     * @param {boolean} isPublic - Whether the group is public
     * @param {boolean} isOpen - Whether the group is open to join
     * @param {string} [authenticatedRelayUrl] - Tokenized relay URL from the worker
     * @returns {Promise<Object>} - Create group events collection
     */
    async createGroup(name, about, isPublic, isOpen, relayKey, proxyServer, proxyProtocol, npub, authenticatedRelayUrl = null, fileSharing = false, options = {}) {
        try {
            // Validate inputs
            if (typeof name !== 'string') {
                throw new Error('Group name must be a string');
            }
            if (about !== undefined && typeof about !== 'string') {
                throw new Error('Group description must be a string');
            }
            if (isPublic !== undefined && typeof isPublic !== 'boolean') {
                throw new Error('isPublic must be a boolean');
            }
            if (isOpen !== undefined && typeof isOpen !== 'boolean') {
                throw new Error('isOpen must be a boolean');
            }
            
            console.log("NostrIntegration creating group:", { name, about, isPublic, isOpen, npub, authenticatedRelayUrl, fileSharing });
        
            const eventsCollection = await this.client.createGroup({
                name,
                about,
                isPublic,
                isOpen,
                relayKey,
                proxyServer,
                proxyProtocol,
                npub,
                authenticatedRelayUrl,
                fileSharing,
                avatar: options.avatar || null
            });
            
            console.log('Group created successfully with the following events:');
            console.log(`- Group Create Event (kind 9007): ${eventsCollection.groupCreateEvent.id.substring(0, 8)}...`);
            console.log(`- Group Metadata Event (kind 39000): ${eventsCollection.metadataEvent.id.substring(0, 8)}...`);
            console.log(`- Hypertuna Relay Event (kind 30166): ${eventsCollection.hypertunaEvent.id.substring(0, 8)}...`);
            
            return eventsCollection;
        } catch (error) {
            console.error('Error creating group:', error);
            throw error;
        }
    }
    
    
    
    /**
     * Join a group
     * @param {string} groupId - Group ID
     * @param {string} inviteCode - Optional invite code for closed groups
     * @returns {Promise<Object>} - Join request event
     */
    async joinGroup(groupId, inviteCode = null, options = {}) {
        return await this.client.joinGroup(groupId, inviteCode, options);
    }
    
    /**
     * Leave a group
     * @param {string} groupId - Group ID
     * @returns {Promise<Object>} - Leave request event
     */
    async leaveGroup(groupId) {
        return await this.client.leaveGroup(groupId);
    }
    
    /**
     * Send a message to a group
     * @param {string} groupId - Group ID
     * @param {string} content - Message content
     * @returns {Promise<Object>} - Message event
     */
    async sendGroupMessage(groupId, content, filePath = '') {
        return await this.client.sendGroupMessage(groupId, content, filePath);
    }
    
    /**
     * Create an invite code for a group
     * @param {string} groupId - Group ID
     * @returns {Promise<Object>} - Invite creation event
     */
    async createGroupInvite(groupId) {
        return await this.client.createGroupInvite(groupId);
    }
    
    /**
     * Add a member to a group or update their role
     * @param {string} groupId - Group ID
     * @param {string} pubkey - Public key of the user to add
     * @param {Array} roles - Array of roles to assign
     * @returns {Promise<Object>} - Put user event
     */
    async addGroupMember(groupId, pubkey, roles = ['member']) {
        return await this.client.addGroupMember(groupId, pubkey, roles);
    }
    
    /**
     * Remove a member from a group
     * @param {string} groupId - Group ID
     * @param {string} pubkey - Public key of the user to remove
     * @returns {Promise<Object>} - Remove user event
     */
    async removeGroupMember(groupId, pubkey) {
        return await this.client.removeGroupMember(groupId, pubkey);
    }

    async approveJoinRequest(groupId, pubkey) {
        return await this.client.approveJoinRequest(groupId, pubkey);
    }

    async inviteMembers(groupId, pubkeys = []) {
        return await this.client.inviteMembers(groupId, pubkeys);
    }

    rejectJoinRequest(groupId, pubkey) {
        this.client.rejectJoinRequest(groupId, pubkey);
    }
    
    /**
     * Update group metadata
     * @param {string} groupId - Group ID
     * @param {Object} metadata - Updated metadata
     * @returns {Promise<Object>} - Collection of metadata update events
     */
    async updateGroupMetadata(groupId, metadata, options = {}) {
        try {
            const events = await this.client.updateGroupMetadata(groupId, metadata, options);
            
            if (events.updatedMetadataEvent) {
                console.log('Group metadata updated successfully:');
                console.log(`- Group Metadata Edit Event (kind 9002): ${events.editEvent.id.substring(0, 8)}...`);
                console.log(`- Updated Group Metadata Event (kind 39000): ${events.updatedMetadataEvent.id.substring(0, 8)}...`);
            } else {
                console.log('Group metadata updated using legacy method');
            }
            
            return events;
        } catch (error) {
            console.error('Error updating group metadata:', error);
            throw error;
        }
    }
    
    /**
     * Delete a group
     * @param {string} groupId - Group ID
     * @returns {Promise<Object>} - Delete group event
     */
    async deleteGroup(groupId) {
        return await this.client.deleteGroup(groupId);
    }
    
    /**
     * Update the updateProfile method in NostrIntegration.js
     * Replace the existing updateProfile method with this one
     */
    async updateProfile(profile, options = {}) {
        const maxAttempts = 3;
        let attempt = 0;
        let lastError = null;

        while (attempt < maxAttempts) {
            try {
                const event = await this.client.updateProfile(profile, options);
                console.log("Profile update published:", {
                    id: event.id,
                    kind: event.kind,
                    created_at: event.created_at
                });

                // Give relays a brief moment to propagate the change
                await new Promise(resolve => setTimeout(resolve, 1000));

                return event;
            } catch (error) {
                attempt++;
                lastError = error;
                console.warn(`Profile update attempt ${attempt} failed:`, error);

                if (attempt >= maxAttempts) {
                    break;
                }

                const waitTime = Math.pow(2, attempt) * 1000; // 2s, 4s, 8s...
                console.log(`Retrying in ${waitTime}ms...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        console.error("Error updating profile:", lastError);
        if (lastError) {
            throw lastError;
        }
        throw new Error("Failed to update profile after multiple attempts");
    }

}

export default NostrIntegration;
