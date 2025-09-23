/**
 * crypto-libraries.js
 * Load cryptographic libraries for Nostr operations
 */

const { electronAPI } = window;

if (!electronAPI || (!electronAPI.importModule && !electronAPI.requireModule)) {
    throw new Error('electronAPI module loaders are not available in renderer context.');
}

const loadModule = async (specifier) => {
    if (electronAPI.requireModule) {
        try {
            return electronAPI.requireModule(specifier);
        } catch (error) {
            console.warn(`Failed to require ${specifier}, falling back to dynamic import`, error);
        }
    }
    if (electronAPI.importModule) {
        return electronAPI.importModule(specifier);
    }
    throw new Error(`Unable to load module: ${specifier}`);
};

console.log('[Crypto] Loading cryptographic dependencies...');

const secpModule = await loadModule('noble-secp256k1');
const cipherModule = await loadModule('browserify-cipher');
const bech32Module = await loadModule('bech32');

const secp256k1 = secpModule.default || secpModule;
const cipher = cipherModule.default || cipherModule;
const bech32 = bech32Module.bech32 || bech32Module.default || bech32Module;

window.nobleSecp256k1 = secp256k1;
window.browserifyCipher = cipher;
window.bech32 = bech32;

export { bech32, secp256k1 as nobleSecp256k1, cipher as browserifyCipher };

console.log('[Crypto] Libraries loaded successfully:');
console.log('[Crypto] Noble Secp256k1 loaded:', !!window.nobleSecp256k1);
console.log('[Crypto] Browserify Cipher loaded:', !!window.browserifyCipher);
console.log('[Crypto] Bech32 loaded:', !!window.bech32);
