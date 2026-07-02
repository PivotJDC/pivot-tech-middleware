#!/usr/bin/env node
'use strict';

/**
 * Generate a signed HS256 admin JWT for MVP admin API access.
 *
 * Usage:
 *   ADMIN_JWT_SECRET=... node scripts/generate-admin-token.js
 *
 * Prints the token to stdout. No expiry for MVP.
 *
 * DECISION: HS256 (symmetric) is used here per the request, even though the
 * spec describes admin tokens as RS256. This is a developer/ops convenience
 * script for the MVP; the runtime adminAuth middleware should be configured to
 * accept the same scheme/secret this script signs with.
 */

const jwt = require('jsonwebtoken');

const secret = process.env.ADMIN_JWT_SECRET;
if (!secret) {
  process.stderr.write('Error: ADMIN_JWT_SECRET is not set in the environment.\n');
  process.exit(1);
}

// No expiry for MVP — intentionally omit `exp`.
const payload = {
  scope: 'admin',
  iat: Math.floor(Date.now() / 1000),
};

const token = jwt.sign(payload, secret, { algorithm: 'HS256' });

process.stdout.write(`${token}\n`);
