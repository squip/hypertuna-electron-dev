import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const LEGACY_PUBLIC_GATEWAY_PATH = 'public-gateway/hyperbee';

const DEFAULT_BLIND_PEER_MAX_BYTES = 25 * 1024 ** 3;

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
    defaultTokenTtl: Number(process.env.GATEWAY_DEFAULT_TOKEN_TTL || 3600),
    tokenRefreshWindowSeconds: Number(process.env.GATEWAY_TOKEN_REFRESH_WINDOW || 300)
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
  },
  relay: {
    storageDir: process.env.GATEWAY_RELAY_STORAGE || null,
    datasetNamespace: process.env.GATEWAY_RELAY_NAMESPACE || 'public-gateway-relay',
    adminPublicKey: process.env.GATEWAY_RELAY_ADMIN_PUBLIC_KEY || null,
    adminSecretKey: process.env.GATEWAY_RELAY_ADMIN_SECRET_KEY || null,
    statsIntervalMs: Number(process.env.GATEWAY_RELAY_STATS_INTERVAL_MS || 15000),
    replicationTopic: process.env.GATEWAY_RELAY_REPLICATION_TOPIC || null,
    canonicalPath: process.env.GATEWAY_RELAY_CANONICAL_PATH || 'relay',
    aliasPaths: parseRelayAliasPaths(process.env.GATEWAY_RELAY_ALIAS_PATHS)
  },
  features: {
    hyperbeeRelayEnabled: process.env.GATEWAY_FEATURE_HYPERBEE_RELAY === 'true',
    dispatcherEnabled: process.env.GATEWAY_FEATURE_RELAY_DISPATCHER === 'true',
    tokenEnforcementEnabled: process.env.GATEWAY_FEATURE_RELAY_TOKEN_ENFORCEMENT === 'true'
  },
  dispatcher: {
    maxConcurrentJobsPerPeer: Number(process.env.GATEWAY_DISPATCHER_MAX_CONCURRENT || 3),
    inFlightWeight: Number(process.env.GATEWAY_DISPATCHER_INFLIGHT_WEIGHT || 25),
    latencyWeight: Number(process.env.GATEWAY_DISPATCHER_LATENCY_WEIGHT || 1),
    failureWeight: Number(process.env.GATEWAY_DISPATCHER_FAILURE_WEIGHT || 500),
    reassignOnLagBlocks: Number(process.env.GATEWAY_DISPATCHER_REASSIGN_LAG || 500),
    circuitBreakerThreshold: Number(process.env.GATEWAY_DISPATCHER_CB_THRESHOLD || 5),
    circuitBreakerDurationMs: Number(process.env.GATEWAY_DISPATCHER_CB_TIMEOUT_MS || 60000)
  },
  blindPeer: {
    enabled: process.env.GATEWAY_BLINDPEER_ENABLED === 'true',
    storageDir: process.env.GATEWAY_BLINDPEER_STORAGE || null,
    maxBytes: Number(process.env.GATEWAY_BLINDPEER_MAX_BYTES) || DEFAULT_BLIND_PEER_MAX_BYTES,
    gcIntervalMs: Number(process.env.GATEWAY_BLINDPEER_GC_INTERVAL_MS) || 300000,
    dedupeBatchSize: Number(process.env.GATEWAY_BLINDPEER_DEDUPE_BATCH) || 100,
    staleCoreTtlMs: Number(process.env.GATEWAY_BLINDPEER_STALE_TTL_MS) || (7 * 24 * 60 * 60 * 1000),
    trustedPeersPersistPath: process.env.GATEWAY_BLINDPEER_TRUSTED_PATH || null
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
    },
    relay: {
      ...DEFAULT_CONFIG.relay,
      ...(overrides.relay || {})
    },
    features: {
      ...DEFAULT_CONFIG.features,
      ...(overrides.features || {})
    },
    dispatcher: {
      ...DEFAULT_CONFIG.dispatcher,
      ...(overrides.dispatcher || {})
    },
    blindPeer: {
      ...DEFAULT_CONFIG.blindPeer,
      ...(overrides.blindPeer || {})
    }
  };

  if (!merged.publicBaseUrl) {
    throw new Error('Gateway requires a publicBaseUrl configuration value');
  }

  if (!merged.registration?.sharedSecret) {
    merged.discovery.openAccess = false;
  }

  merged.relay = normalizeRelaySettings(merged.relay);
  merged.blindPeer = normalizeBlindPeerSettings(merged.blindPeer);

  return merged;
}

function parseRelayAliasPaths(input) {
  if (!input) return null;
  if (Array.isArray(input)) return input.map((value) => (typeof value === 'string' ? value.trim() : value)).filter((value) => typeof value === 'string' && value.length);
  return String(input)
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length);
}

function normalizeGatewayPathValue(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeRelaySettings(relayConfig = {}) {
  const result = { ...relayConfig };
  const canonicalPath = normalizeGatewayPathValue(result.canonicalPath) || 'relay';
  const aliasInput = Array.isArray(result.aliasPaths) ? result.aliasPaths : parseRelayAliasPaths(result.aliasPaths);
  const aliasSet = new Set();
  const addAlias = (value) => {
    const normalized = normalizeGatewayPathValue(value);
    if (normalized) {
      aliasSet.add(normalized);
    }
  };

  addAlias(canonicalPath);
  (aliasInput || []).forEach(addAlias);
  addAlias(LEGACY_PUBLIC_GATEWAY_PATH);
  addAlias('relay');

  result.canonicalPath = canonicalPath;
  result.aliasPaths = Array.from(aliasSet);
  return result;
}

function normalizeBlindPeerSettings(settings = {}) {
  const sanitizePath = (value) => {
    if (!value || typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  };

  const toPositiveInt = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
  };

  return {
    enabled: !!settings.enabled,
    storageDir: sanitizePath(settings.storageDir),
    maxBytes: toPositiveInt(settings.maxBytes, DEFAULT_BLIND_PEER_MAX_BYTES),
    gcIntervalMs: toPositiveInt(settings.gcIntervalMs, 300000),
    dedupeBatchSize: toPositiveInt(settings.dedupeBatchSize, 100),
    staleCoreTtlMs: toPositiveInt(settings.staleCoreTtlMs, 7 * 24 * 60 * 60 * 1000),
    trustedPeersPersistPath: sanitizePath(settings.trustedPeersPersistPath)
  };
}

export {
  loadConfig,
  loadTlsOptions
};
