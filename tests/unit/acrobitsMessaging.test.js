jest.mock('../../src/services/accountService');
jest.mock('../../src/services/messagingService');
jest.mock('../../src/services/pushService');
jest.mock('../../src/utils/crypto');

const express = require('express');
const request = require('supertest');
const accountService = require('../../src/services/accountService');
const messagingService = require('../../src/services/messagingService');
const pushService = require('../../src/services/pushService');
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
  id: 'acc-1', sip_username: 'pivottech-abc', sip_password_hash: 'bcrypt$x', status: 'active',
};

beforeEach(() => {
  jest.clearAllMocks();
  accountService.lookupBySipUsername.mockResolvedValue(ACCOUNT);
  crypto.verifyPassword.mockResolvedValue(true);
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
    // SIP identity split: username = subscriber E.164, authUsername = gencred.
    expect(res.text).toContain('<username>+12085550100</username>');
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
      to: '+12085550142', body: 'Hello',
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
    const res = await request(app)
      .get('/v1/acrobits/send')
      .query({
        username: 'nope', password: 'pw', sms_to: '+1', sms_body: 'hi',
      });
    expect(res.status).toBe(403);
    expect(res.text).toContain('<message>Authentication failed.</message>');
    expect(messagingService.sendMessage).not.toHaveBeenCalled();
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
    expect(res.text).toContain('<received_smss>');
    expect(res.text).toContain('<sms_from>+12085550142</sms_from>');
    expect(res.text).toContain('<sms_id>r1</sms_id>');
    expect(res.text).toContain('<sent_smss>');
    expect(res.text).toContain('<sms_to>+12085550143</sms_to>');
    expect(res.text).toContain('<stream_id>+12085550143</stream_id>');
    expect(messagingService.fetchForAcrobits).toHaveBeenCalledWith('acc-1', 'r0', 's0');
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
  it('registers the push token', async () => {
    pushService.registerToken.mockResolvedValueOnce({ id: 'pt-1' });
    const res = await request(app)
      .post('/v1/acrobits/push-token')
      .type('form')
      .send({
        username: 'pivottech-abc',
        password: 'pw',
        device_token: 'tok-123',
        selector: 'sel',
        app_id: 'io.pivot-tech.dialer',
        platform: 'ios',
        device_id: 'dev-1',
      });

    expect(res.status).toBe(200);
    expect(res.text).toContain('<status>ok</status>');
    expect(pushService.registerToken).toHaveBeenCalledWith('acc-1', {
      deviceToken: 'tok-123',
      selector: 'sel',
      appId: 'io.pivot-tech.dialer',
      platform: 'ios',
      deviceId: 'dev-1',
    });
  });

  it('requires authentication', async () => {
    accountService.lookupBySipUsername.mockResolvedValueOnce(null);
    const res = await request(app)
      .post('/v1/acrobits/push-token')
      .type('form')
      .send({
        username: 'nope', device_token: 'x', app_id: 'a', platform: 'ios',
      });
    expect(res.status).toBe(403);
    expect(pushService.registerToken).not.toHaveBeenCalled();
  });
});
