/**
 * Background scheduler — periodic usage polling.
 *
 * On boot, server.js calls start() (after the HTTP server binds) to run a BICS
 * usage poll every USAGE_POLL_INTERVAL_HOURS (default 4). stop() clears the
 * timer for a clean shutdown. The timer is unref'd so it never keeps the process
 * alive on its own during graceful shutdown.
 *
 * Each run logs its summary (polled / succeeded / failed). Errors are caught so
 * a single bad run never crashes the process or stops future runs.
 */
const config = require('./config');
const usageService = require('./services/usageService');
const { logger } = require('./utils/logger');

let timer = null;

function intervalMs() {
  const hours = config.usage.pollIntervalHours || 4;
  return hours * 60 * 60 * 1000;
}

/** Run one usage poll, logging the summary. Never throws. */
async function runPoll() {
  try {
    const summary = await usageService.pollAllActiveAccounts();
    logger.info(
      { polled: summary.polled, succeeded: summary.succeeded, failed: summary.failed },
      'scheduled usage poll complete',
    );
    return summary;
  } catch (err) {
    logger.error({ err: err.message }, 'scheduled usage poll failed');
    return null;
  }
}

/** Start the recurring poll. Idempotent — a second call is a no-op. */
function start() {
  if (timer) return;
  timer = setInterval(runPoll, intervalMs());
  if (typeof timer.unref === 'function') timer.unref();
  logger.info(
    { intervalHours: config.usage.pollIntervalHours },
    'usage poll scheduler started',
  );
}

/** Stop the recurring poll (clean shutdown). Idempotent. */
function stop() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('usage poll scheduler stopped');
}

module.exports = { start, stop, runPoll };
