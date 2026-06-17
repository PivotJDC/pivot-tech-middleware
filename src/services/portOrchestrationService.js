/**
 * Port orchestration — Telnyx-facing port-in submission.
 *
 * Phase 2 will own the full port lifecycle; for now this provides the single
 * piece the admin "retry failed port" endpoint needs: submitting a port to
 * Telnyx.
 *
 * CLAUDE.md rule #2: the transfer PIN is AES-256-GCM at rest and is decrypted
 * ONLY here, in memory, immediately before submission — never logged, never
 * returned in any API response.
 */
const telnyx = require('../integrations/telnyx');
const crypto = require('../utils/crypto');
const config = require('../config');
const { logger } = require('../utils/logger');

/**
 * Submit (or resubmit) a port_request row to Telnyx. The exported name and the
 * returned `signalwirePortId` field are unchanged (the latter maps to the
 * port_requests.signalwire_port_id column) so callers above are unaffected.
 * @param {object} port - a port_requests row (incl. pin_encrypted)
 * @returns {Promise<{ signalwirePortId: string }>}
 */
async function submitPortToSignalwire(port) {
  const pin = crypto.decrypt(port.pin_encrypted); // plaintext only in this scope

  const response = await telnyx.submitPort({
    number: port.number_e164,
    account_number: port.account_number,
    pin,
    billing_zip: port.billing_zip,
    carrier: port.losing_carrier,
    notify_url: `${config.provisioning.baseUrl}/v1/webhooks/port`,
  });

  const signalwirePortId = response && (response.id || response.port_id || response.sid);
  logger.info(
    { portRequestId: port.id, number: port.number_e164, signalwirePortId },
    'port submitted to Telnyx',
  );
  return { signalwirePortId };
}

module.exports = { submitPortToSignalwire };
