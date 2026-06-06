/**
 * HTTP server entrypoint.
 *
 * Boot order matters here:
 *   1. Secrets bootstrap — when SECRETS_ARN is set, fetch the JSON secret
 *      from Secrets Manager and inject its keys into process.env.
 *   2. Only then require config/app/db/cache — config validates process.env
 *      at require time, so it must not load before step 1 completes. That is
 *      why those requires live inside bootstrap() instead of at the top.
 *   3. Startup connectivity check (diagnostic only), then bind the port.
 *
 * Graceful shutdown: on SIGTERM/SIGINT (App Runner sends SIGTERM on
 * deploy/scale-in) stop accepting new connections, drain in-flight requests,
 * then close the DB pool and Redis. Unhandled rejections and uncaught
 * exceptions are logged and exit non-zero so the orchestrator restarts a
 * known-bad instance rather than limping along.
 *
 * Every failure path here logs to stdout before exiting. App Runner forwards
 * container stdout/stderr to the CloudWatch application log group
 * (/aws/apprunner/<service>/<id>/application), so a deploy that crash-loops
 * leaves a readable reason in CloudWatch instead of a silent restart cycle.
 */

// Safe to require eagerly: secrets.js deliberately imports nothing from this
// project, so it can never pull in config before secrets are injected.
const { loadSecrets } = require('./config/secrets');

/**
 * Last-resort startup logger. Used when the failure may have happened before
 * (or inside) the Pino logger's own module graph — most commonly src/config
 * throwing at require time on a missing env var. Emits one structured JSON
 * line to stdout, matching the shape of our Pino logs, so CloudWatch picks
 * it up no matter how early the boot failed.
 */
function logFatalToStdout(stage, err) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    level: 'fatal',
    stage,
    msg: `startup failed during ${stage}: ${err.message}`,
    stack: err.stack,
  }));
}

// Assigned by bootstrap() once secrets are in place and modules can load.
let createApp;
let logger;
let config;
let db;
let cache;
let server;
let shuttingDown = false;

/**
 * Startup connectivity check. Confirms the instance can actually reach its
 * backing services and says so explicitly either way, so an App Runner deploy
 * that fails on networking (VPC connector, security groups, bad URL) is
 * diagnosable from the application log alone.
 *
 * Diagnostic only — never fatal. A failed ping logs a warning and startup
 * continues: the server binds and serves regardless, and /health performs the
 * live DB check that pulls an unhealthy instance out of service. A transient
 * blip at boot shouldn't kill an instance that would recover seconds later.
 */
async function verifyConnectivity() {
  try {
    await db.healthCheck();
    logger.info('startup connectivity check: database reachable');
  } catch (err) {
    logger.warn(
      { err: { message: err.message, stack: err.stack } },
      'startup connectivity check: CANNOT REACH DATABASE — verify DATABASE_URL, '
        + 'the App Runner VPC connector, and the RDS security group allow this service. '
        + 'Starting anyway; /health will report 503 until the database is reachable',
    );
  }

  try {
    await cache.healthCheck();
    logger.info('startup connectivity check: redis reachable');
  } catch (err) {
    logger.warn(
      { err: { message: err.message, stack: err.stack } },
      'startup connectivity check: CANNOT REACH REDIS — verify REDIS_URL, '
        + 'the App Runner VPC connector, and the ElastiCache security group allow this service. '
        + 'Starting anyway',
    );
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutdown initiated, draining connections');

  // Stop accepting new connections; callback fires once in-flight ones finish.
  server.close(async () => {
    try {
      await db.close();
      await cache.close();
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

async function start() {
  logger.info({ env: config.env, port: config.port }, 'starting pivot-tech-middleware');

  await verifyConnectivity();

  const app = createApp();
  server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'pivot-tech-middleware listening');
  });

  // listen() errors (port in use, EACCES) arrive as an 'error' event, not a
  // throw — without this handler they would crash with no structured log line.
  server.on('error', (err) => {
    logger.fatal(
      { err: { message: err.message, code: err.code, stack: err.stack } },
      `failed to bind port ${config.port}`,
    );
    process.exit(1);
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

async function bootstrap() {
  try {
    await loadSecrets();
  } catch (err) {
    logFatalToStdout(
      'secrets bootstrap (check SECRETS_ARN and the instance role secretsmanager:GetSecretValue permission)',
      err,
    );
    process.exit(1);
  }

  // Module loading is deferred to here (after secrets injection) and wrapped
  // so a require-time throw (config validation is fail-fast by design) still
  // produces a clear stdout line instead of a bare Node stack trace.
  try {
    /* eslint-disable global-require */
    ({ createApp, logger } = require('./app'));
    config = require('./config');
    db = require('./db');
    cache = require('./cache');
    /* eslint-enable global-require */
  } catch (err) {
    logFatalToStdout('module load (check required environment variables)', err);
    process.exit(1);
  }

  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled promise rejection');
    process.exit(1);
  });

  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'uncaught exception');
    process.exit(1);
  });

  await start();
}

bootstrap().catch((err) => {
  // logger writes to stdout; the raw fallback below guarantees a line lands
  // even if the failure was in the logging pipeline itself.
  logFatalToStdout('startup', err);
  process.exit(1);
});
