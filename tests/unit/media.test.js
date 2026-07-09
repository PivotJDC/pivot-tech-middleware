// sharp is mocked so we can drive the two-pass compression logic deterministically.
const mockChain = {
  rotate: jest.fn(function rotate() { return this; }),
  resize: jest.fn(function resize() { return this; }),
  jpeg: jest.fn(function jpeg() { return this; }),
  toBuffer: jest.fn(),
};
jest.mock('sharp', () => jest.fn(() => mockChain));
// Only the ffmpeg invocation is mocked; temp-file I/O uses real fs (tmpdir), so
// the video path is exercised end to end without deopting the whole file with an
// fs mock.
const mockExecFile = jest.fn();
jest.mock('child_process', () => ({ execFile: (...args) => mockExecFile(...args) }));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  REDACT_PATHS: [],
}));

const fsp = require('fs').promises;
const sharp = require('sharp');
const {
  compressImageIfNeeded, compressVideoIfNeeded, compressMediaIfNeeded,
  extFor, isImage, isVideo, MAX_MEDIA_BYTES,
} = require('../../src/utils/media');

const big = (n = MAX_MEDIA_BYTES + 1) => Buffer.alloc(n, 1);
const small = (n = 100) => Buffer.alloc(n, 2);

// Simulate a successful ffmpeg run: write `size` bytes to the output path (the
// last arg) and call back with no error.
function ffmpegWrites(size) {
  mockExecFile.mockImplementation((file, args, options, cb) => {
    const outputPath = args[args.length - 1];
    fsp.writeFile(outputPath, Buffer.alloc(size, 3)).then(() => cb(null)).catch(cb);
  });
}

beforeEach(() => {
  sharp.mockClear();
  mockChain.rotate.mockClear();
  mockChain.resize.mockClear();
  mockChain.jpeg.mockClear();
  mockChain.toBuffer.mockReset();
  mockExecFile.mockReset();
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

describe('isVideo', () => {
  it('detects video content-types', () => {
    expect(isVideo('video/mp4')).toBe(true);
    expect(isVideo('video/3gpp')).toBe(true);
    expect(isVideo('image/jpeg')).toBe(false);
    expect(isVideo(undefined)).toBe(false);
  });
});

describe('compressVideoIfNeeded', () => {
  it('returns non-videos unchanged (no ffmpeg)', async () => {
    const buf = big();
    const out = await compressVideoIfNeeded(buf, 'image/png');
    expect(out).toEqual({ buffer: buf, contentType: 'image/png' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns small videos unchanged (no ffmpeg)', async () => {
    const buf = small();
    const out = await compressVideoIfNeeded(buf, 'video/mp4');
    expect(out).toEqual({ buffer: buf, contentType: 'video/mp4' });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('transcodes an oversized video to H.264/AAC mp4 with the size cap', async () => {
    ffmpegWrites(80); // ffmpeg produces an 80-byte output

    const out = await compressVideoIfNeeded(big(), 'video/quicktime');

    expect(out.contentType).toBe('video/mp4');
    expect(out.buffer.length).toBe(80);
    // ffmpeg args carry the required flags.
    const [cmd, args] = mockExecFile.mock.calls[0];
    expect(cmd).toBe('ffmpeg');
    expect(args).toEqual(expect.arrayContaining([
      '-vf', 'scale=480:-2', '-c:v', 'libx264', '-crf', '28',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-fs', '500000',
    ]));
    // Input temp file uses the source extension (mov for quicktime).
    expect(args[args.indexOf('-i') + 1]).toMatch(/\.mov$/);
    // Temp files are cleaned up.
    await expect(fsp.access(args[args.indexOf('-i') + 1])).rejects.toBeDefined();
    await expect(fsp.access(args[args.length - 1])).rejects.toBeDefined();
  });

  it('returns the original when ffmpeg fails (best-effort)', async () => {
    mockExecFile.mockImplementation((file, args, opts, cb) => cb(new Error('ffmpeg boom')));
    const buf = big();

    const out = await compressVideoIfNeeded(buf, 'video/mp4');

    expect(out).toEqual({ buffer: buf, contentType: 'video/mp4' });
  });
});

describe('compressMediaIfNeeded (dispatcher)', () => {
  it('routes images to sharp and videos to ffmpeg; passes others through', async () => {
    // Image → sharp (mocked to return small).
    mockChain.toBuffer.mockResolvedValueOnce(small());
    const img = await compressMediaIfNeeded(big(), 'image/png');
    expect(img.contentType).toBe('image/jpeg');
    expect(mockExecFile).not.toHaveBeenCalled();

    // Video → ffmpeg.
    ffmpegWrites(50);
    const vid = await compressMediaIfNeeded(big(), 'video/mp4');
    expect(vid.contentType).toBe('video/mp4');
    expect(vid.buffer.length).toBe(50);

    // Other (audio) → unchanged.
    const buf = big();
    const audio = await compressMediaIfNeeded(buf, 'audio/mpeg');
    expect(audio).toEqual({ buffer: buf, contentType: 'audio/mpeg' });
  });
});
