import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { config as loadEnv } from 'dotenv';
import { Client } from 'pg';

loadEnv();

const DEFAULT_DATABASE_URL = 'postgres://gateway:gateway@127.0.0.1:5432/gateway_escrow';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MIGRATIONS_DIR = join(__dirname, 'migrations');

async function main() {
  const databaseUrl = process.env.ESCROW_DATABASE_URL || DEFAULT_DATABASE_URL;
  const client = new Client({
    connectionString: databaseUrl
  });
  await client.connect();
  try {
    await ensureMigrationTable(client);
    const files = await getMigrationFiles();
    const applied = await listAppliedMigrations(client);
    for (const file of files) {
      if (applied.has(file)) continue;
      await applyMigration(client, file);
    }
  } finally {
    await client.end();
  }
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS escrow_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getMigrationFiles() {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries
    .filter((file) => file.endsWith('.sql'))
    .sort();
}

async function listAppliedMigrations(client) {
  const result = await client.query('SELECT name FROM escrow_migrations');
  return new Set(result.rows.map((row) => row.name));
}

async function applyMigration(client, file) {
  const fullPath = join(MIGRATIONS_DIR, file);
  const sql = await readFile(fullPath, 'utf8');
  process.stdout.write(`[EscrowMigrations] Applying ${file}\n`);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO escrow_migrations(name, applied_at) VALUES($1, NOW())',
      [file]
    );
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    error.message = `[EscrowMigrations] Failed to apply ${file}: ${error.message}`;
    throw error;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
