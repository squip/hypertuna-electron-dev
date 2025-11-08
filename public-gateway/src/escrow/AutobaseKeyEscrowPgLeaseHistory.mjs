class AutobaseKeyEscrowPgLeaseHistory {
  constructor({ pool, logger = console }) {
    if (!pool) throw new Error('AutobaseKeyEscrowPgLeaseHistory requires a pg pool');
    this.pool = pool;
    this.logger = logger;
  }

  async init() {}

  async recordIssued({
    leaseId,
    escrowId,
    relayKey,
    requesterId,
    issuedAt,
    expiresAt,
    evidence,
    reasons,
    payloadDigest
  } = {}) {
    try {
      await this.pool.query(
        `INSERT INTO escrow_lease_history (
          lease_id,
          escrow_id,
          relay_key,
          requester_id,
          issued_at,
          expires_at,
          evidence,
          reasons,
          payload_digest
        ) VALUES ($1,$2,$3,$4,TO_TIMESTAMP($5 / 1000.0),TO_TIMESTAMP($6 / 1000.0),$7,$8,$9)
        ON CONFLICT (lease_id) DO NOTHING`,
        [
          leaseId,
          escrowId,
          relayKey,
          requesterId,
          issuedAt || Date.now(),
          expiresAt || null,
          evidence || null,
          reasons || null,
          payloadDigest || null
        ]
      );
    } catch (error) {
      this.logger?.warn?.('[EscrowLeaseHistory] Failed to record lease issuance', {
        leaseId,
        error: error?.message || error
      });
    }
  }

  async recordReleased(leaseId, { releasedAt = Date.now(), reason = null } = {}) {
    if (!leaseId) return;
    try {
      await this.pool.query(
        `UPDATE escrow_lease_history
         SET released_at = TO_TIMESTAMP($2 / 1000.0),
             release_reason = $3
         WHERE lease_id = $1`,
        [leaseId, releasedAt, reason]
      );
    } catch (error) {
      this.logger?.warn?.('[EscrowLeaseHistory] Failed to record lease release', {
        leaseId,
        error: error?.message || error
      });
    }
  }
}

export default AutobaseKeyEscrowPgLeaseHistory;
