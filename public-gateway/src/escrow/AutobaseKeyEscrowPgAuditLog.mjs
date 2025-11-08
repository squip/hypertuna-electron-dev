class AutobaseKeyEscrowPgAuditLog {
  constructor({ pool, logger = console }) {
    if (!pool) throw new Error('AutobaseKeyEscrowPgAuditLog requires a pg pool');
    this.pool = pool;
    this.logger = logger;
  }

  async init() {
    // no-op
  }

  async append(event = {}) {
    const payload = {
      event_type: event.type || 'unknown',
      escrow_id: event.escrowId || null,
      lease_id: event.leaseId || null,
      relay_key: event.relayKey || null,
      actor: event.actor || event.requesterId || null,
      metadata: {
        ...event.metadata,
        evidence: event.evidence || undefined,
        reasons: event.reasons || undefined,
        details: event.details || undefined
      }
    };
    await this.pool.query(
      `INSERT INTO escrow_audit_log (
        event_type,
        escrow_id,
        lease_id,
        relay_key,
        actor,
        metadata
      ) VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        payload.event_type,
        payload.escrow_id,
        payload.lease_id,
        payload.relay_key,
        payload.actor,
        payload.metadata
      ]
    );
  }

  async close() {
    // noop
  }
}

export default AutobaseKeyEscrowPgAuditLog;
