class AutobaseKeyEscrowPgStore {
  constructor({ pool, logger = console }) {
    if (!pool) throw new Error('AutobaseKeyEscrowPgStore requires a pg pool');
    this.pool = pool;
    this.logger = logger;
  }

  async init() {
    // noop – migrations handle schema.
  }

  async put(record) {
    const query = `
      INSERT INTO escrow_deposits (
        id,
        relay_key,
        owner_peer_key,
        metadata,
        encrypted_package,
        policy_version,
        created_at,
        expires_at,
        updated_at,
        revoked_at
      ) VALUES ($1,$2,$3,$4,$5,$6,TO_TIMESTAMP($7 / 1000.0),TO_TIMESTAMP($8 / 1000.0),TO_TIMESTAMP($9 / 1000.0),$10)
      RETURNING *
    `;
    const nowMs = Number(record.createdAt) || Date.now();
    const updatedAt = Number(record.updatedAt) || nowMs;
    const expiresAt = Number(record.expiresAt);
    const values = [
      record.id,
      record.relayKey,
      record.ownerPeerKey,
      record.metadata || {},
      record.encryptedPackage || {},
      record.policyVersion,
      nowMs,
      expiresAt,
      updatedAt,
      record.revokedAt ? new Date(record.revokedAt) : null
    ];
    const res = await this.pool.query(query, values);
    return this.#mapRow(res.rows[0]);
  }

  async update(recordId, patch = {}) {
    const existing = await this.getById(recordId);
    if (!existing) return null;
    const columns = [];
    const values = [];
    let idx = 1;
    const apply = (col, val) => {
      columns.push(`${col} = $${idx++}`);
      values.push(val);
    };
    if ('ownerPeerKey' in patch) apply('owner_peer_key', patch.ownerPeerKey);
    if ('metadata' in patch) apply('metadata', patch.metadata);
    if ('encryptedPackage' in patch) apply('encrypted_package', patch.encryptedPackage);
    if ('policyVersion' in patch) apply('policy_version', patch.policyVersion);
    if ('expiresAt' in patch) apply('expires_at', patch.expiresAt ? new Date(patch.expiresAt) : null);
    if ('revokedAt' in patch) apply('revoked_at', patch.revokedAt ? new Date(patch.revokedAt) : null);
    apply('updated_at', new Date());
    if (!columns.length) return existing;
    values.push(recordId);
    await this.pool.query(
      `UPDATE escrow_deposits SET ${columns.join(', ')} WHERE id = $${idx}`,
      values
    );
    return await this.getById(recordId);
  }

  async remove(recordId) {
    const res = await this.pool.query('DELETE FROM escrow_deposits WHERE id = $1', [recordId]);
    return res.rowCount > 0;
  }

  async getByRelayKey(relayKey) {
    if (!relayKey) return null;
    const res = await this.pool.query('SELECT * FROM escrow_deposits WHERE relay_key = $1 LIMIT 1', [relayKey]);
    return res.rows[0] ? this.#mapRow(res.rows[0]) : null;
  }

  async getById(recordId) {
    if (!recordId) return null;
    const res = await this.pool.query('SELECT * FROM escrow_deposits WHERE id = $1 LIMIT 1', [recordId]);
    return res.rows[0] ? this.#mapRow(res.rows[0]) : null;
  }

  async list() {
    const res = await this.pool.query('SELECT * FROM escrow_deposits ORDER BY created_at DESC');
    return res.rows.map((row) => this.#mapRow(row));
  }

  #mapRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      relayKey: row.relay_key,
      ownerPeerKey: row.owner_peer_key,
      metadata: row.metadata || {},
      encryptedPackage: row.encrypted_package || {},
      policyVersion: row.policy_version,
      createdAt: row.created_at ? Number(new Date(row.created_at)) : null,
      expiresAt: row.expires_at ? Number(new Date(row.expires_at)) : null,
      updatedAt: row.updated_at ? Number(new Date(row.updated_at)) : null,
      revokedAt: row.revoked_at ? Number(new Date(row.revoked_at)) : null
    };
  }
}

export default AutobaseKeyEscrowPgStore;
