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
const qrcode = require('qrcode');
const db = require('../db');
const config = require('../config');
const token = require('../utils/token');
const crypto = require('../utils/crypto');
const acrobits = require('../integrations/acrobits');
const accountService = require('./accountService');
const didOrchestration = require('./didOrchestrationService');
const { errors, AppError } = require('../middleware/errorHandler');

/**
 * Rotate the account's SIP password on SignalWire and persist its bcrypt hash.
 * Returns the new plaintext, which the caller must hold in memory only for the
 * duration of building its response (CLAUDE.md security rule #3).
 */
async function rotateAndPersistSipPassword(account) {
  const sipPassword = await didOrchestration.rotateSipPassword(account.sip_endpoint_id);
  const sipPasswordHash = await crypto.hashPassword(sipPassword);
  await accountService.setSipPasswordHash(account.id, sipPasswordHash);
  return sipPassword;
}

/**
 * Build the Acrobits csc: provisioning URI: csc:username:password@CLOUD_ID.
 * Scanning it (or tapping it as a deep link) hands the Cloud Softphone app the
 * SIP credentials directly. Both parts are base64url/uuid charsets, so the
 * URI needs no percent-encoding. NEVER log the result — it embeds the live
 * SIP password (security rule #1).
 */
function buildCscUri(sipUsername, sipPassword) {
  return `csc:${sipUsername}:${sipPassword}@${config.acrobits.cloudId}`;
}

/**
 * Build the customer-facing provisioning links. The QR encodes the Acrobits
 * csc: URI (live SIP credentials); the provisioning URL still embeds the
 * single-use token for the XML credential-delivery flow. Both are secrets —
 * the QR is rendered locally to a data: URL and must never be sent to a
 * third-party QR service (security rule #1).
 */
async function buildLinks(rawToken, cscUri) {
  const provisioningUrl = `${config.provisioning.baseUrl}/v1/provision?token=${rawToken}`;
  const qrCodeUrl = await qrcode.toDataURL(cscUri, { errorCorrectionLevel: 'M' });
  return {
    // XML credential delivery — the Acrobits app can fetch this URL during setup.
    provisioning_url: provisioningUrl,
    // A self-contained PNG data URL the client can render directly.
    qr_code_url: qrCodeUrl,
    // The csc: URI doubles as the deep link on devices with the app installed.
    deep_link: cscUri,
  };
}

/**
 * Issue a fresh provisioning token for an account.
 * @param {{ id: string }} account
 * @returns {Promise<{ raw_token: string, expires_at: Date } & ReturnType<typeof buildLinks>>}
 */
async function issueToken(account) {
  if (!account.sip_endpoint_id || !account.sip_username) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Account is not ready for provisioning (DID assignment incomplete).',
    );
  }

  const rawToken = token.generateProvisioningToken();
  const tokenHash = token.hashProvisioningToken(rawToken);
  const ttlHours = config.provisioning.tokenTtlHours;

  const { rows } = await db.query(
    `INSERT INTO provisioning_tokens (account_id, token_hash, expires_at)
     VALUES ($1, $2, NOW() + ($3 * INTERVAL '1 hour'))
     RETURNING expires_at`,
    [account.id, tokenHash, ttlHours],
  );

  // DECISION: the csc: QR must embed a LIVE SIP password, and we only ever
  // store the bcrypt hash — so issuing links rotates the password right here.
  // Consequence: the QR and the XML endpoint each rotate on use, so whichever
  // path runs LAST holds the valid credentials; a device provisioned from the
  // QR is invalidated if the XML URL is fetched afterward (and vice versa).
  // One account, one delivery path per issuance.
  const sipPassword = await rotateAndPersistSipPassword(account);
  const cscUri = buildCscUri(account.sip_username, sipPassword);

  const links = await buildLinks(rawToken, cscUri);
  return { raw_token: rawToken, expires_at: rows[0].expires_at, ...links };
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
  const sipPassword = await rotateAndPersistSipPassword(account);

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
