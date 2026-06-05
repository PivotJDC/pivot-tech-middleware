/**
 * Provisioning service — the Acrobits onboarding lifecycle.
 *
 * Responsibilities:
 *   - issue/reissue single-use provisioning tokens (72h TTL)
 *   - validate + atomically consume a token (single-use)
 *   - assemble the Account XML, rotating the SIP password so plaintext exists
 *     only in memory and in the XML response (CLAUDE.md security rule #3)
 *   - generate the provisioning URL / QR data / deep link
 *
 * Only the SHA-256 hash of a token is stored; the raw token lives only in the
 * link handed to the customer.
 */
const db = require('../db');
const config = require('../config');
const token = require('../utils/token');
const crypto = require('../utils/crypto');
const acrobits = require('../integrations/acrobits');
const accountService = require('./accountService');
const didOrchestration = require('./didOrchestrationService');
const { errors, AppError } = require('../middleware/errorHandler');

/** Build the customer-facing provisioning links for a raw token. */
function buildLinks(rawToken) {
  const provisioningUrl = `${config.provisioning.baseUrl}/v1/provision?token=${rawToken}`;
  return {
    // The Acrobits app fetches this URL during setup; encode it as the QR.
    provisioning_url: provisioningUrl,
    qr_code_data: provisioningUrl,
    // DECISION: the deep link is the https provisioning URL for MVP. A
    // white-label custom URL scheme can replace this once the app defines one.
    deep_link: provisioningUrl,
  };
}

/**
 * Issue a fresh provisioning token for an account.
 * @param {{ id: string }} account
 * @returns {Promise<{ raw_token: string, expires_at: Date } & ReturnType<typeof buildLinks>>}
 */
async function issueToken(account) {
  const rawToken = token.generateProvisioningToken();
  const tokenHash = token.hashProvisioningToken(rawToken);
  const ttlHours = config.provisioning.tokenTtlHours;

  const { rows } = await db.query(
    `INSERT INTO provisioning_tokens (account_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'))
     RETURNING expires_at`,
    [account.id, tokenHash, ttlHours],
  );

  return { raw_token: rawToken, expires_at: rows[0].expires_at, ...buildLinks(rawToken) };
}

/** Admin: reissue a token for an existing account (validates the account). */
async function reissueToken(accountId) {
  const account = await accountService.getAccountById(accountId); // NOT_FOUND if missing
  return issueToken(account);
}

/**
 * Validate and atomically consume a raw provisioning token. The single UPDATE
 * marks it used only if it is currently unused and unexpired, so concurrent
 * requests can never both succeed. Any failure (missing, used, expired) yields
 * TOKEN_EXPIRED (401) per CLAUDE.md — without leaking which case it was.
 * @returns {Promise<string>} the account id the token belongs to
 */
async function validateAndConsumeToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw errors.validation('A provisioning token is required.', 'token');
  }
  const tokenHash = token.hashProvisioningToken(rawToken);
  const { rows } = await db.query(
    `UPDATE provisioning_tokens
        SET used = TRUE
      WHERE token_hash = $1 AND used = FALSE AND expires_at > NOW()
      RETURNING account_id`,
    [tokenHash],
  );
  if (rows.length === 0) {
    throw errors.tokenExpired('Provisioning token is invalid, expired, or already used.');
  }
  return rows[0].account_id;
}

/**
 * Assemble the Acrobits Account XML for an account, rotating the SIP password.
 * The new plaintext password is pushed to the SignalWire endpoint, its bcrypt
 * hash is persisted, and the plaintext is rendered into the XML — held only in
 * memory for the duration of this call.
 * @returns {Promise<string>} XML document
 */
async function generateAccountXml(account) {
  if (!account.sip_endpoint_id || !account.phone_e164) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Account is not ready for provisioning (DID assignment incomplete).',
    );
  }
  const sipPassword = await didOrchestration.rotateSipPassword(account.sip_endpoint_id);
  const sipPasswordHash = await crypto.hashPassword(sipPassword);
  await accountService.setSipPasswordHash(account.id, sipPasswordHash);

  return acrobits.buildAccountXml({
    sipUsername: account.sip_username,
    sipPassword,
    phoneE164: account.phone_e164,
  });
}

/**
 * Full provisioning flow for GET /v1/provision: consume the token, load the
 * account, and return its Account XML.
 * @returns {Promise<string>} XML document
 */
async function provisionByToken(rawToken) {
  const accountId = await validateAndConsumeToken(rawToken);
  const account = await accountService.getAccountById(accountId);
  return generateAccountXml(account);
}

module.exports = {
  issueToken,
  reissueToken,
  validateAndConsumeToken,
  generateAccountXml,
  provisionByToken,
  buildLinks,
};
