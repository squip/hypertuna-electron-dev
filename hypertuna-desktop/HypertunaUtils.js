/**
 * LEGACY VERSION: HypertunaUtils.js
 * Utility functions for Hypertuna relay server integration
 * Implements key derivation logic from hypertuna-start-relay-server.mjs
 * Uses hypercore-crypto for ED25519 key generation
 */

import { NostrUtils } from './NostrUtils.js';
import { ConfigLogger } from './ConfigLogger.js';
import {
    loadGatewaySettings,
    updateGatewaySettings,
    getCachedGatewaySettings,
    deriveGatewayProxyHost,
    deriveGatewayWebsocketProtocol
} from '../shared/config/GatewaySettings.mjs';

// Import hypercore-crypto library
// Note: Make sure to add "hypercore-crypto": "^3.5.0" to your package.json dependencies
const hypercoreCrypto = window.hypercoreCrypto || null;
const electronAPI = window.electronAPI || null;
const isElectron = !!electronAPI;
const ELECTRON_CONFIG_PATH = 'electron-storage/relay-config.json';

export class HypertunaUtils {
    /**
     * Default context string for key derivation
     */
    static DEFAULT_CONTEXT = 'hypertuna-relay-peer';

    static publicGatewayState = null;
    static publicGatewayConfig = null;

    static async getGatewaySettings() {
        return loadGatewaySettings();
    }

    static getCachedGatewaySettings() {
        return getCachedGatewaySettings();
    }

    static async getDefaultGatewayUrl() {
        const settings = await loadGatewaySettings();
        return settings.gatewayUrl;
    }

    static getCachedGatewayUrl() {
        const settings = getCachedGatewaySettings();
        return settings.gatewayUrl;
    }

    static sanitizeBaseUrl(value) {
        if (!value || typeof value !== 'string') return '';
        const trimmed = value.trim();
        if (!trimmed) return '';
        return trimmed.replace(/\/$/, '');
    }

    static getLocalGatewayBase() {
        const settings = this.getCachedGatewaySettings() || {};
        const configured = this.sanitizeBaseUrl(settings.gatewayUrl || '');
        return configured || 'http://127.0.0.1:8443';
    }

    static updatePublicGatewayState(state, config = null) {
        if (!state || typeof state !== 'object') {
            this.publicGatewayState = null;
            if (config != null) {
                this.updatePublicGatewayConfig(config);
            }
            return;
        }

        const relays = {};
        if (state.relays && typeof state.relays === 'object') {
            for (const [key, value] of Object.entries(state.relays)) {
                relays[key] = value ? { ...value } : value;
            }
        }

        this.publicGatewayState = {
            enabled: !!state.enabled,
            baseUrl: this.sanitizeBaseUrl(state.baseUrl || ''),
            relays,
            defaultTokenTtl: state.defaultTokenTtl || 3600,
            wsBase: state.wsBase || null,
            lastUpdatedAt: state.lastUpdatedAt || null
        };

        if (config != null) {
            this.updatePublicGatewayConfig(config);
        }
    }

    static getPublicGatewayState() {
        return this.publicGatewayState;
    }

    static updatePublicGatewayConfig(config) {
        if (config && typeof config === 'object') {
            this.publicGatewayConfig = { ...config };
        } else {
            this.publicGatewayConfig = null;
        }
    }

    static getPublicGatewayConfig() {
        return this.publicGatewayConfig;
    }

    static isRelayRegisteredWithPublic(identifier) {
        const state = this.publicGatewayState;
        if (!state || !state.enabled || !state.baseUrl) return false;
        if (!identifier) return false;
        const entry = state.relays?.[identifier];
        if (!entry) return false;
        return entry.status === 'registered';
    }

    static resolveDrivePath(identifier, fileId) {
        const safeIdentifier = typeof identifier === 'string' && identifier.trim()
            ? identifier.trim().replace(/^\/+/, '')
            : '';
        const safeFileId = typeof fileId === 'string' && fileId.trim()
            ? fileId.trim().replace(/^\/+/, '')
            : '';
        if (!safeIdentifier || !safeFileId) {
            return null;
        }
        return `/drive/${safeIdentifier}/${safeFileId}`;
    }

    static resolveDriveBases(identifier, preferPublic = true) {
        const localBase = this.sanitizeBaseUrl(this.getLocalGatewayBase());
        const state = this.publicGatewayState;
        const publicAvailable = Boolean(
            preferPublic &&
            state &&
            state.enabled &&
            state.baseUrl &&
            this.isRelayRegisteredWithPublic(identifier)
        );

        const publicBase = publicAvailable ? state.baseUrl : '';

        let primaryBase = localBase;
        let fallbackBase = '';

        if (publicAvailable && publicBase) {
            primaryBase = publicBase;
            if (localBase && localBase !== publicBase) {
                fallbackBase = localBase;
            }
        } else if (state && state.enabled && state.baseUrl && localBase !== state.baseUrl) {
            fallbackBase = state.baseUrl;
        }

        return {
            primaryBase: primaryBase || '',
            fallbackBase: fallbackBase || ''
        };
    }

    static buildDriveUrl({ identifier, fileId, preferPublic = true } = {}) {
        const drivePath = this.resolveDrivePath(identifier, fileId);
        if (!drivePath) {
            return {
                url: null,
                drivePath: null,
                primaryBase: null,
                fallbackBase: null,
                fallbackUrl: null
            };
        }
        const { primaryBase, fallbackBase } = this.resolveDriveBases(identifier, preferPublic);
        const url = primaryBase ? `${primaryBase}${drivePath}` : drivePath;
        const fallbackUrl = fallbackBase ? `${fallbackBase}${drivePath}` : null;
        return {
            url,
            drivePath,
            primaryBase: primaryBase || null,
            fallbackBase: fallbackBase || null,
            fallbackUrl
        };
    }

    static parseDriveUrl(url) {
        if (!url || typeof url !== 'string') return null;
        let parsed;
        try {
            parsed = new URL(url, window?.location?.origin || 'http://localhost');
        } catch (_) {
            return null;
        }

        const pathname = parsed.pathname || '';
        if (!pathname.startsWith('/drive/')) return null;
        const driveSegment = pathname.slice('/drive/'.length);
        const lastSlash = driveSegment.lastIndexOf('/');
        if (lastSlash === -1) return null;
        const identifier = decodeURIComponent(driveSegment.slice(0, lastSlash));
        const fileId = decodeURIComponent(driveSegment.slice(lastSlash + 1));
        const drivePath = `/drive/${driveSegment}`;

        return {
            baseUrl: this.sanitizeBaseUrl(parsed.origin || ''),
            identifier,
            fileId,
            drivePath,
            originalUrl: url
        };
    }

    static getGatewayHost(value) {
        return deriveGatewayProxyHost(value);
    }

    static getGatewayWebsocketProtocol(value) {
        return deriveGatewayWebsocketProtocol(value);
    }

    static resolvePfpUrl(url, isHypertunaPfp = false) {
        if (!url) {
            console.log('[Avatar] resolvePfpUrl called without URL', { isHypertunaPfp });
            return url;
        }
        if (!isHypertunaPfp) {
            return url;
        }

        const cachedSettings = this.getCachedGatewaySettings();
        const baseCandidate = cachedSettings.gatewayUrl || this.getCachedGatewayUrl() || '';
        const base = baseCandidate.replace(/\/$/, '');
        const context = {
            url,
            baseCandidate,
            base,
            isHypertunaPfp
        };

        if (!base) {
            console.warn('[Avatar] resolvePfpUrl missing gateway base', context);
            return url;
        }

        try {
            const parsed = new URL(url, base);
            if (!parsed.pathname.startsWith('/pfp/')) {
                console.log('[Avatar] resolvePfpUrl non-pfp path', {
                    ...context,
                    resolved: url,
                    pathname: parsed.pathname
                });
                return url;
            }
            const resolved = `${base}${parsed.pathname}${parsed.search || ''}`;
            console.log('[Avatar] resolvePfpUrl resolved', {
                ...context,
                resolved
            });
            return resolved;
        } catch (error) {
            if (url.startsWith('/pfp/')) {
                const resolved = `${base}${url}`;
                console.warn('[Avatar] resolvePfpUrl fallback applied', {
                    ...context,
                    resolved,
                    error: error?.message
                });
                return resolved;
            }
            console.warn('[Avatar] resolvePfpUrl failed to resolve', {
                ...context,
                error: error?.message
            });
        }
        return url;
    }

    static async persistGatewaySettings(gatewayUrl) {
        const proxyHost = deriveGatewayProxyHost(gatewayUrl);
        const proxyWebsocketProtocol = deriveGatewayWebsocketProtocol(gatewayUrl);
        return updateGatewaySettings({ gatewayUrl, proxyHost, proxyWebsocketProtocol });
    }
    
    /**
     * LocalStorage key for Hypertuna configuration
     */
    static STORAGE_KEY = 'hypertuna_config';
    
    /**
     * Decode a base32 NOSTR private key (nsec)
     * @param {string} nsec - NOSTR private key in hex format
     * @returns {string} - Hex encoded private key
     */
    static decodeNsec(nsec) {
        // For now, we're assuming the nsec is already in hex format
        // In a real implementation, you would use a base32 decoder here
        return nsec;
    }
    
    /**
     * Convert hex string to Uint8Array
     * @param {string} hex - Hex string
     * @returns {Uint8Array} - Byte array
     */
    static hexToBytes(hex) {
        // Ensure hex string has even length
        if (hex.length % 2 !== 0) {
            hex = '0' + hex;
        }
        
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i/2] = parseInt(hex.substring(i, i + 2), 16);
        }
        return bytes;
    }
    
    /**
     * Convert Uint8Array to hex string
     * @param {Uint8Array} bytes - Byte array
     * @returns {string} - Hex string
     */
    static bytesToHex(bytes) {
        return Array.from(bytes)
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('');
    }
    
    /**
     * Derive a Hypertuna keypair from a NOSTR private key
     * Based on the implementation in hypertuna-start-relay-server.mjs
     * @param {string} privateKeyHex - Hex encoded private key
     * @param {string} context - Context string for derivation (salt)
     * @returns {Promise<Object>} - Derived keypair with privateKey, publicKey, and seed
     */
    static async deriveHypertunaKeypair(privateKeyHex, context = this.DEFAULT_CONTEXT) {
        try {
            // Check if hypercore-crypto is available
            if (hypercoreCrypto) {
                console.log('Using hypercore-crypto for key derivation');
                
                // First use PBKDF2 to derive a seed from the private key and context
                const privateKeyBytes = this.hexToBytes(privateKeyHex);
                const contextBytes = new TextEncoder().encode(context);
                
                // Import the private key as a raw key
                const keyMaterial = await window.crypto.subtle.importKey(
                    'raw',
                    privateKeyBytes,
                    { name: 'PBKDF2' },
                    false,
                    ['deriveBits']
                );
                
                // Derive bits using PBKDF2
                const derivedBits = await window.crypto.subtle.deriveBits(
                    {
                        name: 'PBKDF2',
                        salt: contextBytes,
                        iterations: 100000,
                        hash: 'SHA-256'
                    },
                    keyMaterial,
                    256 // 32 bytes (256 bits)
                );
                
                // Convert the derived bits to a byte array to use as a seed
                const seedBytes = new Uint8Array(derivedBits);
                
                // Use the seedBytes with hypercore-crypto to generate an ED25519 keypair
                // hypercore-crypto.keyPair([seed]) - generates an ED25519 keypair from an optional seed
                const keypair = hypercoreCrypto.keyPair(seedBytes);
                
                // Convert the keypair to hex strings
                const derivedPrivateKey = this.bytesToHex(keypair.secretKey);
                const derivedPublicKey = this.bytesToHex(keypair.publicKey);
                const seedHex = this.bytesToHex(seedBytes);
                
                return {
                    privateKey: derivedPrivateKey,
                    publicKey: derivedPublicKey,
                    seed: seedHex
                };
            } else {
                console.log('hypercore-crypto not available, using WebCrypto API');
                
                // Use SubtleCrypto API for PBKDF2 key derivation, which is available in browsers
                const privateKeyBytes = this.hexToBytes(privateKeyHex);
                const contextBytes = new TextEncoder().encode(context);
                
                // Import the private key as a raw key
                const keyMaterial = await window.crypto.subtle.importKey(
                    'raw',
                    privateKeyBytes,
                    { name: 'PBKDF2' },
                    false,
                    ['deriveBits']
                );
                
                // Derive bits using PBKDF2
                const derivedBits = await window.crypto.subtle.deriveBits(
                    {
                        name: 'PBKDF2',
                        salt: contextBytes,
                        iterations: 100000,
                        hash: 'SHA-256'
                    },
                    keyMaterial,
                    256 // 32 bytes (256 bits)
                );
                
                // Convert the derived bits to a byte array and hex string
                const derivedKey = new Uint8Array(derivedBits);
                const derivedKeyHex = this.bytesToHex(derivedKey);
                
                // Since we don't have hypercore-crypto's ED25519 implementation,
                // we'll use the NostrUtils.getPublicKey which should work with the derived key
                const publicKey = NostrUtils.getPublicKey(derivedKeyHex.substring(0, 64));
                
                return {
                    privateKey: derivedKeyHex,
                    publicKey: publicKey,
                    seed: derivedKeyHex.substring(0, 64) // First 32 bytes as seed
                };
            }
        } catch (e) {
            console.error('Error deriving Hypertuna keypair:', e);
            
            // Provide a fallback in case of error
            return this.fallbackKeyPair(privateKeyHex);
        }
    }
    
    /**
     * Fallback method for key derivation if the primary methods fail
     * @param {string} privateKeyHex - Original private key
     * @returns {Object} - A keypair derived from the original key
     */
    static fallbackKeyPair(privateKeyHex) {
        // Use a simplified derivation that will always be valid
        const derivedPrivateKey = this.fallbackDeriveKey(privateKeyHex, this.DEFAULT_CONTEXT);
        
        // Generate the public key from the derived private key
        const publicKey = NostrUtils.getPublicKey(derivedPrivateKey);
        
        return {
            privateKey: derivedPrivateKey,
            publicKey: publicKey,
            seed: derivedPrivateKey.substring(0, 64)
        };
    }
    
    /**
     * Fallback method for key derivation if WebCrypto is not available
     * @param {string} privateKeyHex - Hex encoded private key
     * @param {string} context - Context string for derivation
     * @returns {string} - A deterministic but simplified derived key
     */
    static fallbackDeriveKey(privateKeyHex, context) {
        // Create a simple hash of the privateKey and context
        let hash = 0;
        const input = privateKeyHex + context;
        
        for (let i = 0; i < input.length; i++) {
            const char = input.charCodeAt(i);
            hash = ((hash << 5) - hash) + char;
            hash |= 0; // Convert to 32-bit integer
        }
        
        // Create a deterministic hex string from the hash
        let derivedKey = Math.abs(hash).toString(16);
        
        // Pad to ensure it's long enough for a private key
        while (derivedKey.length < 64) {
            derivedKey += derivedKey;
        }
        
        // Return the first 64 chars (32 bytes) as the private key
        return derivedKey.substring(0, 64);
    }
    
    /**
     * Generate Hypertuna configuration for a user
     * @param {string} privateKeyHex - User's private key in hex format
     * @param {string} publicKeyHex - User's public key in hex format 
     * @param {string} gatewayUrl - Gateway URL (optional)
     * @returns {Promise<Object>} - Hypertuna configuration
     */
    static async generateHypertunaConfig(privateKeyHex, publicKeyHex, gatewayUrl) {
        const effectiveGatewayUrl = gatewayUrl || await this.getDefaultGatewayUrl();
        const cachedSettings = this.getCachedGatewaySettings();
        const proxyHost = this.getGatewayHost(effectiveGatewayUrl) || cachedSettings.proxyHost;
        const proxyWebsocketProtocol = this.getGatewayWebsocketProtocol(effectiveGatewayUrl) || cachedSettings.proxyWebsocketProtocol;
        try {
            // Derive the keypair for Hypertuna relay
            const derivedKeypair = await this.deriveHypertunaKeypair(privateKeyHex);
            
            // Generate bech32 encoded values
            const nostr_npub = NostrUtils.hexToNpub(publicKeyHex);
            const nostr_nsec = NostrUtils.hexToNsec(privateKeyHex);
            
            // Create the full configuration
            return {
                // Hex values (kept for compatibility)
                nostr_pubkey_hex: publicKeyHex,
                nostr_nsec_hex: privateKeyHex,
                
                // Bech32 encoded values (new)
                nostr_npub: nostr_npub,
                nostr_nsec: nostr_nsec,
                
                // Hypertuna proxy keys
                proxy_privateKey: derivedKeypair.privateKey,
                proxy_publicKey: derivedKeypair.publicKey,
                proxy_seed: derivedKeypair.seed,
                swarmPublicKey: derivedKeypair.publicKey,
                
                // Server configuration
                proxy_server_address: proxyHost,
                gatewayUrl: effectiveGatewayUrl,
                proxy_websocket_protocol: proxyWebsocketProtocol,
                registerWithGateway: true,
                registerInterval: 300000
            };
        } catch (error) {
            console.error('Error generating Hypertuna config:', error);
            
            // Return a valid but fallback config if derivation fails
            const fallbackKeypair = this.fallbackKeyPair(privateKeyHex);
            
            // Generate bech32 values even in fallback
            const nostr_npub = NostrUtils.hexToNpub(publicKeyHex);
            const nostr_nsec = NostrUtils.hexToNsec(privateKeyHex);
            
            return {
                // Hex values
                nostr_pubkey_hex: publicKeyHex,
                nostr_nsec_hex: privateKeyHex,
                
                // Bech32 values
                nostr_npub: nostr_npub,
                nostr_nsec: nostr_nsec,
                
                // Proxy keys
                proxy_privateKey: fallbackKeypair.privateKey,
                proxy_publicKey: fallbackKeypair.publicKey,
                proxy_seed: fallbackKeypair.seed,
                swarmPublicKey: fallbackKeypair.publicKey,
                
                // Server configuration
                proxy_server_address: proxyHost,
                gatewayUrl: effectiveGatewayUrl,
                proxy_websocket_protocol: proxyWebsocketProtocol,
                registerWithGateway: true,
                registerInterval: 300000
            };
        }
    }
    
    /**
     * Save Hypertuna configuration to localStorage
     * @param {Object} config - Hypertuna configuration
     */
    static async saveConfig(config) {
        const existing = await this.loadConfig();
        const merged = { ...(existing || {}), ...config };

        ConfigLogger.log('SAVE', {
            module: 'HypertunaUtils',
            method: 'saveConfig',
            key: this.STORAGE_KEY,
            dataSize: ConfigLogger.getDataSize(merged)
        });

        // Save to localStorage
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(merged));
            ConfigLogger.log('SAVE', {
                module: 'HypertunaUtils',
                method: 'saveConfig',
                filepath: 'localStorage',
                key: this.STORAGE_KEY,
                success: true,
                dataSize: ConfigLogger.getDataSize(merged)
            });
        } catch (e) {
            ConfigLogger.log('SAVE', {
                module: 'HypertunaUtils',
                method: 'saveConfig',
                filepath: 'localStorage',
                key: this.STORAGE_KEY,
                success: false,
                error: e.message
            });
        }

        // Persist to disk when running inside Electron
        if (isElectron && electronAPI?.writeConfig) {
            try {
                ConfigLogger.log('SAVE', {
                    module: 'HypertunaUtils',
                    method: 'saveConfig',
                    filepath: ELECTRON_CONFIG_PATH,
                    dataSize: ConfigLogger.getDataSize(merged)
                });

                const result = await electronAPI.writeConfig(merged);
                if (!result?.success) {
                    throw new Error(result?.error || 'Unknown write failure');
                }

                ConfigLogger.log('SAVE', {
                    module: 'HypertunaUtils',
                    method: 'saveConfig',
                    filepath: ELECTRON_CONFIG_PATH,
                    success: true,
                    dataSize: ConfigLogger.getDataSize(merged)
                });
            } catch (e) {
                ConfigLogger.log('SAVE', {
                    module: 'HypertunaUtils',
                    method: 'saveConfig',
                    filepath: ELECTRON_CONFIG_PATH,
                    success: false,
                    error: e.message
                });
            }
        }
    }
    
    /**
     * Load Hypertuna configuration from localStorage or file system
     * Ensures bech32 values are present for backward compatibility
     * @returns {Object|null} - Hypertuna configuration or null if not found
     */
    static async loadConfig() {
        ConfigLogger.log('LOAD', {
            module: 'HypertunaUtils',
            method: 'loadConfig',
            filepath: 'attempting multiple sources'
        });
        
        let config = null;
        
        // Try loading from Electron storage
        if (isElectron && electronAPI?.readConfig) {
            try {
                ConfigLogger.log('LOAD', {
                    module: 'HypertunaUtils',
                    method: 'loadConfig',
                    filepath: ELECTRON_CONFIG_PATH,
                    attempting: true
                });

                const result = await electronAPI.readConfig();
                if (result?.success && result.data) {
                    const serialized = JSON.stringify(result.data);
                    config = result.data;

                    ConfigLogger.log('LOAD', {
                        module: 'HypertunaUtils',
                        method: 'loadConfig',
                        filepath: ELECTRON_CONFIG_PATH,
                        success: true,
                        dataSize: serialized.length
                    });
                } else if (result && !result.success) {
                    ConfigLogger.log('LOAD', {
                        module: 'HypertunaUtils',
                        method: 'loadConfig',
                        filepath: ELECTRON_CONFIG_PATH,
                        success: false,
                        error: result.error
                    });
                }
            } catch (e) {
                ConfigLogger.log('LOAD', {
                    module: 'HypertunaUtils',
                    method: 'loadConfig',
                    filepath: ELECTRON_CONFIG_PATH,
                    success: false,
                    error: e.message
                });
            }
        }
        
        // Fall back to localStorage
        if (!config) {
            try {
                ConfigLogger.log('LOAD', {
                    module: 'HypertunaUtils',
                    method: 'loadConfig',
                    filepath: 'localStorage',
                    key: this.STORAGE_KEY,
                    attempting: true
                });
                
                const local = localStorage.getItem(this.STORAGE_KEY);
                config = local ? JSON.parse(local) : null;
                
                ConfigLogger.log('LOAD', {
                    module: 'HypertunaUtils',
                    method: 'loadConfig',
                    filepath: 'localStorage',
                    key: this.STORAGE_KEY,
                    success: !!config,
                    dataSize: local ? local.length : 0
                });
            } catch (e) {
                ConfigLogger.log('LOAD', {
                    module: 'HypertunaUtils',
                    method: 'loadConfig',
                    filepath: 'localStorage',
                    key: this.STORAGE_KEY,
                    success: false,
                    error: e.message
                });
            }
        }
        
        // Ensure bech32 values are present (for backward compatibility)
        if (config) {
            const gatewaySettings = await this.getGatewaySettings();
            // Check if bech32 values are missing and generate them
            if (config.nostr_pubkey_hex && !config.nostr_npub) {
                config.nostr_npub = NostrUtils.hexToNpub(config.nostr_pubkey_hex);
                console.log('Generated missing npub from hex:', config.nostr_npub);
            }
            
            if (config.nostr_nsec_hex && !config.nostr_nsec) {
                config.nostr_nsec = NostrUtils.hexToNsec(config.nostr_nsec_hex);
                console.log('Generated missing nsec from hex');
            }

            if (config.nostr_nsec && /^[0-9a-fA-F]{64}$/.test(config.nostr_nsec)) {
                console.log('Normalizing hex-formatted nostr_nsec to bech32');
                config.nostr_nsec = NostrUtils.hexToNsec(config.nostr_nsec.toLowerCase());
            }
            
            // Validate bech32 values match hex values
            if (config.nostr_npub) {
                const derivedHex = NostrUtils.npubToHex(config.nostr_npub);
                if (derivedHex && derivedHex !== config.nostr_pubkey_hex) {
                    console.warn('Mismatch between npub and hex pubkey, regenerating npub');
                    config.nostr_npub = NostrUtils.hexToNpub(config.nostr_pubkey_hex);
                }
            }
            
            if (config.nostr_nsec) {
                const derivedHex = NostrUtils.nsecToHex(config.nostr_nsec);
                if (derivedHex && derivedHex !== config.nostr_nsec_hex) {
                    console.warn('Mismatch between nsec and hex privkey, regenerating nsec');
                    config.nostr_nsec = NostrUtils.hexToNsec(config.nostr_nsec_hex);
                }
            }

            if (typeof config.driveKey === 'undefined') {
                config.driveKey = null;
            }

            if (typeof config.pfpDriveKey === 'undefined') {
                config.pfpDriveKey = null;
            }

            if (!config.proxy_server_address && gatewaySettings.proxyHost) {
                config.proxy_server_address = gatewaySettings.proxyHost;
            }

            if (!config.proxy_websocket_protocol) {
                const referenceGatewayUrl = config.gatewayUrl || gatewaySettings.gatewayUrl;
                config.proxy_websocket_protocol = gatewaySettings.proxyWebsocketProtocol || this.getGatewayWebsocketProtocol(referenceGatewayUrl);
            }
        }

        return config;
    }
    
    /**
     * Create or update Hypertuna configuration for a user
     * @param {Object} user - User object with privateKey and pubkey
     * @param {string} gatewayUrl - Gateway URL (optional)
     * @returns {Promise<Object>} - Hypertuna configuration
     */
    static async setupUserConfig(user, gatewayUrl) {
        if (!user || !user.privateKey || !user.pubkey) {
            throw new Error('Invalid user object');
        }
        
        const effectiveGatewayUrl = gatewayUrl || await this.getDefaultGatewayUrl();
        const config = await this.generateHypertunaConfig(
            user.privateKey,
            user.pubkey,
            effectiveGatewayUrl
        );
        
        await this.saveConfig(config);
        return config;
    }

    /**
     * Ensure a config object has bech32 encoded values
     * This is useful before sending config to worker or saving
     * @param {Object} config - Hypertuna configuration
     * @returns {Object} - Config with bech32 values added if missing
     */
    static ensureBech32Values(config) {
        if (!config) return config;
        
        // Create a copy to avoid mutating the original
        const enhancedConfig = { ...config };
        
        // Add npub if missing
        if (enhancedConfig.nostr_pubkey_hex && !enhancedConfig.nostr_npub) {
            try {
                enhancedConfig.nostr_npub = NostrUtils.hexToNpub(enhancedConfig.nostr_pubkey_hex);
            } catch (e) {
                console.error('Failed to generate npub:', e);
            }
        }
        
        // Add nsec if missing
        if (enhancedConfig.nostr_nsec_hex && !enhancedConfig.nostr_nsec) {
            try {
                enhancedConfig.nostr_nsec = NostrUtils.hexToNsec(enhancedConfig.nostr_nsec_hex);
            } catch (e) {
                console.error('Failed to generate nsec:', e);
            }
        }
        
        return enhancedConfig;
    }

}
