import { buildAuthHeaders, stableStringify } from './AutobaseKeyEscrowAuth.mjs';

function normalizeBaseUrl(url) {
  if (!url) return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.length ? trimmed : null;
}

class AutobaseKeyEscrowClient {
  constructor({ baseUrl, sharedSecret, clientId, fetchImpl = globalThis.fetch?.bind(globalThis) } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.sharedSecret = sharedSecret;
    this.clientId = clientId || '';
    this.fetch = fetchImpl;
    if (typeof this.fetch !== 'function') {
      throw new Error('AutobaseKeyEscrowClient requires a fetch implementation');
    }
  }

  isEnabled() {
    return Boolean(this.baseUrl && this.sharedSecret);
  }

  async fetchPolicy() {
    const url = this.#url('/policy');
    const response = await this.fetch(url);
    if (!response.ok) {
      throw new Error(`Escrow policy request failed with status ${response.status}`);
    }
    return await response.json();
  }

  async deposit(payload) {
    return this.#post('/', payload);
  }

  async unlock(payload) {
    return this.#post('/unlock', payload);
  }

  async revoke(payload) {
    return this.#post('/revoke', payload);
  }

  async listLeases() {
    const url = this.#url('/leases');
    const headers = this.#signedHeaders({});
    const response = await this.fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Escrow leases request failed with status ${response.status}`);
    }
    return await response.json();
  }

  async #post(path, body = {}) {
    const url = this.#url(path);
    const headers = {
      'content-type': 'application/json',
      ...this.#signedHeaders(body)
    };
    const response = await this.fetch(url, {
      method: 'POST',
      headers,
      body: stableStringify(body)
    });
    const text = await response.text();
    const json = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const error = new Error(json?.error || `Escrow service responded with status ${response.status}`);
      error.statusCode = response.status;
      error.body = json;
      throw error;
    }
    return json;
  }

  #signedHeaders(body) {
    if (!this.sharedSecret) {
      throw new Error('Escrow client is not configured with a shared secret');
    }
    return buildAuthHeaders({
      secret: this.sharedSecret,
      clientId: this.clientId || 'worker',
      body
    });
  }

  #url(path = '/') {
    if (!this.baseUrl) {
      throw new Error('Escrow client missing baseUrl');
    }
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${this.baseUrl}${normalized}`;
  }
}

export default AutobaseKeyEscrowClient;
