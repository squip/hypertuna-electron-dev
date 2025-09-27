import { URL } from 'node:url';

import {
  createRelayRegistration,
  createSignature,
  issueClientToken
} from '../../shared/auth/PublicGatewayTokens.mjs';

class PublicGatewayRegistrar {
  constructor({ baseUrl, sharedSecret, logger, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl ? baseUrl.replace(/\/$/, '') : null;
    this.sharedSecret = sharedSecret;
    this.fetch = fetchImpl;
    this.logger = logger || console;
    this.enabled = Boolean(this.baseUrl && this.sharedSecret && typeof this.fetch === 'function');
  }

  isEnabled() {
    return this.enabled;
  }

  async registerRelay(relayKey, payload = {}) {
    if (!this.isEnabled()) return false;
    if (!relayKey) throw new Error('relayKey is required');

    const registration = createRelayRegistration(relayKey, payload);
    const signature = createSignature(registration, this.sharedSecret);

    const body = JSON.stringify({ registration, signature });
    const url = new URL('/api/relays', this.baseUrl).toString();

    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body
      });

      if (!response.ok) {
        const text = await response.text();
        this.logger.warn?.('Public gateway registration failed', { status: response.status, relayKey });
        if (text) {
          this.logger.debug?.('Public gateway error response', { body: text, relayKey });
        }
        return false;
      }

      this.logger.info?.('Relay registered with public gateway', { relayKey });
      return true;
    } catch (error) {
      this.logger.error?.('Failed to register relay with public gateway', { relayKey, error: error.message });
      return false;
    }
  }

  async unregisterRelay(relayKey) {
    if (!this.isEnabled()) return false;
    const url = new URL(`/api/relays/${encodeURIComponent(relayKey)}`, this.baseUrl).toString();
    const signature = createSignature({ relayKey }, this.sharedSecret);

    try {
      const response = await this.fetch(url, {
        method: 'DELETE',
        headers: {
          'x-signature': signature
        }
      });
      if (!response.ok) {
        this.logger.warn?.('Public gateway unregister failed', { relayKey, status: response.status });
        return false;
      }
      this.logger.info?.('Relay unregistered from public gateway', { relayKey });
      return true;
    } catch (error) {
      this.logger.error?.('Failed to unregister relay', { relayKey, error: error.message });
      return false;
    }
  }

  issueClientToken(relayKey, options = {}) {
    if (!this.isEnabled()) throw new Error('Public gateway registrar not configured');
    const payload = {
      relayKey,
      expiresAt: options.expiresAt || Date.now() + (options.ttlSeconds || 3600) * 1000,
      scope: options.scope || 'relay-access'
    };
    return issueClientToken(payload, this.sharedSecret);
  }
}

export default PublicGatewayRegistrar;
