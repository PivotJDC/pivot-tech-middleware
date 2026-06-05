const e164 = require('../../src/utils/e164');

describe('e164.toE164', () => {
  it('normalizes common US formats to E.164', () => {
    const expected = '+12085550100';
    expect(e164.toE164('2085550100')).toBe(expected);
    expect(e164.toE164('(208) 555-0100')).toBe(expected);
    expect(e164.toE164('208-555-0100')).toBe(expected);
    expect(e164.toE164('208.555.0100')).toBe(expected);
    expect(e164.toE164('12085550100')).toBe(expected);
    expect(e164.toE164('+1 208 555 0100')).toBe(expected);
    expect(e164.toE164('+12085550100')).toBe(expected);
  });

  it('throws on empty or non-string input', () => {
    expect(() => e164.toE164('')).toThrow();
    expect(() => e164.toE164('   ')).toThrow();
    expect(() => e164.toE164(null)).toThrow();
    expect(() => e164.toE164(2085550100)).toThrow();
  });

  it('throws on wrong digit counts', () => {
    expect(() => e164.toE164('555-0100')).toThrow();
    expect(() => e164.toE164('1234567890123')).toThrow();
  });

  it('throws when area code or exchange starts with 0 or 1 (invalid NANP)', () => {
    expect(() => e164.toE164('1085550100')).toThrow(); // area code starts 1
    expect(() => e164.toE164('2081550100')).toThrow(); // exchange starts 1
  });

  it('rejects a +country code that is not +1', () => {
    expect(() => e164.toE164('+442085550100')).toThrow();
  });
});

describe('e164.isE164', () => {
  it('accepts valid NANP E.164 and rejects everything else', () => {
    expect(e164.isE164('+12085550100')).toBe(true);
    expect(e164.isE164('+13315550199')).toBe(true);
    expect(e164.isE164('2085550100')).toBe(false);
    expect(e164.isE164('+1208555010')).toBe(false); // too short
    expect(e164.isE164('')).toBe(false);
    expect(e164.isE164(undefined)).toBe(false);
  });
});

describe('e164.areaCodeOf', () => {
  it('extracts the NPA', () => {
    expect(e164.areaCodeOf('+12085550100')).toBe('208');
    expect(e164.areaCodeOf('+16305550100')).toBe('630');
    expect(e164.areaCodeOf('+13315550100')).toBe('331');
  });

  it('throws on non-E.164 input', () => {
    expect(() => e164.areaCodeOf('2085550100')).toThrow();
  });
});

describe('e164.formatNational', () => {
  it('formats for display', () => {
    expect(e164.formatNational('+12085550100')).toBe('(208) 555-0100');
  });
  it('returns input unchanged when not parseable', () => {
    expect(e164.formatNational('not-a-number')).toBe('not-a-number');
  });
});
