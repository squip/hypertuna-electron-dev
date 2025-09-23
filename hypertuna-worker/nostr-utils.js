/**
 * NostrUtils.js
 * Core utilities for nostr operations
 * Using nobleSecp256k1 for cryptography
 */

// Import from local module if available, otherwise try window object
import { nobleSecp256k1 } from './crypto-libraries.js';
import b4a from 'b4a';

export class NostrUtils {
    /**
     * Convert hex string to Uint8Array
     * @param {string} hex - Hex string
     * @returns {Uint8Array}
     */
    static hexToBytes(hex) {
        return new Uint8Array(
            hex.match(/.{1,2}/g).map(byte => parseInt(byte, 16))
        );
    }
    
    /**
     * Convert Uint8Array to hex string
     * @param {Uint8Array} bytes - Bytes to convert
     * @returns {string} - Hex string
     */
    static bytesToHex(bytes) {
        return Array.from(bytes)
            .map(byte => byte.toString(16).padStart(2, '0'))
            .join('');
    }
    
    /**
     * Generate a new private key
     * @returns {string} - Hex-encoded private key
     */
    static generatePrivateKey() {
        // Access nobleSecp256k1 from either the import or window global
        const secp = nobleSecp256k1;
        if (!secp) {
            throw new Error('Noble Secp256k1 library not available');
        }
        return this.bytesToHex(secp.utils.randomPrivateKey());
    }
    
    /**
     * Get public key from private key
     * @param {string} privateKey - Hex-encoded private key
     * @returns {string} - Hex-encoded public key (without compression prefix)
     */
    static getPublicKey(privateKey) {
        // Access nobleSecp256k1 from either the import or window global
        const secp = nobleSecp256k1;
        if (!secp) {
            throw new Error('Noble Secp256k1 library not available');
        }
        
        // Get the compressed public key (33 bytes)
        const pubKeyBytes = secp.getPublicKey(privateKey, true);
        
        // Convert to hex
        const pubKeyHex = this.bytesToHex(pubKeyBytes);
        
        // Remove the compression prefix (first 2 hex chars)
        // This returns only the x-coordinate (32 bytes = 64 hex chars)
        return pubKeyHex.substring(2);
    }
    
    /**
     * Sign an event with a private key
     * @param {Object} event - Unsigned event
     * @param {string} privateKey - Private key
     * @returns {Promise<Object>} - Signed event
     */
    static async signEvent(event, privateKey) {
        // Access nobleSecp256k1 from either the import or window global
        const secp = nobleSecp256k1;
        if (!secp) {
            throw new Error('Noble Secp256k1 library not available');
        }
        
        // Prepare the event for signing
        const eventData = JSON.stringify([
            0,
            event.pubkey,
            event.created_at,
            event.kind,
            event.tags,
            event.content
        ]);
        
        // Generate the event ID (sha256 returns Uint8Array)
        const hashBytes = await secp.utils.sha256(
            b4a.from(eventData, 'utf8')
        );
        event.id = this.bytesToHex(hashBytes);
        
        // Sign the event (schnorr.sign returns Uint8Array)
        const sigBytes = await secp.schnorr.sign(event.id, privateKey);
        event.sig = this.bytesToHex(sigBytes);
        
        return event;
    }
    
    /**
     * Verify an event signature
     * @param {Object} event - Signed event
     * @returns {Promise<boolean>} - Whether the signature is valid
     */
    static async verifySignature(event) {
        try {
            // Access nobleSecp256k1 from either the import or window global
            const secp = nobleSecp256k1;
            if (!secp) {
                throw new Error('Noble Secp256k1 library not available');
            }
            
            // Recreate the event ID
            const eventData = JSON.stringify([
                0,
                event.pubkey,
                event.created_at,
                event.kind,
                event.tags,
                event.content
            ]);
            
            const hashBytes = await secp.utils.sha256(
                b4a.from(eventData, 'utf8')
            );
            const id = this.bytesToHex(hashBytes);
            
            // Check if the ID matches
            if (id !== event.id) {
                return false;
            }
            
            // Verify the signature
            // Note: Schnorr signatures in Nostr use x-only pubkeys (32 bytes)
            // So we don't need to add the '02' prefix
            return await secp.schnorr.verify(
                event.sig,
                event.id,
                event.pubkey
            );
        } catch (error) {
            console.error('Error verifying signature:', error);
            return false;
        }
    }
    
    /**
     * Convert base64 to hex
     * @param {string} str - Base64 string
     * @returns {string} - Hex string
     */
    static base64ToHex(str) {
        var raw = atob(str);
        var result = '';
        for (var i = 0; i < raw.length; i++) {
            var hex = raw.charCodeAt(i).toString(16);
            result += (hex.length === 2 ? hex : '0' + hex);
        }
        return result;
    }
    
    /**
     * Format timestamp to human-readable time
     * @param {number} timestamp - Unix timestamp
     * @returns {string} - Formatted time string
     */
    static formatTime(timestamp) {
        const date = new Date(timestamp * 1000);
        return date.toLocaleString();
    }
    
    /**
     * Truncate pubkey for display
     * @param {string} pubkey - Public key
     * @returns {string} - Truncated public key
     */
    static truncatePubkey(pubkey) {
        if (!pubkey) return '';
        return pubkey.substring(0, 6) + '...' + pubkey.substring(pubkey.length - 4);
    }
    
    /**
     * Generate a random ID (for group IDs, etc.)
     * @returns {string} - Random ID
     */
    static generateRandomId() {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789-_';
        let result = '';
        for (let i = 0; i < 12; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    
    /**
     * Generate a random invite code
     * @returns {string} - Invite code
     */
    static generateInviteCode() {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 10; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }
    
    /**
     * Get previous event references for timeline threading
     * @param {Array} events - Array of events
     * @param {string} currentPubkey - Current user's pubkey
     * @returns {Array} - Array of event IDs to reference
     */
    static getPreviousEventRefs(events, currentPubkey) {
        // Get last 50 events excluding the current user's events
        const filteredEvents = events
            .filter(e => e.pubkey !== currentPubkey)
            .sort((a, b) => b.created_at - a.created_at)
            .slice(0, 50);
        
        // Take 3 random events from those or all if less than 3
        const numRefs = Math.min(3, filteredEvents.length);
        const refs = [];
        
        // If we have less than 3 events, use all of them
        if (filteredEvents.length <= 3) {
            refs.push(...filteredEvents.map(e => e.id.substring(0, 8)));
        } else {
            // Otherwise pick 3 random ones
            const indices = new Set();
            while (indices.size < numRefs) {
                indices.add(Math.floor(Math.random() * filteredEvents.length));
            }
            
            indices.forEach(index => {
                refs.push(filteredEvents[index].id.substring(0, 8));
            });
        }
        
        return refs;
    }
}
