jest.mock('../../src/config', () => ({
  partner: { keys: { fox: 'fox-key', confluence: 'conf-key' } },
}));
jest.mock('../../src/services/accountService');
jest.mock('../../src/services/billingMigrationService');
jest.mock('../../src/utils/logger', () => ({
  logger: {
    info: () => {}, warn: () => {}, error: () => {},
  },
  REDACT_PATHS: [],
}));

const express = require('express');
const request = require('supertest');
const accountService = require('../../src/services/accountService');
const billingMigration = require('../../src/services/billingMigrationService');
const partnerRouter = require('../../src/routes/v1/partner');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/v1/partner', partnerRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

beforeEach(() => jest.clearAllMocks());

describe('POST /v1/partner/link', () => {
  it('links a broadband subscriber (pending migration)', async () => {
    accountService.findByEmailOrPhone.mockResolvedValueOnce({ id: 'acc-1' });
    billingMigration.initiateMigration.mockResolvedValueOnce({ id: 'mig-1', status: 'pending' });

    const res = await request(app).post('/v1/partner/link').send({
      partner_key: 'fox-key',
      broadband_provider: 'fox',
      broadband_account_id: 'fox-99',
      mobilitynet_email_or_phone: 'jane@example.com',
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ migration_id: 'mig-1', status: 'pending', account_id: 'acc-1' });
    expect(billingMigration.initiateMigration).toHaveBeenCalledWith('acc-1', expect.objectContaining({
      toProvider: 'gaiia', broadbandProvider: 'fox', broadbandAccountId: 'fox-99',
    }));
    expect(billingMigration.completeMigration).not.toHaveBeenCalled();
  });

  it('completes immediately when effective_immediately is true', async () => {
    accountService.findByEmailOrPhone.mockResolvedValueOnce({ id: 'acc-1' });
    billingMigration.initiateMigration.mockResolvedValueOnce({ id: 'mig-1', status: 'pending' });
    billingMigration.completeMigration.mockResolvedValueOnce({ id: 'mig-1', status: 'completed' });

    const res = await request(app).post('/v1/partner/link').send({
      partner_key: 'fox-key',
      broadband_provider: 'fox',
      broadband_account_id: 'fox-99',
      mobilitynet_email_or_phone: '+12085550100',
      effective_immediately: true,
    });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('completed');
    expect(billingMigration.completeMigration).toHaveBeenCalledWith('mig-1');
  });

  it('rejects an invalid partner key (401)', async () => {
    const res = await request(app).post('/v1/partner/link').send({
      partner_key: 'wrong',
      broadband_provider: 'fox',
      broadband_account_id: 'fox-99',
      mobilitynet_email_or_phone: 'jane@example.com',
    });
    expect(res.status).toBe(401);
    expect(accountService.findByEmailOrPhone).not.toHaveBeenCalled();
  });

  it('404s when no MobilityNet account matches', async () => {
    accountService.findByEmailOrPhone.mockResolvedValueOnce(null);
    const res = await request(app).post('/v1/partner/link').send({
      partner_key: 'fox-key',
      broadband_provider: 'fox',
      broadband_account_id: 'fox-99',
      mobilitynet_email_or_phone: 'ghost@example.com',
    });
    expect(res.status).toBe(404);
    expect(billingMigration.initiateMigration).not.toHaveBeenCalled();
  });
});

describe('POST /v1/partner/unlink', () => {
  it('reverses the active migration', async () => {
    billingMigration.findMigrationByBroadband.mockResolvedValueOnce({ id: 'mig-1' });
    billingMigration.reverseMigration.mockResolvedValueOnce({ id: 'mig-1', status: 'reversed' });

    const res = await request(app).post('/v1/partner/unlink').send({
      partner_key: 'conf-key',
      broadband_provider: 'confluence',
      broadband_account_id: 'conf-7',
      reason: 'fiber cancelled',
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ migration_id: 'mig-1', status: 'reversed' });
    expect(billingMigration.reverseMigration).toHaveBeenCalledWith('mig-1', 'fiber cancelled');
  });

  it('404s when there is no migration to reverse', async () => {
    billingMigration.findMigrationByBroadband.mockResolvedValueOnce(null);
    const res = await request(app).post('/v1/partner/unlink').send({
      partner_key: 'fox-key', broadband_provider: 'fox', broadband_account_id: 'nope',
    });
    expect(res.status).toBe(404);
    expect(billingMigration.reverseMigration).not.toHaveBeenCalled();
  });

  it('rejects an invalid partner key (401)', async () => {
    const res = await request(app).post('/v1/partner/unlink').send({
      partner_key: 'bad', broadband_provider: 'fox', broadband_account_id: 'fox-99',
    });
    expect(res.status).toBe(401);
    expect(billingMigration.findMigrationByBroadband).not.toHaveBeenCalled();
  });
});

describe('GET /v1/partner/status', () => {
  it('returns the linked account status and migration history', async () => {
    billingMigration.findMigrationByBroadband.mockResolvedValueOnce({ id: 'mig-1', account_id: 'acc-1' });
    accountService.getAccountById.mockResolvedValueOnce({
      id: 'acc-1',
      status: 'active',
      phone_e164: '+12085550100',
      external_billing_provider: 'gaiia',
      broadband_provider: 'fox',
      broadband_account_id: 'fox-99',
    });
    billingMigration.getMigrationHistory.mockResolvedValueOnce([{ id: 'mig-1' }]);

    const res = await request(app)
      .get('/v1/partner/status')
      .query({ partner_key: 'fox-key', broadband_provider: 'fox', broadband_account_id: 'fox-99' });

    expect(res.status).toBe(200);
    expect(res.body.account).toMatchObject({ id: 'acc-1', external_billing_provider: 'gaiia' });
    expect(res.body.migrations).toHaveLength(1);
  });

  it('rejects an invalid partner key (401)', async () => {
    const res = await request(app)
      .get('/v1/partner/status')
      .query({ partner_key: 'bad', broadband_provider: 'fox', broadband_account_id: 'fox-99' });
    expect(res.status).toBe(401);
    expect(billingMigration.findMigrationByBroadband).not.toHaveBeenCalled();
  });
});
