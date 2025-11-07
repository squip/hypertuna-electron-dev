class AutobaseKeyEscrowPolicyEngine {
  constructor(policy = {}, { logger = console } = {}) {
    this.policy = {
      version: policy.version || 'unknown',
      leaseTtlMs: Number(policy.leaseTtlMs) || 10 * 60 * 1000,
      maxDepositTtlMs: Number(policy.maxDepositTtlMs) || 24 * 60 * 60 * 1000,
      peerLivenessTimeoutMs: Number(policy.peerLivenessTimeoutMs) || 45_000,
      mirrorFreshnessMaxLagMs: Number(policy.mirrorFreshnessMaxLagMs) || 15_000,
      mirrorFreshnessWindowMs: Number(policy.mirrorFreshnessWindowMs) || 60_000,
      requireRegistrationFlag: policy.requireRegistrationFlag !== false,
      maxUnlocksPerLease: Number(policy.maxUnlocksPerLease) || 1
    };
    this.logger = logger;
  }

  getPolicyMetadata() {
    return { ...this.policy };
  }

  evaluateUnlock(record, evidence = {}) {
    const reasons = [];
    const now = Date.now();

    if (!record) {
      reasons.push('record-not-found');
    } else {
      if (record.revokedAt) reasons.push('record-revoked');
      if (record.expiresAt && record.expiresAt < now) reasons.push('record-expired');
    }

    const registrationEscrowEnabled = evidence?.registration?.escrowEnabled ?? false;
    if (this.policy.requireRegistrationFlag && !registrationEscrowEnabled) {
      reasons.push('registration-flag-missing');
    }

    const healthyCount = Number(evidence?.peerHealth?.healthyCount) || 0;
    if (healthyCount > 0) {
      reasons.push('peers-still-healthy');
    }

    const lastHealthyAt = Number(evidence?.peerHealth?.lastHealthyAt);
    if (Number.isFinite(lastHealthyAt) && (now - lastHealthyAt) < this.policy.peerLivenessTimeoutMs) {
      reasons.push('peer-timeout-not-reached');
    }

    const mirrorLag = Number(evidence?.mirror?.lagMs);
    if (Number.isFinite(mirrorLag) && mirrorLag > this.policy.mirrorFreshnessMaxLagMs) {
      reasons.push('mirror-too-stale');
    }

    const mirrorLastSyncedAt = Number(evidence?.mirror?.lastSyncedAt);
    if (
      Number.isFinite(mirrorLastSyncedAt)
      && (now - mirrorLastSyncedAt) > this.policy.mirrorFreshnessWindowMs
    ) {
      reasons.push('mirror-window-expired');
    }

    return {
      allow: reasons.length === 0,
      reasons
    };
  }
}

export default AutobaseKeyEscrowPolicyEngine;
