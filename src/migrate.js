import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createPool } from './db.js';

const migrationsDirectory = fileURLToPath(new URL('../db/migrations/', import.meta.url));

export async function runMigrations(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort();
  for (const filename of files) {
    const alreadyApplied = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [filename]);
    if (alreadyApplied.rowCount) continue;

    const sql = await readFile(path.join(migrationsDirectory, filename), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1)', [filename]);
      await client.query('COMMIT');
      console.log(`migration applied: ${filename}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${filename} failed: ${error.message}`, { cause: error });
    } finally {
      client.release();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const pool = createPool();
  try {
    await runMigrations(pool);
    console.log('migrations up to date');
  } finally {
    await pool.end();
  }
}
