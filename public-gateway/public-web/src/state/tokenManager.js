import { hmacSha256Hex, stableStringify } from '../support/hmac.js';

function now() {
  return Date.now();
}

function toRelayBase(baseUrl = '') {
  const trimmed = (baseUrl || '').replace(/\/+$/, '');
  return trimmed ? `${trimmed}/relay` : '';
}

function toTokenEndpoint(baseUrl = '', action = 'issue') {
  const trimmed = (baseUrl || '').replace(/\/+$/, '');
  return `${trimmed}/api/relay-tokens/${action}`;
}

export class TokenManager {
  constructor({ sharedSecret = '', baseUrl = '', defaultTtlSeconds = 3600 }) {
    this.sharedSecret = sharedSecret || '';
    this.baseUrl = baseUrl || '';
    this.defaultTtlSeconds = Number.isFinite(defaultTtlSeconds) && defaultTtlSeconds > 0
      ? Math.trunc(defaultTtlSeconds)
      : 3600;
    this.tokens = new Map(); // relayKey -> { token, expiresAt, refreshAfter }
    this.refreshTimers = new Map();
    this.lastError = null;
  }

  updateConfig({ sharedSecret, baseUrl, defaultTtlSeconds }) {
    if (sharedSecret !== undefined) this.sharedSecret = sharedSecret || '';
    if (baseUrl !== undefined) this.baseUrl = baseUrl || '';
    if (defaultTtlSeconds !== undefined && Number.isFinite(defaultTtlSeconds) && defaultTtlSeconds > 0) {
      this.defaultTtlSeconds = Math.trunc(defaultTtlSeconds);
    }
  }

  getRelayUrl(relayKey) {
    const base = toRelayBase(this.baseUrl);
    if (!base) return null;
    const tokenState = relayKey ? this.tokens.get(relayKey) : null;
    const token = tokenState?.token;
    if (!token) return base;
    try {
      const url = new URL(base);
      url.searchParams.set('token', token);
      return url.toString();
    } catch (_) {
      const sep = base.includes('?') ? '&' : '?';
      return `${base}${sep}token=${token}`;
    }
  }

  clear() {
    for (const timer of this.refreshTimers.values()) {
      clearTimeout(timer);
    }
    this.refreshTimers.clear();
    this.tokens.clear();
    this.lastError = null;
  }

  async issueToken({ relayKey, relayAuthToken, pubkey = null, scope = 'relay-access', ttlSeconds } = {}) {
    if (!relayKey || !relayAuthToken) {
      throw new Error('relayKey and relayAuthToken are required');
    }
    const payload = {
      relayKey,
      relayAuthToken,
      pubkey,
      scope,
      ttlSeconds: Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.trunc(ttlSeconds) : this.defaultTtlSeconds
    };
    return this.#sendSigned('issue', payload, relayKey);
  }

  async refreshToken(relayKey) {
    if (!relayKey) throw new Error('relayKey required for refresh');
    const state = this.tokens.get(relayKey);
    if (!state?.token) {
      throw new Error('no token to refresh');
    }
    const payload = {
      relayKey,
      token: state.token,
      ttlSeconds: this.defaultTtlSeconds
    };
    return this.#sendSigned('refresh', payload, relayKey);
  }

  async #sendSigned(action, payload, relayKey) {
    if (!this.sharedSecret) {
      throw new Error('Shared secret missing; cannot sign token request');
    }
    const signature = await hmacSha256Hex(stableStringify(payload), this.sharedSecret);
    const endpoint = toTokenEndpoint(this.baseUrl, action);

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ payload, signature })
    });

    if (!resp.ok) {
      const body = await safeJson(resp);
      const error = body?.error || mapHttpError(resp.status) || resp.statusText || 'Token request failed';
      this.lastError = { action, relayKey, error, status: resp.status };
      throw new Error(error);
    }

    const data = await resp.json();
    this.#storeToken(relayKey, data);
    this.lastError = null;
    return data;
  }

  #storeToken(relayKey, data = {}) {
    if (!relayKey || !data) return;
    const token = data.token || null;
    const expiresAt = Number(data.expiresAt) || null;
    const refreshAfter = Number(data.refreshAfter) || (expiresAt ? expiresAt - this.#refreshWindowMs() : null);

    this.tokens.set(relayKey, {
      token,
      expiresAt,
      refreshAfter
    });

    if (this.refreshTimers.has(relayKey)) {
      clearTimeout(this.refreshTimers.get(relayKey));
      this.refreshTimers.delete(relayKey);
    }

    if (token && refreshAfter && refreshAfter > now()) {
      const delay = Math.max(500, refreshAfter - now());
      const timer = setTimeout(() => {
        this.refreshTimers.delete(relayKey);
        this.refreshToken(relayKey).catch((err) => {
          this.lastError = { action: 'refresh', relayKey, error: err?.message || String(err) };
        });
      }, delay);
      this.refreshTimers.set(relayKey, timer);
    }
  }

  #refreshWindowMs() {
    // 80% of TTL by default
    const ttlMs = this.defaultTtlSeconds * 1000;
    return Math.round(ttlMs * 0.2);
  }
}

async function safeJson(resp) {
  try {
    return await resp.json();
  } catch (_) {
    return null;
  }
}

function mapHttpError(status) {
  if (status === 0) return 'gateway unreachable';
  if (status >= 500) return 'gateway unavailable';
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'endpoint not found';
  if (status === 429) return 'rate limited';
  return null;
}
