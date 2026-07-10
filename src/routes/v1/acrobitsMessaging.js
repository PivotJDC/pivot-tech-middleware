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
const s3 = require('../../integrations/s3');
const crypto = require('../../utils/crypto');
const { formatNational } = require('../../utils/e164');
const { logger } = require('../../utils/logger');
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

// file extension -> content-type, for inferring an attachment's MIME type from
// its (presigned) S3 URL — the messages table stores only the URLs, not types.
const CONTENT_TYPE_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  amr: 'audio/amr',
  pdf: 'application/pdf',
};

/** Best-effort content-type from a media URL's extension (default image/jpeg). */
function contentTypeForUrl(url) {
  const match = /\.([a-z0-9]{2,4})(?:\?|#|$)/i.exec(String(url || ''));
  const ext = match ? match[1].toLowerCase() : '';
  return CONTENT_TYPE_BY_EXT[ext] || 'image/jpeg';
}

/**
 * The other participants in a group message, excluding the subscriber, deduped
 * in first-seen order. Union of the sender, the recipient side (to_number), and
 * the stored `cc` list. Empty for a 1:1 message (no group_id).
 */
function groupParticipants(m, subscriberNumber) {
  const out = [];
  const seen = new Set([subscriberNumber]);
  const add = (n) => {
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  };
  add(m.from_number);
  add(m.to_number);
  (Array.isArray(m.cc) ? m.cc : []).forEach(add);
  return out;
}

/**
 * Group-thread elements for an <item>: the group id, a human label for the
 * conversation list, and the participant numbers. DECISION: the middleware only
 * knows E.164 numbers (no contact names), so the label lists national-format
 * numbers — the app substitutes its own contact names on top. Returns [] for a
 * 1:1 message so the item is unchanged.
 */
function groupXmlLines(m, subscriberNumber) {
  if (!m.group_id) return [];
  const participants = groupParticipants(m, subscriberNumber);
  const label = `Group: ${participants.map(formatNational).join(', ')}`;
  return [
    `      <group_id>${escapeXml(m.group_id)}</group_id>`,
    `      <group_label>${escapeXml(label)}</group_label>`,
    '      <group_participants>',
    ...participants.map((p) => `        <participant>${escapeXml(p)}</participant>`),
    '      </group_participants>',
  ];
}

/**
 * Render one <item> block (Acrobits Modern API). Both <sender> and <recipient>
 * are emitted so the app can thread the message correctly: it needs to know the
 * subscriber's own number (not just the peer) to place an inbound message in the
 * conversation thread instead of a group chat. `streamId` is the peer number so
 * inbound + outbound of the same conversation share a thread — except for group
 * messages, where the caller passes the group_id so the whole group threads
 * together and `groupXmlLines` adds the participant list.
 *
 * MMS: Cloud Softphone renders inbound media via a file-transfer payload — the
 * content_type is application/x-acro-filetransfer+json and <sms_text> carries a
 * JSON { attachments: [...] } document (the presigned URLs live inside it), not
 * plain text. Any caption rides along as a "text" field. Plain SMS is unchanged
 * (content_type text/plain, <sms_text> = the body).
 */
function smsXml(m, sender, recipient, streamId, subscriberNumber) {
  const media = Array.isArray(m.media_urls) ? m.media_urls : [];
  const previews = Array.isArray(m.mediaPreviews) ? m.mediaPreviews : [];
  let smsText = m.body || '';
  let contentType = 'text/plain';
  if (media.length > 0) {
    contentType = 'application/x-acro-filetransfer+json';
    const payload = {
      attachments: media.map((url, i) => {
        const attachment = { 'content-url': url, 'content-type': contentTypeForUrl(url) };
        // Video attachments carry a base64 JPEG preview (Acrobits thumbnail).
        if (previews[i]) attachment.preview = previews[i];
        return attachment;
      }),
    };
    if (m.body) payload.text = m.body;
    smsText = JSON.stringify(payload);
  }
  return [
    '    <item>',
    `      <sms_id>${escapeXml(m.id)}</sms_id>`,
    `      <sending_date>${escapeXml(fmtDate(m.created_at))}</sending_date>`,
    `      <sender>${escapeXml(sender)}</sender>`,
    `      <recipient>${escapeXml(recipient)}</recipient>`,
    `      <sms_text>${escapeXml(smsText)}</sms_text>`,
    `      <content_type>${contentType}</content_type>`,
    `      <stream_id>${escapeXml(streamId)}</stream_id>`,
    ...groupXmlLines(m, subscriberNumber),
    '    </item>',
  ].join('\n');
}

function fetchXml(received, sent, subscriberNumber) {
  const sub = subscriberNumber;
  // Received: sender = external peer, recipient = the subscriber. Thread by the
  // group id when the message is part of a group, else by the peer number.
  const recv = received
    .map((m) => smsXml(m, m.from_number, sub, m.group_id || m.from_number, sub))
    .join('\n');
  // Sent: sender = the subscriber, recipient = external peer. Thread by group id
  // when set, else by the peer number.
  const snt = sent
    .map((m) => smsXml(m, sub, m.to_number, m.group_id || m.to_number, sub))
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

/**
 * Prepare a message's media for the fetch response (mutates the row in place):
 *   - load a base64 JPEG preview for each video attachment into m.mediaPreviews,
 *     aligned to media_urls;
 *   - replace media_urls with fresh presigned URLs for our own S3 objects.
 * Best-effort throughout — external URLs, missing thumbnails, and signing
 * failures are left as-is.
 *
 * The video thumbnail is served from the cached column (video_thumbnail_base64)
 * when present, so a fetch poll never depends on S3 — a slow/transient
 * getObjectBuffer used to null the preview out, making the thumbnail flicker
 * (appear, then disappear on the next poll). When the cache is empty (an
 * outbound message, whose row is created after media archival, or a row from
 * before this cache existed) we fall back to S3 and write the result back so the
 * next poll is served from the row. Only the first video attachment is cached
 * (the column holds one thumbnail per message).
 */
async function prepareMessageMedia(m) {
  if (!m || !Array.isArray(m.media_urls) || m.media_urls.length === 0) return;
  const rawUrls = m.media_urls;
  const firstVideoIdx = rawUrls.findIndex((u) => contentTypeForUrl(u).startsWith('video/'));
  const previews = await Promise.all(rawUrls.map(async (rawUrl, i) => {
    if (!contentTypeForUrl(rawUrl).startsWith('video/')) return null;
    // Cache hit: serve straight from the row, no S3 call.
    if (i === firstVideoIdx && m.video_thumbnail_base64) {
      logger.info({ messageId: m.id, source: 'cached' }, 'using cached video thumbnail');
      return { 'content-type': 'image/jpeg', content: m.video_thumbnail_base64 };
    }
    const key = s3.keyFromUrl(rawUrl);
    if (!key) return null;
    try {
      const buf = await s3.getObjectBuffer(`${key}_thumb.jpg`);
      const base64 = buf.toString('base64');
      // Write-through so subsequent polls skip S3 (best-effort; never throws).
      if (i === firstVideoIdx) {
        await messagingService.cacheVideoThumbnail(m.id, base64);
      }
      return { 'content-type': 'image/jpeg', content: base64 };
    } catch {
      return null; // no thumbnail stored
    }
  }));
  // eslint-disable-next-line no-param-reassign
  m.mediaPreviews = previews;
  // eslint-disable-next-line no-param-reassign
  m.media_urls = await Promise.all(rawUrls.map((u) => s3.presignUrlIfOwn(u, 3600)));
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

// Acrobits may send a destination unprefixed (a 10-digit US number, or 11 with a
// leading 1); normalize to E.164 before handing it to Telnyx.
function normalizeToE164(raw) {
  const n = typeof raw === 'string' ? raw.trim() : '';
  if (!n || n.startsWith('+')) return n;
  if (n.length === 10) return `+1${n}`;
  if (n.length === 11 && n.startsWith('1')) return `+${n}`;
  return `+${n}`;
}

/**
 * Parse the recipient(s) from an Acrobits send. Cloud Softphone delivers group
 * recipients either as a repeated `to` param (Express parses `to=+1A&to=+1B`
 * into an array) or comma-separated (`to=+1A,+1B,+1C`) — handle both, plus the
 * `sms_to` alias. Returns E.164 numbers, deduped in order. A single recipient
 * yields a one-element array (a normal 1:1 send); two or more mean a group MMS.
 */
function parseRecipients(p) {
  const raw = p.to != null ? p.to : p.sms_to;
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  list
    .flatMap((entry) => String(entry == null ? '' : entry).split(','))
    .map(normalizeToE164)
    .filter(Boolean)
    .forEach((n) => {
      if (!seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    });
  return out;
}

// --- Send (GET or POST) ---
async function sendHandler(req, res) {
  const p = params(req);
  const account = await authAcrobits(p);
  if (!account) {
    sendXml(res, 403, errorXml('Authentication failed.'));
    return;
  }
  const recipients = parseRecipients(p);
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
    // Two or more recipients → Telnyx Group MMS; one → ordinary 1:1 send.
    const message = recipients.length > 1
      ? await messagingService.sendGroupMessage(account.id, { to: recipients, body, mediaUrls })
      : await messagingService.sendMessage(account.id, { to: recipients[0], body, mediaUrls });
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
    // Presign our S3 media (external URLs pass through) and attach base64 video
    // thumbnails for the Acrobits preview.
    await Promise.all([...received, ...sent].map(prepareMessageMedia));
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
