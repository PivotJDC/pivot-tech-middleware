/**
 * PostgreSQL connection pool singleton.
 *
 * One pg.Pool is shared process-wide. Import { query } for one-off statements,
 * or getPool()/withTransaction() when you need a dedicated client (transactions,
 * multi-statement units of work). The migration runner (src/db/migrate.js) uses
 * its own short-lived Client and intentionally does NOT go through this pool.
 */
const { Pool } = require('pg');
const config = require('../config');

let pool;

function createPool() {
  const instance = new Pool({
    connectionString: config.database.url,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    // RDS requires TLS in production; locally (docker-compose) it does not.
    ssl: config.isProduction ? { rejectUnauthorized: false } : false,
  });

  // A pool-level error is an idle client dropping its connection. Surface it;
  // pg will evict the bad client and hand out a fresh one on the next query.
  instance.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('Unexpected idle pg client error:', err.message);
  });

  return instance;
}

/** Return the shared pool, lazily creating it on first use. */
function getPool() {
  if (!pool) {
    pool = createPool();
  }
  return pool;
}

/**
 * Run a single parameterized query against the pool.
 * @param {string} text - SQL with $1, $2, ... placeholders.
 * @param {Array} [params] - Bound parameter values.
 * @returns {Promise<import('pg').QueryResult>}
 */
function query(text, params) {
  return getPool().query(text, params);
}

/**
 * Run a function inside a single transaction. The callback receives a dedicated
 * client; the transaction commits if it resolves and rolls back if it throws.
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Lightweight liveness probe for the health endpoint. */
async function healthCheck() {
  const result = await query('SELECT 1 AS ok');
  return result.rows[0].ok === 1;
}

/** Close the pool. Call during graceful shutdown; tests also use this. */
async function close() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = {
  getPool,
  query,
  withTransaction,
  healthCheck,
  close,
};
