jest.mock('../../src/db');

const db = require('../../src/db');
const voiceService = require('../../src/services/voiceService');

beforeEach(() => db.query.mockReset());

describe('lookupByCalledNumber', () => {
  it('returns account id, sip username, and status for a known number', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'a1', sip_username: 'pivottech-abc', status: 'active' }],
    });
    const result = await voiceService.lookupByCalledNumber('+12085550100');
    expect(result).toEqual({ account_id: 'a1', sip_username: 'pivottech-abc', status: 'active' });
    expect(db.query.mock.calls[0][1]).toEqual(['+12085550100']);
  });

  it('returns null for an unknown number', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await voiceService.lookupByCalledNumber('+19999999999')).toBeNull();
  });

  it('returns null without querying when no number is given', async () => {
    expect(await voiceService.lookupByCalledNumber('')).toBeNull();
    expect(db.query).not.toHaveBeenCalled();
  });
});
