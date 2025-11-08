import { Pool } from 'pg';

async function createEscrowDbPool(config = {}, logger = console) {
  if (!config?.enabled) return null;
  const connectionString = config.connectionString || process.env.ESCROW_DATABASE_URL || '';
  if (!connectionString) {
    logger?.warn?.('[EscrowDB] Connection string missing; falling back to file store');
    return null;
  }
  const pool = new Pool({
    connectionString,
    max: Math.max(1, Number(config.poolSize) || 5),
    idleTimeoutMillis: Number(config.idleTimeoutMs) || 10_000
  });
  pool.on('error', (error) => {
    logger?.error?.({ err: error }, '[EscrowDB] Unexpected pool error');
  });
  await pool.query('SELECT 1');
  logger?.info?.('[EscrowDB] Connected to Postgres', { connectionString: redactedUrl(connectionString) });
  return pool;
}

function redactedUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = '****';
    }
    return parsed.toString();
  } catch {
    return 'redacted';
  }
}

export {
  createEscrowDbPool
};
