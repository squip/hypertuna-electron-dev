import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import { buildAuthHeaders, stableStringify } from './AutobaseKeyEscrowAuth.mjs';

function normalizeBaseUrl(url) {
  if (!url) return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed.length ? trimmed : null;
}

function normalizeTlsOptions(tls = null) {
  if (!tls || typeof tls !== 'object') return null;
  const normalized = {
    ca: tls.ca || null,
    cert: tls.cert || null,
    key: tls.key || null,
    rejectUnauthorized: tls.rejectUnauthorized !== false
  };
  if (!normalized.ca && !normalized.cert && !normalized.key && normalized.rejectUnauthorized === true) {
    return null;
  }
  return normalized;
}

class AutobaseKeyEscrowClient {
  constructor({
    baseUrl,
    sharedSecret,
    clientId,
    tls = null
  } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.sharedSecret = sharedSecret;
    this.clientId = clientId || '';
    this.tls = normalizeTlsOptions(tls);
  }

  isEnabled() {
    return Boolean(this.baseUrl && this.sharedSecret);
  }

  async fetchPolicy() {
    const response = await this.#sendRequest('/policy');
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Escrow policy request failed with status ${response.statusCode}`);
    }
    const text = response.body.toString('utf8');
    return text ? JSON.parse(text) : {};
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
    const headers = this.#signedHeaders({});
    const response = await this.#sendRequest('/leases', { headers });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error(`Escrow leases request failed with status ${response.statusCode}`);
    }
    const text = response.body.toString('utf8');
    return text ? JSON.parse(text) : {};
  }

  async #post(path, body = {}) {
    const url = this.#url(path);
    const headers = {
      'content-type': 'application/json',
      ...this.#signedHeaders(body)
    };
    const payload = stableStringify(body);
    headers['content-length'] = String(Buffer.byteLength(payload));
    const response = await this.#sendRequest(path, {
      method: 'POST',
      headers,
      body: payload
    });
    const text = response.body.toString('utf8');
    const json = text ? JSON.parse(text) : {};
    if (response.statusCode < 200 || response.statusCode >= 300) {
      const error = new Error(json?.error || `Escrow service responded with status ${response.statusCode}`);
      error.statusCode = response.statusCode;
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

  async #sendRequest(path, { method = 'GET', headers = {}, body = null } = {}) {
    const resolvedUrl = new URL(this.#url(path));
    const isHttps = resolvedUrl.protocol === 'https:';
    const transport = isHttps ? https : http;
    const requestOptions = {
      method,
      headers,
      hostname: resolvedUrl.hostname,
      port: resolvedUrl.port || (isHttps ? 443 : 80),
      path: `${resolvedUrl.pathname}${resolvedUrl.search}`
    };
    if (isHttps && this.tls) {
      requestOptions.rejectUnauthorized = this.tls.rejectUnauthorized !== false;
      if (this.tls.ca) requestOptions.ca = this.tls.ca;
      if (this.tls.cert) requestOptions.cert = this.tls.cert;
      if (this.tls.key) requestOptions.key = this.tls.key;
    }

    const payloadBuffer = typeof body === 'string' ? Buffer.from(body) : null;

    return await new Promise((resolve, reject) => {
      const req = transport.request(requestOptions, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode || 0,
            body: Buffer.concat(chunks)
          });
        });
      });
      req.on('error', reject);
      if (payloadBuffer) {
        req.write(payloadBuffer);
      }
      req.end();
    });
  }
}

export default AutobaseKeyEscrowClient;
