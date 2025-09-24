/**
 * AppIntegration.js
 * Modifies the existing App to use real nostr relays
 * Enhanced with support for Hypertuna relay groups
 */

import NostrIntegration from './NostrIntegration.js';
import { NostrUtils } from './NostrUtils.js';
import { HypertunaUtils } from './HypertunaUtils.js';
import { ConfigLogger } from './ConfigLogger.js';
import NostrEvents from './NostrEvents.js';  // Add this import
import MembersList from './MembersList.js';

const relayReadinessTracker = new Map(); // Track relay readiness state
const electronAPI = window.electronAPI || null;
const isElectron = !!electronAPI;
const ELECTRON_CONFIG_PATH = 'electron-storage/relay-config.json';

/**
 * This function modifies the existing App object to use real nostr relays
 * Call this function after the App has been initialized
 * @param {Object} App - The existing App object
 */
function integrateNostrRelays(App) {
    console.log('Integrating nostr relays with Hypertuna support...');
    
    // Save original methods before replacing them - check if they exist first
    const originalMethods = {};
    
    // Define a list of methods to potentially save
    const methodsToSave = [
        'connectRelay', 'loadGroups', 'loadGroupDetails', 'loadGroupMessages',
        'loadGroupMembers', 'loadJoinRequests', 'createGroup', 'joinGroup', 'leaveGroup',
        'sendMessage', 'createInvite', 'addMember', 'updateMemberRole',
        'removeMember', 'approveJoinRequest', 'rejectJoinRequest', 'saveGroupSettings', 'deleteGroup', 'updateProfile',
        'login', 'generatePrivateKey', 'saveUserToLocalStorage', 
        'loadUserFromLocalStorage', 'updateProfileDisplay'
    ];
    
    // Save methods that exist
    methodsToSave.forEach(method => {
        if (typeof App[method] === 'function') {
            originalMethods[method] = App[method].bind(App);
        }
    });
    
    // Create nostr integration
    App.nostr = new NostrIntegration(App);

    // Track discovery relay connections displayed in profile UI
    App.discoveryRelays = new Map();
    App.discoveryRelayStorageKey = 'discovery_relay_whitelist';
    App.persistedDiscoveryRelays = [];
    

    
    /**
     * Enhanced login method with Hypertuna support
     * Generate and store Hypertuna keypair during login
     */
    App.login = async function() {
        const privateKeyInput = document.getElementById('privateKey').value.trim();
        
        if (!privateKeyInput) {
            alert('Please enter a valid private key or generate a new one.');
            return;
        }
        
        try {
            // Normalize the private key input (handles both hex and nsec)
            const privateKey = NostrUtils.normalizePrivateKey(privateKeyInput);
            if (!privateKey) {
                alert('Invalid private key format. Please enter a hex key or nsec format.');
                return;
            }
            
            localStorage.removeItem('explicit_logout');
            const pubkey = NostrUtils.getPublicKey(privateKey);
            
            this.currentUser = {
                privateKey,
                pubkey,
                name: 'User_' + NostrUtils.truncatePubkey(pubkey),
                about: ''
            };
            
            // Generate and save Hypertuna configuration
            try {
                // Setup Hypertuna configuration with default gateway
                const hypertunaConfig = await HypertunaUtils.setupUserConfig(this.currentUser);
                
                // Add Hypertuna configuration to user object for easy access
                this.currentUser.hypertunaConfig = hypertunaConfig;
                
                console.log('Hypertuna configuration generated:', {
                    pubkey: hypertunaConfig.nostr_pubkey_hex.substring(0, 8) + '...',
                    proxy_pubkey: hypertunaConfig.proxy_publicKey.substring(0, 8) + '...',
                    proxy_server: hypertunaConfig.proxy_server_address,
                    gatewayUrl: hypertunaConfig.gatewayUrl
                });
                
                // IMPORTANT: Sync to file system for worker
                await this.syncHypertunaConfigToFile();
                
            } catch (e) {
                console.error('Error generating Hypertuna configuration:', e);
                // Continue with login even if Hypertuna config fails
            }
            
            // Save the user data to localStorage
            this.saveUserToLocalStorage();
            this.updateProfileDisplay();
            
            // IMPORTANT: Recreate NostrIntegration if it's null
            if (!this.nostr) {
                console.log('Creating new NostrIntegration instance');
                this.nostr = new NostrIntegration(this);
            }
            
            // Initialize nostr integration if login was successful
            try {
                this.showGroupListSpinner();
                await this.nostr.init(this.currentUser);
                console.log('Nostr integration initialized');

                if (this.configureRelays) {
                    await this.configureRelays(this.nostr.relayUrls || [], { skipNetwork: true, includePersisted: true });
                }

                // Fetch the latest profile metadata so avatar images load
                try {
                    const profile = await this.nostr.client.fetchUserProfile(this.currentUser.pubkey);
                    Object.assign(this.currentUser, profile);
                    this.saveUserToLocalStorage();
                    this.updateProfileDisplay();
                } catch (err) {
                    console.error('Failed to fetch user profile after init:', err);
                }
                if (window.startWorker) {
                    try {
                        const key = await window.startWorker();
                        if (key && this.currentUser.hypertunaConfig) {
                            this.currentUser.hypertunaConfig.swarmPublicKey = key;
                            await HypertunaUtils.saveConfig(this.currentUser.hypertunaConfig);
                            this.saveUserToLocalStorage();
                            if (typeof this.updateHypertunaDisplay === 'function') {
                                this.updateHypertunaDisplay();
                            }
                        }
                        if (window.refreshGatewayStatus) {
                            await window.refreshGatewayStatus({ fetchOptions: false });
                        }
                    } catch (err) {
                        console.error('Failed to start worker:', err);
                    }
                }
            } catch (e) {
                console.error('Error initializing nostr integration:', e);
            }
            
            // Connect to relay if not already connected
            if ((!this.relay || !this.relay.isConnected()) && this.nostr) {
                this.connectRelay();
            } else {
                this.updateUIState();
            }
        } catch (e) {
            console.error('Error logging in:', e);
            alert('Error: Invalid private key format.');
        }
    };


    App.logout = function() {
        // Set a flag to indicate explicit logout
        localStorage.setItem('explicit_logout', 'true');
        
        // Disconnect from relays
        if (this.relay && this.relay.isConnected()) {
            this.relay.disconnect();
        }
        
        if (this.nostr && this.nostr.client) {
            // Properly cleanup NostrIntegration
            this.nostr.client.activeSubscriptions.forEach(subId => {
                this.nostr.client.relayManager.unsubscribe(subId);
            });
            this.nostr.client.activeSubscriptions.clear();
            
            // Disconnect from all relays with prevention flag
            this.nostr.client.relayManager.getRelays().forEach(url => {
                const relay = this.nostr.client.relayManager.relays.get(url);
                if (relay && relay.conn) {
                    relay.preventReconnect = true;
                    relay.conn.close();
                }
                this.nostr.client.relayManager.relays.delete(url);
            });
            
            // Clear the nostr integration
            this.nostr = null;
        }
        
        window.stopWorker();
        this.currentUser = null;
        this.saveUserToLocalStorage();
        this.navigateTo('auth');
        this.updateUIState();
    };
    
    /**
     * Enhanced key generation method with Hypertuna preview
     */
    App.generatePrivateKey = async function() {
        const newPrivateKey = NostrUtils.generatePrivateKey();
        document.getElementById('privateKey').value = newPrivateKey;
        
        // Preview Hypertuna configuration
        try {
            const pubkey = NostrUtils.getPublicKey(newPrivateKey);
            
            // Generate preview config without saving
            const previewConfig = await HypertunaUtils.generateHypertunaConfig(newPrivateKey, pubkey);
            
            console.log('Hypertuna preview configuration generated:', {
                pubkey: previewConfig.nostr_pubkey_hex.substring(0, 8) + '...',
                proxy_pubkey: previewConfig.proxy_publicKey.substring(0, 8) + '...',
                proxy_server: previewConfig.proxy_server_address,
                gatewayUrl: previewConfig.gatewayUrl
            });
        } catch (e) {
            console.error('Error generating Hypertuna preview configuration:', e);
        }
    };
    
    /**
     * Enhanced saveUserToLocalStorage method
     * Save Hypertuna configuration separately
     */
    App.saveUserToLocalStorage = function() {
        ConfigLogger.log('SAVE', {
            module: 'AppIntegration',
            method: 'saveUserToLocalStorage',
            attempting: true
        });
        
        if (this.currentUser) {
            // Create a clean copy of the user object without any circular references
            const userToSave = {
                privateKey: this.currentUser.privateKey,
                pubkey: this.currentUser.pubkey,
                name: this.currentUser.name,
                about: this.currentUser.about
            };
            
            // If there's Hypertuna configuration, add it to the saved user
            if (this.currentUser.hypertunaConfig) {
                userToSave.hypertunaConfig = this.currentUser.hypertunaConfig;
            }
            
            // Save user data to localStorage
            try {
                localStorage.setItem('nostr_user', JSON.stringify(userToSave));
                ConfigLogger.log('SAVE', {
                    module: 'AppIntegration',
                    method: 'saveUserToLocalStorage',
                    filepath: 'localStorage',
                    key: 'nostr_user',
                    success: true,
                    dataSize: ConfigLogger.getDataSize(userToSave)
                });
            } catch (e) {
                ConfigLogger.log('SAVE', {
                    module: 'AppIntegration',
                    method: 'saveUserToLocalStorage',
                    filepath: 'localStorage',
                    key: 'nostr_user',
                    success: false,
                    error: e.message
                });
            }
            
            // If the user has Hypertuna configuration, also save it separately
            if (this.currentUser.hypertunaConfig) {
                try {
                    localStorage.setItem('hypertuna_config', JSON.stringify(this.currentUser.hypertunaConfig));
                    ConfigLogger.log('SAVE', {
                        module: 'AppIntegration',
                        method: 'saveUserToLocalStorage',
                        filepath: 'localStorage',
                        key: 'hypertuna_config',
                        success: true,
                        dataSize: ConfigLogger.getDataSize(this.currentUser.hypertunaConfig)
                    });
                } catch (e) {
                    ConfigLogger.log('SAVE', {
                        module: 'AppIntegration',
                        method: 'saveUserToLocalStorage',
                        filepath: 'localStorage',
                        key: 'hypertuna_config',
                        success: false,
                        error: e.message
                    });
                }
            }
        } else {
            // Remove user data from localStorage
            ConfigLogger.log('DELETE', {
                module: 'AppIntegration',
                method: 'saveUserToLocalStorage',
                filepath: 'localStorage',
                key: 'nostr_user'
            });
            localStorage.removeItem('nostr_user');
        }
    };
    
    /**
 * Enhanced loadUserFromLocalStorage method
 * Load and check for Hypertuna configuration
 */
    App.loadUserFromLocalStorage = async function() {
        ConfigLogger.log('LOAD', {
            module: 'AppIntegration',
            method: 'loadUserFromLocalStorage',
            attempting: true
        });
        
        const savedUser = localStorage.getItem('nostr_user');
        const explicitLogout = localStorage.getItem('explicit_logout') === 'true';
        
        // Only load user if they haven't explicitly logged out
        if (savedUser && !explicitLogout) {
            try {
            ConfigLogger.log('LOAD', {
                module: 'AppIntegration',
                method: 'loadUserFromLocalStorage',
                filepath: 'localStorage',
                key: 'nostr_user',
                success: true,
                dataSize: savedUser.length
            });
            
            this.currentUser = JSON.parse(savedUser);
            
            // Check for Hypertuna configuration
            ConfigLogger.log('LOAD', {
                module: 'AppIntegration',
                method: 'loadUserFromLocalStorage',
                filepath: 'localStorage',
                key: 'hypertuna_config',
                attempting: true
            });
            
            const hypertunaConfig = localStorage.getItem('hypertuna_config');
            if (hypertunaConfig) {
                this.currentUser.hypertunaConfig = JSON.parse(hypertunaConfig);
                
                ConfigLogger.log('LOAD', {
                    module: 'AppIntegration',
                    method: 'loadUserFromLocalStorage',
                    filepath: 'localStorage',
                    key: 'hypertuna_config',
                    success: true,
                    dataSize: hypertunaConfig.length
                });
                
                console.log('Loaded Hypertuna configuration from localStorage:', {
                    pubkey: this.currentUser.hypertunaConfig.nostr_pubkey_hex.substring(0, 8) + '...',
                    proxy_pubkey: this.currentUser.hypertunaConfig.proxy_publicKey.substring(0, 8) + '...',
                    proxy_server: this.currentUser.hypertunaConfig.proxy_server_address,
                    gatewayUrl: this.currentUser.hypertunaConfig.gatewayUrl
                });
                
                // IMPORTANT: Sync to file system after loading
                await this.syncHypertunaConfigToFile();
                
            } else {
                ConfigLogger.log('LOAD', {
                    module: 'AppIntegration',
                    method: 'loadUserFromLocalStorage',
                    filepath: 'localStorage',
                    key: 'hypertuna_config',
                    success: false,
                    error: 'Config not found, generating new one'
                });
                
                // If no Hypertuna config exists, generate it now
                try {
                    this.currentUser.hypertunaConfig = await HypertunaUtils.setupUserConfig(this.currentUser);
                    console.log('Generated new Hypertuna configuration for existing user');
                    this.saveUserToLocalStorage();
                    
                    // IMPORTANT: Sync to file system
                    await this.syncHypertunaConfigToFile();
                    
                } catch (e) {
                    console.error('Error generating Hypertuna configuration for existing user:', e);
                }
            }
            
            this.updateProfileDisplay();
            
            // Initialize nostr integration for logged-in user
            if (this.nostr) {
                try {
                    this.showGroupListSpinner();
                    await this.nostr.init(this.currentUser);
                    console.log('Nostr integration initialized for existing user');

                    if (this.configureRelays) {
                        await this.configureRelays(this.nostr.relayUrls || [], { skipNetwork: true, includePersisted: true });
                    }

                    // Ensure local profile cache is populated so avatars display
                    try {
                        const profile = await this.nostr.client.fetchUserProfile(this.currentUser.pubkey);
                        Object.assign(this.currentUser, profile);
                        this.saveUserToLocalStorage();
                        this.updateProfileDisplay();
                    } catch (err) {
                        console.error('Failed to fetch user profile after init:', err);
                    }
                } catch (e) {
                    console.error('Error initializing nostr integration for existing user:', e);
                }
            }
        } catch (e) {
            ConfigLogger.log('LOAD', {
                module: 'AppIntegration',
                method: 'loadUserFromLocalStorage',
                filepath: 'localStorage',
                key: 'nostr_user',
                success: false,
                error: e.message
            });
            
            console.error('Error loading user data:', e);
            localStorage.removeItem('nostr_user');
        }
    } else {
        // If explicit logout, clear any saved user data
        if (explicitLogout) {
            localStorage.removeItem('nostr_user');
            localStorage.removeItem('hypertuna_config');
        }
        
        ConfigLogger.log('LOAD', {
            module: 'AppIntegration',
            method: 'loadUserFromLocalStorage',
            filepath: 'localStorage',
            key: 'nostr_user',
            success: false,
            error: explicitLogout ? 'Explicit logout detected' : 'No saved user found'
        });
    }
};
    
    /**
     * Enhanced updateProfileDisplay method
     * Display Hypertuna configuration in profile
     */
    App.updateProfileDisplay = function() {
        if (!this.currentUser) return;
        
        // Try to get profile from nostr client cache
        let profile = null;
        if (this.nostr && this.nostr.client) {
            profile = this.nostr.client.cachedProfiles.get(this.currentUser.pubkey);
        }
        
        // If no profile found, use basic info
        if (!profile) {
            profile = {
                name: this.currentUser.name || 'User_' + NostrUtils.truncatePubkey(this.currentUser.pubkey),
                about: this.currentUser.about || '',
                picture: null
            };
        }
        
        const name = profile.name || 'User_' + NostrUtils.truncatePubkey(this.currentUser.pubkey);
        
        console.log('Updating profile display with:', {
            name: profile.name,
            about: profile.about ? profile.about.substring(0, 30) + '...' : undefined,
            picture: profile.picture ? 'present' : undefined
        });
        
        // Update profile display on auth page with null checks
        const profileNameElement = document.getElementById('profile-name');
        if (profileNameElement) {
            profileNameElement.textContent = name;
        }
        
        const profilePubkeyElement = document.getElementById('profile-pubkey');
        if (profilePubkeyElement) {
            profilePubkeyElement.textContent = this.currentUser.pubkey;
        }
        
        // Update profile page with null checks
        const profileDisplayName = document.getElementById('profile-display-name');
        if (profileDisplayName) {
            profileDisplayName.textContent = name;
        }
        
        const profileDisplayPubkey = document.getElementById('profile-display-pubkey');
        if (profileDisplayPubkey) {
            profileDisplayPubkey.textContent = this.currentUser.pubkey;
        }
        
        const profileNameInput = document.getElementById('profile-name-input');
        if (profileNameInput) {
            profileNameInput.value = profile.name || '';
        }
        
        const profileAboutInput = document.getElementById('profile-about-input');
        if (profileAboutInput) {
            profileAboutInput.value = profile.about || '';
        }

        const summaryName = document.getElementById('profile-summary-name');
        if (summaryName) {
            summaryName.textContent = name || 'Display Name';
        }

        const summaryAbout = document.getElementById('profile-summary-about');
        if (summaryAbout) {
            if (profile.about) {
                summaryAbout.textContent = profile.about;
                summaryAbout.classList.remove('muted');
            } else {
                summaryAbout.textContent = 'Add something about yourself';
                summaryAbout.classList.add('muted');
            }
        }

        const profilePubkeyDisplay = document.getElementById('profile-pubkey-display');
        if (profilePubkeyDisplay) {
            // Display as npub by default
            profilePubkeyDisplay.value = NostrUtils.hexToNpub(this.currentUser.pubkey);
            profilePubkeyDisplay.dataset.format = 'npub';
            profilePubkeyDisplay.dataset.hex = this.currentUser.pubkey;
        }
        
        const profilePrivkeyDisplay = document.getElementById('profile-privkey-display');
        if (profilePrivkeyDisplay) {
            // Display as nsec by default
            profilePrivkeyDisplay.value = NostrUtils.hexToNsec(this.currentUser.privateKey);
            profilePrivkeyDisplay.dataset.format = 'nsec';
            profilePrivkeyDisplay.dataset.hex = this.currentUser.privateKey;
        }
        
        // Update profile picture if available
        const updateProfilePicture = (selector) => {
            const avatar = document.querySelector(selector);
            if (avatar) {
                if (profile.picture) {
                    console.log(`Setting profile picture from URL: ${profile.picture}`);
                    // Replace the text content with an image
                    avatar.innerHTML = `<img src="${profile.picture}" alt="${name}" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">`;
                } else {
                    console.log(`Using initials for profile avatar: ${name.charAt(0).toUpperCase()}`);
                    // Use first character of name as avatar
                    avatar.innerHTML = `<span>${name.charAt(0).toUpperCase()}</span>`;
                }
            }
        };
        
        // Update profile pictures in all locations
        updateProfilePicture('#profile-display .profile-avatar-large');
        updateProfilePicture('.page#page-profile .profile-avatar-large');
        updateProfilePicture('#profile-details-card .profile-avatar-small');

        if (typeof this.renderDiscoveryRelays === 'function') {
            this.renderDiscoveryRelays();
        }
        
        // Update Hypertuna configuration if available
        if (this.currentUser.hypertunaConfig) {
            this.updateHypertunaDisplay();
        }
        
        console.log('Profile display updated successfully');
    };
    
    /**
     * New method to update Hypertuna configuration display
     */
    App.updateHypertunaDisplay = async function() {
        if (!this.currentUser || !this.currentUser.hypertunaConfig) return;

        try {
            const config = this.currentUser.hypertunaConfig;
            const gatewaySettings = await HypertunaUtils.getGatewaySettings();
            const placeholderGateway = gatewaySettings.gatewayUrl;

            const pubkeyInput = document.getElementById('hypertuna-pubkey-display');
            if (pubkeyInput) {
                pubkeyInput.value = config.swarmPublicKey || '';
            }

            const privkeyInput = document.getElementById('hypertuna-privkey-display');
            if (privkeyInput) {
                privkeyInput.value = config.proxy_privateKey || '';
            }

            const gatewayInput = document.getElementById('hypertuna-gateway-url');
            if (gatewayInput) {
                gatewayInput.placeholder = placeholderGateway;
                gatewayInput.value = config.gatewayUrl || placeholderGateway;
            }

            const togglePrivBtn = document.getElementById('btn-toggle-hypertuna-privkey');
            if (togglePrivBtn && !togglePrivBtn.dataset.bound) {
                togglePrivBtn.addEventListener('click', () => {
                    const input = document.getElementById('hypertuna-privkey-display');
                    if (!input) return;
                    input.type = input.type === 'password' ? 'text' : 'password';
                });
                togglePrivBtn.dataset.bound = 'true';
            }

            document.querySelectorAll('#relay-node-card .copy-btn').forEach(btn => {
                if (btn.dataset.bound === 'true') return;
                btn.addEventListener('click', () => {
                    const targetId = btn.dataset.copy;
                    const target = document.getElementById(targetId);
                    if (!target) return;

                    const isPassword = target.type === 'password';
                    if (isPassword) target.type = 'text';
                    target.select();
                    document.execCommand('copy');
                    if (isPassword) target.type = 'password';

                    const originalText = btn.textContent;
                    btn.textContent = 'Copied!';
                    setTimeout(() => {
                        btn.textContent = originalText;
                    }, 2000);
                });
                btn.dataset.bound = 'true';
            });
        } catch (error) {
            console.error('[App] Failed to update Hypertuna display:', error);
        }
    };

    /**
 * Sync current user's Hypertuna config to file system
 * Call this after login or when user changes
 */
App.syncHypertunaConfigToFile = async function() {
    if (!this.currentUser || !this.currentUser.hypertunaConfig) {
        console.log('[App] No Hypertuna config to sync');
        return;
    }

    if (!isElectron || !electronAPI?.writeConfig) {
        return;
    }

    try {
        ConfigLogger.log('SAVE', {
            module: 'AppIntegration',
            method: 'syncHypertunaConfigToFile',
            filepath: ELECTRON_CONFIG_PATH,
            attempting: true,
            dataSize: ConfigLogger.getDataSize(this.currentUser.hypertunaConfig)
        });

        const result = await electronAPI.writeConfig(this.currentUser.hypertunaConfig);
        if (!result?.success) {
            throw new Error(result?.error || 'Unknown write failure');
        }

        ConfigLogger.log('SAVE', {
            module: 'AppIntegration',
            method: 'syncHypertunaConfigToFile',
            filepath: ELECTRON_CONFIG_PATH,
            success: true,
            dataSize: ConfigLogger.getDataSize(this.currentUser.hypertunaConfig)
        });

        console.log('[App] Synced Hypertuna config to persistent storage');
    } catch (e) {
        ConfigLogger.log('SAVE', {
            module: 'AppIntegration',
            method: 'syncHypertunaConfigToFile',
            filepath: ELECTRON_CONFIG_PATH,
            success: false,
            error: e.message
        });

        console.error('[App] Failed to sync config to persistent storage:', e);
    }
};
    
    /**
     * New method to update Hypertuna settings
     */
    App.updateHypertunaSettings = async function() {
        ConfigLogger.log('UPDATE', {
            module: 'AppIntegration',
            method: 'updateHypertunaSettings',
            attempting: true
        });
        
        if (!this.currentUser || !this.currentUser.hypertunaConfig) return;
        
        const gatewayInput = document.getElementById('hypertuna-gateway-url');
        const gatewayUrl = gatewayInput ? gatewayInput.value.trim() : '';

        if (!gatewayUrl) {
            alert('Please enter a valid gateway URL');
            return;
        }
        
        try {
            const updatedSettings = await HypertunaUtils.persistGatewaySettings(gatewayUrl);
            const normalizedGatewayUrl = updatedSettings.gatewayUrl;
            const proxyHost = updatedSettings.proxyHost;
            const proxyWebsocketProtocol = updatedSettings.proxyWebsocketProtocol;

            this.currentUser.hypertunaConfig.gatewayUrl = normalizedGatewayUrl;
            this.currentUser.hypertunaConfig.proxy_server_address = proxyHost;
            this.currentUser.hypertunaConfig.proxy_websocket_protocol = proxyWebsocketProtocol;

            await HypertunaUtils.saveConfig(this.currentUser.hypertunaConfig);

            try {
                localStorage.setItem('hypertuna_config', JSON.stringify(this.currentUser.hypertunaConfig));
                ConfigLogger.log('UPDATE', {
                    module: 'AppIntegration',
                    method: 'updateHypertunaSettings',
                    filepath: 'localStorage',
                    key: 'hypertuna_config',
                    success: true,
                    dataSize: ConfigLogger.getDataSize(this.currentUser.hypertunaConfig)
                });
            } catch (e) {
                ConfigLogger.log('UPDATE', {
                    module: 'AppIntegration',
                    method: 'updateHypertunaSettings',
                    filepath: 'localStorage',
                    key: 'hypertuna_config',
                    success: false,
                    error: e.message
                });
            }

            this.saveUserToLocalStorage();

            if (gatewayInput) {
                gatewayInput.value = normalizedGatewayUrl;
                gatewayInput.placeholder = normalizedGatewayUrl;
            }

            ConfigLogger.log('UPDATE', {
                module: 'AppIntegration',
                method: 'updateHypertunaSettings',
                target: 'gateway-settings',
                success: true
            });

            await this.updateHypertunaDisplay();

            alert('Hypertuna configuration updated successfully');
        } catch (error) {
            ConfigLogger.log('UPDATE', {
                module: 'AppIntegration',
                method: 'updateHypertunaSettings',
                target: 'gateway-settings',
                success: false,
                error: error.message
            });

            console.error('[App] Failed to persist Hypertuna settings:', error);
            alert(`Failed to update Hypertuna settings: ${error.message}`);
        }
    };
    
 
    /**
     * Public Relay connection method
     * Uses real WebSocket connections to nostr relays
     */
    App.connectRelay = async function() {
        try {
            if (!this.currentUser) {
                throw new Error('User not logged in');
            }
            
            // Check if nostr integration exists
            if (!this.nostr) {
                console.error('NostrIntegration not initialized');
                throw new Error('NostrIntegration not initialized. Please try logging in again.');
            }
            
            // If we're using the local relay, switch to real relays
            if (this.relay && this.relay.isConnected()) {
                this.relay.disconnect();
            }
            
            // Initialize the nostr client
            await this.nostr.connectRelay();
            
            document.getElementById('relay-status').className = 'alert alert-success';
            document.getElementById('relay-status').innerHTML = 'Connected to nostr relays';
            
            this.updateUIState();
        } catch (e) {
            console.error('Error connecting to relays:', e);
            
            document.getElementById('relay-status').className = 'alert alert-error';
            document.getElementById('relay-status').textContent = 'Error connecting to relays: ' + e.message;
        }
    };
    
    /**
     * Display the loading spinner in the groups list
     */
    App.showGroupListSpinner = function() {
        const groupsList = document.getElementById('groups-list');
        if (groupsList) {
            groupsList.innerHTML = '<div class="loading">Loading relays...</div>';
        }
    };

    App.fetchGroupMetadata = async function(groupId) {
        if (!this.nostr || !this.nostr.client) return null;
        
        // Check if already in cache
        const existingGroup = this.nostr.getGroupById(groupId);
        if (existingGroup) return existingGroup;
        
        console.log(`Fetching metadata for group ${groupId}`);
        
        return new Promise((resolve) => {
            const subId = `group-metadata-${groupId}-${Date.now()}`;
            let resolved = false;
            
            const timeoutId = setTimeout(() => {
                this.nostr.client.relayManager.unsubscribe(subId);
                if (!resolved) {
                    resolved = true;
                    resolve(null);
                }
            }, 3000);
            
            this.nostr.client.relayManager.subscribe(subId, [
                {
                    kinds: [NostrEvents.KIND_GROUP_METADATA],
                    "#d": [groupId],
                    limit: 1
                }
            ], (event) => {
                if (!resolved && event.kind === NostrEvents.KIND_GROUP_METADATA) {
                    const groupData = NostrEvents.parseGroupMetadata(event);
                    if (groupData && groupData.id === groupId) {
                        // Manually add to the groups Map for caching
                        this.nostr.client.groups.set(groupId, groupData);
                        
                        // Also fetch the hypertuna mapping
                        const hypertunaId = groupData.hypertunaId;
                        if (hypertunaId) {
                            this.nostr.client.hypertunaGroups.set(hypertunaId, groupId);
                            this.nostr.client.groupHypertunaIds.set(groupId, hypertunaId);
                        }
                        
                        clearTimeout(timeoutId);
                        this.nostr.client.relayManager.unsubscribe(subId);
                        resolved = true;
                        resolve(groupData);
                    }
                }
            });
        });
    };

    /**
     * Gets Hypertuna groups from the nostr client
     */
    App.loadGroups = async function() {
        if (!this.currentUser) return;
    
        const groupsList = document.getElementById('groups-list');
        
        // Only show spinner if we're not already showing one
        if (!groupsList.querySelector('.loading')) {
            this.showGroupListSpinner();
        }
    
        try {
            // Wait for relay list to be ready
            let retries = 0;
            while (!this.nostr.areRelayIdsReady() && retries < 10) {
                await new Promise(resolve => setTimeout(resolve, 500));
                retries++;
            }
    
            // Get groups from the nostr client
            const allGroups = this.nostr.getGroups();
            const allowedIds = this.nostr.getUserRelayGroupIds();
            
            // Extra safety: filter out any groups that don't have the user as a member
            const groups = allGroups.filter(g => {
                // Must be in the user's relay list
                if (!allowedIds.includes(g.hypertunaId)) {
                    return false;
                }
                
                // Additional check: verify user is actually a member
                const isMember = this.nostr.isGroupMember(g.id, this.currentUser.pubkey);
                const isAdmin = this.nostr.isGroupAdmin(g.id, this.currentUser.pubkey);
                const isCreator = g.event && g.event.pubkey === this.currentUser.pubkey;
                
                return isMember || isAdmin || isCreator;
            });
            
            // Add a small delay to prevent flash of "no relays" message
            if (groups.length === 0 && retries < 5) {
                await new Promise(resolve => setTimeout(resolve, 1000));
                
                // Re-check after delay
                const updatedGroups = this.nostr.getGroups();
                const updatedAllowedIds = this.nostr.getUserRelayGroupIds();
                const finalGroups = updatedGroups.filter(g => updatedAllowedIds.includes(g.hypertunaId));
                
                if (finalGroups.length > 0) {
                    groups.length = 0;
                    groups.push(...finalGroups);
                }
            }
            
            if (groups.length === 0) {
                groupsList.innerHTML = `
                    <div class="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                            <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                            <line x1="12" y1="22.08" x2="12" y2="12"></line>
                        </svg>
                        <p>No Hypertuna relays found</p>
                        <p>Create your first relay to get started!</p>
                    </div>
                `;
                return;
            }
            
            // Clear and populate groups
            groupsList.innerHTML = '';
            
            for (const group of groups) {
                // Skip deleted groups
                if (group.event && group.event.markedAsDeleted) continue;
                
                const groupElement = document.createElement('a');
                groupElement.href = '#';
                groupElement.className = 'group-item';
                
                // Create avatar with first letter of group name
                const firstLetter = group.name ? group.name.charAt(0).toUpperCase() : 'G';
                
                // Use hypertunaId as an additional identifier
                const hypertunaId = group.hypertunaId || '';
                
                // Get the actual connection URL from the relay manager
                let connectionUrl = 'Not connected';
                const relayUrl = this.nostr.client.groupRelayUrls.get(group.id);
                if (relayUrl) {
                    connectionUrl = relayUrl;
                }
                
                groupElement.innerHTML = `
                    <div class="group-avatar">${firstLetter}</div>
                    <div class="group-info">
                        <div class="group-name">${group.name || 'Unnamed Relay'}</div>
                        <div class="group-description">${group.about || 'No description available'}</div>
                    </div>
                    <div class="group-meta-badges">
                        <span class="meta-badge">${group.isPublic ? 'Public' : 'Private'}</span>
                        <span class="meta-badge">${group.isOpen ? 'Open' : 'Closed'}</span>
                    </div>
                `;
                
                groupElement.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.currentGroupId = group.id;
                    this.currentHypertunaId = hypertunaId;
                    this.navigateTo('group-detail');
                });
                
                groupsList.appendChild(groupElement);
            }
        } catch (e) {
            console.error('Error loading groups:', e);
            groupsList.innerHTML = `
                <div class="status-message error">
                    Error loading relays. Please try again.
                </div>
            `;
        }
    };
    
    /**
     * Replace load group details method
     * Gets group details from the nostr client
     */
    App.loadGroupDetails = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            // Subscribe to this group's events
            this.nostr.client.subscribeToGroup(this.currentGroupId);
            
            // First try to get from cache
            let group = this.nostr.getGroupById(this.currentGroupId);
            
            // If not in cache, fetch it
            if (!group) {
                console.log(`Group ${this.currentGroupId} not in cache, fetching...`);
                group = await this.fetchGroupMetadata(this.currentGroupId);
            }
            
            if (!group || (group.event && group.event.markedAsDeleted)) {
                alert('Group not found or has been deleted');
                this.navigateTo('groups');
                return;
            }
            
            this.currentGroup = group;
            this.currentHypertunaId = group.hypertunaId;
            
            // Rest of the method remains the same...
            // Update group header with null checks
            const groupNameElement = document.getElementById('group-detail-name');
            if (groupNameElement) {
                groupNameElement.textContent = group.name || 'Unnamed Relay';
            }
            
            const groupVisibilityElement = document.getElementById('group-detail-visibility');
            if (groupVisibilityElement) {
                groupVisibilityElement.textContent = group.isPublic ? 'Public' : 'Private';
            }
            
            const groupJoinTypeElement = document.getElementById('group-detail-join-type');
            if (groupJoinTypeElement) {
                groupJoinTypeElement.textContent = group.isOpen ? 'Open' : 'Closed';
            }
            
            const groupDescriptionElement = document.getElementById('group-detail-description');
            if (groupDescriptionElement) {
                groupDescriptionElement.textContent = group.about || 'No description available.';
            }
            
            // Load members and check if user is a member/admin - with retries
            await this.loadGroupMembers();
            
            // Check if creator of group is automatically admin and member
            const isCreator = group.event && group.event.pubkey === this.currentUser.pubkey;
            console.log(`Current user is group creator: ${isCreator}`);
            
            // If they're the creator, force-add them to admin and member lists if not already there
            if (isCreator) {
                if (!this.nostr.isGroupAdmin(this.currentGroupId, this.currentUser.pubkey)) {
                    console.log('Group creator not in admin list, adding manually');
                    this.nostr.client.groupAdmins.set(
                        this.currentGroupId, 
                        [...(this.nostr.client.groupAdmins.get(this.currentGroupId) || []),
                        { pubkey: this.currentUser.pubkey, roles: ['admin'] }]
                    );
                }
                
                if (!this.nostr.isGroupMember(this.currentGroupId, this.currentUser.pubkey)) {
                    console.log('Group creator not in member list, adding manually');
                    this.nostr.client.groupMembers.set(
                        this.currentGroupId, 
                        [...(this.nostr.client.groupMembers.get(this.currentGroupId) || []),
                        { pubkey: this.currentUser.pubkey, roles: ['member'] }]
                    );
                }
            }
            
            // Re-check member and admin status
            const isMember = this.nostr.isGroupMember(this.currentGroupId, this.currentUser.pubkey);
            const isAdmin = this.nostr.isGroupAdmin(this.currentGroupId, this.currentUser.pubkey);
            
            console.log(`Final status checks - isMember: ${isMember}, isAdmin: ${isAdmin}`);
            
            // Update join/leave buttons
            const joinButton = document.getElementById('btn-join-group');
            const leaveButton = document.getElementById('btn-leave-group');
            if (joinButton) joinButton.classList.toggle('hidden', isMember);
            if (leaveButton) leaveButton.classList.toggle('hidden', !isMember);
            
            // Load messages if user is a member
            if (isMember) {
                this.loadGroupMessages();
            } else {
                const messageList = document.getElementById('message-list');
                if (messageList) {
                    messageList.innerHTML = `
                        <div class="empty-state">
                            <p>Join this relay to view messages</p>
                        </div>
                    `;
                }
                const messageInput = document.getElementById('message-input');
                const sendButton = document.getElementById('btn-send-message');
                if (messageInput) messageInput.disabled = true;
                if (sendButton) sendButton.disabled = true;
            }
            
            // Update admin panel visibility
            const adminPanel = document.getElementById('admin-panel');
            if (adminPanel) {
                adminPanel.classList.toggle('hidden', !isAdmin);
            }

            if (isAdmin) {
                this.loadJoinRequests();
            } else {
                const jrSection = document.getElementById('join-requests-section');
                if (jrSection) jrSection.classList.add('hidden');
            }

            const memberPanel = document.getElementById('member-actions');
            if (memberPanel) {
                memberPanel.classList.toggle(
                    'hidden',
                    !(isMember && !isAdmin && group.isOpen)
                );
            }

            const adminInviteBtn = document.getElementById('btn-invite-members');
            if (adminInviteBtn) adminInviteBtn.disabled = !isAdmin;

            const memberInviteBtn = document.getElementById('btn-member-invite');
            if (memberInviteBtn) memberInviteBtn.disabled = !(isMember && group.isOpen);

            const editFileSharingCheckbox = document.getElementById('edit-group-file-sharing');
            if (editFileSharingCheckbox) {
                editFileSharingCheckbox.checked = !!group.fileSharing;
                editFileSharingCheckbox.disabled = true;
            }

            // Update settings form
            const settingsForm = document.getElementById('group-settings-form');
            const noPermissionMsg = document.getElementById('group-settings-no-permission');
            
            if (isAdmin && settingsForm && noPermissionMsg) {
                settingsForm.classList.remove('hidden');
                noPermissionMsg.classList.add('hidden');
                
                // Populate settings form with null checks
                const editNameInput = document.getElementById('edit-group-name');
                if (editNameInput) editNameInput.value = group.name || '';
                
                const editDescInput = document.getElementById('edit-group-description');
                if (editDescInput) editDescInput.value = group.about || '';
                
                const editPublicCheckbox = document.getElementById('edit-group-public');
                if (editPublicCheckbox) editPublicCheckbox.checked = group.isPublic;
                
                const editOpenCheckbox = document.getElementById('edit-group-open');
                if (editOpenCheckbox) editOpenCheckbox.checked = group.isOpen;
            } else if (settingsForm && noPermissionMsg) {
                settingsForm.classList.add('hidden');
                noPermissionMsg.classList.remove('hidden');
            }
        } catch (e) {
            console.error('Error loading group details:', e);
            alert('Error loading group details');
        }
    };
    
    /**
     * Replace load group messages method
     * Gets messages from the nostr client
     */
    App.loadGroupMessages = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            // First check if user is a member (existing logic)
            const isMember = this.nostr.isGroupMember(this.currentGroupId, this.currentUser.pubkey);
            if (!isMember) return;
            
            const messageList = document.getElementById('message-list');
            
            // Then check if connected to group's relay (new logic)
            if (!this.nostr.isConnectedToGroupRelay(this.currentGroupId)) {
                messageList.innerHTML = `
                    <div class="status-message warning">
                        Connecting to relay...
                    </div>
                `;
                
                // Try to connect if we have the relay URL
                const group = this.nostr.getGroupById(this.currentGroupId);
                if (group && group.hypertunaId) {
                    const relayUrl = this.nostr.client.hypertunaRelayUrls.get(this.currentGroupId);
                    if (relayUrl) {
                        await this.nostr.connectToGroupRelay(this.currentGroupId, relayUrl);
                        // Retry loading messages after connection
                        setTimeout(() => this.loadGroupMessages(), 1000);
                    }
                }
                return;
            }
            
            // Clear message list
            messageList.innerHTML = '';
            
            // Get messages for the group (existing logic continues)
            const messages = this.nostr.getGroupMessages(this.currentGroupId);
            
            if (messages.length === 0) {
                messageList.innerHTML = `
                    <div class="empty-state">
                        <p>No messages yet</p>
                        <p>Be the first to send a message!</p>
                    </div>
                `;
                return;
            }
            
            // Get profiles for all message authors
            const profiles = {};
            const authors = [...new Set(messages.map(msg => msg.pubkey))];
            
            // Fetch profiles for each author
            for (const pubkey of authors) {
                try {
                    const profile = await this.nostr.client.fetchUserProfile(pubkey);
                    profiles[pubkey] = profile;
                } catch (e) {
                    profiles[pubkey] = { name: 'User_' + NostrUtils.truncatePubkey(pubkey) };
                }
            }
            
            // Display messages
            for (const message of messages) {
                const author = profiles[message.pubkey] || { name: 'User_' + NostrUtils.truncatePubkey(message.pubkey) };
                const isCurrentUser = message.pubkey === this.currentUser.pubkey;
                const npub = NostrUtils.hexToNpub(message.pubkey);
                const displayPub = NostrUtils.truncateNpub(npub);

                const messageElement = document.createElement('div');
                messageElement.className = `message ${isCurrentUser ? 'own' : ''}`;

                const contentHtml = await this.renderMessageContent(message);

                messageElement.innerHTML = `
                    <div class="message-bubble">
                        <div class="message-content">${contentHtml}</div>
                    </div>
                    <div class="message-meta">
                        <span>${author.name || 'Unknown'}</span>
                        <span class="message-pubkey">${displayPub}</span>
                        <span>${this.formatTime(message.created_at)}</span>
                    </div>
                `;

                messageList.appendChild(messageElement);
            }
            
            // Scroll to bottom
            messageList.scrollTop = messageList.scrollHeight;
            
            // Enable message input
            document.getElementById('message-input').disabled = false;
            document.getElementById('btn-send-message').disabled = false;
            
        } catch (e) {
            console.error('Error loading messages:', e);
            document.getElementById('message-list').innerHTML = `
                <div class="status-message error">
                    Error loading messages. Please try again.
                </div>
            `;
        }
    };
    
    
    /**
     * Replace load group members method
     * Gets members from the nostr client
     */
    App.loadGroupMembers = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
    
        // Debounce rapid calls
        if (this._loadMembersTimeout) {
            clearTimeout(this._loadMembersTimeout);
        }
        
        // Prevent concurrent loads
        if (this._loadingMembers) {
            console.log('Member loading already in progress, skipping');
            return;
        }
        
        this._loadMembersTimeout = setTimeout(async () => {
            await this._doLoadGroupMembers();
            delete this._loadMembersTimeout;
        }, 100);
    };
    
    App._doLoadGroupMembers = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        // Set loading flag
        this._loadingMembers = true;
    
        const container = document.getElementById("member-list");
        if (!container) {
            this._loadingMembers = false;
            return;
        }
        
        // Show loading state only if membersList doesn't exist
        if (!this.membersList) {
            container.innerHTML = '<div class="loading">Loading members...</div>';
        }
    
        // Ensure member list is built from history
        try {
            await this.nostr.client.buildMemberList(this.currentGroupId);
        } catch (err) {
            console.error('Failed to build member list', err);
        }
    
        // Remove old event listeners before adding new ones
        if (this._memberListeners) {
            this._memberListeners.forEach(({ event, handler }) => {
                container.removeEventListener(event, handler);
            });
            this._memberListeners = null;
        }
        
        // Create or update the MembersList instance
        if (!this.membersList) {
            this.membersList = new MembersList(container, this.nostr.client, this.currentUser.pubkey);
        } else {
            // Clear rendered members tracking when updating
            this.membersList.clearRenderedMembers();
            this.membersList.container = container;
            this.membersList.client = this.nostr.client;
            this.membersList.setUserPubkey(this.currentUser.pubkey);
        }
        
        try {
            // Get members and admins
            const members = this.nostr.getGroupMembers(this.currentGroupId);
            const admins = this.nostr.getGroupAdmins(this.currentGroupId);
            
            console.log(`Loading members for group ${this.currentGroupId}:`, {
                memberCount: members.length,
                adminCount: admins.length
            });
            
            // Clear container before rendering to ensure clean slate
            container.innerHTML = '';
            
            // Render the members list
            await this.membersList.render(members, admins);
            
            // Create new event handlers with proper cleanup
            const promoteHandler = (e) => {
                e.stopPropagation();
                if (e.detail && e.detail.pubkey) {
                    this.updateMemberRole(e.detail.pubkey, ['admin']);
                }
            };
            
            const removeHandler = (e) => {
                e.stopPropagation();
                if (e.detail && e.detail.pubkey) {
                    this.removeMember(e.detail.pubkey);
                }
            };
            
            // Add new listeners
            container.addEventListener('promote', promoteHandler);
            container.addEventListener('remove', removeHandler);
            
            // Store references for cleanup
            this._memberListeners = [
                { event: 'promote', handler: promoteHandler },
                { event: 'remove', handler: removeHandler }
            ];
            
        } catch (e) {
            console.error("Error loading members:", e);
            container.innerHTML = `
                <div class="status-message error">
                    Error loading members. Please try again.
                </div>
            `;
        } finally {
            // Clear loading flag
            this._loadingMembers = false;
        }
    };

    App.renderMembersList = async function(members) {
        if (!this.currentUser || !this.currentGroupId) return;
        const admins = this.nostr.getGroupAdmins(this.currentGroupId);
        const container = document.getElementById("member-list");
        if (!this.membersList) {
            this.membersList = new MembersList(container, this.nostr.client, this.currentUser.pubkey);
        } else {
            this.membersList.container = container;
            this.membersList.client = this.nostr.client;
            this.membersList.setUserPubkey(this.currentUser.pubkey);
        }
        await this.membersList.render(members, admins);
        container.addEventListener('promote', (e) => {
            this.updateMemberRole(e.detail.pubkey, ['admin']);
        });
        container.addEventListener('remove', (e) => {
            this.removeMember(e.detail.pubkey);
        });
    };

    App.escapeHtml = function(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };
    
    // Add this helper method for formatting time
    App.formatTime = function(timestamp) {
        const date = new Date(timestamp * 1000);
        const now = new Date();
        const diff = now - date;
        
        // If less than 24 hours ago, show time
        if (diff < 24 * 60 * 60 * 1000) {
            return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        
        // If less than 7 days ago, show day and time
        if (diff < 7 * 24 * 60 * 60 * 1000) {
            return date.toLocaleDateString([], { weekday: 'short' }) + ' ' + 
                   date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        }
        
        // Otherwise show full date
        return date.toLocaleDateString();
    };

    App.isMediaUrl = function(url) {
        return /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|ogg|mov)$/i.test(url);
    };

    App.fetchPreview = async function(url) {
        try {
            const oembed = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
            const res = await fetch(oembed);
            if (res.ok) {
                const data = await res.json();
                return {
                    title: data.title || '',
                    description: data.description || '',
                    thumbnail: data.thumbnail_url || '',
                    url
                };
            }
        } catch (e) {
            // ignore oEmbed errors
        }
        try {
            const res = await fetch(url);
            const text = await res.text();
            const doc = new DOMParser().parseFromString(text, 'text/html');
            const title = doc.querySelector('meta[property="og:title"]')?.getAttribute('content') || doc.title || '';
            const description = doc.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
            const thumbnail = doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
            return { title, description, thumbnail, url };
        } catch (e) {
            console.error('fetchPreview failed', e);
        }
        return null;
    };

    App.renderMessageContent = async function(message) {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const parts = [];
        let lastIndex = 0;
        const text = this.escapeHtml(message.content);
        for (const match of text.matchAll(urlRegex)) {
            const url = match[0];
            parts.push(text.slice(lastIndex, match.index));
            let replacement = `<a href="${url}" target="_blank" rel="noopener">${url}</a>`;
            if (this.isMediaUrl(url)) {
                if (/\.(mp4|webm|ogg|mov)$/i.test(url)) {
                    replacement = `<video controls class="media-video"><source src="${url}"></video>`;
                } else {
                    replacement = `<img src="${url}" class="media-image"/>`;
                }
            } else {
                const preview = await this.fetchPreview(url);
                if (preview) {
                    replacement = `<a href="${url}" target="_blank" rel="noopener" class="link-preview">`;
                    if (preview.thumbnail) {
                        replacement += `<img src="${preview.thumbnail}" class="preview-thumb">`;
                    }
                    replacement += `<div class="preview-info">`;
                    if (preview.title) {
                        replacement += `<div class="preview-title">${this.escapeHtml(preview.title)}</div>`;
                    }
                    if (preview.description) {
                        replacement += `<div class="preview-desc">${this.escapeHtml(preview.description)}</div>`;
                    }
                    replacement += `</div></a>`;
                }
            }
            parts.push(replacement);
            lastIndex = match.index + url.length;
        }
        parts.push(text.slice(lastIndex));
        return parts.join('');
    };

    App.loadJoinRequests = function() {
        if (!this.currentUser || !this.currentGroupId) return;
        const requests = this.nostr.client.getJoinRequests(this.currentGroupId);
        if (typeof this.updateJoinRequests === 'function') {
            this.updateJoinRequests(this.currentGroupId, requests);
        }
    };
    
    /**
     * Replace create group method
     * Creates a group via the nostr client with Hypertuna events
     */
    App.createGroup = async function() {
        if (!this.currentUser) return;
        
        const name = document.getElementById('new-group-name').value.trim();
        const about = document.getElementById('new-group-description').value.trim();
        const isPublic = document.getElementById('new-group-public').checked;
        const isOpen = document.getElementById('new-group-open').checked;
        const fileSharingEl = document.getElementById('new-group-file-sharing');
        const fileSharing = fileSharingEl ? fileSharingEl.checked : false;
        
        if (!name) {
            alert('Please enter a group name.');
            return;
        }
        
        try {
            // Get the user's npub
            const npub = NostrUtils.hexToNpub(this.currentUser.pubkey); 
            
            console.log("Creating group with parameters:", { name, about, isPublic, isOpen, npub });

            let relayKey = null;

            // Show a modal similar to the join flow
            const modal = document.getElementById('join-auth-modal');
            modal.classList.add('show');
            this.resetAuthModal();
            document.getElementById('auth-status-title').textContent = 'Creating Relay...';
            document.getElementById('auth-status-message').textContent = 'Initializing relay instance in worker...';

            if (window.createRelayInstance) {
                try {
                    // Pass all necessary metadata to the worker for profile creation
                    relayKey = await window.createRelayInstance(name, about, isPublic, isOpen, fileSharing);
                } catch (err) {
                    console.error('Failed to create relay instance:', err);
                }
            }

            const proxyServer = this.currentUser?.hypertunaConfig?.proxy_server_address || '';
            const proxyProtocol = this.currentUser?.hypertunaConfig?.proxy_websocket_protocol || 'wss';

            if (relayKey && relayKey.authToken) {
                await this.showAuthSuccess(relayKey, isPublic);
            } else {
                this.closeJoinAuthModal();
            }

            const eventsCollection = await this.nostr.createGroup(
                name,
                about,
                isPublic,
                isOpen,
                relayKey,
                proxyServer,
                proxyProtocol,
                npub,
                relayKey?.relayUrl || null,
                fileSharing
            );

            console.log(`Group created successfully with public ID: ${eventsCollection.groupId}`);
            console.log(`Internal relay key: ${eventsCollection.internalRelayKey}`);
            
            // Store the mapping in the Nostr client
            if (eventsCollection.internalRelayKey && eventsCollection.groupId) {
                this.nostr.client.publicToInternalMap = this.nostr.client.publicToInternalMap || new Map();
                this.nostr.client.internalToPublicMap = this.nostr.client.internalToPublicMap || new Map();
                
                this.nostr.client.publicToInternalMap.set(eventsCollection.groupId, eventsCollection.internalRelayKey);
                this.nostr.client.internalToPublicMap.set(eventsCollection.internalRelayKey, eventsCollection.groupId);
            }
            
            // Give the relays time to process the events
            console.log("Waiting for relays to process events...");
            await new Promise(resolve => setTimeout(resolve, 5000));
            
            // Force-load the groups to ensure the new group appears
            console.log("Force reloading groups list...");
            this.loadGroups();
            
            alert('Group created successfully!');
            // this.navigateTo('groups'); // Don't navigate away immediately, let user see modal
        } catch (e) {
            console.error('Error creating group:', e);
            alert('Error creating group: ' + e.message);
        }
    };
    
    /**
     * Enhanced join group method with authentication flow
     */
    App.joinGroup = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            const group = this.nostr.getGroupById(this.currentGroupId);
            if (!group) return;
            
            if (group.isOpen) {
                // For open groups, show authentication modal
                await this.showJoinAuthModal();
            } else {
                // For closed groups, immediately send join request and display status
                this.showJoinModal(false);
                await this.sendJoinRequest();
            }
        } catch (e) {
            console.error('Error joining group:', e);
            alert('Error joining group: ' + e.message);
        }
    };

    /**
     * Show join authentication modal
     */
    App.showJoinAuthModal = async function() {
        const modal = document.getElementById('join-auth-modal');
        modal.classList.add('show');

        // Reset modal state
        this.resetAuthModal();

        try {
            const group = this.nostr.getGroupById(this.currentGroupId) || {};
            const fileSharing = !!group.fileSharing;
            // The new global function will handle communication with the worker
            // and return a promise that resolves with the auth result.
            // The UI will be updated by messages from the worker.
            const authResult = await window.joinRelayInstance(this.currentGroupId, fileSharing);

            // The 'join-auth-success' message from the worker will have already
            // called App.showAuthSuccess. We can just log the successful outcome.
            console.log('Worker-driven join flow completed successfully.', authResult);

        } catch (error) {
            console.error('Worker-driven join flow failed:', error);
            // The 'join-auth-error' message from the worker will have already
            // called App.showAuthError. We can just log it here.
        }
    };

    /**
     * Reset authentication modal to initial state
     */
    App.resetAuthModal = function() {
        // Reset progress steps
        document.querySelectorAll('.progress-step').forEach(step => {
            step.classList.remove('active', 'completed');
        });
        document.getElementById('step-request').classList.add('active');
        
        // Show status section
        document.getElementById('auth-status').classList.remove('hidden');
        document.getElementById('auth-success').classList.add('hidden');
        document.getElementById('auth-error').classList.add('hidden');
        
        // Reset status text
        document.getElementById('auth-status-title').textContent = 'Approval Pending';
        document.getElementById('auth-status-message').textContent = 'Registering your pubkey with the relay...';
        
        // Hide continue button
        document.getElementById('btn-close-auth-modal').classList.add('hidden');
        document.getElementById('btn-cancel-auth').classList.remove('hidden');
    };

    /**
     * Update authentication progress
     */
    App.updateAuthProgress = function(step) {
        const steps = ['request', 'verify', 'complete'];
        const currentIndex = steps.indexOf(step);
        
        steps.forEach((s, index) => {
            const stepElement = document.getElementById(`step-${s}`);
            stepElement.classList.remove('active', 'completed');
            
            if (index < currentIndex) {
                stepElement.classList.add('completed');
            } else if (index === currentIndex) {
                stepElement.classList.add('active');
            }
        });
        
        // Update status message based on step
        const statusTitle = document.getElementById('auth-status-title');
        const statusMessage = document.getElementById('auth-status-message');
        
        switch (step) {
            case 'verify':
                statusTitle.textContent = 'Verifying Identity';
                statusMessage.textContent = 'Completing cryptographic handshake...';
                break;
            case 'complete':
                statusTitle.textContent = 'Finalizing';
                statusMessage.textContent = 'Setting up your access credentials...';
                break;
        }
    };

    /**
     * Show authentication success
     * @param {Object} authResult - Result object from the worker
     * @param {boolean|null} [isPublic] - Public flag for the relay if known
     */
    App.showAuthSuccess = async function(authResult, isPublic = null) {
        // Update progress to complete
        this.updateAuthProgress('complete');
        
        // Wait a moment to show completion
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Hide status and show success
        document.getElementById('auth-status').classList.add('hidden');
        document.getElementById('auth-success').classList.remove('hidden');
        document.getElementById('btn-close-auth-modal').classList.remove('hidden');
        document.getElementById('btn-cancel-auth').classList.add('hidden');
        
    
        // IMPORTANT: Update the user's relay list with the FULL authenticated URL
        if (this.nostr && this.nostr.client) {
            // The relayUrl should already include the token from the worker
            await this.nostr.client.updateUserRelayListWithAuth(
                authResult.publicIdentifier,
                authResult.relayUrl, // This should be the full authenticated URL
                authResult.authToken,
                isPublic
            );
        } else {
            console.error("Nostr client not available to update relay list.");
        }
        
        // Reload group details and list
        setTimeout(() => {
            this.loadGroupDetails();
            this.loadGroups();
        }, 500);
    };

    /**
     * Show authentication error
     */
    App.showAuthError = function(errorMessage) {
        document.getElementById('auth-status').classList.add('hidden');
        document.getElementById('auth-error').classList.remove('hidden');
        document.getElementById('auth-error-message').textContent = errorMessage || 'An error occurred during authentication.';
        document.getElementById('btn-cancel-auth').classList.remove('hidden');
    };

    /**
     * Close authentication modal
     */
    App.closeJoinAuthModal = function() {
        document.getElementById('join-auth-modal').classList.remove('show');
        
        // If authentication was successful, navigate to group
        const successSection = document.getElementById('auth-success');
        if (!successSection.classList.contains('hidden')) {
            this.loadGroupDetails();
        }
    };

    /**
     * Setup authentication modal event listeners
     */
    App.setupAuthModalListeners = function() {
        // Close button
        document.getElementById('close-join-auth-modal').addEventListener('click', () => {
            this.closeJoinAuthModal();
        });
        
        // Cancel button
        document.getElementById('btn-cancel-auth').addEventListener('click', () => {
            this.closeJoinAuthModal();
        });
        
        // Continue button (after success)
        document.getElementById('btn-close-auth-modal').addEventListener('click', () => {
            this.closeJoinAuthModal();
        });
        
        // Retry button
        document.getElementById('btn-retry-auth').addEventListener('click', () => {
            this.showJoinAuthModal();
        });
        
        
        // Click outside modal to close
        window.addEventListener('click', (e) => {
            if (e.target.id === 'join-auth-modal') {
                // Only allow closing if not in progress
                const statusSection = document.getElementById('auth-status');
                if (statusSection.classList.contains('hidden')) {
                    this.closeJoinAuthModal();
                }
            }
        });
    };

    /**
     * Replace send join request method
     * Sends a join request via the nostr client
     */
    App.sendJoinRequest = async function(inviteCode = null) {
        if (!this.currentUser || !this.currentGroupId) return;

        const statusEl = document.getElementById('join-request-status');
        if (statusEl) {
            statusEl.classList.add('hidden');
        }

        try {
            const group = this.nostr.getGroupById(this.currentGroupId) || {};
            const fileSharing = !!group.fileSharing;
            // Build the join request event without publishing
            const event = await this.nostr.joinGroup(
                this.currentGroupId,
                inviteCode,
                { publish: false, fileSharing }
            );

            // Send the event to the gateway
            const gatewaySettings = await HypertunaUtils.getGatewaySettings();
            const gatewayUrl = this.currentUser.hypertunaConfig?.gatewayUrl || gatewaySettings.gatewayUrl;
            const response = await fetch(`${gatewayUrl}/post/join/${this.currentGroupId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ event })
            });

            if (response.ok) {
                if (statusEl) {
                    statusEl.textContent = 'join request received – pending admin approval';
                    statusEl.classList.remove('hidden');
                }
                const messageEl = document.getElementById('join-modal-message');
                if (messageEl) {
                    messageEl.textContent = 'Join request submitted.';
                }
            } else {
                const text = await response.text();
                throw new Error(`Gateway error: ${response.status} ${text}`);
            }

            // Reload group details and groups list to reflect membership changes
            setTimeout(() => {
                this.loadGroupDetails();
                this.loadGroups();
            }, 1000);

        } catch (e) {
            console.error('Error sending join request:', e);
            alert('Error joining group: ' + e.message);
            throw e;
        }
    };
    
    /**
     * Replace leave group method
     * Leaves a group via the nostr client
     */
    App.leaveGroup = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.leaveGroup(this.currentGroupId);

            if (window.disconnectRelayInstance && this.currentHypertunaId) {
                window.disconnectRelayInstance(this.currentHypertunaId);
            }
            
            // Reload group details and groups list to reflect membership changes
            setTimeout(() => {
                this.loadGroupDetails();
                this.loadGroups();
            }, 1000);
            
        } catch (e) {
            console.error('Error leaving group:', e);
            alert('Error leaving group: ' + e.message);
        }
    };
    
    /**
     * Replace send message method
     * Sends a message via the nostr client
     */
    App.sendMessage = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        const messageInput = document.getElementById('message-input');
        const fileInput = document.getElementById('message-file');
        const sendButton = document.getElementById('btn-send-message');
        const messageText = messageInput.value.trim();

        const file = fileInput.files[0];
        let filePath = '';
        if (file) {
            if ('path' in file && file.path) {
                filePath = file.path;
            } else {
                console.warn('File path is not accessible for the selected attachment');
            }
        }

        if (!messageText && !filePath) return;
        
        try {
            // Disable input and button while sending
            messageInput.disabled = true;
            fileInput.disabled = true;
            sendButton.disabled = true;
            
            await this.nostr.sendGroupMessage(
                this.currentGroupId,
                messageText,
                filePath
            );
            
            // Clear inputs
            messageInput.value = '';
            messageInput.style.height = 'auto';
            fileInput.value = '';
            
            // Reload messages
            this.loadGroupMessages();
            
        } catch (e) {
            console.error('Error sending message:', e);
            alert('Error sending message: ' + e.message);
        } finally {
            // Re-enable input and button
            messageInput.disabled = false;
            fileInput.disabled = false;
            sendButton.disabled = false;
            messageInput.focus();
        }
    };
    
    
    /**
     * Replace create invite method
     * Creates an invite code via the nostr client
     */
    App.createInvite = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.createGroupInvite(this.currentGroupId);
            
            // Generate invite code (in real implementation, this would come from the relay response)
            const inviteCode = NostrUtils.generateInviteCode();
            
            // Show invite code in modal
            this.showInviteCodeModal(inviteCode);
            
        } catch (e) {
            console.error('Error creating invite code:', e);
            alert('Error creating invite code: ' + e.message);
        }
    };
    
    /**
     * Replace add member method
     * Adds a member via the nostr client
     */
    App.addMember = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        const memberPubkeyInput = document.getElementById('add-member-pubkey').value.trim();
        const role = document.getElementById('add-member-role').value;
        
        if (!memberPubkeyInput) {
            alert('Please enter a valid public key.');
            return;
        }
        
        // Normalize the public key (handles both hex and npub)
        const memberPubkey = NostrUtils.normalizePublicKey(memberPubkeyInput);
        if (!memberPubkey) {
            alert('Invalid public key format. Please enter a hex key or npub format.');
            return;
        }
        
        try {
            await this.nostr.addGroupMember(this.currentGroupId, memberPubkey, [role]);
            
            this.closeAddMemberModal();
            setTimeout(() => {
                this.loadGroupMembers();
            }, 1000);
            
        } catch (e) {
            console.error('Error adding member:', e);
            alert('Error adding member: ' + e.message);
        }
    };
    
    /**
     * Replace update member role method
     * Updates a member's role via the nostr client
     */
    App.updateMemberRole = async function(pubkey, roles) {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.addGroupMember(this.currentGroupId, pubkey, roles);
            
            // Reload members to reflect changes
            setTimeout(() => {
                this.loadGroupMembers();
            }, 1000);
            
        } catch (e) {
            console.error('Error updating member role:', e);
            alert('Error updating member role: ' + e.message);
        }
    };
    
    /**
     * Replace remove member method
     * Removes a member via the nostr client
     */
    App.removeMember = async function(pubkey) {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.removeGroupMember(this.currentGroupId, pubkey);
            
            // Reload members to reflect changes
            setTimeout(() => {
                this.loadGroupMembers();
            }, 1000);
            
        } catch (e) {
            console.error('Error removing member:', e);
            alert('Error removing member: ' + e.message);
        }
    };

    App.approveJoinRequest = async function(pubkey) {
        if (!this.currentUser || !this.currentGroupId) return;
        try {
            await this.nostr.approveJoinRequest(this.currentGroupId, pubkey);
            setTimeout(() => {
                this.loadJoinRequests();
                this.loadGroupMembers();
            }, 500);
        } catch (e) {
            console.error('Error approving join request:', e);
            alert('Error approving join request: ' + e.message);
        }
    };

    App.rejectJoinRequest = function(pubkey) {
        if (!this.currentUser || !this.currentGroupId) return;
        this.nostr.rejectJoinRequest(this.currentGroupId, pubkey);
        this.loadJoinRequests();
    };
    
    /**
     * Replace save group settings method
     * Updates group settings via the nostr client with metadata events
     */
    App.saveGroupSettings = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        const name = document.getElementById('edit-group-name').value.trim();
        const about = document.getElementById('edit-group-description').value.trim();
        const isPublic = document.getElementById('edit-group-public').checked;
        const isOpen = document.getElementById('edit-group-open').checked;
        
        if (!name) {
            alert('Please enter a group name.');
            return;
        }
        
        try {
            // Update group metadata with both kind 9002 and 39000 events
            const events = await this.nostr.updateGroupMetadata(this.currentGroupId, {
                name,
                about,
                isPublic,
                isOpen
            });
            
            // Reload group details to reflect changes
            setTimeout(() => {
                this.loadGroupDetails();
            }, 1000);
            
            alert('Group settings updated successfully!');
            
        } catch (e) {
            console.error('Error updating group settings:', e);
            alert('Error updating group settings: ' + e.message);
        }
    };
    
    /**
     * Replace delete group method
     * Deletes a group via the nostr client
     */
    App.deleteGroup = async function() {
        if (!this.currentUser || !this.currentGroupId) return;
        
        try {
            await this.nostr.deleteGroup(this.currentGroupId);

            if (window.disconnectRelayInstance && this.currentHypertunaId) {
                window.disconnectRelayInstance(this.currentHypertunaId);
            }
            
            this.closeConfirmationModal();
            alert('Group deletion request sent! The group will be removed once relays process the event.');
            
            // Navigate back to groups list
            setTimeout(() => {
                this.navigateTo('groups');
            }, 1000);
            
        } catch (e) {
            console.error('Error deleting group:', e);
            alert('Error deleting group: ' + e.message);
        }
    };

/**
 * Current list view mode
 */
App.currentListView = 'your'; // 'your' or 'discover'
App.discoverRelaysCache = null;
App.discoverRelaysCacheTime = 0;
App.DISCOVER_CACHE_DURATION = 60000; // 1 minute cache

/**
 * Setup list toggle listeners
 */
App.setupListToggle = function() {
    const toggleOptions = document.querySelectorAll('.toggle-option');
    
    toggleOptions.forEach(option => {
        option.addEventListener('click', (e) => {
            const view = e.target.dataset.view;
            this.switchListView(view);
        });
    });
    
    // Setup following modal listeners
    this.setupFollowingModalListeners();
};

/**
 * Switch between list views
 */
App.switchListView = function(view) {
    if (this.currentListView === view) return;
    
    this.currentListView = view;
    
    // Update toggle buttons
    document.querySelectorAll('.toggle-option').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === view);
    });
    
    // Show/hide appropriate buttons
    const createBtn = document.getElementById('btn-create-new-group');
    const followingBtn = document.getElementById('btn-edit-following');
    
    if (view === 'your') {
        if (createBtn) createBtn.style.display = 'flex';
        if (followingBtn) followingBtn.style.display = 'none';
    } else {
        if (createBtn) createBtn.style.display = 'none';
        if (followingBtn) followingBtn.style.display = 'flex';
    }
    
    // Switch lists
    const groupsList = document.getElementById('groups-list');
    const discoverList = document.getElementById('discover-list');
    
    if (view === 'your') {
        groupsList.classList.remove('hidden');
        discoverList.classList.add('hidden');
        this.loadGroups();
    } else {
        groupsList.classList.add('hidden');
        discoverList.classList.remove('hidden');
        this.loadDiscoverRelays();
    }
};

App.setupKeyFormatToggles = function() {
    // Add toggle buttons next to key displays
    const addToggleButton = (inputId, keyType) => {
        const input = document.getElementById(inputId);
        if (!input) return;
        
        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'key-format-toggle';
        toggleBtn.textContent = '[Toggle Format]';
        toggleBtn.onclick = () => {
            const currentFormat = input.dataset.format;
            const hexValue = input.dataset.hex;
            
            if (currentFormat === 'hex') {
                if (keyType === 'public') {
                    input.value = NostrUtils.hexToNpub(hexValue);
                    input.dataset.format = 'npub';
                } else {
                    input.value = NostrUtils.hexToNsec(hexValue);
                    input.dataset.format = 'nsec';
                }
            } else {
                input.value = hexValue;
                input.dataset.format = 'hex';
            }
        };
        
        // Insert after the input
        input.parentElement.appendChild(toggleBtn);
    };
    
    addToggleButton('profile-pubkey-display', 'public');
    addToggleButton('profile-privkey-display', 'private');
};


/**
 * Load discover relays
 */
App.loadDiscoverRelays = async function() {
    if (!this.currentUser || !this.nostr) return;
    
    const discoverList = document.getElementById('discover-list');
    
    // Check cache
    const now = Date.now();
    if (this.discoverRelaysCache && (now - this.discoverRelaysCacheTime) < this.DISCOVER_CACHE_DURATION) {
        this.displayDiscoverRelays(this.discoverRelaysCache);
        return;
    }
    
    // Show loading state
    discoverList.innerHTML = `
        <div class="discover-loading">
            <div class="loading"></div>
            <div class="discover-loading-text">Discovering relays from your network...</div>
        </div>
    `;
    
    try {
        // Discover relays from follows
        const discoveredRelays = await this.nostr.client.discoverRelaysFromFollows();
        
        // Cache the results
        this.discoverRelaysCache = discoveredRelays;
        this.discoverRelaysCacheTime = now;
        
        // Display the results
        this.displayDiscoverRelays(discoveredRelays);
        
    } catch (e) {
        console.error('Error discovering relays:', e);
        discoverList.innerHTML = `
            <div class="empty-state">
                <p>Error discovering relays</p>
                <p>Please try again later</p>
            </div>
        `;
    }
};

/**
 * Display discovered relays
 */
App.displayDiscoverRelays = function(discoveredRelays) {
    const discoverList = document.getElementById('discover-list');
    
    if (discoveredRelays.size === 0) {
        discoverList.innerHTML = `
            <div class="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                    <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                    <line x1="12" y1="22.08" x2="12" y2="12"></line>
                </svg>
                <p>No relays found in your network</p>
                <p>Follow more people to discover relays!</p>
            </div>
        `;
        return;
    }
    
    // Sort by follower count
    const sortedRelays = Array.from(discoveredRelays.entries())
        .sort((a, b) => b[1].followerCount - a[1].followerCount);
    
    discoverList.innerHTML = '';
    
    sortedRelays.forEach(([groupId, relayData]) => {
        const { group, followers } = relayData;
        
        // Skip if user is already a member
        if (this.nostr.isGroupMember(groupId, this.currentUser.pubkey)) {
            return;
        }
        
        const groupElement = document.createElement('a');
        groupElement.href = '#';
        groupElement.className = 'group-item group-item-with-followers';
        
        const firstLetter = group.name ? group.name.charAt(0).toUpperCase() : 'R';
        
        // Create followers avatars HTML
        const maxAvatars = 3;
        const displayedFollowers = followers.slice(0, maxAvatars);
        const additionalCount = followers.length - maxAvatars;
        
        const avatarsHtml = displayedFollowers.map(follower => {
            const initial = follower.profile.name ? follower.profile.name.charAt(0).toUpperCase() : '?';
            
            if (follower.profile.picture) {
                return `
                    <div class="follower-avatar">
                        <img src="${follower.profile.picture}" alt="${follower.profile.name}" 
                             onerror="this.parentElement.innerHTML='<span>${initial}</span>'">
                        <div class="follower-tooltip">${follower.profile.name}</div>
                    </div>
                `;
            } else {
                return `
                    <div class="follower-avatar">
                        <span>${initial}</span>
                        <div class="follower-tooltip">${follower.profile.name}</div>
                    </div>
                `;
            }
        }).join('');
        
        groupElement.innerHTML = `
            <div class="group-avatar">${firstLetter}</div>
            <div class="group-info">
                <div class="group-name">${group.name || 'Unnamed Relay'}</div>
                <div class="group-description">${group.about || 'No description available'}</div>
            </div>
            <div class="group-meta-badges">
                <span class="meta-badge">${group.isPublic ? 'Public' : 'Private'}</span>
                <span class="meta-badge">${group.isOpen ? 'Open' : 'Closed'}</span>
            </div>
            <div class="followers-info">
                <div class="followers-avatars">
                    ${avatarsHtml}
                </div>
                <div class="followers-count">
                    ${followers.length} ${followers.length === 1 ? 'follow' : 'follows'}
                    ${additionalCount > 0 ? `+${additionalCount}` : ''}
                </div>
            </div>
        `;
        
        groupElement.addEventListener('click', (e) => {
            e.preventDefault();
            this.currentGroupId = groupId;
            this.currentHypertunaId = group.hypertunaId;
            this.navigateTo('group-detail');
        });
        
        discoverList.appendChild(groupElement);
    });
    
    // Add info message if all discovered relays are already joined
    if (discoverList.children.length === 0) {
        discoverList.innerHTML = `
            <div class="empty-state">
                <p>You've already joined all relays in your network!</p>
                <p>Follow more people to discover new relays.</p>
            </div>
        `;
    }
};

// properties for following management
App.followingModalOpen = false;
App.pendingFollowChanges = {
    toAdd: new Set(),
    toRemove: new Set()
};
App.originalFollows = new Set();
// properties for invite members management
App.inviteMembersModalOpen = false;
App.pendingInvites = new Set();

/**
 * Show the following modal
 */
App.showFollowingModal = async function() {
    this.followingModalOpen = true;
    document.getElementById('following-modal').classList.add('show');
    
    // Reset pending changes
    this.pendingFollowChanges.toAdd.clear();
    this.pendingFollowChanges.toRemove.clear();
    
    // Load current follows
    await this.loadFollowingList();
    
    // Clear the input
    document.getElementById('add-follow-pubkey').value = '';
};

/**
 * Close the following modal
 */
App.closeFollowingModal = function() {
    this.followingModalOpen = false;
    document.getElementById('following-modal').classList.remove('show');
    
    // Reset pending changes
    this.pendingFollowChanges.toAdd.clear();
    this.pendingFollowChanges.toRemove.clear();
};

/**
 * Load and display the following list
 */
App.loadFollowingList = async function() {
    const followingList = document.getElementById('following-list');
    const followingCount = document.getElementById('following-count');
    
    // Show loading state
    followingList.innerHTML = '<div class="following-loading">Loading...</div>';
    
    try {
        // Get current follows
        const follows = this.nostr.client.follows;
        this.originalFollows = new Set(follows);
        
        if (follows.size === 0) {
            followingList.innerHTML = `
                <div class="following-empty">
                    <p>You're not following anyone yet</p>
                </div>
            `;
            followingCount.textContent = '(0)';
            return;
        }
        
        // Fetch profiles for all follows
        const followsArray = Array.from(follows);
        const profiles = await this.nostr.client.fetchMultipleProfiles(followsArray);
        
        // Update count
        followingCount.textContent = `(${follows.size})`;
        
        // Clear list
        followingList.innerHTML = '';
        
        // Display each follow
        followsArray.forEach(pubkey => {
            const profile = profiles.get(pubkey) || { 
                name: `User_${NostrUtils.truncatePubkey(pubkey)}`,
                pubkey 
            };
            
            const followItem = document.createElement('div');
            followItem.className = 'following-item';
            followItem.dataset.pubkey = pubkey;
            
            const name = profile.name || `User_${NostrUtils.truncatePubkey(pubkey)}`;
            const firstLetter = name.charAt(0).toUpperCase();
            
            let avatarHtml;
            if (profile.picture) {
                avatarHtml = `<img src="${profile.picture}" alt="${name}" onerror="this.parentElement.innerHTML='<span>${firstLetter}</span>'">`;
            } else {
                avatarHtml = `<span>${firstLetter}</span>`;
            }
            
            const npub = NostrUtils.hexToNpub(pubkey);
            const displayPub = NostrUtils.truncateNpub(npub);

            followItem.innerHTML = `
                <div class="following-avatar">
                    ${avatarHtml}
                </div>
                <div class="following-info">
                    <div class="following-name">${name}</div>
                    <div class="following-pubkey">${displayPub}</div>
                </div>
                <button class="btn-remove" data-pubkey="${pubkey}">Remove</button>
            `;
            
            // Add remove handler
            const removeBtn = followItem.querySelector('.btn-remove');
            removeBtn.addEventListener('click', () => {
                this.toggleFollowRemoval(pubkey);
            });
            
            followingList.appendChild(followItem);
        });
        
    } catch (e) {
        console.error('Error loading following list:', e);
        followingList.innerHTML = `
            <div class="following-empty">
                <p>Error loading following list</p>
            </div>
        `;
    }
};

/**
 * Add a new follow
 */
App.addFollow = async function() {
    const input = document.getElementById('add-follow-pubkey');
    let pubkeyInput = input.value.trim();
    
    if (!pubkeyInput) {
        alert('Please enter a public key');
        return;
    }
    
    // Normalize the public key input
    const pubkey = NostrUtils.normalizePublicKey(pubkeyInput);
    if (!pubkey) {
        alert('Invalid public key format. Please enter a hex key or npub format.');
        return;
    }
    
    // Validate hex pubkey
    if (!/^[a-fA-F0-9]{64}$/.test(pubkey)) {
        alert('Invalid public key format. Must be 64 hex characters.');
        return;
    }
    
    // Check if already following
    if (this.originalFollows.has(pubkey) && !this.pendingFollowChanges.toRemove.has(pubkey)) {
        alert('You are already following this user');
        return;
    }
    
    // Add to pending additions
    this.pendingFollowChanges.toAdd.add(pubkey);
    if (this.pendingFollowChanges.toRemove.has(pubkey)) {
        this.pendingFollowChanges.toRemove.delete(pubkey);
    }
    
    // Fetch profile and add to list
    try {
        const profile = await this.nostr.client.fetchUserProfile(pubkey);
        const name = profile.name || `User_${NostrUtils.truncatePubkey(pubkey)}`;
        const firstLetter = name.charAt(0).toUpperCase();
        
        const followingList = document.getElementById('following-list');
        
        // Remove empty state if present
        const emptyState = followingList.querySelector('.following-empty');
        if (emptyState) {
            emptyState.remove();
        }
        
        const followItem = document.createElement('div');
        followItem.className = 'following-item pending-addition';
        followItem.dataset.pubkey = pubkey;
        
        let avatarHtml;
        if (profile.picture) {
            avatarHtml = `<img src="${profile.picture}" alt="${name}" onerror="this.parentElement.innerHTML='<span>${firstLetter}</span>'">`;
        } else {
            avatarHtml = `<span>${firstLetter}</span>`;
        }
        
        const npubAdded = NostrUtils.hexToNpub(pubkey);
        const displayPubAdded = NostrUtils.truncateNpub(npubAdded);

        followItem.innerHTML = `
            <div class="following-avatar">
                ${avatarHtml}
            </div>
            <div class="following-info">
                <div class="following-name">${name}</div>
                <div class="following-pubkey">${displayPubAdded}</div>
            </div>
            <button class="btn-remove" data-pubkey="${pubkey}">Remove</button>
        `;
        
        // Add remove handler
        const removeBtn = followItem.querySelector('.btn-remove');
        removeBtn.addEventListener('click', () => {
            this.toggleFollowRemoval(pubkey);
        });
        
        // Add to top of list
        followingList.insertBefore(followItem, followingList.firstChild);
        
        // Clear input
        input.value = '';
        
        // Update count
        const currentCount = this.originalFollows.size + this.pendingFollowChanges.toAdd.size - this.pendingFollowChanges.toRemove.size;
        document.getElementById('following-count').textContent = `(${currentCount})`;
        
    } catch (e) {
        console.error('Error adding follow:', e);
        alert('Error adding follow. Please try again.');
    }
};

/**
 * Toggle removal of a follow
 */
App.toggleFollowRemoval = function(pubkey) {
    const item = document.querySelector(`.following-item[data-pubkey="${pubkey}"]`);
    if (!item) return;
    
    if (this.pendingFollowChanges.toAdd.has(pubkey)) {
        // If it was pending addition, just remove it
        this.pendingFollowChanges.toAdd.delete(pubkey);
        item.remove();
    } else if (this.pendingFollowChanges.toRemove.has(pubkey)) {
        // Cancel removal
        this.pendingFollowChanges.toRemove.delete(pubkey);
        item.classList.remove('pending-removal');
    } else {
        // Mark for removal
        this.pendingFollowChanges.toRemove.add(pubkey);
        item.classList.add('pending-removal');
    }
    
    // Update count
    const currentCount = this.originalFollows.size + this.pendingFollowChanges.toAdd.size - this.pendingFollowChanges.toRemove.size;
    document.getElementById('following-count').textContent = `(${currentCount})`;
};

/**
 * Save following changes
 */
App.saveFollowingChanges = async function() {
    if (this.pendingFollowChanges.toAdd.size === 0 && this.pendingFollowChanges.toRemove.size === 0) {
        this.closeFollowingModal();
        return;
    }
    
    try {
        // Show saving state
        const saveBtn = document.getElementById('btn-save-following');
        const originalText = saveBtn.textContent;
        saveBtn.textContent = 'Saving...';
        saveBtn.disabled = true;
        
        // Create new follows set
        const newFollows = new Set(this.originalFollows);
        
        // Apply removals
        this.pendingFollowChanges.toRemove.forEach(pubkey => {
            newFollows.delete(pubkey);
            this.nostr.client.follows.delete(pubkey);
        });
        
        // Apply additions
        this.pendingFollowChanges.toAdd.forEach(pubkey => {
            newFollows.add(pubkey);
            this.nostr.client.follows.add(pubkey);
            this.nostr.client.relevantPubkeys.add(pubkey);
        });
        
        // Create kind 3 event
        const tags = Array.from(newFollows).map(pubkey => ['p', pubkey]);
        
        const event = await NostrEvents.createEvent(
            3, // Kind 3 - Contact List
            '', // Empty content
            tags,
            this.currentUser.privateKey
        );
        
        // Publish the event
        await this.nostr.client.relayManager.publish(event);
        
        // Clear pending changes
        this.pendingFollowChanges.toAdd.clear();
        this.pendingFollowChanges.toRemove.clear();
        
        // Close modal
        this.closeFollowingModal();
        
        // Refresh discover view if active
        if (this.currentListView === 'discover') {
            // Clear cache to force refresh
            this.discoverRelaysCache = null;
            this.loadDiscoverRelays();
        }
        
        alert('Following list updated successfully!');
        
    } catch (e) {
        console.error('Error saving following changes:', e);
        alert('Error saving changes. Please try again.');
    } finally {
        const saveBtn = document.getElementById('btn-save-following');
        saveBtn.textContent = 'Save Changes';
        saveBtn.disabled = false;
    }
};

/**
 * Show the invite members modal
 */
App.showInviteMembersModal = async function() {
    this.inviteMembersModalOpen = true;
    document.getElementById('invite-members-modal').classList.add('show');

    // Reset any pending invites
    this.pendingInvites.clear();

    // Load followed users to invite
    const list = document.getElementById('invite-members-list');
    list.innerHTML = '<div class="following-loading">Loading...</div>';

    try {
        const follows = this.nostr.client.follows;

        if (follows.size === 0) {
            list.innerHTML = `
                <div class="following-empty">
                    <p>You're not following anyone yet</p>
                </div>
            `;
            return;
        }

        const followsArray = Array.from(follows);
        const profiles = await this.nostr.client.fetchMultipleProfiles(followsArray);

        list.innerHTML = '';

        followsArray.forEach(pubkey => {
            const profile = profiles.get(pubkey) || { name: `User_${NostrUtils.truncatePubkey(pubkey)}` };
            const npub = NostrUtils.hexToNpub(pubkey);
            const displayPub = NostrUtils.truncateNpub(npub);

            const item = document.createElement('div');
            item.className = 'invite-member-item';
            item.dataset.pubkey = pubkey;
            item.innerHTML = `
                <label>
                    <input type="checkbox" data-pubkey="${pubkey}">
                    <div class="invite-member-info">
                        <div class="name">${profile.name}</div>
                        <div class="pubkey">${displayPub}</div>
                    </div>
                </label>`;

            const checkbox = item.querySelector('input');
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.pendingInvites.add(pubkey); else this.pendingInvites.delete(pubkey);
            });

            list.appendChild(item);
        });
    } catch (e) {
        console.error('Error loading invite members list:', e);
        list.innerHTML = `
            <div class="following-empty">
                <p>Error loading list</p>
            </div>
        `;
    }

    document.getElementById('invite-member-pubkey').value = '';
};

/**
 * Close the invite members modal
 */
App.closeInviteMembersModal = function() {
    this.inviteMembersModalOpen = false;
    document.getElementById('invite-members-modal').classList.remove('show');

    this.pendingInvites.clear();
    document.getElementById('invite-members-list').innerHTML = '';
    document.getElementById('invite-member-pubkey').value = '';
};

/**
 * Send invites to selected members
 */
App.saveInviteMembers = async function() {
    const additionalInput = document.getElementById('invite-member-pubkey').value.trim();
    if (additionalInput) {
        const normalized = NostrUtils.normalizePublicKey(additionalInput);
        if (!normalized || !/^[a-fA-F0-9]{64}$/.test(normalized)) {
            alert('Invalid public key format.');
            return;
        }
        this.pendingInvites.add(normalized);
    }

    if (this.pendingInvites.size === 0) {
        this.closeInviteMembersModal();
        return;
    }

    const btn = document.getElementById('btn-send-invites');
    const originalText = btn.textContent;
    btn.textContent = 'Sending...';
    btn.disabled = true;

    try {
        const pubkeys = Array.from(this.pendingInvites);
        await this.nostr.inviteMembers(this.currentGroupId, pubkeys);

        alert('Invites sent successfully!');
        this.closeInviteMembersModal();
    } catch (e) {
        console.error('Error sending invites:', e);
        alert('Error sending invites. Please try again.');
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
        this.pendingInvites.clear();
    }
};

/**
 * Setup following modal event listeners
 */
App.setupFollowingModalListeners = function() {
    // Edit following button
    const editFollowingBtn = document.getElementById('btn-edit-following');
    if (editFollowingBtn) {
        editFollowingBtn.addEventListener('click', () => {
            this.showFollowingModal();
        });
    }
    
    // Modal controls
    document.getElementById('close-following-modal').addEventListener('click', () => {
        this.closeFollowingModal();
    });
    
    document.getElementById('btn-cancel-following').addEventListener('click', () => {
        this.closeFollowingModal();
    });
    
    document.getElementById('btn-save-following').addEventListener('click', () => {
        this.saveFollowingChanges();
    });
    
    document.getElementById('btn-add-follow').addEventListener('click', () => {
        this.addFollow();
    });
    
    // Enter key in input
    document.getElementById('add-follow-pubkey').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            this.addFollow();
        }
    });
    
    // Click outside modal
    window.addEventListener('click', (e) => {
        if (e.target.id === 'following-modal') {
            this.closeFollowingModal();
        }
    });
};


    // Update handleRelayInitialized in AppIntegration.js:
    App.handleRelayInitialized = function(data) {
        console.log('[App] Received relay-initialized:', {
            relayKey: data.relayKey,
            publicIdentifier: data.publicIdentifier,
            hasUrl: !!data.gatewayUrl,
            hasToken: data.gatewayUrl?.includes('?token='),
            timestamp: data.timestamp
        });
        
        const identifier = data.publicIdentifier || data.relayKey;
        
        // Track state
        if (!relayReadinessTracker.has(identifier)) {
            relayReadinessTracker.set(identifier, {
                initialized: false,
                registered: false,
                initCount: 0,
                regCount: 0,
                lastUrl: null
            });
        }
        
        const state = relayReadinessTracker.get(identifier);
        state.initialized = true;
        state.initCount++;
        state.lastUrl = data.gatewayUrl;
        
        console.log(`[App] Relay ${identifier} state after initialized:`, state);
        
        if (this.nostr) {
            this.nostr.handleRelayInitialized(identifier, data.gatewayUrl, data.userAuthToken);
        }
    };

    // Add handleRelayRegistered if it doesn't exist:
    App.handleRelayRegistered = function(data) {
        console.log('[App] Received relay-registration-complete:', {
            relayKey: data.relayKey,
            publicIdentifier: data.publicIdentifier,
            hasUrl: !!data.gatewayUrl,
            hasToken: data.gatewayUrl?.includes('?token='),
            timestamp: data.timestamp
        });
        
        const identifier = data.publicIdentifier || data.relayKey;
        
        // Track state
        if (!relayReadinessTracker.has(identifier)) {
            relayReadinessTracker.set(identifier, {
                initialized: false,
                registered: false,
                initCount: 0,
                regCount: 0,
                lastUrl: null
            });
        }
        
        const state = relayReadinessTracker.get(identifier);
        state.registered = true;
        state.regCount++;
        if (data.gatewayUrl) {
            state.lastUrl = data.gatewayUrl;
        }
        
        console.log(`[App] Relay ${identifier} state after registered:`, state);
        console.log('[App] All relay states:', Array.from(relayReadinessTracker.entries()));
        
        if (this.nostr) {
            this.nostr.handleRelayRegistered(identifier);
        }
    };

    // Process any queued worker messages that arrived before handlers were ready
    if (window.pendingRelayMessages) {
        while (window.pendingRelayMessages.initialized.length) {
            App.handleRelayInitialized(window.pendingRelayMessages.initialized.shift());
        }
        while (window.pendingRelayMessages.registered.length) {
            App.handleRelayRegistered(window.pendingRelayMessages.registered.shift());
        }
    }
    
    /**
     * Replace update profile method
     * Updates user profile via the nostr client
     */
    App.updateProfile = async function() {
        if (!this.currentUser) return;
        
        const name = document.getElementById('profile-name-input').value.trim();
        const about = document.getElementById('profile-about-input').value.trim();
        
        try {
            await this.nostr.updateProfile({
                name,
                about
            });
            
            // Update user profile metadata
            this.currentUser.name = name;
            this.currentUser.about = about;
            
            // Save to localStorage
            this.saveUserToLocalStorage();
            
            // Update profile display
            this.updateProfileDisplay();
            
            alert('Profile updated successfully');
        } catch (e) {
            console.error('Error updating profile:', e);
            alert('Error updating profile: ' + e.message);
        }
    };
    
    /**
     * Normalize a relay URL for display and connection
     * @param {string} url - Relay URL entered by the user
     * @returns {{normalized: string, connection: string, display: string}|null}
     */
    App.normalizeRelayUrl = function(url) {
        if (!url) return null;

        let value = url.trim();
        if (!value) return null;

        if (!/^wss?:\/\//i.test(value)) {
            value = `wss://${value}`;
        }

        try {
            const parsed = new URL(value);
            const basePath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/$/, '') : '';
            const normalized = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}${basePath}`;
            const connection = parsed.toString();
            const display = normalized || connection;

            return { normalized, connection, display };
        } catch (error) {
            console.warn('[App] Invalid relay URL provided:', url, error);
            return null;
        }
    };

    /**
     * Merge relay URL lists while preserving order and removing duplicates
     * @param {string[]} primary - Primary list of relay URLs
     * @param {string[]} secondary - Secondary list of relay URLs to append if missing
     * @returns {string[]} - Merged array of connection URLs
     */
    App.mergeRelayLists = function(primary = [], secondary = []) {
        const merged = [];
        const seen = new Set();

        const append = (value) => {
            const normalized = this.normalizeRelayUrl(value);
            if (!normalized) return;
            if (seen.has(normalized.normalized)) return;
            seen.add(normalized.normalized);
            merged.push(normalized.connection);
        };

        primary.forEach(append);
        secondary.forEach(append);

        return merged;
    };

    App.loadPersistedDiscoveryRelays = function() {
        if (typeof localStorage === 'undefined') {
            return [];
        }

        try {
            const raw = localStorage.getItem(this.discoveryRelayStorageKey);
            if (!raw) return [];

            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];

            return this.mergeRelayLists(parsed, []);
        } catch (error) {
            console.warn('Failed to load discovery relay whitelist:', error);
            return [];
        }
    };

    /**
     * Replace current discovery relay list with provided URLs
     * @param {string[]|Array} relayUrls - Array of relay URLs
     * @param {Object} [options]
     * @param {boolean} [options.skipRender] - Skip UI render (used internally)
     */
    App.setDiscoveryRelays = function(relayUrls = [], { skipRender = false } = {}) {
        const nextRelays = new Map();

        relayUrls.forEach((entry) => {
            const value = typeof entry === 'string' ? entry : entry?.connection || entry?.url;
            const normalized = this.normalizeRelayUrl(value);
            if (normalized) {
                nextRelays.set(normalized.normalized, normalized);
            }
        });

        this.discoveryRelays = nextRelays;

        if (!skipRender) {
            if (typeof this.renderDiscoveryRelays === 'function') {
                this.renderDiscoveryRelays();
            } else {
                this._pendingDiscoveryRender = true;
            }
        }
    };

    App.persistedDiscoveryRelays = App.loadPersistedDiscoveryRelays();
    if (App.persistedDiscoveryRelays.length > 0 && App.discoveryRelays.size === 0) {
        App.setDiscoveryRelays(App.persistedDiscoveryRelays);
    }

    /**
     * Get discovery relay URLs for connection
     * @returns {string[]}
     */
    App.getDiscoveryRelays = function() {
        return Array.from(this.discoveryRelays.values()).map(entry => entry.connection);
    };

    /**
     * Render discovery relay list UI
     */
    App.renderDiscoveryRelays = function() {
        const listEl = document.getElementById('discovery-relay-list');
        const emptyState = document.getElementById('discovery-relay-empty');
        if (!listEl) return;

        const entries = Array.from(this.discoveryRelays.values());

        listEl.innerHTML = '';

        if (entries.length === 0) {
            if (emptyState) emptyState.classList.remove('hidden');
            listEl.classList.add('hidden');
            if (typeof this.updateDiscoveryRelaySummary === 'function') {
                this.updateDiscoveryRelaySummary();
            }
            return;
        }

        if (emptyState) emptyState.classList.add('hidden');
        listEl.classList.remove('hidden');

        entries.forEach((entry) => {
            const rawStatus = this.nostr?.client?.relayManager?.getRelayStatus(entry.connection) ||
                this.nostr?.client?.relayManager?.getRelayStatus(entry.normalized) ||
                'closed';
            const indicatorStatusSource = rawStatus === 'pending' ? 'connecting' : rawStatus;
            const indicatorStatus = ['open', 'connecting', 'closed', 'error'].includes(indicatorStatusSource)
                ? indicatorStatusSource
                : 'closed';

            const item = document.createElement('li');
            item.className = 'relay-list-item';
            item.dataset.relayUrl = entry.normalized;

            const main = document.createElement('div');
            main.className = 'relay-item-main';

            const indicator = document.createElement('span');
            indicator.className = `status-indicator status-${indicatorStatus}`;
            indicator.setAttribute('aria-hidden', 'true');
            indicator.title = indicatorStatus.charAt(0).toUpperCase() + indicatorStatus.slice(1);

            const text = document.createElement('span');
            text.className = 'relay-url';
            text.textContent = entry.display;

            main.append(indicator, text);

            const removeBtn = document.createElement('button');
            removeBtn.className = 'relay-remove-btn';
            removeBtn.type = 'button';
            removeBtn.innerHTML = '&times;';
            removeBtn.setAttribute('aria-label', `Remove relay ${entry.display}`);

            item.append(main, removeBtn);
            listEl.appendChild(item);
        });

        if (typeof this.updateDiscoveryRelaySummary === 'function') {
            this.updateDiscoveryRelaySummary();
        }
    };

    if (App._pendingDiscoveryRender) {
        App._pendingDiscoveryRender = false;
        App.renderDiscoveryRelays();
    }

    /**
     * Update discovery relay summary count text
     */
    App.updateDiscoveryRelaySummary = function() {
        const summaryEl = document.getElementById('discovery-relay-count');
        if (!summaryEl) return;

        const manager = this.nostr?.client?.relayManager || null;
        const entries = Array.from(this.discoveryRelays.values());

        let connected = 0;
        if (manager) {
            entries.forEach(entry => {
                const status = manager.getRelayStatus(entry.connection) || manager.getRelayStatus(entry.normalized);
                if (status === 'open') connected += 1;
            });
        }

        const label = connected === 1 ? 'Connected Relay' : 'Connected Relays';
        summaryEl.textContent = `${connected} ${label}`;
    };

    /**
     * Persist discovery relay whitelist to local storage
     */
    App.persistDiscoveryRelays = async function() {
        if (typeof localStorage === 'undefined') {
            return;
        }

        const list = this.getDiscoveryRelays();

        try {
            localStorage.setItem(this.discoveryRelayStorageKey, JSON.stringify(list));
            this.persistedDiscoveryRelays = list;
        } catch (error) {
            console.warn('Failed to persist discovery relay whitelist:', error);
            throw error;
        }
    };

    /**
     * Add a relay to discovery list and update connections
     * @param {string} url - Relay URL
     */
    App.addDiscoveryRelay = async function(url) {
        const normalized = this.normalizeRelayUrl(url);
        if (!normalized) {
            alert('Please enter a valid relay URL (e.g. wss://relay.example.com).');
            return;
        }

        if (this.discoveryRelays.has(normalized.normalized)) {
            alert('That relay is already in your discovery list.');
            return;
        }

        const updated = [...this.getDiscoveryRelays(), normalized.connection];
        await this.configureRelays(updated);
    };

    /**
     * Remove a relay from discovery list
     * @param {string} normalizedUrl - Normalized relay URL key
     */
    App.removeDiscoveryRelay = async function(normalizedUrl) {
        if (!this.discoveryRelays.has(normalizedUrl)) {
            return;
        }

        const remaining = Array.from(this.discoveryRelays.entries())
            .filter(([key]) => key !== normalizedUrl)
            .map(([, entry]) => entry.connection);

        await this.configureRelays(remaining);
    };

    /**
     * Handler for add relay button/input
     */
    App.handleAddDiscoveryRelay = function() {
        const input = document.getElementById('new-discovery-relay');
        if (!input) return;

        const value = input.value.trim();
        if (!value) {
            input.focus();
            return;
        }

        this.addDiscoveryRelay(value)
            .then(() => {
                input.value = '';
                input.focus();
            })
            .catch(err => {
                console.error('Failed to add discovery relay:', err);
            });
    };

    /**
     * Initialize accordion interactions on profile page
     */
    App.initializeProfileAccordions = function() {
        const toggles = document.querySelectorAll('.accordion-toggle');
        toggles.forEach(toggle => {
            const card = toggle.closest('.accordion-card');
            if (!card) return;

            const expanded = !card.classList.contains('collapsed');
            toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');

            toggle.addEventListener('click', () => {
                const isCollapsed = card.classList.toggle('collapsed');
                toggle.setAttribute('aria-expanded', (!isCollapsed).toString());
            });
        });
    };

    // Add method to configure relays
    App.configureRelays = async function(relayUrls = [], options = {}) {
        const urls = Array.isArray(relayUrls) ? relayUrls : [];
        const { skipNetwork = false, skipRender = false, includePersisted = false } = options;

        const finalUrls = includePersisted
            ? this.mergeRelayLists(urls, this.persistedDiscoveryRelays)
            : urls;

        this.setDiscoveryRelays(finalUrls, { skipRender });

        try {
            await this.persistDiscoveryRelays();
        } catch (err) {
            console.warn('Failed to persist discovery relays:', err);
        }

        if (!skipNetwork && this.nostr) {
            try {
                await this.nostr.updateRelays(this.getDiscoveryRelays());
            } catch (err) {
                console.error('Failed to update discovery relays:', err);
            }
        }
    };
    
    // Add method to track Hypertuna ID 
    App.setCurrentHypertunaId = function(hypertunaId) {
        this.currentHypertunaId = hypertunaId;
    };
    
    // Method to confirm join group with invite code
    App.confirmJoinGroup = async function() {
        if (!this.currentUser || !this.currentGroupId) {
            this.closeJoinModal();
            return;
        }
        
        const inviteCode = document.getElementById('invite-code-input').value.trim();
        if (!inviteCode) {
            alert('Please enter an invite code.');
            return;
        }
        
        try {
            await this.sendJoinRequest(inviteCode);
            // Modal remains open to display status message
        } catch (e) {
            console.error('Error joining group with invite code:', e);
            // Don't close the modal in case of error, so the user can try again
        }
    };
    
    // Initialize nostr integration if user is already logged in
    const explicitLogout = localStorage.getItem('explicit_logout') === 'true';

    // Initialize nostr integration if user is already logged in AND hasn't explicitly logged out
    if (App.currentUser && App.currentUser.privateKey && !explicitLogout) {
        App.showGroupListSpinner();
        
        App.nostr.init(App.currentUser)
            .then(async () => {
                console.log('Nostr integration initialized with discovery relays');

                if (App.configureRelays) {
                    await App.configureRelays(App.nostr.relayUrls || [], { skipNetwork: true, includePersisted: true });
                }

                // Populate profile cache for the logged in user
                try {
                    const profile = await App.nostr.client.fetchUserProfile(App.currentUser.pubkey);
                    Object.assign(App.currentUser, profile);
                    App.saveUserToLocalStorage();
                    App.updateProfileDisplay();
                } catch (err) {
                    console.error('Failed to fetch user profile after init:', err);
                }

                // Wait for relays to be ready before loading groups
                await App.nostr.waitForRelaysAndLoadGroups();
                
                // Start worker if available
                if (window.startWorker) {
                    try {
                        const key = await window.startWorker();
                        // ... rest of worker start code ...
                    } catch (err) {
                        console.error('Failed to start worker:', err);
                    }
                }
            })
            .catch(e => console.error('Error initializing nostr integration:', e));
    }
    
    return App;
}


export default integrateNostrRelays;
