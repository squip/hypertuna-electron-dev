/**
 * crypto-libraries.js
 * Load cryptographic libraries for Nostr operations
 */

// Polyfill globals before pulling in crypto deps
import './process-shim.js';

const { electronAPI } = window;
const nodeRequire = typeof require === 'function' ? require : null;

// Use Electron preload loaders when available; otherwise fall back to bundler/browser imports.
const loadModule = async (specifier) => {
  if (electronAPI?.requireModule || electronAPI?.importModule) {
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
  }

  if (nodeRequire) {
    try {
      return nodeRequire(specifier);
    } catch (error) {
      console.warn(`Node require failed for ${specifier}, falling back to dynamic import`, error);
    }
  }

  // Browser/Vite fallback uses statically imported modules (ensures bundling)
  if (specifier === 'noble-secp256k1') return nobleImport;
  if (specifier === 'browserify-cipher') return cipherImport;
  if (specifier === 'bech32') return bech32Import;
  return import(specifier);
};

console.log('[Crypto] Loading cryptographic dependencies...');

let secpModule;
let cipherModule;
let bech32Module;

// Prefer Electron/Node require when available to avoid bare-specifier resolution issues
if (nodeRequire || electronAPI?.requireModule) {
  try {
    secpModule = (electronAPI?.requireModule || nodeRequire)('noble-secp256k1');
    cipherModule = (electronAPI?.requireModule || nodeRequire)('browserify-cipher');
    bech32Module = (electronAPI?.requireModule || nodeRequire)('bech32');
  } catch (err) {
    console.warn('[Crypto] Node require failed, falling back to dynamic import', err);
  }
}

if (!secpModule || !cipherModule || !bech32Module) {
  secpModule = secpModule || await loadModule('noble-secp256k1');
  cipherModule = cipherModule || await loadModule('browserify-cipher');
  bech32Module = bech32Module || await loadModule('bech32');
}

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
