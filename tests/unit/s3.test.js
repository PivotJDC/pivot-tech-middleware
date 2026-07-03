const mockSend = jest.fn();
jest.mock('@aws-sdk/client-s3', () => ({
  S3Client: jest.fn(() => ({ send: mockSend })),
  PutObjectCommand: jest.fn((input) => ({ Put: input })),
  GetObjectCommand: jest.fn((input) => ({ Get: input })),
}));
const mockGetSignedUrl = jest.fn();
jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args) => mockGetSignedUrl(...args),
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const s3 = require('../../src/integrations/s3');

beforeEach(() => {
  mockSend.mockReset();
  mockGetSignedUrl.mockReset();
  global.fetch = jest.fn();
});
afterAll(() => {
  delete global.fetch;
});

describe('archiveRecording', () => {
  it('downloads the source and uploads it to the recordings bucket', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'audio/wav' },
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    mockSend.mockResolvedValueOnce({});

    const r = await s3.archiveRecording({
      key: 'voicemails/acc-1/vm-1.wav',
      sourceUrl: 'https://telnyx.example/rec',
    });
    expect(r).toEqual({ key: 'voicemails/acc-1/vm-1.wav' });
    expect(global.fetch).toHaveBeenCalledWith('https://telnyx.example/rec');
    const cmd = mockSend.mock.calls[0][0];
    expect(cmd.Put.Bucket).toBe('mobilitynet-recordings');
    expect(cmd.Put.Key).toBe('voicemails/acc-1/vm-1.wav');
    expect(cmd.Put.ContentType).toBe('audio/wav');
  });

  it('throws (and never uploads) when the download fails', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
    await expect(s3.archiveRecording({ key: 'k', sourceUrl: 'https://x' }))
      .rejects.toThrow(/download/);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('signed URLs', () => {
  it('getSignedRecordingUrl presigns a GetObject with a 1h default expiry', async () => {
    mockGetSignedUrl.mockResolvedValueOnce('https://signed.example/x');
    const url = await s3.getSignedRecordingUrl('voicemails/a/v.wav');
    expect(url).toBe('https://signed.example/x');
    const [, cmd, opts] = mockGetSignedUrl.mock.calls[0];
    expect(cmd.Get.Bucket).toBe('mobilitynet-recordings');
    expect(cmd.Get.Key).toBe('voicemails/a/v.wav');
    expect(opts).toEqual({ expiresIn: 3600 });
  });

  it('signedUrlForVoicemail signs the S3 key when present', async () => {
    mockGetSignedUrl.mockResolvedValueOnce('https://signed.example/x');
    expect(await s3.signedUrlForVoicemail({ recording_s3_key: 'k' })).toBe('https://signed.example/x');
  });

  it('signedUrlForVoicemail falls back to recording_url when there is no key', async () => {
    expect(await s3.signedUrlForVoicemail({ recording_url: 'https://telnyx/rec' }))
      .toBe('https://telnyx/rec');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});

describe('objectUrl', () => {
  it('builds a canonical https URL', () => {
    expect(s3.objectUrl('voicemails/a/v.wav'))
      .toBe('https://mobilitynet-recordings.s3.us-east-1.amazonaws.com/voicemails/a/v.wav');
  });
});
