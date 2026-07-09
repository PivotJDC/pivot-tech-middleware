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
  it('uploads as audio/wav, ignoring the download response content-type', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      // Telnyx may report a type <Play> rejects — it must be ignored.
      headers: { get: () => 'application/octet-stream' },
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

  it('honors an explicit contentType (e.g. a greeting)', async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      headers: { get: () => null },
      arrayBuffer: async () => new Uint8Array([1]).buffer,
    });
    mockSend.mockResolvedValueOnce({});
    await s3.archiveRecording({
      key: 'greetings/acc-1/greeting.wav',
      sourceUrl: 'https://telnyx.example/greet',
      contentType: 'audio/wav',
    });
    expect(mockSend.mock.calls[0][0].Put.ContentType).toBe('audio/wav');
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

describe('presignUrlIfOwn', () => {
  it('presigns a canonical URL that points at our bucket', async () => {
    mockGetSignedUrl.mockResolvedValueOnce('https://signed.example/mms');
    const own = s3.objectUrl('mms-inbound/acc-1/msg_0.jpg');
    const out = await s3.presignUrlIfOwn(own);
    expect(out).toBe('https://signed.example/mms');
    const [, cmd, opts] = mockGetSignedUrl.mock.calls[0];
    expect(cmd.Get.Key).toBe('mms-inbound/acc-1/msg_0.jpg');
    expect(opts).toEqual({ expiresIn: 3600 });
  });

  it('passes an external URL through unchanged (no signing)', async () => {
    const out = await s3.presignUrlIfOwn('https://api.telnyx.com/v2/media/abc.jpg');
    expect(out).toBe('https://api.telnyx.com/v2/media/abc.jpg');
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });

  it('does not re-sign an already-presigned URL (has a query string)', async () => {
    const already = `${s3.objectUrl('mms/a/x.jpg')}?X-Amz-Signature=abc`;
    const out = await s3.presignUrlIfOwn(already);
    expect(out).toBe(already);
    expect(mockGetSignedUrl).not.toHaveBeenCalled();
  });
});

describe('getObjectText', () => {
  it('GetObjects the key and returns the body as a string', async () => {
    mockSend.mockResolvedValueOnce({ Body: { transformToString: async () => '{"a":1}' } });
    const text = await s3.getObjectText('transcripts/vm-1.json');
    expect(text).toBe('{"a":1}');
    expect(mockSend.mock.calls[0][0].Get).toEqual({
      Bucket: 'mobilitynet-recordings', Key: 'transcripts/vm-1.json',
    });
  });
});

describe('getObjectBuffer', () => {
  it('GetObjects the key and returns the body as a Buffer', async () => {
    mockSend.mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    });
    const buf = await s3.getObjectBuffer('mms/a/x.mp4_thumb.jpg');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(mockSend.mock.calls[0][0].Get.Key).toBe('mms/a/x.mp4_thumb.jpg');
  });
});

describe('keyFromUrl', () => {
  it('extracts the key from our canonical URL', () => {
    expect(s3.keyFromUrl(s3.objectUrl('mms/a/x.mp4'))).toBe('mms/a/x.mp4');
  });
  it('tolerates a presigned query string (unlike keyFromObjectUrl)', () => {
    expect(s3.keyFromUrl(`${s3.objectUrl('mms/a/x.mp4')}?X-Amz-Signature=abc`)).toBe('mms/a/x.mp4');
  });
  it('returns null for an external URL', () => {
    expect(s3.keyFromUrl('https://external/x.mp4')).toBeNull();
  });
});
