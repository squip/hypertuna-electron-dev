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
    }
  };

  if (!merged.publicBaseUrl) {
    throw new Error('Gateway requires a publicBaseUrl configuration value');
  }

  return merged;
}

export {
  loadConfig,
  loadTlsOptions
};
