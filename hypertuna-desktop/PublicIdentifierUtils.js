// hypertuna-desktop/PublicIdentifierUtils.js
export class PublicIdentifierUtils {
    /**
     * Generate a public-facing identifier for a relay
     * @param {string} npub - User's bech32 encoded public key
     * @param {string} relayName - The relay name
     * @returns {string} - Public identifier in format "npub:relayNameInCamelCase"
     */
    static generatePublicIdentifier(npub, relayName) {
        // Remove spaces and convert to camelCase
        const camelCaseName = relayName
            .split(' ')
            .map((word, index) => {
                if (index === 0) {
                    return word.toLowerCase();
                }
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join('');
        
        return `${npub}:${camelCaseName}`;
    }
    
    /**
     * Generate WebSocket URL for a relay
     * @param {string} proxyServer - Proxy server address
     * @param {string} npub - User's bech32 encoded public key
     * @param {string} relayName - The relay name
     * @returns {string} - WebSocket URL
     */
    static generateWebSocketUrl(proxyServer, npub, relayName) {
        const camelCaseName = relayName
            .split(' ')
            .map((word, index) => {
                if (index === 0) {
                    return word.toLowerCase();
                }
                return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
            })
            .join('');
        
        return `wss://${proxyServer}/${npub}/${camelCaseName}`;
    }
    
    /**
     * Parse a public identifier
     * @param {string} publicIdentifier - The public identifier
     * @returns {Object} - Parsed components {npub, relayName}
     */
    static parsePublicIdentifier(publicIdentifier) {
        const [npub, ...nameParts] = publicIdentifier.split(':');
        return {
            npub,
            relayName: nameParts.join(':')
        };
    }
}
