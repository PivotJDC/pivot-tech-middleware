/**
 * Secrets bootstrap — must complete BEFORE src/config/index.js is required.
 *
 * When SECRETS_ARN is set, fetches that secret from AWS Secrets Manager,
 * parses it as a JSON object, and injects each key into process.env so the
 * config module (which validates the environment at require time) sees a
 * fully populated environment. App Runner then only needs one configured env
 * var (SECRETS_ARN) plus an instance role allowed to read the secret, instead
 * of 19 individually injected values.
 *
 * Deliberately imports nothing from this project: requiring this module must
 * never pull in config (or anything that logs through it) before secrets are
 * in place. Logs via console for the same reason — Pino can't be built until
 * config can load. Key NAMES and counts are logged, never values
 * (CLAUDE.md security rule #1).
 */

/** Emit one structured JSON line to stdout, matching our Pino log shape. */
function logInfo(msg) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ level: 'info', msg }));
}

/**
 * Fetch and inject secrets. No-op when SECRETS_ARN is unset (local dev and
 * tests keep using .env). Throws on any fetch/parse failure — the caller
 * (server.js) logs the stage and exits, so a bad ARN or missing IAM
 * permission fails the deploy with a readable reason in CloudWatch.
 */
async function loadSecrets() {
  const arn = process.env.SECRETS_ARN;
  if (!arn) {
    return { loaded: false, injected: 0 };
  }

  // Lazy require: the SDK is only loaded when SECRETS_ARN is set, keeping
  // local boots and the test suite free of it.
  // eslint-disable-next-line global-require
  const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

  // Credentials come from the default provider chain — the App Runner
  // instance role in production, the local AWS profile in dev.
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || 'us-east-1',
  });

  const response = await client.send(new GetSecretValueCommand({ SecretId: arn }));
  if (!response.SecretString) {
    throw new Error('secret has no SecretString — binary secrets are not supported');
  }

  let secrets;
  try {
    secrets = JSON.parse(response.SecretString);
  } catch (err) {
    throw new Error(`secret value is not valid JSON: ${err.message}`);
  }
  if (typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) {
    throw new Error('secret value must be a JSON object of KEY: value pairs');
  }

  let injected = 0;
  const kept = [];
  Object.entries(secrets).forEach(([key, value]) => {
    // DECISION: values already present in the environment win, so platform-
    // level settings on the App Runner service (PORT, NODE_ENV, LOG_LEVEL)
    // are never clobbered by the secret blob.
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = typeof value === 'string' ? value : JSON.stringify(value);
      injected += 1;
    } else {
      kept.push(key);
    }
  });

  const keptNote = kept.length ? `; kept existing env for: ${kept.join(', ')}` : '';
  logInfo(`secrets bootstrap: injected ${injected} value(s) from Secrets Manager${keptNote}`);

  return { loaded: true, injected };
}

module.exports = { loadSecrets };
