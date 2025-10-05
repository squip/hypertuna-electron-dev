import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_CONFIG = {
  host: '0.0.0.0',
  port: Number(process.env.PORT) || 4430,
  tls: {
    enabled: process.env.GATEWAY_TLS_ENABLED === 'true',
    keyPath: process.env.GATEWAY_TLS_KEY || null,
    certPath: process.env.GATEWAY_TLS_CERT || null
  },
  publicBaseUrl: process.env.GATEWAY_PUBLIC_URL || 'https://hypertuna.com',
  metrics: {
    enabled: process.env.GATEWAY_METRICS_ENABLED !== 'false',
    path: process.env.GATEWAY_METRICS_PATH || '/metrics'
  },
  registration: {
    sharedSecret: process.env.GATEWAY_REGISTRATION_SECRET || null,
    redisUrl: process.env.GATEWAY_REGISTRATION_REDIS || null,
    redisPrefix: process.env.GATEWAY_REGISTRATION_REDIS_PREFIX || 'gateway:registrations:',
    cacheTtlSeconds: Number(process.env.GATEWAY_REGISTRATION_TTL || 300),
    defaultTokenTtl: Number(process.env.GATEWAY_DEFAULT_TOKEN_TTL || 3600)
  },
  rateLimit: {
    enabled: process.env.GATEWAY_RATELIMIT_ENABLED === 'true',
    windowSeconds: Number(process.env.GATEWAY_RATELIMIT_WINDOW || 60),
    maxRequests: Number(process.env.GATEWAY_RATELIMIT_MAX || 120)
  },
  discovery: {
    enabled: process.env.GATEWAY_DISCOVERY_ENABLED === 'true',
    openAccess: process.env.GATEWAY_DISCOVERY_OPEN_ACCESS !== 'false',
    displayName: process.env.GATEWAY_DISCOVERY_DISPLAY_NAME || '',
    region: process.env.GATEWAY_DISCOVERY_REGION || '',
    keySeed: process.env.GATEWAY_DISCOVERY_KEY_SEED || null,
    ttlSeconds: Number(process.env.GATEWAY_DISCOVERY_TTL || 60),
    refreshIntervalMs: Number(process.env.GATEWAY_DISCOVERY_REFRESH_MS || 30000),
    secretPath: process.env.GATEWAY_DISCOVERY_SECRET_PATH || '/.well-known/hypertuna-gateway-secret',
    sharedSecretVersion: process.env.GATEWAY_DISCOVERY_SECRET_VERSION || '',
    protocolVersion: Number(process.env.GATEWAY_DISCOVERY_PROTOCOL_VERSION || 1)
  }
};

async function loadTlsOptions(tlsConfig) {
  if (!tlsConfig.enabled) return null;
  if (!tlsConfig.keyPath || !tlsConfig.certPath) {
    throw new Error('TLS enabled but key/cert paths not provided');
  }

  const [key, cert] = await Promise.all([
    readFile(resolve(tlsConfig.keyPath)),
    readFile(resolve(tlsConfig.certPath))
  ]);

  return { key, cert };
}

function loadConfig(overrides = {}) {
  const merged = {
    ...DEFAULT_CONFIG,
    ...overrides,
    tls: {
      ...DEFAULT_CONFIG.tls,
      ...(overrides.tls || {})
    },
    metrics: {
      ...DEFAULT_CONFIG.metrics,
      ...(overrides.metrics || {})
    },
    registration: {
      ...DEFAULT_CONFIG.registration,
      ...(overrides.registration || {})
    },
    rateLimit: {
      ...DEFAULT_CONFIG.rateLimit,
      ...(overrides.rateLimit || {})
    },
    discovery: {
      ...DEFAULT_CONFIG.discovery,
      ...(overrides.discovery || {})
    }
  };

  if (!merged.publicBaseUrl) {
    throw new Error('Gateway requires a publicBaseUrl configuration value');
  }

  if (!merged.registration?.sharedSecret) {
    merged.discovery.openAccess = false;
  }

  return merged;
}

export {
  loadConfig,
  loadTlsOptions
};
