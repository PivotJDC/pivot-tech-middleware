#!/usr/bin/env node

/**
 * One-time ops script: clear the static outbound ANI override on the SIP
 * credential connection so each customer's own DID is used as the outbound
 * caller ID (instead of one hard-coded number).
 *
 * The connection currently forces ani_override "+12088231792"; setting
 * ani_override_type to "default" makes Telnyx pass through the per-call caller
 * ID (the DID the Acrobits dialer sends).
 *
 * Usage (needs the production Telnyx API key in the environment, e.g. via
 * SECRETS_ARN or TELNYX_API_KEY):
 *   TELNYX_API_KEY=... node scripts/reset-connection-ani-override.js
 *
 * Connection id defaults to the live SIP credential connection; override with
 * TELNYX_CREDENTIAL_CONNECTION_ID.
 */

const telnyx = require('../src/integrations/telnyx');

const CONNECTION_ID = process.env.TELNYX_CREDENTIAL_CONNECTION_ID || '2984224004669178914';

telnyx
  .updateConnectionOutbound(CONNECTION_ID, { ani_override_type: 'default' })
  .then(() => {
    process.stdout.write(`OK: cleared ani_override on connection ${CONNECTION_ID} (ani_override_type=default)\n`);
  })
  .catch((err) => {
    process.stderr.write(`Failed: ${err.message}\n`);
    process.exit(1);
  });
