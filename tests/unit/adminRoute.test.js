// adminAuth is exercised in adminAuth.test.js; here we stub it to a pass-through
// so we can test the route wiring + handlers in isolation.
jest.mock('../../src/middleware/adminAuth', () => ({
  adminAuth: (req, res, next) => { req.admin = { id: 'admin-1', role: 'super_admin' }; next(); },
  requireRole: () => (req, res, next) => next(),
  verifyAdminToken: jest.fn(),
  isIpAllowed: jest.fn(),
}));
jest.mock('../../src/services/adminService');
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/provisioningService');
jest.mock('../../src/services/adminUserService');
jest.mock('../../src/services/cdrService');
jest.mock('../../src/services/usageService');
jest.mock('../../src/services/voicemailService');
jest.mock('../../src/integrations/s3');

const express = require('express');
const request = require('supertest');
const adminService = require('../../src/services/adminService');
const accountService = require('../../src/services/accountService');
const provisioningService = require('../../src/services/provisioningService');
const cdrService = require('../../src/services/cdrService');
const usageService = require('../../src/services/usageService');
const voicemailService = require('../../src/services/voicemailService');
const s3 = require('../../src/integrations/s3');
const adminRouter = require('../../src/routes/admin');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/admin', adminRouter);
  app.use(errorHandler);
  return app;
}

describe('admin API', () => {
  const app = buildApp();
  beforeEach(() => jest.clearAllMocks());

  it('GET /admin/accounts lists accounts', async () => {
    adminService.listAccounts.mockResolvedValueOnce({ accounts: [{ id: 'a1' }], pagination: { total: 1 } });
    const res = await request(app).get('/admin/accounts?status=active&market=lewiston-id');
    expect(res.status).toBe(200);
    expect(res.body.accounts).toHaveLength(1);
    expect(adminService.listAccounts).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'active', market: 'lewiston-id' }),
    );
  });

  it('GET /admin/accounts/:id returns detail', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', status: 'active' });
    const res = await request(app).get('/admin/accounts/a1');
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('a1');
  });

  it('GET /admin/accounts/:id/history returns calls + messages', async () => {
    cdrService.getCallHistory.mockResolvedValueOnce([{ id: 'cr-1' }]);
    cdrService.getMessageHistory.mockResolvedValueOnce([{ id: 'mr-1' }]);
    const res = await request(app).get('/admin/accounts/a1/history?limit=10&offset=0');
    expect(res.status).toBe(200);
    expect(res.body.calls).toEqual([{ id: 'cr-1' }]);
    expect(res.body.messages).toEqual([{ id: 'mr-1' }]);
    expect(cdrService.getCallHistory).toHaveBeenCalledWith('a1', { limit: '10', offset: '0' }, null);
  });

  it('GET /admin/accounts/:id/usage returns usage stats', async () => {
    adminService.getAccountUsageStats.mockResolvedValueOnce({
      data_used_mb: 12400, data_cap_mb: 30720, voice_minutes: 47, sms_count: 23, mms_count: 2,
    });
    const res = await request(app).get('/admin/accounts/a1/usage');
    expect(res.status).toBe(200);
    expect(res.body.voice_minutes).toBe(47);
    expect(adminService.getAccountUsageStats).toHaveBeenCalledWith('a1', null);
  });

  it('PATCH /admin/accounts/:id/status forces a status change', async () => {
    accountService.transitionStatus.mockResolvedValueOnce({ id: 'a1', status: 'suspended' });
    const res = await request(app)
      .patch('/admin/accounts/a1/status')
      .send({ status: 'suspended', reason: 'fraud review' });
    expect(res.status).toBe(200);
    expect(accountService.transitionStatus).toHaveBeenCalledWith('a1', 'suspended');
    expect(res.body.status).toBe('suspended');
  });

  it('PATCH /admin/accounts/:id/status requires a status', async () => {
    const res = await request(app).patch('/admin/accounts/a1/status').send({});
    expect(res.status).toBe(400);
    expect(accountService.transitionStatus).not.toHaveBeenCalled();
  });

  it('PATCH /admin/accounts/:id with action=retry_bics re-runs eSIM provisioning', async () => {
    accountService.retryBicsProvisioning.mockResolvedValueOnce({
      id: 'a1', bics_provisioned: true, esim: { iccid: 'icc-1', endpointId: 'ep-1' },
    });
    const res = await request(app)
      .patch('/admin/accounts/a1')
      .send({ action: 'retry_bics' });
    expect(res.status).toBe(200);
    expect(accountService.retryBicsProvisioning).toHaveBeenCalledWith('a1');
    expect(res.body.esim.iccid).toBe('icc-1');
  });

  it('PATCH /admin/accounts/:id action=activate transitions a pending account to active', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', status: 'pending' });
    accountService.transitionStatus.mockResolvedValueOnce({ id: 'a1', status: 'active' });
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'activate' });
    expect(res.status).toBe(200);
    expect(accountService.transitionStatus).toHaveBeenCalledWith('a1', 'active');
    expect(res.body.status).toBe('active');
  });

  it('PATCH /admin/accounts/:id action=activate is rejected when not pending', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', status: 'active' });
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'activate' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('action');
    expect(accountService.transitionStatus).not.toHaveBeenCalled();
  });

  it('PATCH /admin/accounts/:id action=suspend transitions to suspended', async () => {
    accountService.transitionStatus.mockResolvedValueOnce({ id: 'a1', status: 'suspended' });
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'suspend' });
    expect(res.status).toBe(200);
    expect(accountService.transitionStatus).toHaveBeenCalledWith('a1', 'suspended');
    // suspend does not pre-fetch the account.
    expect(accountService.getAccountById).not.toHaveBeenCalled();
  });

  it('PATCH /admin/accounts/:id action=cancel transitions to cancelled', async () => {
    accountService.transitionStatus.mockResolvedValueOnce({ id: 'a1', status: 'cancelled' });
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'cancel' });
    expect(res.status).toBe(200);
    expect(accountService.transitionStatus).toHaveBeenCalledWith('a1', 'cancelled');
  });

  it('PATCH /admin/accounts/:id action=update_sip updates the SIP credentials', async () => {
    accountService.updateAccount.mockResolvedValueOnce({
      id: 'a1', sip_username: 'pivottech-new', sip_endpoint_id: 'ep-new',
    });
    const res = await request(app)
      .patch('/admin/accounts/a1')
      .send({ action: 'update_sip', sip_username: 'pivottech-new', sip_endpoint_id: 'ep-new' });
    expect(res.status).toBe(200);
    expect(accountService.updateAccount).toHaveBeenCalledWith('a1', {
      sip_username: 'pivottech-new', sip_endpoint_id: 'ep-new',
    });
    expect(res.body.sip_username).toBe('pivottech-new');
  });

  it('PATCH /admin/accounts/:id action=update_sip requires at least one SIP field', async () => {
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'update_sip' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('sip_username');
    expect(accountService.updateAccount).not.toHaveBeenCalled();
  });

  it('POST /admin/accounts/:id/update-profile updates name + email', async () => {
    accountService.updateAccount.mockResolvedValueOnce({
      id: 'a1', first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com',
    });
    const res = await request(app)
      .post('/admin/accounts/a1/update-profile')
      .send({ first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' });
    expect(res.status).toBe(200);
    expect(accountService.updateAccount).toHaveBeenCalledWith('a1', {
      first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com',
    });
    expect(res.body.first_name).toBe('Jane');
  });

  it('POST /admin/accounts/:id/update-profile allows a partial update', async () => {
    accountService.updateAccount.mockResolvedValueOnce({ id: 'a1', first_name: 'Jane' });
    const res = await request(app)
      .post('/admin/accounts/a1/update-profile')
      .send({ first_name: 'Jane' });
    expect(res.status).toBe(200);
    expect(accountService.updateAccount).toHaveBeenCalledWith('a1', {
      first_name: 'Jane', last_name: undefined, email: undefined,
    });
  });

  it('POST /admin/accounts/:id/update-profile requires at least one field', async () => {
    const res = await request(app).post('/admin/accounts/a1/update-profile').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('first_name');
    expect(accountService.updateAccount).not.toHaveBeenCalled();
  });

  it('PATCH /admin/accounts/:id/profile updates name, email, and address', async () => {
    accountService.updateAccount.mockResolvedValueOnce({
      id: 'a1', first_name: 'Jane', city: 'Lewiston', state: 'ID',
    });
    const res = await request(app)
      .patch('/admin/accounts/a1/profile')
      .send({
        first_name: 'Jane',
        last_name: 'Doe',
        email: 'jane@example.com',
        address_line1: '1 Main St',
        address_line2: 'Apt 2',
        city: 'Lewiston',
        state: 'ID',
        zip: '83501',
        phone_alt: '+12085550111',
      });
    expect(res.status).toBe(200);
    expect(accountService.updateAccount).toHaveBeenCalledWith('a1', {
      first_name: 'Jane',
      last_name: 'Doe',
      email: 'jane@example.com',
      address_line1: '1 Main St',
      address_line2: 'Apt 2',
      city: 'Lewiston',
      state: 'ID',
      zip: '83501',
      phone_alt: '+12085550111',
    });
    expect(res.body.city).toBe('Lewiston');
  });

  it('PATCH /admin/accounts/:id/profile passes only the fields provided', async () => {
    accountService.updateAccount.mockResolvedValueOnce({ id: 'a1', phone_alt: '+12085550111' });
    const res = await request(app)
      .patch('/admin/accounts/a1/profile')
      .send({ phone_alt: '+12085550111' });
    expect(res.status).toBe(200);
    expect(accountService.updateAccount).toHaveBeenCalledWith('a1', { phone_alt: '+12085550111' });
  });

  it('PATCH /admin/accounts/:id/profile requires at least one field', async () => {
    const res = await request(app).patch('/admin/accounts/a1/profile').send({});
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('first_name');
    expect(accountService.updateAccount).not.toHaveBeenCalled();
  });

  it('GET /admin/accounts/:id/port-pin returns the PIN for CSR support', async () => {
    accountService.getPortPin.mockResolvedValueOnce({ port_out_pin: '654321' });
    const res = await request(app).get('/admin/accounts/a1/port-pin');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ port_out_pin: '654321' });
    expect(accountService.getPortPin).toHaveBeenCalledWith('a1');
  });

  it('GET /admin/accounts/:id/provisioning-qr returns the dialer QR', async () => {
    accountService.getAccountById.mockResolvedValueOnce({ id: 'a1', sip_username: 'pivottech-abc' });
    provisioningService.buildProvisioningQr.mockResolvedValueOnce({
      qr_url: 'data:image/png;base64,AAA',
      provisioning_url: 'cloudsoftphone://Pivot-Tech?username=pivottech-abc&password=pw',
    });
    const res = await request(app).get('/admin/accounts/a1/provisioning-qr');
    expect(res.status).toBe(200);
    expect(res.body.qr_url).toMatch(/^data:image\/png;base64,/);
    expect(provisioningService.buildProvisioningQr).toHaveBeenCalledWith(
      expect.objectContaining({ sip_username: 'pivottech-abc' }),
    );
  });

  it('DELETE /admin/accounts/:id hard-deletes with the confirm header', async () => {
    accountService.deleteAccount.mockResolvedValueOnce({ deleted: true });
    const res = await request(app)
      .delete('/admin/accounts/a1')
      .set('X-Confirm-Delete', 'true');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true });
    expect(accountService.deleteAccount).toHaveBeenCalledWith('a1');
  });

  it('DELETE /admin/accounts/:id requires the X-Confirm-Delete header', async () => {
    const res = await request(app).delete('/admin/accounts/a1');
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('confirm');
    expect(accountService.deleteAccount).not.toHaveBeenCalled();
  });

  it('DELETE /admin/accounts/:id rejects a non-"true" confirm header', async () => {
    const res = await request(app)
      .delete('/admin/accounts/a1')
      .set('X-Confirm-Delete', 'yes');
    expect(res.status).toBe(400);
    expect(accountService.deleteAccount).not.toHaveBeenCalled();
  });

  it('PATCH /admin/accounts/:id rejects an unsupported action', async () => {
    const res = await request(app).patch('/admin/accounts/a1').send({ action: 'nope' });
    expect(res.status).toBe(400);
    expect(res.body.error.field).toBe('action');
    expect(accountService.retryBicsProvisioning).not.toHaveBeenCalled();
  });

  it('POST /admin/accounts/:id/provision/reissue returns a new token', async () => {
    provisioningService.reissueToken.mockResolvedValueOnce({ raw_token: 'rt', provisioning_url: 'u' });
    const res = await request(app).post('/admin/accounts/a1/provision/reissue').send({});
    expect(res.status).toBe(201);
    expect(provisioningService.reissueToken).toHaveBeenCalledWith('a1');
  });

  it('POST /admin/accounts/:id/refresh-sip-credentials rotates + returns new creds', async () => {
    accountService.refreshSipCredentials.mockResolvedValueOnce({
      sip_username: 'pivottech-new', sip_password: 'plaintext-new', updated: true,
    });
    const res = await request(app).post('/admin/accounts/a1/refresh-sip-credentials').send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      sip_username: 'pivottech-new', sip_password: 'plaintext-new', updated: true,
    });
    expect(accountService.refreshSipCredentials).toHaveBeenCalledWith('a1');
  });

  it('POST /admin/accounts/:id/esim-qr returns a QR (default show)', async () => {
    accountService.getEsimQr.mockResolvedValueOnce({
      qr_code_url: 'data:image/png;base64,AAA', iccid: 'icc-1', endpoint_id: 'ep-1',
    });
    const res = await request(app).post('/admin/accounts/a1/esim-qr').send({});
    expect(res.status).toBe(200);
    expect(res.body.qr_code_url).toMatch(/^data:image\/png/);
    expect(accountService.getEsimQr).toHaveBeenCalledWith('a1', { regenerate: false });
  });

  it('POST /admin/accounts/:id/esim-qr passes regenerate through', async () => {
    accountService.getEsimQr.mockResolvedValueOnce({
      qr_code_url: 'data:image/png;base64,BBB', iccid: 'icc-2', endpoint_id: 'ep-2',
    });
    const res = await request(app).post('/admin/accounts/a1/esim-qr').send({ regenerate: true });
    expect(res.status).toBe(200);
    expect(accountService.getEsimQr).toHaveBeenCalledWith('a1', { regenerate: true });
  });

  it('GET /admin/accounts/:id/voicemails lists voicemails', async () => {
    voicemailService.getVoicemails.mockResolvedValueOnce([{ id: 'vm-1' }]);
    const res = await request(app).get('/admin/accounts/a1/voicemails?limit=10');
    expect(res.status).toBe(200);
    expect(res.body.voicemails).toEqual([{ id: 'vm-1' }]);
    expect(voicemailService.getVoicemails).toHaveBeenCalledWith(
      'a1',
      { limit: '10', offset: undefined },
      null, // tenantScope: super_admin sees all
    );
  });

  it('PATCH /admin/voicemails/:id/read marks a voicemail read', async () => {
    voicemailService.markAsRead.mockResolvedValueOnce({ id: 'vm-1', is_read: true });
    const res = await request(app).patch('/admin/voicemails/vm-1/read').send({});
    expect(res.status).toBe(200);
    expect(res.body.is_read).toBe(true);
  });

  it('PATCH /admin/voicemails/:id/read 404s when missing', async () => {
    voicemailService.markAsRead.mockResolvedValueOnce(null);
    const res = await request(app).patch('/admin/voicemails/vm-x/read').send({});
    expect(res.status).toBe(404);
  });

  it('DELETE /admin/voicemails/:id deletes a voicemail', async () => {
    voicemailService.deleteVoicemail.mockResolvedValueOnce({ deleted: true, id: 'vm-1' });
    const res = await request(app).delete('/admin/voicemails/vm-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deleted: true, id: 'vm-1' });
  });

  it('GET /admin/voicemails/:id/recording returns a signed URL (?format=json)', async () => {
    voicemailService.getById.mockResolvedValueOnce({ id: 'vm-1', recording_s3_key: 'k' });
    s3.signedUrlForVoicemail.mockResolvedValueOnce('https://signed.example/x');
    const res = await request(app).get('/admin/voicemails/vm-1/recording?format=json');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: 'https://signed.example/x' });
  });

  it('GET /admin/voicemails/:id/recording 404s when missing', async () => {
    voicemailService.getById.mockResolvedValueOnce(null);
    const res = await request(app).get('/admin/voicemails/vm-x/recording?format=json');
    expect(res.status).toBe(404);
  });

  it('GET /admin/dids lists inventory', async () => {
    adminService.listDids.mockResolvedValueOnce({ dids: [], pagination: {} });
    const res = await request(app).get('/admin/dids?market=lewiston-id&area_code=208');
    expect(res.status).toBe(200);
    expect(adminService.listDids).toHaveBeenCalledWith(
      expect.objectContaining({ market: 'lewiston-id', area_code: '208' }),
    );
  });

  it('GET /admin/ports lists port requests', async () => {
    adminService.listPorts.mockResolvedValueOnce({ ports: [], pagination: {} });
    const res = await request(app).get('/admin/ports?status=failed');
    expect(res.status).toBe(200);
  });

  it('POST /admin/ports/:id/retry resubmits a port', async () => {
    adminService.retryPort.mockResolvedValueOnce({ id: 'p1', status: 'submitted' });
    const res = await request(app).post('/admin/ports/p1/retry').send({});
    expect(res.status).toBe(200);
    expect(adminService.retryPort).toHaveBeenCalledWith('p1');
  });

  it('GET /admin/metrics returns metrics', async () => {
    adminService.getMetrics.mockResolvedValueOnce({ accounts: {}, ports: {}, dids: {} });
    const res = await request(app).get('/admin/metrics');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('accounts');
  });

  it('GET /admin/usage/summary returns the current-period summary', async () => {
    usageService.getCurrentPeriodSummary.mockResolvedValueOnce({
      totalAccounts: 3, totalDataMb: 900,
    });
    const res = await request(app).get('/admin/usage/summary');
    expect(res.status).toBe(200);
    expect(res.body.totalAccounts).toBe(3);
    expect(usageService.getCurrentPeriodSummary).toHaveBeenCalled();
  });

  it('POST /admin/usage/poll triggers a poll and returns the summary', async () => {
    usageService.pollAllActiveAccounts.mockResolvedValueOnce({
      polled: 5, succeeded: 5, failed: 0,
    });
    const res = await request(app).post('/admin/usage/poll');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ polled: 5, succeeded: 5, failed: 0 });
    expect(usageService.pollAllActiveAccounts).toHaveBeenCalled();
  });

  it('GET /admin/analytics/hourly-activity returns the hourly series', async () => {
    adminService.getHourlyActivity.mockResolvedValueOnce([
      { hour: 0, calls: 2, messages: 5 },
    ]);
    const res = await request(app).get('/admin/analytics/hourly-activity');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ hour: 0, calls: 2, messages: 5 }]);
    expect(adminService.getHourlyActivity).toHaveBeenCalled();
  });

  it('GET /admin/analytics/usage-distribution returns the bucket counts', async () => {
    adminService.getUsageDistribution.mockResolvedValueOnce([
      { bucket: '0-1 GB', count: 42 },
    ]);
    const res = await request(app).get('/admin/analytics/usage-distribution');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ bucket: '0-1 GB', count: 42 });
    expect(adminService.getUsageDistribution).toHaveBeenCalled();
  });

  it('GET /admin/analytics/hourly-data-voice returns the voice/call series', async () => {
    adminService.getHourlyDataVoice.mockResolvedValueOnce([
      { hour: 9, voice_minutes: 12, call_count: 4 },
    ]);
    const res = await request(app).get('/admin/analytics/hourly-data-voice');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ hour: 9, voice_minutes: 12, call_count: 4 });
    expect(adminService.getHourlyDataVoice).toHaveBeenCalled();
  });

  it('GET /admin/analytics/hourly-messages returns the sent/received series', async () => {
    adminService.getHourlyMessages.mockResolvedValueOnce([
      { hour: 10, sent: 7, received: 3 },
    ]);
    const res = await request(app).get('/admin/analytics/hourly-messages');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ hour: 10, sent: 7, received: 3 });
    expect(adminService.getHourlyMessages).toHaveBeenCalled();
  });

  it('GET /admin/analytics/usage-trends passes a valid period through', async () => {
    adminService.getUsageTrends.mockResolvedValueOnce([{ label: '2026-06-01', total_mb: 45000 }]);
    const res = await request(app).get('/admin/analytics/usage-trends?period=week');
    expect(res.status).toBe(200);
    expect(res.body[0]).toEqual({ label: '2026-06-01', total_mb: 45000 });
    expect(adminService.getUsageTrends).toHaveBeenCalledWith('week', null);
  });

  it('GET /admin/analytics/usage-trends defaults an invalid/absent period to day', async () => {
    adminService.getUsageTrends.mockResolvedValue([]);
    await request(app).get('/admin/analytics/usage-trends');
    await request(app).get('/admin/analytics/usage-trends?period=bogus');
    expect(adminService.getUsageTrends).toHaveBeenNthCalledWith(1, 'day', null);
    expect(adminService.getUsageTrends).toHaveBeenNthCalledWith(2, 'day', null);
  });

  it('GET /admin/analytics/billing-reconciliation returns the report', async () => {
    adminService.getBillingReconciliation.mockResolvedValueOnce({
      period: { from: '2026-07-01', to: '2026-07-31' },
      telnyx: {
        voice_minutes: 120, voice_calls: 40, sms_count: 15, mms_count: 3,
      },
      bics: { data_total_mb: 20480, data_total_gb: 20, estimated_cost: 40 },
    });
    const res = await request(app)
      .get('/admin/analytics/billing-reconciliation?from=2026-07-01&to=2026-07-31');
    expect(res.status).toBe(200);
    expect(res.body.bics.data_total_gb).toBe(20);
    expect(adminService.getBillingReconciliation).toHaveBeenCalledWith('2026-07-01', '2026-07-31', null);
  });

  it('GET /admin/analytics/billing-reconciliation 400s on missing/invalid dates', async () => {
    const res = await request(app).get('/admin/analytics/billing-reconciliation?from=2026-07-01');
    expect(res.status).toBe(400);
    const res2 = await request(app)
      .get('/admin/analytics/billing-reconciliation?from=nope&to=2026-07-31');
    expect(res2.status).toBe(400);
    expect(adminService.getBillingReconciliation).not.toHaveBeenCalled();
  });
});
