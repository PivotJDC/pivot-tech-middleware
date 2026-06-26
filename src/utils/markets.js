/**
 * Market lookup helpers over the config map (src/config/markets.js).
 *
 * Kept separate from the data map so the map stays a plain
 * market -> [areaCodes] object for its existing consumers (didOrchestration).
 */
const MARKET_AREA_CODES = require('../config/markets');

/** True if `market` is a configured (launched) market. */
function isValidMarket(market) {
  return typeof market === 'string'
    && Object.prototype.hasOwnProperty.call(MARKET_AREA_CODES, market);
}

/** The set of every area code across all launched markets. */
function launchedAreaCodes() {
  return new Set(Object.values(MARKET_AREA_CODES).flat());
}

/** True if `areaCode` belongs to some launched market. */
function isLaunchedAreaCode(areaCode) {
  return launchedAreaCodes().has(areaCode);
}

module.exports = { isValidMarket, isLaunchedAreaCode, launchedAreaCodes };
