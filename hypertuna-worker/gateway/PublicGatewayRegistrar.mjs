import { URL } from 'node:url';

import {
  createRelayRegistration,
  createSignature
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
    if (!this.isEnabled()) return { success: false };
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
        return { success: false, status: response.status };
      }

      let data = null;
      try {
        data = await response.json();
      } catch (_) {
        data = null;
      }

      this.logger.info?.('Relay registered with public gateway', { relayKey });
      return { success: true, ...data };
    } catch (error) {
      this.logger.error?.('Failed to register relay with public gateway', { relayKey, error: error.message });
      return { success: false, error: error.message };
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

  async issueGatewayToken(relayKey, payload = {}) {
    const body = await this.#signedPayload({ relayKey, ...payload });
    return this.#postJson('/api/relay-tokens/issue', body);
  }

  async refreshGatewayToken(relayKey, payload = {}) {
    const body = await this.#signedPayload({ relayKey, ...payload });
    return this.#postJson('/api/relay-tokens/refresh', body);
  }

  async revokeGatewayToken(relayKey, payload = {}) {
    const body = await this.#signedPayload({ relayKey, ...payload });
    return this.#postJson('/api/relay-tokens/revoke', body);
  }

  async #postJson(path, body) {
    if (!this.isEnabled()) {
      throw new Error('Public gateway registrar not configured');
    }
    const url = new URL(path, this.baseUrl).toString();
    const response = await this.fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Gateway responded with status ${response.status}`);
    }
    try {
      return await response.json();
    } catch (error) {
      throw new Error(`Failed to parse gateway response: ${error.message}`);
    }
  }

  async #signedPayload(payload) {
    if (!this.sharedSecret) throw new Error('Shared secret not configured');
    const signature = createSignature(payload, this.sharedSecret);
    return { payload, signature };
  }
}

export default PublicGatewayRegistrar;
