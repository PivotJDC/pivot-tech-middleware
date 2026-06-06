/**
 * Redis client singleton (ioredis).
 *
 * Mirrors src/db/index.js: one client shared process-wide, created lazily on
 * first use. lazyConnect keeps module import side-effect free so tests can
 * require this without a Redis server running; the first command (or an
 * explicit healthCheck()) opens the connection.
 */
const Redis = require('ioredis');
const config = require('../config');
const { logger } = require('../utils/logger');

let client;

function createClient() {
  const instance = new Redis(config.redis.url, {
    lazyConnect: true,
    connectTimeout: 5000,
    // Bound how long a single command (e.g. the startup ping) can spend
    // retrying, instead of ioredis's default of queueing forever.
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

  // ioredis emits 'error' on connection drops; without a listener Node treats
  // it as an unhandled error event and crashes the process. Log and let the
  // built-in reconnect strategy recover.
  instance.on('error', (err) => {
    logger.error({ err: { message: err.message } }, 'redis client error');
  });

  return instance;
}

/** Return the shared client, lazily creating it on first use. */
function getClient() {
  if (!client) {
    client = createClient();
  }
  return client;
}

/** Liveness probe: PING round-trip. Throws if Redis is unreachable. */
async function healthCheck() {
  const pong = await getClient().ping();
  return pong === 'PONG';
}

/** Close the connection. Call during graceful shutdown; tests also use this. */
async function close() {
  if (client) {
    // quit() waits for pending replies; disconnect() is the hard fallback when
    // the connection never came up (quit would hang waiting to connect).
    if (client.status === 'ready') {
      await client.quit();
    } else {
      client.disconnect();
    }
    client = undefined;
  }
}

module.exports = {
  getClient,
  healthCheck,
  close,
};
