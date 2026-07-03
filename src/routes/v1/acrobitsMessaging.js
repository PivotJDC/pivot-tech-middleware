/**
 * Acrobits Cloud Softphone messaging web services (mounted at /v1/acrobits).
 *
 * Acrobits does messaging over HTTP (not SIP/SIMPLE): the app calls these
 * endpoints using URL templates configured in the Acrobits provider portal.
 * This is an adapter layer that translates Acrobits' params/XML to/from our
 * messagingService + pushService.
 *
 *   GET|POST /v1/acrobits/send         send an outbound message
 *   GET      /v1/acrobits/fetch        poll for new received/sent messages
 *   POST     /v1/acrobits/push-token   register the app's push token
 *
 * Auth is by SIP username + password (the same credentials provisioned into the
 * app). All responses are Acrobits-flavored XML; errors return non-2xx with
 * <response><message>...</message></response>.
 */
const express = require('express');
const accountService = require('../../services/accountService');
const messagingService = require('../../services/messagingService');
const mmsService = require('../../services/mmsService');
const pushService = require('../../services/pushService');
const acrobits = require('../../integrations/acrobits');
const crypto = require('../../utils/crypto');
const { asyncHandler } = require('../../middleware/errorHandler');

const router = express.Router();

/** Escape the five XML special characters so values can't break the document. */
function escapeXml(value) {
  return String(value == null ? '' : value).replace(/[<>&'"]/g, (ch) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[ch]));
}

/** Format a created_at value (pg Date or string) as ISO-8601. */
function fmtDate(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value == null ? '' : value);
}

function sendOkXml(smsId) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<response>\n  <sms_id>${escapeXml(smsId)}</sms_id>\n</response>\n`;
}

function errorXml(message) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<response>\n  <message>${escapeXml(message)}</message>\n</response>\n`;
}

/**
 * Render one <item> block (Acrobits Modern API). Both <sender> and <recipient>
 * are emitted so the app can thread the message correctly: it needs to know the
 * subscriber's own number (not just the peer) to place an inbound message in the
 * conversation thread instead of a group chat. `streamId` is the peer number so
 * inbound + outbound of the same conversation share a thread.
 */
function smsXml(m, sender, recipient, streamId) {
  return [
    '    <item>',
    `      <sms_id>${escapeXml(m.id)}</sms_id>`,
    `      <sending_date>${escapeXml(fmtDate(m.created_at))}</sending_date>`,
    `      <sender>${escapeXml(sender)}</sender>`,
    `      <recipient>${escapeXml(recipient)}</recipient>`,
    `      <sms_text>${escapeXml(m.body)}</sms_text>`,
    '      <content_type>text/plain</content_type>',
    `      <stream_id>${escapeXml(streamId)}</stream_id>`,
    '    </item>',
  ].join('\n');
}

function fetchXml(received, sent, subscriberNumber) {
  // Received: sender = external peer, recipient = the subscriber; thread by peer.
  const recv = received
    .map((m) => smsXml(m, m.from_number, subscriberNumber, m.from_number))
    .join('\n');
  // Sent: sender = the subscriber, recipient = external peer; thread by peer.
  const snt = sent
    .map((m) => smsXml(m, subscriberNumber, m.to_number, m.to_number))
    .join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<response>',
    `  <date>${new Date().toISOString()}</date>`,
    '  <received_smss>',
    recv,
    '  </received_smss>',
    '  <sent_smss>',
    snt,
    '  </sent_smss>',
    '</response>',
    '',
  ].filter((line) => line !== '').join('\n');
}

/** Merge query + body so handlers work for both GET and POST templates. */
function params(req) {
  return { ...req.query, ...(req.body || {}) };
}

/**
 * Resolve + authenticate the account from SIP username (+ password when the
 * caller supplies one). Returns the raw account row, or null on failure.
 *
 * The identifier is accepted from either `username`/`password` (our templated
 * URLs) or `cloud_username`/`cloud_password` (which Acrobits appends
 * automatically for External Provisioning). Lookup is by sip_username first
 * (the gencred that %AUTH_USERNAME% carries), then falls back to phone_e164 —
 * because %USERNAME% substitutes the subscriber E.164, not the gencred.
 */
async function authAcrobits(p) {
  const username = p.username || p.cloud_username;
  const password = p.password || p.cloud_password;
  let account = await accountService.lookupBySipUsername(username);
  if (!account) {
    account = await accountService.lookupByPhoneE164(username);
  }
  if (!account) return null;
  if (password) {
    const ok = account.sip_password_hash
      ? await crypto.verifyPassword(password, account.sip_password_hash)
      : false;
    if (!ok) return null;
  }
  return account;
}

function sendXml(res, status, xml) {
  res.status(status).type('application/xml').send(xml);
}

/**
 * Parse an Acrobits send body into { text, attachments }.
 *
 * MMS arrives as a JSON body carrying an `attachments` array — each attachment
 * has a `content-url`, `content-type`, and (sometimes) an `encryption-key`. Any
 * `text` alongside the attachments becomes the message body; attachments-only
 * sends have an empty body. Anything that isn't JSON-with-attachments (plain
 * SMS text, or JSON without attachments) is treated as literal SMS text.
 *
 * The encrypted media is resolved to Telnyx-fetchable URLs separately by
 * mmsService (download + AES-decrypt + re-host on S3) — see sendHandler.
 */
function parseSendBody(rawBody) {
  if (!rawBody) return { text: '', attachments: [] };
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && Array.isArray(parsed.attachments)) {
      const attachments = parsed.attachments
        .map((a) => (a ? {
          url: a['content-url'] || a.content_url,
          contentType: a['content-type'] || a.content_type,
          encryptionKey: a['encryption-key'] || a.encryption_key,
        } : null))
        .filter((a) => a && a.url);
      const text = typeof parsed.text === 'string' ? parsed.text : '';
      return { text, attachments };
    }
  } catch {
    // Not JSON — a plain-text SMS body.
  }
  return { text: rawBody, attachments: [] };
}

// --- Send (GET or POST) ---
async function sendHandler(req, res) {
  const p = params(req);
  const account = await authAcrobits(p);
  if (!account) {
    sendXml(res, 403, errorXml('Authentication failed.'));
    return;
  }
  // Acrobits may send the destination unprefixed (e.g. a 10-digit US number);
  // normalize to E.164 before handing it to Telnyx.
  let toNumber = p.to || p.sms_to;
  if (toNumber && !toNumber.startsWith('+')) {
    if (toNumber.length === 10) {
      toNumber = `+1${toNumber}`;
    } else if (toNumber.length === 11 && toNumber.startsWith('1')) {
      toNumber = `+${toNumber}`;
    } else {
      toNumber = `+${toNumber}`;
    }
  }
  // SMS vs MMS: an attachments JSON body yields media; plain text is SMS.
  const { text, attachments } = parseSendBody(p.body || p.sms_body || p.message_body);
  try {
    // Resolve encrypted Acrobits media to Telnyx-fetchable URLs (best-effort).
    const mediaUrls = await mmsService.resolveMediaUrls(account.id, attachments);
    // Fallback: if the MMS had attachments but none could be resolved
    // (download/decrypt/upload failed) and there's no text, send a plain SMS
    // placeholder instead of failing the whole message.
    let body = text;
    if (!body && mediaUrls.length === 0 && attachments.length > 0) {
      body = '[Photo message]';
    }
    const message = await messagingService.sendMessage(account.id, {
      to: toNumber,
      body,
      mediaUrls,
    });
    sendXml(res, 200, sendOkXml(message.id));
  } catch (err) {
    const status = err && err.status >= 400 ? err.status : 500;
    sendXml(res, status, errorXml((err && err.message) || 'Failed to send message.'));
  }
}
router.get('/send', asyncHandler(sendHandler));
router.post('/send', asyncHandler(sendHandler));

// --- Fetch (poll for new messages) ---
router.get(
  '/fetch',
  asyncHandler(async (req, res) => {
    const p = params(req);
    const account = await authAcrobits(p);
    if (!account) {
      sendXml(res, 403, errorXml('Authentication failed.'));
      return;
    }
    const { received, sent } = await messagingService.fetchForAcrobits(
      account.id,
      p.last_id,
      p.last_sent_id,
    );
    sendXml(res, 200, fetchXml(received, sent, account.phone_e164));
  }),
);

// --- Push Token Reporter ---
// The Acrobits app POSTs its push tokens here (form-urlencoded via
// pushTokenReporterUrl/PostData in the Account XML). It reports two tokens: one
// for incoming calls (VoIP) and one for "other" (messages). We authenticate by
// SIP credentials (same as /send) and UPSERT by (account_id, selector).
router.post(
  '/push-token',
  asyncHandler(async (req, res) => {
    const p = params(req);
    const account = await authAcrobits(p);
    if (!account) {
      sendXml(res, 403, errorXml('Authentication failed.'));
      return;
    }
    try {
      await pushService.registerToken(account.id, account.tenant_id, {
        selector: p.selector,
        pushTokenCalls: p.pushTokenIncomingCall,
        pushTokenOther: p.pushTokenOther,
        pushAppIdCalls: p.pushappid_incoming_call,
        pushAppIdOther: p.pushappid_other || p.pushappid,
        deviceId: p.device_id,
        platform: p.platform,
      });
      // Acrobits ignores the body; return 200 empty.
      res.status(200).end();
    } catch (err) {
      const status = err && err.status >= 400 ? err.status : 500;
      sendXml(res, status, errorXml((err && err.message) || 'Failed to register push token.'));
    }
  }),
);

// --- External Provisioning (Account XML) ---
// Acrobits calls this REPEATEDLY (not single-use like the token flow) with the
// SIP username + password templated in. We authenticate by SIP credentials
// (same pattern as /send) and return the Account XML. Because the caller proved
// it knows the SIP password (verified against sip_password_hash), that value IS
// the plaintext to render into the XML — no Telnyx round-trip needed.
//
// Ignored Acrobits params: cloud_id, cloud_password, initialScreen.
router.get(
  '/provision',
  asyncHandler(async (req, res) => {
    const p = params(req);
    // External Provisioning doesn't template %USERNAME%/%PASSWORD%; Acrobits
    // appends cloud_username/cloud_password automatically. Accept either.
    const username = p.username || p.cloud_username;
    const password = p.password || p.cloud_password;
    if (!username || !password) {
      sendXml(res, 403, errorXml('Authentication failed.'));
      return;
    }
    const account = await authAcrobits({ username, password });
    if (!account) {
      sendXml(res, 403, errorXml('Authentication failed.'));
      return;
    }
    const xml = acrobits.buildAccountXml({
      sipUsername: account.sip_username,
      sipPassword: password, // verified above; the caller's SIP password
      phoneE164: account.phone_e164,
      firstName: account.first_name,
      lastName: account.last_name,
    });
    res.status(200).type('text/xml').send(xml);
  }),
);

module.exports = router;
