const mockSend = jest.fn();
jest.mock('@aws-sdk/client-transcribe', () => ({
  TranscribeClient: jest.fn(() => ({ send: mockSend })),
  StartTranscriptionJobCommand: jest.fn((input) => ({ Start: input })),
  GetTranscriptionJobCommand: jest.fn((input) => ({ Get: input })),
}));
jest.mock('../../src/integrations/s3');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const s3 = require('../../src/integrations/s3');
const transcribe = require('../../src/integrations/transcribe');

beforeEach(() => {
  jest.clearAllMocks();
  s3.bucket.mockReturnValue('mobilitynet-recordings');
});

describe('startTranscription', () => {
  it('starts a job pointing input+output at our bucket, en-US, wav', async () => {
    mockSend.mockResolvedValueOnce({});
    const jobName = await transcribe.startTranscription('voicemails/a1/vm-1.wav', 'vm-1');
    expect(jobName).toBe('vm-vm-1');
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.Start.TranscriptionJobName).toBe('vm-vm-1');
    expect(cmd.Start.LanguageCode).toBe('en-US');
    expect(cmd.Start.MediaFormat).toBe('wav');
    expect(cmd.Start.Media.MediaFileUri).toBe('s3://mobilitynet-recordings/voicemails/a1/vm-1.wav');
    expect(cmd.Start.OutputBucketName).toBe('mobilitynet-recordings');
    expect(cmd.Start.OutputKey).toBe('transcripts/vm-1.json');
  });
});

describe('getTranscriptionResult', () => {
  it('returns null text while the job is not COMPLETED', async () => {
    mockSend.mockResolvedValueOnce({ TranscriptionJob: { TranscriptionJobStatus: 'IN_PROGRESS' } });
    const r = await transcribe.getTranscriptionResult('vm-vm-1');
    expect(r).toEqual({ status: 'IN_PROGRESS', text: null });
    expect(s3.getObjectText).not.toHaveBeenCalled();
  });

  it('reads + parses the transcript from S3 when COMPLETED', async () => {
    mockSend.mockResolvedValueOnce({ TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED' } });
    s3.getObjectText.mockResolvedValueOnce(JSON.stringify({
      results: { transcripts: [{ transcript: 'Hey Jim, call me back.' }] },
    }));
    const r = await transcribe.getTranscriptionResult('vm-vm-1');
    expect(s3.getObjectText).toHaveBeenCalledWith('transcripts/vm-1.json');
    expect(r).toEqual({ status: 'COMPLETED', text: 'Hey Jim, call me back.' });
  });

  it('returns empty text (never throws) on a malformed transcript', async () => {
    mockSend.mockResolvedValueOnce({ TranscriptionJob: { TranscriptionJobStatus: 'COMPLETED' } });
    s3.getObjectText.mockResolvedValueOnce('not json');
    const r = await transcribe.getTranscriptionResult('vm-vm-1');
    expect(r).toEqual({ status: 'COMPLETED', text: '' });
  });
});
