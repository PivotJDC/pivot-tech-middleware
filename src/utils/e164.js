/**
 * E.164 phone-number helpers, scoped to the North American Numbering Plan
 * (NANP / country code +1), which covers every Pivot-Tech market.
 *
 * The canonical stored/transported form is E.164: "+1" followed by a 10-digit
 * national number, e.g. +12085550100. Inputs from clients arrive in many shapes
 * ((208) 555-0100, 208-555-0100, 12085550100, +1 208 555 0100) — toE164()
 * normalizes them or throws a clear error.
 */

// NANP rule: area code (NPA) and exchange (NXX) both start 2-9; subscriber is 4 digits.
const NANP_E164 = /^\+1[2-9]\d{2}[2-9]\d{6}$/;

/** True if value is a valid NANP number in E.164 form. */
function isE164(value) {
  return typeof value === 'string' && NANP_E164.test(value);
}

/**
 * Normalize a loosely-formatted US/Canada number to E.164 (+1XXXXXXXXXX).
 * @param {string} input
 * @returns {string} E.164 string
 * @throws {Error} if the input cannot be parsed to a valid NANP number.
 */
function toE164(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('phone number is required');
  }

  // Keep a leading +, drop every other non-digit.
  const hasPlus = input.trim().startsWith('+');
  let digits = input.replace(/\D/g, '');

  if (hasPlus) {
    // Already international; must be +1 + 10 digits.
    if (digits.length === 11 && digits.startsWith('1')) {
      digits = digits.slice(1);
    } else {
      throw new Error(`not a valid +1 (NANP) number: ${input}`);
    }
  } else if (digits.length === 11 && digits.startsWith('1')) {
    digits = digits.slice(1); // 1XXXXXXXXXX -> XXXXXXXXXX
  } else if (digits.length !== 10) {
    throw new Error(`expected a 10-digit US/Canada number, got: ${input}`);
  }

  const e164 = `+1${digits}`;
  if (!NANP_E164.test(e164)) {
    throw new Error(`not a valid NANP number: ${input}`);
  }
  return e164;
}

/**
 * Extract the 3-digit area code (NPA) from an E.164 NANP number.
 * @param {string} e164
 * @returns {string} e.g. "208"
 */
function areaCodeOf(e164) {
  if (!isE164(e164)) {
    throw new Error(`not an E.164 NANP number: ${e164}`);
  }
  return e164.slice(2, 5);
}

/**
 * Format an E.164 number for display: +12085550100 -> "(208) 555-0100".
 * Returns the input unchanged if it is not a parseable NANP number.
 */
function formatNational(e164) {
  if (!isE164(e164)) return e164;
  const d = e164.slice(2);
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

module.exports = {
  isE164,
  toE164,
  areaCodeOf,
  formatNational,
};
