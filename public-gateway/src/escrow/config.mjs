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
    policy: mergedPolicy
  };

  if (!config.keyPath) {
    config.keyPath = `${config.storageDir}/keypair.json`;
  }
  if (!config.auditDir) {
    config.auditDir = `${config.storageDir}/audit`;
  }

  return config;
}

export {
  DEFAULT_ESCROW_CONFIG,
  loadEscrowConfig
};
