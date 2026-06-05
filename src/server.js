/**
 * HTTP server entrypoint.
 *
 * Builds the app via the factory, binds the port, and wires graceful shutdown:
 * on SIGTERM/SIGINT (App Runner sends SIGTERM on deploy/scale-in) it stops
 * accepting new connections, drains in-flight requests, then closes the DB pool.
 * Unhandled rejections and uncaught exceptions are logged and exit non-zero so
 * the orchestrator restarts a known-bad instance rather than limping along.
 */
const { createApp, logger } = require('./app');
const config = require('./config');
const db = require('./db');

const app = createApp();

const server = app.listen(config.port, () => {
  logger.info({ port: config.port, env: config.env }, 'pivot-tech-middleware listening');
});

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated, draining connections');

  // Stop accepting new connections; callback fires once in-flight ones finish.
  server.close(async () => {
    try {
      await db.close();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  });

  // Hard cap: if draining stalls, force exit so we don't hang the platform.
  setTimeout(() => {
    logger.error('graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandled promise rejection');
  process.exit(1);
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaught exception');
  process.exit(1);
});

module.exports = server;
