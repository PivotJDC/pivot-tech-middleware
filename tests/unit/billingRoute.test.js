jest.mock('../../src/services/billingExportService');

// adminAuth: a controllable double (real enforcement is covered in
// adminAuth.test.js). Default = allow; tests flip it to deny. verifyAdminToken
// is used by the owner-or-admin guard.
const mockAdminAuth = jest.fn((req, res, next) => { req.admin = { id: 'admin-1' }; next(); });
const mockVerifyAdminToken = jest.fn();
jest.mock('../../src/middleware/adminAuth', () => ({
  adminAuth: (req, res, next) => mockAdminAuth(req, res, next),
  verifyAdminToken: (...args) => mockVerifyAdminToken(...args),
}));

// token.verifyCustomerToken drives the owner branch of the guard.
const mockVerifyCustomerToken = jest.fn();
jest.mock('../../src/utils/token', () => ({
  verifyCustomerToken: (...args) => mockVerifyCustomerToken(...args),
}));

const express = require('express');
const request = require('supertest');
const billingExportService = require('../../src/services/billingExportService');
const billingRouter = require('../../src/routes/v1/billing');
const { errorHandler, errors } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/billing', billingRouter);
  app.use(errorHandler);
  return app;
}

const app = buildApp();

beforeEach(() => {
  jest.clearAllMocks();
  // Restore default allow behavior after clearAllMocks wipes implementations.
  mockAdminAuth.mockImplementation((req, res, next) => { req.admin = { id: 'admin-1' }; next(); });
});

describe('GET /v1/billing/export (JSON)', () => {
  it('returns the export to an admin', async () => {
    billingExportService.generateMonthlyExport.mockResolvedValueOnce({
      period: '2026-07', recordCount: 2, totalRevenue: 35, records: [],
    });
    const res = await request(app).get('/v1/billing/export?year=2026&month=7');
    expect(res.status).toBe(200);
    expect(res.body.period).toBe('2026-07');
    expect(billingExportService.generateMonthlyExport).toHaveBeenCalledWith(2026, 7);
  });

  it('is admin-only — rejects when adminAuth denies', async () => {
    mockAdminAuth.mockImplementationOnce((req, res, next) => next(errors.forbidden('nope')));
    const res = await request(app).get('/v1/billing/export?year=2026&month=7');
    expect(res.status).toBe(403);
    expect(billingExportService.generateMonthlyExport).not.toHaveBeenCalled();
  });

  it('validates year/month', async () => {
    const res = await request(app).get('/v1/billing/export?year=2026&month=13');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.field).toBe('month');
  });
});

describe('GET /v1/billing/export/csv', () => {
  it('returns a CSV download with the right content-type and filename', async () => {
    billingExportService.exportToCsv.mockResolvedValueOnce('action,external_billing_id\ncreate,');
    const res = await request(app).get('/v1/billing/export/csv?year=2026&month=7');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="mobilitynet-billing-2026-07.csv"',
    );
    expect(res.text).toBe('action,external_billing_id\ncreate,');
    expect(billingExportService.exportToCsv).toHaveBeenCalledWith(2026, 7);
  });

  it('is admin-only', async () => {
    mockAdminAuth.mockImplementationOnce((req, res, next) => next(errors.unauthorized('no')));
    const res = await request(app).get('/v1/billing/export/csv?year=2026&month=7');
    expect(res.status).toBe(401);
    expect(billingExportService.exportToCsv).not.toHaveBeenCalled();
  });
});

describe('GET /v1/billing/:accountId', () => {
  it('returns the summary to the account owner', async () => {
    mockVerifyCustomerToken.mockReturnValueOnce({ sub: 'acc-1' });
    billingExportService.getAccountBillingSummary.mockResolvedValueOnce({
      accountId: 'acc-1', totalCharge: 25,
    });
    const res = await request(app)
      .get('/v1/billing/acc-1?year=2026&month=7')
      .set('Authorization', 'Bearer customer-token');
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe('acc-1');
    expect(billingExportService.getAccountBillingSummary).toHaveBeenCalledWith('acc-1', 2026, 7);
  });

  it('allows an admin to read any account', async () => {
    mockVerifyCustomerToken.mockImplementationOnce(() => { throw new Error('not a customer token'); });
    mockVerifyAdminToken.mockReturnValueOnce({ sub: 'admin-1' });
    billingExportService.getAccountBillingSummary.mockResolvedValueOnce({ accountId: 'acc-9' });
    const res = await request(app)
      .get('/v1/billing/acc-9?year=2026&month=7')
      .set('Authorization', 'Bearer admin-token');
    expect(res.status).toBe(200);
    expect(res.body.accountId).toBe('acc-9');
  });

  it('forbids a customer reading a different account', async () => {
    mockVerifyCustomerToken.mockReturnValueOnce({ sub: 'acc-OTHER' });
    mockVerifyAdminToken.mockImplementationOnce(() => { throw new Error('not admin'); });
    const res = await request(app)
      .get('/v1/billing/acc-1?year=2026&month=7')
      .set('Authorization', 'Bearer customer-token');
    expect(res.status).toBe(403);
    expect(billingExportService.getAccountBillingSummary).not.toHaveBeenCalled();
  });

  it('401s when no token is provided', async () => {
    const res = await request(app).get('/v1/billing/acc-1?year=2026&month=7');
    expect(res.status).toBe(401);
  });

  it('404s when no billing data exists', async () => {
    mockVerifyCustomerToken.mockReturnValueOnce({ sub: 'acc-1' });
    billingExportService.getAccountBillingSummary.mockResolvedValueOnce(null);
    const res = await request(app)
      .get('/v1/billing/acc-1?year=2026&month=7')
      .set('Authorization', 'Bearer customer-token');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});
