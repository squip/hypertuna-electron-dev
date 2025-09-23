/**
 * browser-compat.js
 * Provides compatibility between browser and Node.js environments
 */

// Ensure window object exists
if (typeof window === 'undefined') {
    global.window = global;
}

// Ensure WebSocket is available
if (typeof WebSocket === 'undefined' && typeof require !== 'undefined') {
    try {
        const WebSocketImpl = require('ws');
        global.WebSocket = WebSocketImpl;
    } catch (e) {
        console.error('WebSocket implementation not available:', e);
    }
}

// Ensure crypto.getRandomValues is available
if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
    console.log('Polyfilling crypto.getRandomValues');
    if (typeof crypto === 'undefined') {
        global.crypto = {};
    }
    
    crypto.getRandomValues = function(array) {
        // Simple polyfill for crypto.getRandomValues
        for (let i = 0; i < array.length; i++) {
            array[i] = Math.floor(Math.random() * 256);
        }
        return array;
    };
}

// Add other browser APIs that might be needed
if (typeof atob === 'undefined' || typeof btoa === 'undefined') {
    console.log('Polyfilling atob and btoa');
    
    // In Node.js environment
    if (typeof Buffer !== 'undefined') {
        global.btoa = function(str) {
            return Buffer.from(str, 'binary').toString('base64');
        };
        
        global.atob = function(b64) {
            return Buffer.from(b64, 'base64').toString('binary');
        };
    }
}

console.log('Browser compatibility layer loaded');
