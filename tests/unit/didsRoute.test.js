jest.mock('../../src/integrations/signalwire');

const express = require('express');
const request = require('supertest');
const signalwire = require('../../src/integrations/signalwire');
const didsRouter = require('../../src/routes/v1/dids');
const { errorHandler } = require('../../src/middleware/errorHandler');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/v1/numbers', didsRouter);
  app.use(errorHandler);
  return app;
}

describe('GET /v1/numbers/available', () => {
  const app = buildApp();
  beforeEach(() => jest.clearAllMocks());

  it('returns numbers mapped to { e164, formatted, area_code } (no auth required)', async () => {
    signalwire.searchAvailableNumbers.mockResolvedValueOnce([
      { number: '+12085550100' },
      { number: '+12085550142' },
    ]);

    const res = await request(app).get('/v1/numbers/available?areacode=208');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      numbers: [
        { e164: '+12085550100', formatted: '(208) 555-0100', area_code: '208' },
        { e164: '+12085550142', formatted: '(208) 555-0142', area_code: '208' },
      ],
    });
  });

  it('defaults max_results to 50 and passes it to the integration', async () => {
    signalwire.searchAvailableNumbers.mockResolvedValueOnce([]);

    await request(app).get('/v1/numbers/available?areacode=630');

    expect(signalwire.searchAvailableNumbers).toHaveBeenCalledWith(
      '630',
      expect.objectContaining({ maxResults: 50 }),
    );
  });

  it('forwards contains / starts_with / ends_with and a clamped max_results', async () => {
    signalwire.searchAvailableNumbers.mockResolvedValueOnce([]);

    await request(app).get(
      '/v1/numbers/available?areacode=208&max_results=500&contains=420&starts_with=208&ends_with=99',
    );

    expect(signalwire.searchAvailableNumbers).toHaveBeenCalledWith('208', {
      maxResults: 100, // 500 clamped to the SignalWire ceiling
      contains: '420',
      startsWith: '208',
      endsWith: undefined, // "99" is < 3 digits, dropped as malformed
    });
  });

  it('400s with VALIDATION_ERROR when areacode is missing', async () => {
    const res = await request(app).get('/v1/numbers/available');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', field: 'areacode' });
    expect(signalwire.searchAvailableNumbers).not.toHaveBeenCalled();
  });

  it('400s when areacode is not 3 digits', async () => {
    const res = await request(app).get('/v1/numbers/available?areacode=20');

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(signalwire.searchAvailableNumbers).not.toHaveBeenCalled();
  });

  it('returns an empty list when SignalWire has no matches', async () => {
    signalwire.searchAvailableNumbers.mockResolvedValueOnce([]);

    const res = await request(app).get('/v1/numbers/available?areacode=331');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ numbers: [] });
  });
});
