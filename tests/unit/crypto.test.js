// 64 hex chars => a 32-byte AES-256 key.
jest.mock('../../src/config', () => ({ encryptionKey: 'a'.repeat(64) }));

const crypto = require('../../src/utils/crypto');

describe('AES-256-GCM encrypt/decrypt', () => {
  it('round-trips plaintext', () => {
    const secret = 'transfer-pin-7788';
    const ct = crypto.encrypt(secret);
    expect(ct).not.toContain(secret);
    expect(ct.split(':')).toHaveLength(3);
    expect(crypto.decrypt(ct)).toBe(secret);
  });

  it('produces a different ciphertext each time (random IV)', () => {
    const a = crypto.encrypt('same');
    const b = crypto.encrypt('same');
    expect(a).not.toBe(b);
    expect(crypto.decrypt(a)).toBe('same');
    expect(crypto.decrypt(b)).toBe('same');
  });

  it('throws when the ciphertext was tampered with', () => {
    const ct = crypto.encrypt('secret');
    const [iv, tag, body] = ct.split(':');
    const flipped = Buffer.from(body, 'base64');
    flipped[0] = flipped[0] === 0 ? 1 : 0; // mutate first byte without bitwise ops
    const tampered = `${iv}:${tag}:${flipped.toString('base64')}`;
    expect(() => crypto.decrypt(tampered)).toThrow();
  });

  it('throws on malformed payloads and non-string input', () => {
    expect(() => crypto.decrypt('only:two')).toThrow();
    expect(() => crypto.encrypt(12345)).toThrow();
  });
});

describe('bcrypt password hashing', () => {
  it('hashes and verifies a password', async () => {
    const hash = await crypto.hashPassword('sip-pass-xyz');
    expect(hash).not.toBe('sip-pass-xyz');
    expect(await crypto.verifyPassword('sip-pass-xyz', hash)).toBe(true);
    expect(await crypto.verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('randomSecret', () => {
  it('returns a URL-safe random string', () => {
    const s = crypto.randomSecret();
    expect(s).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(crypto.randomSecret()).not.toBe(s);
  });
});
