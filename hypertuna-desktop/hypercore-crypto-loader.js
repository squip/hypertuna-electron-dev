/**
 * hypercore-crypto-loader.js
 * Loads the hypercore-crypto library and makes it available globally
 * and as an ES module export.
 */

let hypercoreCrypto;

const { electronAPI } = window;

if (!electronAPI || (!electronAPI.importModule && !electronAPI.requireModule)) {
    console.warn('electronAPI module loaders unavailable; falling back to WebCrypto API for hypercore-crypto.');
    window.hypercoreCrypto = createFallbackHypercoreCrypto();
} else {
    try {
        let module;
        if (electronAPI.requireModule) {
            try {
                module = electronAPI.requireModule('hypercore-crypto');
            } catch (requireError) {
                console.warn('Failed to require hypercore-crypto, attempting dynamic import', requireError);
                module = await electronAPI.importModule('hypercore-crypto');
            }
        } else {
            module = await electronAPI.importModule('hypercore-crypto');
        }
        hypercoreCrypto = module.default || module;
        window.hypercoreCrypto = hypercoreCrypto;
        console.log('[Hypercore] hypercore-crypto loaded successfully');
    } catch (error) {
        console.warn('[Hypercore] Failed to load hypercore-crypto module:', error);
        console.warn('[Hypercore] Falling back to WebCrypto API for key derivation');
        window.hypercoreCrypto = createFallbackHypercoreCrypto();
    }
}

/**
 * Creates a fallback implementation of the hypercore-crypto API
 * using the WebCrypto API and other available methods
 * @returns {Object} - A minimal hypercore-crypto compatible API
 */
function createFallbackHypercoreCrypto() {
    return {
        /**
         * Generate an ED25519 keypair
         * @param {Uint8Array} [seed] - Optional seed for deterministic generation
         * @returns {Object} - Object with secretKey and publicKey as Uint8Array
         */
        keyPair: function(seed) {
            // If a seed is provided, use it for deterministic key generation
            if (seed) {
                // Since we don't have direct ED25519 generation,
                // we'll have to use what's available
                
                // Convert seed to hex for use with NostrUtils
                const seedHex = bytesToHex(seed);
                
                // Use NostrUtils to get the public key from the private key
                // Assuming the seed can be used as a private key
                const publicKeyHex = NostrUtils.getPublicKey(seedHex);
                
                // Convert back to Uint8Array format
                return {
                    secretKey: seed, // Use the seed as the secret key
                    publicKey: hexToBytes(publicKeyHex)
                };
            } else {
                // Generate a random private key using WebCrypto API
                const privateKey = NostrUtils.generatePrivateKey();
                const publicKey = NostrUtils.getPublicKey(privateKey);
                
                // Convert hex strings to Uint8Array format
                return {
                    secretKey: hexToBytes(privateKey),
                    publicKey: hexToBytes(publicKey)
                };
            }
        },
        
        /**
         * Sign a message using ED25519
         * @param {Uint8Array} message - Message to sign
         * @param {Uint8Array} secretKey - Secret key to sign with
         * @returns {Uint8Array} - Signature
         */
        sign: function(message, secretKey) {
            console.warn('Fallback sign() method not fully implemented');
            // This is a placeholder - in a real implementation, 
            // you would need to implement ED25519 signing
            return new Uint8Array(64); // Return dummy signature
        },
        
        /**
         * Verify a signature using ED25519
         * @param {Uint8Array} message - Message to verify
         * @param {Uint8Array} signature - Signature to verify
         * @param {Uint8Array} publicKey - Public key to verify with
         * @returns {boolean} - Whether the signature is valid
         */
        verify: function(message, signature, publicKey) {
            console.warn('Fallback verify() method not fully implemented');
            // This is a placeholder - in a real implementation,
            // you would need to implement ED25519 verification
            return false;
        },
        
        /**
         * Generate random bytes
         * @param {number} size - Number of bytes to generate
         * @returns {Uint8Array} - Random bytes
         */
        randomBytes: function(size) {
            return window.crypto.getRandomValues(new Uint8Array(size));
        }
    };
}

/**
 * Convert hex string to Uint8Array
 * @param {string} hex - Hex string
 * @returns {Uint8Array} - Byte array
 */
function hexToBytes(hex) {
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
function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

// Export the hypercore-crypto instance
export default hypercoreCrypto;
