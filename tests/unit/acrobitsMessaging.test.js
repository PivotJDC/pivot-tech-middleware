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
    // SIP identity: both username + authUsername are the gencred (used for
    // REGISTER); the E.164 is caller ID only.
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

  it('includes MMS media in the item XML and presigns our own S3 URLs', async () => {
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
          'https://external/telnyx.jpg',
        ],
      }],
      sent: [],
    });
    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'pivottech-abc', password: 'pw' });

    expect(res.status).toBe(200);
    // Own S3 URL was presigned; external URL passed through.
    expect(res.text).toContain(
      '<media_urls>https://bucket.s3.us-east-1.amazonaws.com/mms-inbound/acc-1/r1_0.jpg?signed=1,https://external/telnyx.jpg</media_urls>',
    );
    expect(res.text).toContain(
      '<media_url>https://bucket.s3.us-east-1.amazonaws.com/mms-inbound/acc-1/r1_0.jpg?signed=1</media_url>',
    );
    expect(res.text).toContain('<media_url>https://external/telnyx.jpg</media_url>');
  });

  it('omits media elements for plain SMS (no media_urls)', async () => {
    messagingService.fetchForAcrobits.mockResolvedValueOnce({
      received: [{
        id: 'r2', from_number: '+12085550142', body: 'hi', created_at: '2026-06-25T12:00:00.000Z',
      }],
      sent: [],
    });
    const res = await request(app)
      .get('/v1/acrobits/fetch')
      .query({ username: 'pivottech-abc', password: 'pw' });
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
