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
const acrobits = require('../integrations/acrobits');
const accountService = require('./accountService');
const didOrchestration = require('./didOrchestrationService');
const { errors, AppError } = require('../middleware/errorHandler');

/**
 * Resolve the account's current plaintext SIP password for credential delivery.
 *
 * With Telnyx the credential is vendor-generated and immutable, so we fetch the
 * existing password rather than rotating it; the bcrypt hash stored at account
 * creation stays valid and there is nothing to re-persist. The plaintext is held
 * in memory only for the duration of building the response (security rule #3).
 */
async function resolveSipPassword(account) {
  return didOrchestration.getSipPassword(account.sip_endpoint_id);
}

/**
 * Build the Acrobits csc: provisioning URI: csc:username:password@CLOUD_ID.
 * Scanning it (or tapping it as a deep link) hands the Cloud Softphone app the
 * SIP credentials directly. Both parts are base64url/uuid charsets, so the
 * URI needs no percent-encoding. NEVER log the result — it embeds the live
 * SIP password (security rule #1).
 *
 * The subscriber's E.164 is the single SIP username Acrobits uses for both the
 * From identity (caller ID) and digest auth, so the csc: form carries it
 * directly: csc:{phoneE164}:{password}@{cloudId}.
 */
function buildCscUri(phoneE164, sipPassword) {
  return `csc:${phoneE164}:${sipPassword}@${config.acrobits.cloudId}`;
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
 * Build the dialer provisioning QR for an account: the Acrobits Cloud Softphone
 * QR text (csc:user:pass@CloudID — see doc.acrobits.net/cloudsoftphone/qr.html)
 * carrying the live SIP credentials, plus a PNG data URL of its QR. The
 * plaintext password is held in memory only for this call and is NEVER logged
 * (security rule #1); the QR is rendered locally, never via a third-party.
 * @param {{ sip_username: string, sip_endpoint_id: string }} account
 * @returns {Promise<{ qr_url: string, provisioning_url: string }>}
 */
async function buildProvisioningQr(account) {
  if (!account.sip_endpoint_id || !account.sip_username) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Account is not ready for provisioning (DID assignment incomplete).',
    );
  }
  const sipPassword = await resolveSipPassword(account);
  // The E.164 is the SIP username (no gencred).
  const provisioningUrl = `csc:${encodeURIComponent(account.phone_e164)}`
    + `:${encodeURIComponent(sipPassword)}@${config.acrobits.cloudId}`;
  const qrUrl = await qrcode.toDataURL(provisioningUrl, { errorCorrectionLevel: 'M' });
  return { qr_url: qrUrl, provisioning_url: provisioningUrl };
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

  // The csc: QR embeds the LIVE SIP password. Telnyx credentials are stable
  // (no rotation), so the QR and the XML endpoint now deliver the SAME valid
  // credential — fetching one no longer invalidates the other.
  const sipPassword = await resolveSipPassword(account);
  const cscUri = buildCscUri(account.phone_e164, sipPassword);

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
 * Assemble the Acrobits Account XML for an account. The account's current SIP
 * password is fetched from Telnyx and rendered into the XML — held only in
 * memory for the duration of this call. The subscriber's E.164 is the SIP
 * username (no gencred), so buildAccountXml derives it from phoneE164.
 * @returns {Promise<string>} XML document
 */
async function generateAccountXml(account) {
  if (!account.sip_endpoint_id || !account.phone_e164) {
    throw new AppError(
      'INTERNAL_ERROR',
      'Account is not ready for provisioning (DID assignment incomplete).',
    );
  }
  const sipPassword = await resolveSipPassword(account);

  return acrobits.buildAccountXml({
    sipPassword,
    phoneE164: account.phone_e164,
    // Per-subscriber caller ID display name (first + last). Optional — falls
    // back to the national-format number inside buildAccountXml when absent.
    firstName: account.first_name,
    lastName: account.last_name,
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
  buildProvisioningQr,
};
