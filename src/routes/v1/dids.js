/**
 * DID discovery routes (mounted at /v1/numbers).
 *
 *   GET /v1/numbers/available   public number search for the signup flow
 *
 * PUBLIC, unauthenticated by design: the customer dashboard calls this before
 * an account exists, to let people browse available numbers by area code. It
 * only exposes numbers Telnyx already lists as purchasable — no account
 * data — so there is nothing to authorize. Handlers stay thin; the Telnyx
 * call + retry policy live in the integration module.
 */
const express = require('express');
const telnyx = require('../../integrations/telnyx');
const e164 = require('../../utils/e164');
const { errors, asyncHandler } = require('../../middleware/errorHandler');

const router = express.Router();

// Clamp to Telnyx's documented ceiling (100) with the dashboard default of 50.
const DEFAULT_MAX = 50;
const HARD_MAX = 100;

function parseMaxResults(raw) {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return DEFAULT_MAX;
  return Math.min(Math.max(n, 1), HARD_MAX);
}

// Optional Telnyx patterns are 3-7 digits; ignore anything malformed rather
// than 400, so a stray param never blocks discovery.
function cleanPattern(raw) {
  return typeof raw === 'string' && /^\d{3,7}$/.test(raw) ? raw : undefined;
}

// GET /v1/numbers/available?areacode=208&max_results=50&contains=420
router.get(
  '/available',
  asyncHandler(async (req, res) => {
    const {
      areacode, max_results: maxRaw, contains, starts_with: startsWith, ends_with: endsWith,
    } = req.query;

    if (!areacode || !/^\d{3}$/.test(areacode)) {
      throw errors.validation('A 3-digit area code is required.', 'areacode');
    }

    const results = await telnyx.searchAvailableNumbers(areacode, {
      maxResults: parseMaxResults(maxRaw),
      contains: cleanPattern(contains),
      startsWith: cleanPattern(startsWith),
      endsWith: cleanPattern(endsWith),
    });

    const numbers = results
      .map((r) => r.number || r.e164)
      .filter(Boolean)
      .map((num) => ({
        e164: num,
        formatted: e164.formatNational(num),
        // Derive from the number when it's a valid NANP E.164; otherwise fall
        // back to the searched area code.
        area_code: e164.isE164(num) ? e164.areaCodeOf(num) : areacode,
      }));

    res.json({ numbers });
  }),
);

module.exports = router;
