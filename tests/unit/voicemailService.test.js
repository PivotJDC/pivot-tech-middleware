jest.mock('../../src/db');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const db = require('../../src/db');
const vm = require('../../src/services/voicemailService');

beforeEach(() => {
  db.query.mockReset();
});

describe('createVoicemail', () => {
  it('inserts with account_id + tenant_id and returns the row', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'vm-1' }] });
    const row = await vm.createVoicemail({
      accountId: 'acc-1',
      tenantId: 'ten-1',
      callerNumber: '+12022762305',
      recordingUrl: 'https://rec/1.mp3',
      recordingSid: 'RS1',
      durationSeconds: 12,
    });
    expect(row).toEqual({ id: 'vm-1' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO voicemails/);
    expect(params).toEqual(['acc-1', 'ten-1', '+12022762305', null, 12, 'https://rec/1.mp3', 'RS1']);
  });
});

describe('getVoicemails', () => {
  it('scopes to the account, clamps the limit, applies offset, newest first', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'vm-1' }] });
    await vm.getVoicemails('acc-1', { limit: '9999', offset: '5' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE account_id = \$1/);
    expect(sql).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual(['acc-1', 200, 5]); // 9999 clamped to 200
  });

  it('adds a tenant filter when a tenantId is supplied', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    await vm.getVoicemails('acc-1', {}, 'ten-1');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/AND tenant_id = \$2/);
    expect(params).toEqual(['acc-1', 'ten-1', 50, 0]);
  });
});

describe('markAsRead', () => {
  it('sets is_read and scopes by account when given', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'vm-1', is_read: true }] });
    const row = await vm.markAsRead('vm-1', { accountId: 'acc-1' });
    expect(row).toEqual({ id: 'vm-1', is_read: true });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE voicemails SET is_read = true WHERE id = \$1 AND account_id = \$2/);
    expect(params).toEqual(['vm-1', 'acc-1']);
  });

  it('returns null when nothing matched (wrong owner)', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await vm.markAsRead('vm-x', { accountId: 'acc-1' })).toBeNull();
  });
});

describe('deleteVoicemail', () => {
  it('deletes (scoped) and reports the id', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'vm-1' }] });
    const result = await vm.deleteVoicemail('vm-1', { tenantId: 'ten-1' });
    expect(result).toEqual({ deleted: true, id: 'vm-1' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/DELETE FROM voicemails WHERE id = \$1 AND tenant_id = \$2/);
    expect(params).toEqual(['vm-1', 'ten-1']);
  });

  it('returns null when nothing was deleted', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await vm.deleteVoicemail('vm-x')).toBeNull();
  });
});

describe('getVoicemailCount', () => {
  it('returns the unread count', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ count: 3 }] });
    expect(await vm.getVoicemailCount('acc-1')).toBe(3);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/COUNT\(\*\)::int AS count FROM voicemails WHERE account_id = \$1 AND is_read = false/);
    expect(params).toEqual(['acc-1']);
  });
});

describe('getById', () => {
  it('fetches a voicemail scoped by account', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'vm-1' }] });
    const row = await vm.getById('vm-1', { accountId: 'acc-1' });
    expect(row).toEqual({ id: 'vm-1' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SELECT \* FROM voicemails WHERE id = \$1 AND account_id = \$2/);
    expect(params).toEqual(['vm-1', 'acc-1']);
  });

  it('returns null when not found', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    expect(await vm.getById('vm-x')).toBeNull();
  });
});

describe('setRecording', () => {
  it('stores the S3 key and recording URL', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'vm-1' }] });
    await vm.setRecording('vm-1', { s3Key: 'voicemails/a/vm-1.wav', recordingUrl: 'https://s3/x' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET\s+recording_s3_key = \$1/);
    expect(sql).toMatch(/recording_url = COALESCE\(\$2, recording_url\)/);
    expect(params).toEqual(['voicemails/a/vm-1.wav', 'https://s3/x', 'vm-1']);
  });
});

describe('setGreeting / clearGreeting', () => {
  it('setGreeting updates the account greeting URL', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] });
    const row = await vm.setGreeting('acc-1', 'https://rec/greet.mp3');
    expect(row).toEqual({ id: 'acc-1' });
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE accounts SET voicemail_greeting_url = \$1 WHERE id = \$2/);
    expect(params).toEqual(['https://rec/greet.mp3', 'acc-1']);
  });

  it('clearGreeting nulls the greeting URL', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'acc-1' }] });
    await vm.clearGreeting('acc-1');
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/SET voicemail_greeting_url = NULL WHERE id = \$1/);
    expect(params).toEqual(['acc-1']);
  });
});

describe('attachTranscription', () => {
  it('matches by recording_sid first', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 'vm-1', transcription: 'hi' }] });
    const row = await vm.attachTranscription({
      accountId: 'acc-1', recordingSid: 'RS1', transcription: 'hi',
    });
    expect(row).toEqual({ id: 'vm-1', transcription: 'hi' });
    expect(db.query.mock.calls[0][0]).toMatch(/WHERE recording_sid = \$2/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('falls back to the account newest voicemail when the sid misses', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [] }) // sid update miss
      .mockResolvedValueOnce({ rows: [{ id: 'vm-2', transcription: 'yo' }] }); // fallback
    const row = await vm.attachTranscription({
      accountId: 'acc-1', recordingSid: 'RS-miss', transcription: 'yo',
    });
    expect(row).toEqual({ id: 'vm-2', transcription: 'yo' });
    expect(db.query.mock.calls[1][0]).toMatch(/ORDER BY created_at DESC LIMIT 1/);
    expect(db.query.mock.calls[1][1]).toEqual(['yo', 'acc-1']);
  });
});
