/**
 * Market -> ordered list of area codes to try when assigning a DID.
 *
 * New markets are added HERE (config), not in code (CLAUDE.md "Markets":
 * new markets added via config — no code changes required). Area codes are
 * tried in order until SignalWire returns availability.
 */
module.exports = {
  'lewiston-id': ['208'],
  'kendall-il': ['630', '331'],
};
