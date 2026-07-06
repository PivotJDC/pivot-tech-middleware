jest.mock('../../src/config', () => ({
  aws: { region: 'us-east-1' },
  transcribe: { enabled: true, pollIntervalMs: 0, maxPollAttempts: 3 },
}));
jest.mock('../../src/integrations/transcribe');
jest.mock('../../src/integrations/s3');
jest.mock('../../src/services/voicemailService');
jest.mock('../../src/services/messagingService');
jest.mock('../../src/services/cdrService');
jest.mock('../../src/services/pushService');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const config = require('../../src/config');
const transcribe = require('../../src/integrations/transcribe');
const s3 = require('../../src/integrations/s3');
const voicemailService = require('../../src/services/voicemailService');
const messagingService = require('../../src/services/messagingService');
const cdrService = require('../../src/services/cdrService');
const pushService = require('../../src/services/pushService');
const svc = require('../../src/services/voicemailTranscriptionService');

const ACCOUNT = {
  id: 'a1', tenant_id: 'ten-1', phone_e164: '+12085550100',
};
const VOICEMAIL = { id: 'vm-1', created_at: '2026-07-06T00:00:00.000Z', recording_sid: 'RS1' };

beforeEach(() => {
  jest.clearAllMocks();
  config.transcribe.enabled = true;
  s3.bucket.mockReturnValue('mobilitynet-recordings');
});

describe('process', () => {
  it('transcribes, delivers to Messages (thread + CDR), and pushes a preview', async () => {
    transcribe.startTranscription.mockResolvedValueOnce('vm-vm-1');
    transcribe.getTranscriptionResult.mockResolvedValueOnce({
      status: 'COMPLETED', text: 'Hey Jim, calling about the project.',
    });

    await svc.process({
      voicemail: VOICEMAIL, account: ACCOUNT, from: '+12022762305', s3Key: 'k', durationSeconds: 12,
    });

    expect(transcribe.startTranscription).toHaveBeenCalledWith('k', 'vm-1');
    // Stored on the voicemail row.
    expect(voicemailService.attachTranscription).toHaveBeenCalledWith({
      accountId: 'a1', recordingSid: 'RS1', transcription: 'Hey Jim, calling about the project.',
    });
    // messages table → Acrobits Messages tab, threaded with the caller.
    expect(messagingService.recordInboundMessage).toHaveBeenCalledWith({
      accountId: 'a1',
      from: '+12022762305',
      to: '+12085550100',
      body: '🎙️ Voicemail (12s): Hey Jim, calling about the project.',
      createdAt: '2026-07-06T00:00:00.000Z',
    });
    // message_records CDR with message_type=voicemail.
    expect(cdrService.recordVoicemail).toHaveBeenCalledWith({
      messageId: 'vm-1',
      accountId: 'a1',
      tenantId: 'ten-1',
      from: '+12022762305',
      to: '+12085550100',
      createdAt: '2026-07-06T00:00:00.000Z',
    });
    // Push with the transcription preview + formatted caller.
    expect(pushService.sendMessagePush).toHaveBeenCalledWith('a1', expect.objectContaining({
      from: '+12022762305',
      body: 'Voicemail from (202) 276-2305: Hey Jim, calling about the project.',
      messageId: 'vm-1',
      streamId: '+12022762305',
    }));
  });

  it('polls until COMPLETED (retries while IN_PROGRESS)', async () => {
    transcribe.startTranscription.mockResolvedValueOnce('vm-vm-1');
    transcribe.getTranscriptionResult
      .mockResolvedValueOnce({ status: 'IN_PROGRESS', text: null })
      .mockResolvedValueOnce({ status: 'COMPLETED', text: 'done' });
    await svc.process({
      voicemail: VOICEMAIL, account: ACCOUNT, from: '+1', s3Key: 'k', durationSeconds: 3,
    });
    expect(transcribe.getTranscriptionResult).toHaveBeenCalledTimes(2);
    expect(messagingService.recordInboundMessage).toHaveBeenCalled();
  });

  it('a FAILED job → no delivery, but still pushes a basic notification', async () => {
    transcribe.startTranscription.mockResolvedValueOnce('vm-vm-1');
    transcribe.getTranscriptionResult.mockResolvedValueOnce({ status: 'FAILED', text: null });
    await svc.process({
      voicemail: VOICEMAIL, account: ACCOUNT, from: '+1', s3Key: 'k', durationSeconds: 7,
    });
    expect(messagingService.recordInboundMessage).not.toHaveBeenCalled();
    expect(cdrService.recordVoicemail).not.toHaveBeenCalled();
    expect(pushService.sendMessagePush).toHaveBeenCalledWith('a1', expect.objectContaining({
      body: 'New voicemail (7s)',
    }));
  });

  it('when transcription is disabled: no transcribe call, just a basic push', async () => {
    config.transcribe.enabled = false;
    await svc.process({
      voicemail: VOICEMAIL, account: ACCOUNT, from: '+1', s3Key: 'k', durationSeconds: 4,
    });
    expect(transcribe.startTranscription).not.toHaveBeenCalled();
    expect(messagingService.recordInboundMessage).not.toHaveBeenCalled();
    expect(pushService.sendMessagePush).toHaveBeenCalledWith('a1', expect.objectContaining({
      body: 'New voicemail (4s)',
    }));
  });

  it('never throws when transcription errors — still pushes', async () => {
    transcribe.startTranscription.mockRejectedValueOnce(new Error('aws down'));
    await expect(svc.process({
      voicemail: VOICEMAIL, account: ACCOUNT, from: '+1', s3Key: 'k', durationSeconds: 2,
    })).resolves.toBeUndefined();
    expect(pushService.sendMessagePush).toHaveBeenCalled();
  });
});
