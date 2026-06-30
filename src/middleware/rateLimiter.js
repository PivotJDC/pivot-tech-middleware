/**
 * Fixed-window rate limiter middleware factory.
 *
 *   rateLimit({ windowMs, max, keyGenerator })
 *
 * Counts requests per key (default: client IP) within a rolling fixed window;
 * once a key exceeds `max` in the current window, further requests get a 429
 * with a Retry-After header until the window resets.
 *
 * DECISION (for Jim): this is an IN-MEMORY, per-instance limiter — simple and
 * dependency-free, which is enough to blunt brute-force on /admin/login at MVP
 * scale. Under multiple App Runner instances the effective limit is max × N
 * instances; move the counter to Redis (INCR + EXPIRE, see src/cache) when
 * login traffic is sharded across instances. CLAUDE.md targets a Redis-backed
 * limiter — tracked here so the upgrade path is explicit.
 */
const { AppError } = require('./errorHandler');

/**
 * @param {object} [opts]
 * @param {number} [opts.windowMs=60000] - window length in ms.
 * @param {number} [opts.max=5] - max requests per key per window.
 * @param {(req) => string} [opts.keyGenerator] - derives the bucket key.
 * @returns {import('express').RequestHandler}
 */
function rateLimit({ windowMs = 60000, max = 5, keyGenerator } = {}) {
  const keyOf = keyGenerator || ((req) => req.ip || 'unknown');
  // key -> { count, resetAt }. Per-instance; entries are reset lazily when their
  // window elapses (see below), so the map only holds keys seen this window.
  const buckets = new Map();

  return function rateLimiter(req, res, next) {
    const now = Date.now();
    const key = keyOf(req);
    let bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }

    bucket.count += 1;

    if (bucket.count > max) {
      const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      res.set('Retry-After', String(retryAfter));
      next(new AppError(
        'RATE_LIMITED',
        'Too many attempts. Please wait a minute and try again.',
        { status: 429 },
      ));
      return;
    }

    next();
  };
}

module.exports = { rateLimit };
