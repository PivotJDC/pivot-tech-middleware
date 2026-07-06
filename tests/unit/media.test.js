// sharp is mocked so we can drive the two-pass compression logic deterministically.
const mockChain = {
  rotate: jest.fn(function rotate() { return this; }),
  resize: jest.fn(function resize() { return this; }),
  jpeg: jest.fn(function jpeg() { return this; }),
  toBuffer: jest.fn(),
};
jest.mock('sharp', () => jest.fn(() => mockChain));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const sharp = require('sharp');
const {
  compressImageIfNeeded, extFor, isImage, MAX_MEDIA_BYTES,
} = require('../../src/utils/media');

const big = (n = MAX_MEDIA_BYTES + 1) => Buffer.alloc(n, 1);
const small = (n = 100) => Buffer.alloc(n, 2);

beforeEach(() => {
  sharp.mockClear();
  mockChain.rotate.mockClear();
  mockChain.resize.mockClear();
  mockChain.jpeg.mockClear();
  mockChain.toBuffer.mockReset();
});

describe('extFor / isImage', () => {
  it('maps content-types and falls back to url then bin', () => {
    expect(extFor('image/jpeg')).toBe('jpg');
    expect(extFor('image/png')).toBe('png');
    expect(extFor('', 'https://x/f.gif?s=1')).toBe('gif');
    expect(extFor('', 'https://x/none')).toBe('bin');
  });
  it('detects image content-types', () => {
    expect(isImage('image/jpeg')).toBe(true);
    expect(isImage('video/mp4')).toBe(false);
    expect(isImage(undefined)).toBe(false);
  });
});

describe('compressImageIfNeeded', () => {
  it('returns non-images unchanged (no sharp)', async () => {
    const buf = big();
    const out = await compressImageIfNeeded(buf, 'video/mp4');
    expect(out).toEqual({ buffer: buf, contentType: 'video/mp4' });
    expect(sharp).not.toHaveBeenCalled();
  });

  it('returns small images unchanged (no sharp)', async () => {
    const buf = small();
    const out = await compressImageIfNeeded(buf, 'image/png');
    expect(out).toEqual({ buffer: buf, contentType: 'image/png' });
    expect(sharp).not.toHaveBeenCalled();
  });

  it('compresses an oversized image in one pass (1024px q75) → image/jpeg', async () => {
    mockChain.toBuffer.mockResolvedValueOnce(small());
    const out = await compressImageIfNeeded(big(), 'image/png');
    expect(sharp).toHaveBeenCalledTimes(1);
    expect(mockChain.resize).toHaveBeenCalledWith({ width: 1024, withoutEnlargement: true });
    expect(mockChain.jpeg).toHaveBeenCalledWith({ quality: 75 });
    expect(out.contentType).toBe('image/jpeg');
    expect(out.buffer.length).toBe(100);
  });

  it('falls back to a second pass (800px q60) when still too big', async () => {
    mockChain.toBuffer
      .mockResolvedValueOnce(big(MAX_MEDIA_BYTES + 50)) // pass 1 still over
      .mockResolvedValueOnce(small(80)); // pass 2 under
    const out = await compressImageIfNeeded(big(), 'image/jpeg');
    expect(sharp).toHaveBeenCalledTimes(2);
    expect(mockChain.resize).toHaveBeenNthCalledWith(1, { width: 1024, withoutEnlargement: true });
    expect(mockChain.resize).toHaveBeenNthCalledWith(2, { width: 800, withoutEnlargement: true });
    expect(mockChain.jpeg).toHaveBeenNthCalledWith(2, { quality: 60 });
    expect(out).toEqual({ buffer: expect.any(Buffer), contentType: 'image/jpeg' });
    expect(out.buffer.length).toBe(80);
  });

  it('returns the original on a sharp failure (best-effort)', async () => {
    mockChain.toBuffer.mockRejectedValueOnce(new Error('bad image'));
    const buf = big();
    const out = await compressImageIfNeeded(buf, 'image/heic');
    expect(out).toEqual({ buffer: buf, contentType: 'image/heic' });
  });
});
