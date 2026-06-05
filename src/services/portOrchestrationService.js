/**
 * Port orchestration — SignalWire-facing port-in submission.
 *
 * Phase 2 will own the full port lifecycle; for now this provides the single
 * piece the admin "retry failed port" endpoint needs: submitting a port to
 * SignalWire.
 *
 * CLAUDE.md rule #2: the transfer PIN is AES-256-GCM at rest and is decrypted
 * ONLY here, in memory, immediately before submission — never logged, never
 * returned in any API response.
 */
const signalwire = require('../integrations/signalwire');
const crypto = require('../utils/crypto');
const config = require('../config');
const { logger } = require('../utils/logger');

/**
 * Submit (or resubmit) a port_request row to SignalWire.
 * @param {object} port - a port_requests row (incl. pin_encrypted)
 * @returns {Promise<{ signalwirePortId: string }>}
 */
async function submitPortToSignalwire(port) {
  const pin = crypto.decrypt(port.pin_encrypted); // plaintext only in this scope

  const response = await signalwire.submitPort({
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
    'port submitted to SignalWire',
  );
  return { signalwirePortId };
}

module.exports = { submitPortToSignalwire };
