import { readFile } from 'node:fs/promises';

const DEFAULT_ESCROW_CONFIG = Object.freeze({
  host: process.env.AUTOBASING_ESCROW_HOST || process.env.ESCROW_HOST || '0.0.0.0',
  port: Number(process.env.AUTOBASING_ESCROW_PORT || process.env.ESCROW_PORT) || 4795,
  basePath: process.env.AUTOBASING_ESCROW_BASE_PATH || process.env.ESCROW_BASE_PATH || '/api/escrow',
  storageDir: process.env.AUTOBASING_ESCROW_STORAGE || process.env.ESCROW_STORAGE_DIR || 'escrow-data',
  keyPath: process.env.AUTOBASING_ESCROW_KEY_PATH || process.env.ESCROW_KEY_PATH || null,
  auditDir: process.env.AUTOBASING_ESCROW_AUDIT_DIR || process.env.ESCROW_AUDIT_DIR || null,
  sharedSecret: process.env.AUTOBASING_ESCROW_SHARED_SECRET
    || process.env.ESCROW_SHARED_SECRET
    || process.env.GATEWAY_REGISTRATION_SECRET
    || null,
  tls: {
    enabled: process.env.AUTOBASING_ESCROW_TLS_ENABLED === 'true' || process.env.ESCROW_TLS_ENABLED === 'true',
    keyPath: process.env.AUTOBASING_ESCROW_TLS_KEY_PATH || process.env.ESCROW_TLS_SERVER_KEY || null,
    certPath: process.env.AUTOBASING_ESCROW_TLS_CERT_PATH || process.env.ESCROW_TLS_SERVER_CERT || null,
    caPath: process.env.AUTOBASING_ESCROW_TLS_CA_PATH || process.env.ESCROW_TLS_CA || null,
    requestClientCert: process.env.AUTOBASING_ESCROW_TLS_REQUEST_CLIENT_CERT === 'false' ? false : true,
    rejectUnauthorized: process.env.AUTOBASING_ESCROW_TLS_REJECT_UNAUTHORIZED === 'false' ? false : true
  },
  db: {
    enabled: process.env.ESCROW_DB_ENABLED !== 'false',
    connectionString: process.env.ESCROW_DATABASE_URL || '',
    poolSize: Number(process.env.ESCROW_DB_POOL_SIZE) || 5,
    idleTimeoutMs: Number(process.env.ESCROW_DB_IDLE_TIMEOUT_MS) || 10000
  },
  metrics: {
    enabled: process.env.ESCROW_METRICS_DISABLED === 'true' ? false : true,
    path: process.env.ESCROW_METRICS_PATH || '/metrics'
  },
  policy: {
    version: process.env.AUTOBASING_ESCROW_POLICY_VERSION
      || process.env.ESCROW_POLICY_VERSION
      || '2024-09-autobase-escrow-v1',
    leaseTtlMs: Number(process.env.AUTOBASING_ESCROW_LEASE_TTL_MS || process.env.ESCROW_LEASE_TTL_MS) || (10 * 60 * 1000),
    maxDepositTtlMs: Number(process.env.AUTOBASING_ESCROW_DEPOSIT_TTL || process.env.ESCROW_DEPOSIT_TTL_MS) || (24 * 60 * 60 * 1000),
    peerLivenessTimeoutMs: Number(process.env.AUTOBASING_ESCROW_PEER_TIMEOUT || process.env.ESCROW_PEER_LIVENESS_TIMEOUT_MS) || 45_000,
    mirrorFreshnessMaxLagMs: Number(process.env.AUTOBASING_ESCROW_MIRROR_LAG_MS || process.env.ESCROW_MIRROR_MAX_LAG_MS) || 15_000,
    mirrorFreshnessWindowMs: Number(process.env.AUTOBASING_ESCROW_MIRROR_WINDOW_MS || process.env.ESCROW_MIRROR_WINDOW_MS) || 60_000,
    requireRegistrationFlag: (() => {
      if (process.env.AUTOBASING_ESCROW_REQUIRE_FLAG === 'true') return true;
      if (process.env.AUTOBASING_ESCROW_REQUIRE_FLAG === 'false') return false;
      if (process.env.ESCROW_REQUIRE_FLAG === 'true') return true;
      if (process.env.ESCROW_REQUIRE_FLAG === 'false') return false;
      return true;
    })(),
    maxUnlocksPerLease: Number(process.env.AUTOBASING_ESCROW_MAX_UNLOCKS || process.env.ESCROW_MAX_UNLOCKS_PER_LEASE) || 1
  }
});

function loadEscrowConfig(overrides = {}) {
  const mergedPolicy = {
    ...DEFAULT_ESCROW_CONFIG.policy,
    ...(overrides.policy || {})
  };

  const toPositiveInt = (value, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) && num > 0 ? Math.trunc(num) : fallback;
  };

  mergedPolicy.leaseTtlMs = toPositiveInt(mergedPolicy.leaseTtlMs, DEFAULT_ESCROW_CONFIG.policy.leaseTtlMs);
  mergedPolicy.maxDepositTtlMs = toPositiveInt(mergedPolicy.maxDepositTtlMs, DEFAULT_ESCROW_CONFIG.policy.maxDepositTtlMs);
  mergedPolicy.peerLivenessTimeoutMs = toPositiveInt(mergedPolicy.peerLivenessTimeoutMs, DEFAULT_ESCROW_CONFIG.policy.peerLivenessTimeoutMs);
  mergedPolicy.mirrorFreshnessMaxLagMs = toPositiveInt(mergedPolicy.mirrorFreshnessMaxLagMs, DEFAULT_ESCROW_CONFIG.policy.mirrorFreshnessMaxLagMs);
  mergedPolicy.mirrorFreshnessWindowMs = toPositiveInt(mergedPolicy.mirrorFreshnessWindowMs, DEFAULT_ESCROW_CONFIG.policy.mirrorFreshnessWindowMs);
  mergedPolicy.maxUnlocksPerLease = toPositiveInt(mergedPolicy.maxUnlocksPerLease, DEFAULT_ESCROW_CONFIG.policy.maxUnlocksPerLease);
  mergedPolicy.requireRegistrationFlag = overrides?.policy?.requireRegistrationFlag
    ?? DEFAULT_ESCROW_CONFIG.policy.requireRegistrationFlag;

  const config = {
    ...DEFAULT_ESCROW_CONFIG,
    ...overrides,
    policy: mergedPolicy,
    tls: {
      ...DEFAULT_ESCROW_CONFIG.tls,
      ...(overrides.tls || {})
    },
    db: {
      ...DEFAULT_ESCROW_CONFIG.db,
      ...(overrides.db || {})
    },
    metrics: {
      ...DEFAULT_ESCROW_CONFIG.metrics,
      ...(overrides.metrics || {})
    }
  };

  config.db.enabled = Boolean(
    config.db.enabled
    && (config.db.connectionString || process.env.ESCROW_DATABASE_URL)
  );
  if (!config.db.connectionString) {
    config.db.connectionString = process.env.ESCROW_DATABASE_URL || '';
  }

  if (!config.keyPath) {
    config.keyPath = `${config.storageDir}/keypair.json`;
  }
  if (!config.auditDir) {
    config.auditDir = `${config.storageDir}/audit`;
  }

  return config;
}

async function loadEscrowTlsOptions(tlsConfig = {}) {
  if (!tlsConfig.enabled) return null;
  if (!tlsConfig.keyPath || !tlsConfig.certPath) {
    throw new Error('Escrow TLS requires both keyPath and certPath when enabled');
  }
  const [key, cert, ca] = await Promise.all([
    readFile(tlsConfig.keyPath),
    readFile(tlsConfig.certPath),
    tlsConfig.caPath ? readFile(tlsConfig.caPath) : Promise.resolve(null)
  ]);
  return {
    httpsOptions: {
      key,
      cert,
      ca: ca ? [ca] : undefined,
      requestCert: tlsConfig.requestClientCert !== false,
      rejectUnauthorized: tlsConfig.rejectUnauthorized !== false
    },
    watchFiles: [tlsConfig.keyPath, tlsConfig.certPath, tlsConfig.caPath].filter(Boolean)
  };
}

export {
  DEFAULT_ESCROW_CONFIG,
  loadEscrowConfig,
  loadEscrowTlsOptions
};
