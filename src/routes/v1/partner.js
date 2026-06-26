/**
 * Broadband partner API (mounted at /v1/partner).
 *
 * Fox / Confluence call these to bundle (link) or unbundle (unlink) a broadband
 * subscriber's MobilityNet line, switching their billing between telgoo5
 * (standalone) and gaiia (broadband-bundled). Authenticated by a per-partner
 * `partner_key` validated against config (FOX_PARTNER_KEY / CONFLUENCE_PARTNER_KEY).
 *
 *   POST /v1/partner/link     bundle a line  (telgoo5 -> gaiia)
 *   POST /v1/partner/unlink   unbundle       (gaiia -> telgoo5, reverse)
 *   GET  /v1/partner/status   linked account status + migration history
 */
const express = require('express');
const config = require('../../config');
const accountService = require('../../services/accountService');
const billingMigration = require('../../services/billingMigrationService');
const { asyncHandler, errors } = require('../../middleware/errorHandler');
const { logger } = require('../../utils/logger');

const router = express.Router();

/**
 * Validate a partner_key for a broadband provider against config. Constant-ish:
 * a missing/empty configured key never authorizes. Throws UNAUTHORIZED on fail.
 */
function requirePartnerKey(provider, key) {
  const expected = config.partner.keys[provider];
  if (!expected || !key || key !== expected) {
    throw errors.unauthorized('Invalid partner key.');
  }
}

// Link: a broadband subscriber bundles their MobilityNet line.
router.post(
  '/link',
  asyncHandler(async (req, res) => {
    const {
      partner_key: partnerKey,
      broadband_provider: broadbandProvider,
      broadband_account_id: broadbandAccountId,
      mobilitynet_email_or_phone: lookup,
      effective_immediately: effectiveImmediately = false,
    } = req.body || {};

    requirePartnerKey(broadbandProvider, partnerKey);
    if (!broadbandAccountId) {
      throw errors.validation('broadband_account_id is required.', 'broadband_account_id');
    }

    const account = await accountService.findByEmailOrPhone(lookup);
    if (!account) {
      throw errors.notFound('No MobilityNet account found for that email or phone.');
    }

    let migration = await billingMigration.initiateMigration(account.id, {
      toProvider: 'gaiia',
      broadbandProvider,
      broadbandAccountId,
      reason: `Broadband bundle linked by ${broadbandProvider}`,
    });

    if (effectiveImmediately) {
      migration = await billingMigration.completeMigration(migration.id);
    }

    logger.info(
      {
        broadbandProvider, broadbandAccountId, accountId: account.id, migrationId: migration.id,
      },
      'partner link',
    );
    res.status(201).json({
      migration_id: migration.id,
      status: migration.status,
      account_id: account.id,
    });
  }),
);

// Unlink: broadband cancelled — reverse the line back to standalone billing.
router.post(
  '/unlink',
  asyncHandler(async (req, res) => {
    const {
      partner_key: partnerKey,
      broadband_provider: broadbandProvider,
      broadband_account_id: broadbandAccountId,
      reason,
    } = req.body || {};

    requirePartnerKey(broadbandProvider, partnerKey);

    const migration = await billingMigration.findMigrationByBroadband(
      broadbandProvider,
      broadbandAccountId,
    );
    if (!migration) {
      throw errors.notFound('No migration found for that broadband account.');
    }

    const reversed = await billingMigration.reverseMigration(
      migration.id,
      reason || `Broadband cancelled by ${broadbandProvider}`,
    );
    logger.info(
      { broadbandProvider, broadbandAccountId, migrationId: reversed.id },
      'partner unlink',
    );
    res.json({ migration_id: reversed.id, status: reversed.status });
  }),
);

// Status: the linked MobilityNet account + its migration history.
router.get(
  '/status',
  asyncHandler(async (req, res) => {
    const {
      partner_key: partnerKey,
      broadband_provider: broadbandProvider,
      broadband_account_id: broadbandAccountId,
    } = req.query;

    requirePartnerKey(broadbandProvider, partnerKey);

    const migration = await billingMigration.findMigrationByBroadband(
      broadbandProvider,
      broadbandAccountId,
    );
    if (!migration) {
      throw errors.notFound('No migration found for that broadband account.');
    }

    const account = await accountService.getAccountById(migration.account_id);
    const migrations = await billingMigration.getMigrationHistory(migration.account_id);
    res.json({
      account: {
        id: account.id,
        status: account.status,
        phone_e164: account.phone_e164,
        external_billing_provider: account.external_billing_provider,
        broadband_provider: account.broadband_provider,
        broadband_account_id: account.broadband_account_id,
      },
      migrations,
    });
  }),
);

module.exports = router;
