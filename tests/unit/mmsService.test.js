jest.mock('../../src/integrations/s3');
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const nodeCrypto = require('crypto');
const s3 = require('../../src/integrations/s3');
const mms = require('../../src/services/mmsService');

// A known AES-128 key (16 bytes) as a hex string.
const HEX_KEY = '000102030405060708090a0b0c0d0e0f';
const KEY = Buffer.from(HEX_KEY, 'hex');

function ecbEncrypt(plaintext) {
  const cipher = nodeCrypto.createCipheriv('aes-128-ecb', KEY, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}
function cbcEncrypt(plaintext) {
  const cipher = nodeCrypto.createCipheriv('aes-128-cbc', KEY, Buffer.alloc(16));
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = jest.fn();
  s3.bucket.mockReturnValue('mobilitynet-recordings');
  s3.uploadObject.mockResolvedValue({ key: 'k' });
  s3.getSignedRecordingUrl.mockResolvedValue('https://signed.example/x');
});
afterAll(() => {
  delete global.fetch;
});

describe('decryptMedia', () => {
  it('decrypts AES-128-ECB ciphertext', () => {
    const plain = Buffer.from('hello mms media payload');
    const out = mms.decryptMedia(ecbEncrypt(plain), HEX_KEY);
    expect(out.equals(plain)).toBe(true);
  });

  it('falls back to AES-128-CBC (zero IV) when ECB fails', () => {
    // 16-byte plaintext so unpadded ECB wouldn't obviously error — use CBC input.
    const plain = Buffer.from('another payload!');
    const out = mms.decryptMedia(cbcEncrypt(plain), HEX_KEY);
    expect(out.equals(plain)).toBe(true);
  });

  it('returns null for a too-short key', () => {
    expect(mms.decryptMedia(Buffer.from('x'), 'ab')).toBeNull();
  });
});

describe('extFor', () => {
  it('maps common content-types', () => {
    expect(mms.extFor('image/jpeg')).toBe('jpg');
    expect(mms.extFor('image/png')).toBe('png');
    expect(mms.extFor('video/mp4')).toBe('mp4');
  });
  it('falls back to the URL extension, then bin', () => {
    expect(mms.extFor('', 'https://x/file.gif?sig=1')).toBe('gif');
    expect(mms.extFor('', 'https://x/no-ext')).toBe('bin');
  });
});

describe('resolveMediaUrls', () => {
  it('passes through an unencrypted attachment untouched', async () => {
    const urls = await mms.resolveMediaUrls('acc-1', [
      { url: 'https://media/plain.jpg', contentType: 'image/jpeg' },
    ]);
    expect(urls).toEqual(['https://media/plain.jpg']);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(s3.uploadObject).not.toHaveBeenCalled();
  });

  it('downloads, decrypts, uploads, and returns a presigned URL for encrypted media', async () => {
    const plain = Buffer.from('secret image bytes');
    const ct = ecbEncrypt(plain);
    global.fetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array(ct).buffer,
    });

    const urls = await mms.resolveMediaUrls('acc-1', [
      { url: 'https://acrobits/enc', contentType: 'image/jpeg', encryptionKey: HEX_KEY },
    ]);

    expect(urls).toEqual(['https://signed.example/x']);
    expect(global.fetch).toHaveBeenCalledWith('https://acrobits/enc');
    // Uploaded the DECRYPTED plaintext under an mms/{accountId}/ key.
    const upload = s3.uploadObject.mock.calls[0][0];
    expect(upload.key).toMatch(/^mms\/acc-1\/[0-9a-f-]+\.jpg$/);
    expect(upload.body.equals(plain)).toBe(true);
    expect(upload.contentType).toBe('image/jpeg');
    expect(s3.getSignedRecordingUrl).toHaveBeenCalledWith(upload.key, 3600);
  });

  it('skips an attachment (best-effort) when the download fails', async () => {
    global.fetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const urls = await mms.resolveMediaUrls('acc-1', [
      { url: 'https://acrobits/enc', contentType: 'image/jpeg', encryptionKey: HEX_KEY },
    ]);
    expect(urls).toEqual([]);
    expect(s3.uploadObject).not.toHaveBeenCalled();
  });

  it('skips an encrypted attachment when no S3 bucket is configured', async () => {
    s3.bucket.mockReturnValue('');
    const urls = await mms.resolveMediaUrls('acc-1', [
      { url: 'https://acrobits/enc', encryptionKey: HEX_KEY },
    ]);
    expect(urls).toEqual([]);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('preserves order across a mix of plain and encrypted attachments', async () => {
    const ct = ecbEncrypt(Buffer.from('bytes-16-exactly'));
    global.fetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array(ct).buffer,
    });
    const urls = await mms.resolveMediaUrls('acc-1', [
      { url: 'https://media/a.png', contentType: 'image/png' },
      { url: 'https://acrobits/enc', contentType: 'image/jpeg', encryptionKey: HEX_KEY },
    ]);
    expect(urls).toEqual(['https://media/a.png', 'https://signed.example/x']);
  });
});
