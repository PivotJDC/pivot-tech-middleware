/**
 * Billing migration service — routes subscribers between billing providers:
 *   - telgoo5: standalone mobile (default)
 *   - gaiia:   broadband-bundled mobile (Fox / Confluence fiber subscribers)
 *
 * The account's current provider is accounts.external_billing_provider. Every
 * switch is recorded in billing_migrations and only takes effect when the
 * migration is "completed" (at the next billing cycle, or immediately if forced).
 * Routes call into here; this module never touches HTTP.
 */
const db = require('../db');
const { errors } = require('../middleware/errorHandler');
const { logger } = require('../utils/logger');

const DEFAULT_PROVIDER = 'telgoo5';

/**
 * Parse a promo code into its billing routing.
 *   FOX-{id}  -> gaiia / fox / {id}
 *   CONF-{id} -> gaiia / confluence / {id}
 *   else/none -> telgoo5 (standalone)
 * @param {string} [code]
 * @returns {{ provider: string, broadband_provider?: string, broadband_account_id?: string }}
 */
function validatePromoCode(code) {
  if (typeof code === 'string') {
    const m = code.trim().match(/^(FOX|CONF)-(.+)$/i);
    if (m) {
      const broadbandProvider = m[1].toUpperCase() === 'FOX' ? 'fox' : 'confluence';
      return {
        provider: 'gaiia',
        broadband_provider: broadbandProvider,
        broadband_account_id: m[2],
      };
    }
  }
  return { provider: DEFAULT_PROVIDER };
}

/**
 * Resolve a promo code into the fields createAccount persists.
 * @param {string} [promoCode]
 * @returns {{ billingProvider, broadbandProvider, broadbandAccountId }}
 */
function determineBillingProvider(promoCode) {
  const parsed = validatePromoCode(promoCode);
  return {
    billingProvider: parsed.provider,
    broadbandProvider: parsed.broadband_provider || null,
    broadbandAccountId: parsed.broadband_account_id || null,
  };
}

/**
 * Record a pending provider migration. Does NOT switch the account — the switch
 * happens at completeMigration (next billing cycle, or immediately if forced).
 * @param {string} accountId
 * @param {{ toProvider, broadbandProvider?, broadbandAccountId?, promoCode?, reason? }} opts
 * @returns {Promise<object>} the billing_migrations row.
 */
async function initiateMigration(accountId, opts = {}) {
  const {
    toProvider, broadbandProvider, broadbandAccountId, promoCode, reason,
  } = opts;
  if (!toProvider) {
    throw errors.validation('toProvider is required.', 'toProvider');
  }

  const acct = await db.query(
    'SELECT external_billing_provider FROM accounts WHERE id = $1',
    [accountId],
  );
  if (acct.rows.length === 0) {
    throw errors.notFound('Account not found.');
  }
  const fromProvider = acct.rows[0].external_billing_provider || DEFAULT_PROVIDER;

  const { rows } = await db.query(
    `INSERT INTO billing_migrations
       (account_id, from_provider, to_provider, broadband_provider,
        broadband_account_id, promo_code, status, reason)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     RETURNING *`,
    [
      accountId,
      fromProvider,
      toProvider,
      broadbandProvider || null,
      broadbandAccountId || null,
      promoCode || null,
      reason || null,
    ],
  );
  logger.info(
    {
      accountId, migrationId: rows[0].id, fromProvider, toProvider,
    },
    'billing migration initiated',
  );
  return rows[0];
}

/** Load a migration row or throw NOT_FOUND. */
async function getMigration(migrationId) {
  const { rows } = await db.query('SELECT * FROM billing_migrations WHERE id = $1', [migrationId]);
  if (rows.length === 0) {
    throw errors.notFound('Migration not found.');
  }
  return rows[0];
}

/**
 * Apply a migration: switch the account onto the target provider + broadband
 * fields, then mark the migration completed. Transactional.
 * @returns {Promise<object>} the completed migration row.
 */
async function completeMigration(migrationId) {
  const migration = await getMigration(migrationId);

  const completed = await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE accounts
          SET external_billing_provider = $1,
              broadband_provider = $2,
              broadband_account_id = $3,
              billing_migration_at = NOW()
        WHERE id = $4`,
      [
        migration.to_provider,
        migration.broadband_provider,
        migration.broadband_account_id,
        migration.account_id,
      ],
    );
    const { rows } = await client.query(
      `UPDATE billing_migrations
          SET status = 'completed', completed_at = NOW(), updated_at = NOW()
        WHERE id = $1
      RETURNING *`,
      [migrationId],
    );
    return rows[0];
  });

  logger.info(
    {
      accountId: migration.account_id,
      migrationId,
      provider: migration.to_provider,
    },
    'billing migration completed',
  );
  return completed;
}

/**
 * Reverse a migration: switch the account back to its from_provider and clear
 * the broadband linkage (e.g. broadband was cancelled). Transactional.
 * @returns {Promise<object>} the reversed migration row.
 */
async function reverseMigration(migrationId, reason) {
  const migration = await getMigration(migrationId);

  const reversed = await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE accounts
          SET external_billing_provider = $1,
              broadband_provider = NULL,
              broadband_account_id = NULL,
              billing_migration_at = NOW()
        WHERE id = $2`,
      [migration.from_provider, migration.account_id],
    );
    const { rows } = await client.query(
      `UPDATE billing_migrations
          SET status = 'reversed', reversed_at = NOW(), reason = $2, updated_at = NOW()
        WHERE id = $1
      RETURNING *`,
      [migrationId, reason || migration.reason || null],
    );
    return rows[0];
  });

  logger.info(
    {
      accountId: migration.account_id,
      migrationId,
      provider: migration.from_provider,
    },
    'billing migration reversed',
  );
  return reversed;
}

/** All migrations for an account, newest first. */
async function getMigrationHistory(accountId) {
  const { rows } = await db.query(
    'SELECT * FROM billing_migrations WHERE account_id = $1 ORDER BY created_at DESC',
    [accountId],
  );
  return rows;
}

/**
 * Latest migration for a broadband account (any status), used by the partner
 * unlink/status flows. Returns null if none.
 */
async function findMigrationByBroadband(broadbandProvider, broadbandAccountId) {
  if (!broadbandProvider || !broadbandAccountId) return null;
  const { rows } = await db.query(
    `SELECT * FROM billing_migrations
      WHERE broadband_provider = $1 AND broadband_account_id = $2
      ORDER BY created_at DESC
      LIMIT 1`,
    [broadbandProvider, broadbandAccountId],
  );
  return rows[0] || null;
}

module.exports = {
  validatePromoCode,
  determineBillingProvider,
  initiateMigration,
  completeMigration,
  reverseMigration,
  getMigrationHistory,
  findMigrationByBroadband,
};
