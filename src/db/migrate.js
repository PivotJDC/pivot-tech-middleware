#!/usr/bin/env node
/**
 * Minimal forward-only migration runner.
 * Applies every *.sql file in ./migrations in lexical order exactly once,
 * tracking applied files in a schema_migrations table. Idempotent: already
 * applied files are skipped. Each file runs inside its own transaction.
 *
 * Usage: npm run migrate   (reads DATABASE_URL from the environment)
 *
 * This is build/infra tooling, not application service code.
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function run() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    const applied = new Set(
      (await client.query('SELECT filename FROM schema_migrations')).rows.map((r) => r.filename),
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    // Sequential, ordered application is required: each migration may depend on
    // a prior one, so this intentionally awaits inside the loop.
    // eslint-disable-next-line no-restricted-syntax
    for (const filename of files) {
      if (applied.has(filename)) {
        // eslint-disable-next-line no-console
        console.log(`skip  ${filename}`);
      } else {
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
        // eslint-disable-next-line no-await-in-loop
        await client.query('BEGIN');
        try {
          // eslint-disable-next-line no-await-in-loop
          await client.query(sql);
          // eslint-disable-next-line no-await-in-loop
          await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [filename]);
          // eslint-disable-next-line no-await-in-loop
          await client.query('COMMIT');
          // eslint-disable-next-line no-console
          console.log(`apply ${filename}`);
          count += 1;
        } catch (err) {
          // eslint-disable-next-line no-await-in-loop
          await client.query('ROLLBACK');
          throw new Error(`Migration ${filename} failed: ${err.message}`);
        }
      }
    }

    // eslint-disable-next-line no-console
    console.log(`Done. ${count} migration(s) applied, ${files.length - count} already current.`);
  } finally {
    await client.end();
  }
}

// Run as a CLI (`npm run migrate`) but stay importable: when required from
// server.js we want only the exported run(), with no auto-execution and no
// process.exit on failure (the server decides how to handle a failed migration).
if (require.main === module) {
  run().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { run };
