jest.mock('../../src/services/accountService');
jest.mock('../../src/services/messagingService');
jest.mock('../../src/services/mmsService');
jest.mock('../../src/services/pushService');
jest.mock('../../src/integrations/s3');
jest.mock('../../src/utils/crypto');

const express = require('express');
const request = require('supertest');
const accountService = require('../../src/services/accountService');
const messagingService = require('../../src/services/messagingService');
const mmsService = require('../../src/services/mmsService');
const pushService = require('../../src/services/pushService');
const s3 = require('../../src/integrations/s3');
const crypto = require('../../src/utils/crypto');
const acrobitsRouter = require('../../src/routes/v1/acrobitsMessaging');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());
  app.use('/v1/acrobits', acrobitsRouter);
  app.use(errorHandler);
  return app;
}

// Extract <sms_text> from a fetch response and XML-unescape it back to raw JSON.
const XML_UNESCAPE = {
  '&quot;': '"', '&apos;': "'", '&amp;': '&', '&lt;': '<', '&gt;': '>',
};
function smsTextJson(xml) {
  const raw = /<sms_text>([\s\S]*?)<\/sms_text>/.exec(xml)[1];
  return raw.replace(/&(quot|apos|amp|lt|gt);/g, (m) => XML_UNESCAPE[m]);
}

const app = buildApp();
const ACCOUNT = {
  id: 'acc-1',
  tenant_id: 'ten-1',
  sip_username: 'pivottech-abc',
  sip_password_hash: 'bcrypt$x',
  phone_e164: '+12087869908',
  status: 'active',
};

beforeEach(() => {
  jest.clearAllMocks();
  accountService.lookupBySipUsername.mockResolvedValue(ACCOUNT);
  crypto.verifyPassword.mockResolvedValue(true);
  // Default: media resolution passes attachment URLs through (no encryption).
  mmsService.resolveMediaUrls.mockImplementation(
    (accountId, atts) => Promise.resolve((atts || []).map((a) => a.url)),
  );
  // Default: presign is an identity pass-through (mark own URLs as "signed").
  s3.presignUrlIfOwn.mockImplementation((url) => Promise.resolve(url));
});

describe('GET /v1/acrobits/provision', () => {
  const PROV_ACCOUNT = {
    id: 'acc-1',
    sip_username: 'pivottech-abc',
    sip_password_hash: 'bcrypt$x',
    phone_e164: '+12085550100',
    first_name: 'Jane',
    last_name: 'Doe',
    status: 'active',
  };

  it('returns the Account XML (text/xml) for valid SIP credentials', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(PROV_ACCOUNT);
    crypto.verifyPassword.mockResolvedValueOnce(true);

    const res = await request(app)
      .get('/v1/acrobits/provision')
      .query({ username: 'pivottech-abc', password: 'sip-secret', initialScreen: 'dialer' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    // SIP identity: <username> and <authUsername> are both the gencred (required
    // for SIP REGISTER); the E.164 is caller ID only (fromUser/displayName).
    expect(res.text).toContain('<username>pivottech-abc</username>');
    expect(res.text).toContain('<authUsername>pivottech-abc</authUsername>');
    // The verified plaintext password is rendered into the XML (no Telnyx call).
    expect(res.text).toContain('<password>sip-secret</password>');
    expect(res.text).toContain('<displayName>Jane Doe</displayName>');
    expect(crypto.verifyPassword).toHaveBeenCalledWith('sip-secret', 'bcrypt$x');
  });

  it('authenticates via cloud_username/cloud_password (External Provisioning)', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(PROV_ACCOUNT);
    crypto.verifyPassword.mockResolvedValueOnce(true);

    const res = await request(app)
      .get('/v1/acrobits/provision')
      .query({ cloud_username: 'pivottech-abc', cloud_password: 'sip-secret' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/xml/);
    expect(res.text).toContain('<authUsername>pivottech-abc</authUsername>');
    expect(res.text).toContain('<password>sip-secret</password>');
    expect(accountService.lookupBySipUsername).toHaveBeenCalledWith('pivottech-abc');
    expect(crypto.verifyPassword).toHaveBeenCalledWith('sip-secret', 'bcrypt$x');
  });

  it('rejects a wrong SIP password with 403', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(PROV_ACCOUNT);
    crypto.verifyPassword.mockResolvedValueOnce(false);
    const res = await request(app)
      .get('/v1/acrobits/provision')
      .query({ username: 'pivottech-abc', password: 'wrong' });
    expect(res.status).toBe(403);
    expect(res.text).not.toContain('<account>');
  });

  it('rejects an unknown SIP username with 403', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(null);
    const res = await request(app)
      .get('/v1/acrobits/provision')
      .query({ username: 'nobody', password: 'x' });
    expect(res.status).toBe(403);
  });

  it('rejects a missing password without a DB lookup', async () => {
    const res = await request(app)
      .get('/v1/acrobits/provision')
      .query({ username: 'pivottech-abc' });
    expect(res.status).toBe(403);
    expect(accountService.lookupBySipUsername).not.toHaveBeenCalled();
  });
});

describe('GET/POST /v1/acrobits/send', () => {
  it('sends a message and returns the sms_id as XML', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'msg-1' });
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: 'pivottech-abc',
        password: 'pw',
        sms_to: '+12085550142',
        sms_body: 'Hello',
        content_type: 'text/plain',
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<sms_id>msg-1</sms_id>');
    expect(accountService.lookupBySipUsername).toHaveBeenCalledWith('pivottech-abc');
    expect(crypto.verifyPassword).toHaveBeenCalledWith('pw', 'bcrypt$x');
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142', body: 'Hello', mediaUrls: [],
    });
  });

  it('routes multiple comma-separated recipients to the group endpoint', async () => {
    messagingService.sendGroupMessage.mockResolvedValueOnce({ id: 'grp-1' });
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: 'pivottech-abc',
        password: 'pw',
        to: '+12085550142,2085550143,+12085550144',
        sms_body: 'group hi',
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<sms_id>grp-1</sms_id>');
    expect(messagingService.sendGroupMessage).toHaveBeenCalledWith('acc-1', {
      to: ['+12085550142', '+12085550143', '+12085550144'], // normalized to E.164
      body: 'group hi',
      mediaUrls: [],
    });
    expect(messagingService.sendMessage).not.toHaveBeenCalled();
  });

  it('routes repeated `to` params (array) to the group endpoint', async () => {
    messagingService.sendGroupMessage.mockResolvedValueOnce({ id: 'grp-2' });
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query('username=pivottech-abc&password=pw&to=%2B12085550142&to=%2B12085550143&sms_body=hey');
    expect(res.status).toBe(200);
    expect(messagingService.sendGroupMessage).toHaveBeenCalledWith('acc-1', {
      to: ['+12085550142', '+12085550143'],
      body: 'hey',
      mediaUrls: [],
    });
  });

  it('keeps a single recipient on the 1:1 send path', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'solo-1' });
    await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: 'pivottech-abc', password: 'pw', to: '2085550142', sms_body: 'hi',
      });
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142', body: 'hi', mediaUrls: [],
    });
    expect(messagingService.sendGroupMessage).not.toHaveBeenCalled();
  });

  it('sends an MMS: parses a JSON attachments body into media_urls', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'mms-1' });
    const body = JSON.stringify({
      attachments: [
        { 'content-url': 'https://media/1.jpg', 'content-type': 'image/jpeg', 'encryption-key': 'k' },
        { 'content-url': 'https://media/2.png', 'content-type': 'image/png' },
      ],
    });
    const res = await request(app)
      .post('/v1/acrobits/send')
      .type('form')
      .send({
        username: 'pivottech-abc', password: 'pw', sms_to: '+12085550142', sms_body: body,
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<sms_id>mms-1</sms_id>');
    // The attachments (with encryption metadata) go to mmsService to resolve.
    expect(mmsService.resolveMediaUrls).toHaveBeenCalledWith('acc-1', [
      { url: 'https://media/1.jpg', contentType: 'image/jpeg', encryptionKey: 'k' },
      { url: 'https://media/2.png', contentType: 'image/png', encryptionKey: undefined },
    ]);
    // Media-only MMS → empty body, resolved URLs as media.
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142',
      body: '',
      mediaUrls: ['https://media/1.jpg', 'https://media/2.png'],
    });
  });

  it('proxies encrypted media through mmsService (S3 URLs) before sending', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'mms-enc' });
    mmsService.resolveMediaUrls.mockResolvedValueOnce(['https://s3/mms/acc-1/uuid.jpg']);
    const body = JSON.stringify({
      attachments: [{ 'content-url': 'https://acrobits/enc', 'content-type': 'image/jpeg', 'encryption-key': 'ab12' }],
    });
    await request(app)
      .post('/v1/acrobits/send')
      .type('form')
      .send({
        username: 'pivottech-abc', password: 'pw', sms_to: '+12085550142', sms_body: body,
      });
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142',
      body: '',
      mediaUrls: ['https://s3/mms/acc-1/uuid.jpg'],
    });
  });

  it('falls back to a "[Photo message]" SMS when media fails to resolve', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'mms-fallback' });
    // All attachments failed (download/decrypt) → no resolved media, no text.
    mmsService.resolveMediaUrls.mockResolvedValueOnce([]);
    const body = JSON.stringify({
      attachments: [{ 'content-url': 'https://acrobits/enc', 'content-type': 'image/jpeg', 'encryption-key': 'ab12' }],
    });
    const res = await request(app)
      .post('/v1/acrobits/send')
      .type('form')
      .send({
        username: 'pivottech-abc', password: 'pw', sms_to: '+12085550142', sms_body: body,
      });
    expect(res.status).toBe(200);
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142',
      body: '[Photo message]',
      mediaUrls: [],
    });
  });

  it('sends an MMS with text alongside the attachments', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'mms-2' });
    const body = JSON.stringify({
      text: 'check this out',
      attachments: [{ 'content-url': 'https://media/3.gif', 'content-type': 'image/gif' }],
    });
    await request(app)
      .post('/v1/acrobits/send')
      .type('form')
      .send({
        username: 'pivottech-abc', password: 'pw', sms_to: '+12085550142', sms_body: body,
      });
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142',
      body: 'check this out',
      mediaUrls: ['https://media/3.gif'],
    });
  });

  it('treats a JSON body without an attachments array as plain SMS text', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'sms-json' });
    const body = '{"text":"not an mms"}';
    await request(app)
      .post('/v1/acrobits/send')
      .type('form')
      .send({
        username: 'pivottech-abc', password: 'pw', sms_to: '+12085550142', sms_body: body,
      });
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142', body, mediaUrls: [],
    });
  });

  it('normalizes a bare 10-digit destination to E.164 before sending', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'msg-3' });
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: 'pivottech-abc', password: 'pw', sms_to: '2085550142', sms_body: 'hi',
      });
    expect(res.status).toBe(200);
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142', body: 'hi', mediaUrls: [],
    });
  });

  it('prefixes an 11-digit US number (leading 1) with +', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'msg-4' });
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: 'pivottech-abc', password: 'pw', sms_to: '12085550142', sms_body: 'hi',
      });
    expect(res.status).toBe(200);
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142', body: 'hi', mediaUrls: [],
    });
  });

  it('works via POST too', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'msg-2' });
    const res = await request(app)
      .post('/v1/acrobits/send')
      .type('form')
      .send({
        username: 'pivottech-abc', password: 'pw', sms_to: '+1', sms_body: 'hi',
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<sms_id>msg-2</sms_id>');
  });

  it('returns 403 XML when the SIP username is unknown', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(null);
    accountService.lookupByPhoneE164.mockResolvedValueOnce(null);
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: 'nope', password: 'pw', sms_to: '+1', sms_body: 'hi',
      });
    expect(res.status).toBe(403);
    expect(res.text).toContain('<message>Authentication failed.</message>');
    expect(messagingService.sendMessage).not.toHaveBeenCalled();
  });

  it('falls back to a phone_e164 lookup when the identifier is an E.164', async () => {
    // %USERNAME% substitutes the subscriber E.164, not the gencred, so the
    // sip_username lookup misses and we resolve by phone number instead.
    accountService.lookupBySipUsername.mockResolvedValueOnce(null);
    accountService.lookupByPhoneE164.mockResolvedValueOnce(ACCOUNT);
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'msg-9' });
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: '+12085550100', password: 'pw', sms_to: '+12085550142', sms_body: 'hi',
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<sms_id>msg-9</sms_id>');
    expect(accountService.lookupByPhoneE164).toHaveBeenCalledWith('+12085550100');
    expect(messagingService.sendMessage).toHaveBeenCalledWith('acc-1', {
      to: '+12085550142', body: 'hi', mediaUrls: [],
    });
  });

  it('authenticates via cloud_username/cloud_password on /send', async () => {
    messagingService.sendMessage.mockResolvedValueOnce({ id: 'msg-10' });
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        cloud_username: 'pivottech-abc', cloud_password: 'pw', sms_to: '+1', sms_body: 'hi',
      });
    expect(res.status).toBe(200);
    expect(res.text).toContain('<sms_id>msg-10</sms_id>');
    expect(accountService.lookupBySipUsername).toHaveBeenCalledWith('pivottech-abc');
    expect(crypto.verifyPassword).toHaveBeenCalledWith('pw', 'bcrypt$x');
  });

  it('returns 403 XML when the password does not match', async () => {
    crypto.verifyPassword.mockResolvedValueOnce(false);
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: 'pivottech-abc', password: 'wrong', sms_to: '+1', sms_body: 'hi',
      });
    expect(res.status).toBe(403);
    expect(messagingService.sendMessage).not.toHaveBeenCalled();
  });

  it('returns a non-2xx error XML when sending fails', async () => {
    const err = Object.assign(new Error('Account must be active to send messages.'), {
      code: 'VALIDATION_ERROR', status: 400,
    });
    messagingService.sendMessage.mockRejectedValueOnce(err);
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: 'pivottech-abc', password: 'pw', sms_to: '+1', sms_body: 'hi',
      });
    expect(res.status).toBe(400);
    expect(res.text).toContain('<message>Account must be active to send messages.</message>');
  });
});

describe('GET /v1/acrobits/fetch', () => {
  it('returns received and sent messages in Acrobits XML', async () => {
    messagingService.fetchForAcrobits.mockResolvedValueOnce({
      received: [{
        id: 'r1', from_number: '+12085550142', body: 'hi in', created_at: '2026-06-25T12:00:00.000Z',
      }],
      sent: [{
        id: 's1', to_number: '+12085550143', body: 'hi out', created_at: '2026-06-25T12:05:00.000Z',
      }],
    });
    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({
        username: 'pivottech-abc', password: 'pw', last_id: 'r0', last_sent_id: 's0', device: 'd1',
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/xml/);
    // Modern API: <date> at top, <item> blocks, sender/recipient, sms_text.
    expect(res.text).toMatch(/<date>\d{4}-\d{2}-\d{2}T[\d:.]+Z<\/date>/);
    expect(res.text).toContain('<received_smss>');
    expect(res.text).toContain('<item>');
    // Received: sender = external peer, recipient = the subscriber's own number
    // (so the app threads it into the conversation, not a group chat).
    expect(res.text).toContain('<sender>+12085550142</sender>');
    expect(res.text).toContain('<recipient>+12087869908</recipient>');
    expect(res.text).toContain('<sms_text>hi in</sms_text>');
    expect(res.text).toContain('<sms_id>r1</sms_id>');
    expect(res.text).toContain('<sent_smss>');
    // Sent: sender = the subscriber's own number, recipient = external peer.
    expect(res.text).toContain('<sender>+12087869908</sender>');
    expect(res.text).toContain('<recipient>+12085550143</recipient>');
    expect(res.text).toContain('<sms_text>hi out</sms_text>');
    // Both directions thread by the external peer number.
    expect(res.text).toContain('<stream_id>+12085550142</stream_id>');
    expect(res.text).toContain('<stream_id>+12085550143</stream_id>');
    // Legacy element names are gone.
    expect(res.text).not.toContain('<sms>');
    expect(res.text).not.toContain('<sms_from>');
    expect(res.text).not.toContain('<sms_to>');
    expect(res.text).not.toContain('<body>');
    expect(messagingService.fetchForAcrobits).toHaveBeenCalledWith('acc-1', 'r0', 's0');
  });

  it('threads a group message by group_id and lists participants', async () => {
    messagingService.fetchForAcrobits.mockResolvedValueOnce({
      received: [{
        id: 'gr1',
        from_number: '+12085550142',
        to_number: '+12087869908', // the subscriber's DID
        cc: ['+12085550143', '+12085550144'],
        group_id: 'gm-9',
        body: 'group hi',
        created_at: '2026-06-25T12:00:00.000Z',
      }],
      sent: [],
    });
    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'pivottech-abc', password: 'pw' });

    expect(res.status).toBe(200);
    // Threads by the group id (not the sender number).
    expect(res.text).toContain('<stream_id>gm-9</stream_id>');
    expect(res.text).toContain('<group_id>gm-9</group_id>');
    // Participants exclude the subscriber; label uses national-format numbers.
    expect(res.text).toContain('<participant>+12085550142</participant>');
    expect(res.text).toContain('<participant>+12085550143</participant>');
    expect(res.text).toContain('<participant>+12085550144</participant>');
    expect(res.text).not.toContain('<participant>+12087869908</participant>');
    expect(res.text).toContain(
      '<group_label>Group: (208) 555-0142, (208) 555-0143, (208) 555-0144</group_label>',
    );
  });

  it('omits group elements for a 1:1 message', async () => {
    messagingService.fetchForAcrobits.mockResolvedValueOnce({
      received: [{
        id: 'p1', from_number: '+12085550142', body: 'hi', created_at: '2026-06-25T12:00:00.000Z',
      }],
      sent: [],
    });
    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'pivottech-abc', password: 'pw' });
    expect(res.text).not.toContain('<group_id>');
    expect(res.text).not.toContain('<group_participants>');
    expect(res.text).toContain('<stream_id>+12085550142</stream_id>');
  });

  it('renders MMS as a filetransfer JSON payload in sms_text (presigned URLs)', async () => {
    s3.presignUrlIfOwn.mockImplementation((url) => Promise.resolve(
      url.includes('bucket.s3') ? `${url}?signed=1` : url,
    ));
    messagingService.fetchForAcrobits.mockResolvedValueOnce({
      received: [{
        id: 'r1',
        from_number: '+12085550142',
        body: 'pic',
        created_at: '2026-06-25T12:00:00.000Z',
        media_urls: [
          'https://bucket.s3.us-east-1.amazonaws.com/mms-inbound/acc-1/r1_0.jpg',
          'https://external/telnyx.png',
        ],
      }],
      sent: [],
    });
    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'pivottech-abc', password: 'pw' });

    expect(res.status).toBe(200);
    // File-transfer content_type + JSON payload (not text/plain), no XML media els.
    expect(res.text).toContain('<content_type>application/x-acro-filetransfer+json</content_type>');
    expect(res.text).not.toContain('<media_url');

    // Pull the sms_text out, XML-unescape it, and assert the JSON shape.
    const json = JSON.parse(smsTextJson(res.text));
    expect(json).toEqual({
      attachments: [
        {
          'content-url': 'https://bucket.s3.us-east-1.amazonaws.com/mms-inbound/acc-1/r1_0.jpg?signed=1',
          'content-type': 'image/jpeg',
        },
        { 'content-url': 'https://external/telnyx.png', 'content-type': 'image/png' },
      ],
      text: 'pic', // the caption rides along as a "text" field
    });
  });

  it('includes a base64 thumbnail preview for a video attachment', async () => {
    s3.presignUrlIfOwn.mockImplementation((url) => Promise.resolve(`${url}?signed=1`));
    s3.keyFromUrl.mockReturnValue('mms-inbound/acc-1/r5_0.mp4');
    s3.getObjectBuffer.mockResolvedValueOnce(Buffer.from('THUMBDATA'));
    messagingService.fetchForAcrobits.mockResolvedValueOnce({
      received: [{
        id: 'r5',
        from_number: '+12085550142',
        body: '',
        created_at: '2026-06-25T12:00:00.000Z',
        media_urls: ['https://bucket.s3.us-east-1.amazonaws.com/mms-inbound/acc-1/r5_0.mp4'],
      }],
      sent: [],
    });

    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'pivottech-abc', password: 'pw' });

    expect(res.status).toBe(200);
    // Thumbnail fetched from {key}_thumb.jpg.
    expect(s3.getObjectBuffer).toHaveBeenCalledWith('mms-inbound/acc-1/r5_0.mp4_thumb.jpg');
    const json = JSON.parse(smsTextJson(res.text));
    expect(json.attachments[0]).toEqual({
      'content-url': 'https://bucket.s3.us-east-1.amazonaws.com/mms-inbound/acc-1/r5_0.mp4?signed=1',
      'content-type': 'video/mp4',
      preview: {
        'content-type': 'image/jpeg',
        content: Buffer.from('THUMBDATA').toString('base64'),
      },
    });
  });

  it('omits the preview when no thumbnail is stored for a video', async () => {
    s3.keyFromUrl.mockReturnValue('mms-inbound/acc-1/r6_0.mp4');
    s3.getObjectBuffer.mockRejectedValueOnce(new Error('NoSuchKey'));
    messagingService.fetchForAcrobits.mockResolvedValueOnce({
      received: [{
        id: 'r6',
        from_number: '+12085550142',
        body: '',
        created_at: '2026-06-25T12:00:00.000Z',
        media_urls: ['https://bucket.s3.us-east-1.amazonaws.com/mms-inbound/acc-1/r6_0.mp4'],
      }],
      sent: [],
    });

    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'pivottech-abc', password: 'pw' });

    const json = JSON.parse(smsTextJson(res.text));
    expect(json.attachments[0].preview).toBeUndefined();
    expect(json.attachments[0]['content-type']).toBe('video/mp4');
  });

  it('omits the text field and media elements appropriately', async () => {
    messagingService.fetchForAcrobits.mockResolvedValueOnce({
      received: [{
        id: 'r3',
        from_number: '+12085550142',
        body: '',
        created_at: '2026-06-25T12:00:00.000Z',
        media_urls: ['https://external/pic.gif'],
      }],
      sent: [],
    });
    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'pivottech-abc', password: 'pw' });
    const json = JSON.parse(smsTextJson(res.text));
    // No caption → no "text" key; gif type inferred from the URL.
    expect(json).toEqual({
      attachments: [{ 'content-url': 'https://external/pic.gif', 'content-type': 'image/gif' }],
    });
  });

  it('keeps plain SMS as text/plain with the body in sms_text (no change)', async () => {
    messagingService.fetchForAcrobits.mockResolvedValueOnce({
      received: [{
        id: 'r2', from_number: '+12085550142', body: 'hi', created_at: '2026-06-25T12:00:00.000Z',
      }],
      sent: [],
    });
    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'pivottech-abc', password: 'pw' });
    expect(res.text).toContain('<sms_text>hi</sms_text>');
    expect(res.text).toContain('<content_type>text/plain</content_type>');
    expect(res.text).not.toContain('filetransfer');
    expect(res.text).not.toContain('<media_url');
  });

  it('requires authentication', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(null);
    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'nope', password: 'pw' });
    expect(res.status).toBe(403);
    expect(messagingService.fetchForAcrobits).not.toHaveBeenCalled();
  });
});

describe('POST /v1/acrobits/push-token', () => {
  it('reports the push tokens and returns 200 empty body', async () => {
    pushService.registerToken.mockResolvedValueOnce({ id: 'pt-1' });
    const res = await request(app)
      .post('/v1/acrobits/push-token')
      .type('form')
      .send({
        username: 'pivottech-abc',
        password: 'pw',
        selector: 'sel-abc',
        pushTokenIncomingCall: 'voip-tok',
        pushTokenOther: 'msg-tok',
        pushappid_incoming_call: 'io.pivot.calls',
        pushappid_other: 'io.pivot.other',
        platform: 'ios',
        device_id: 'dev-1',
      });

    expect(res.status).toBe(200);
    expect(res.text).toBe('');
    expect(pushService.registerToken).toHaveBeenCalledWith('acc-1', 'ten-1', {
      selector: 'sel-abc',
      pushTokenCalls: 'voip-tok',
      pushTokenOther: 'msg-tok',
      pushAppIdCalls: 'io.pivot.calls',
      pushAppIdOther: 'io.pivot.other',
      deviceId: 'dev-1',
      platform: 'ios',
    });
  });

  it('falls back to pushappid when pushappid_other is absent', async () => {
    pushService.registerToken.mockResolvedValueOnce({ id: 'pt-2' });
    await request(app)
      .post('/v1/acrobits/push-token')
      .type('form')
      .send({
        username: 'pivottech-abc', password: 'pw', selector: 'sel-y', pushappid: 'io.pivot.legacy',
      });
    expect(pushService.registerToken).toHaveBeenCalledWith(
      'acc-1',
      'ten-1',
      expect.objectContaining({ pushAppIdOther: 'io.pivot.legacy' }),
    );
  });

  it('requires authentication', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/v1/acrobits/push-token')
      .type('form')
      .send({ username: 'nope', selector: 'x', pushTokenOther: 't' });
    expect(res.status).toBe(403);
    expect(pushService.registerToken).not.toHaveBeenCalled();
  });
});
