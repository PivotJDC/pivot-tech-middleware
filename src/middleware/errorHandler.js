/**
 * Error handling layer: the AppError type, named error factories, the Express
 * error-handling middleware, a 404 handler, and an async route wrapper.
 *
 * Every client-facing error is rendered with the envelope from CLAUDE.md:
 *   { "error": { "code", "message", "field"?, "trace_id" } }
 *
 * Throw an AppError (or use the `errors.*` factories) anywhere in a request and
 * it will be serialized here. Anything else that bubbles up is treated as an
 * unexpected 500 — its real message is logged but never returned to the client.
 */

// Canonical error codes (CLAUDE.md "Error codes") mapped to HTTP status.
const CODE_STATUS = {
  VALIDATION_ERROR: 400,
  NOT_FOUND: 404,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  DID_UNAVAILABLE: 409,
  PORT_ALREADY_PENDING: 409,
  PORT_SUBMISSION_FAILED: 502,
  TOKEN_EXPIRED: 401,
  // TELNYX_ERROR is the migrated equivalent of SIGNALWIRE_ERROR; the latter is
  // retained for the not-yet-migrated inbound webhook path.
  TELNYX_ERROR: 502,
  SIGNALWIRE_ERROR: 502,
  // BICS SIMforThings (cellular data / eSIM vendor) API failure.
  BICS_ERROR: 502,
  INTERNAL_ERROR: 500,
};

class AppError extends Error {
  /**
   * @param {string} code - one of CODE_STATUS.
   * @param {string} message - human-readable, safe to return to the client.
   * @param {{ field?: string, status?: number }} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code in CODE_STATUS ? code : 'INTERNAL_ERROR';
    this.status = opts.status || CODE_STATUS[this.code] || 500;
    if (opts.field) this.field = opts.field;
    // Marks errors we deliberately surface, vs unexpected crashes.
    this.isOperational = true;
  }
}

// Named factories for the errors this codebase actually throws. `status`
// overrides let a code reuse a different HTTP status (e.g. a 409 conflict that
// is still semantically a VALIDATION_ERROR).
const errors = {
  validation: (message, field) => new AppError('VALIDATION_ERROR', message, { field }),
  conflict: (message, field) => new AppError('VALIDATION_ERROR', message, { field, status: 409 }),
  notFound: (message = 'Resource not found.') => new AppError('NOT_FOUND', message),
  unauthorized: (message = 'Authentication required.') => new AppError('UNAUTHORIZED', message),
  forbidden: (message = 'Not permitted.') => new AppError('FORBIDDEN', message),
  tokenExpired: (message = 'Token has expired.') => new AppError('TOKEN_EXPIRED', message),
  internal: (message = 'An unexpected error occurred.') => new AppError('INTERNAL_ERROR', message),
};

/**
 * Wrap an async route handler so a rejected promise is forwarded to next()
 * instead of crashing the process. Usage: router.get('/', asyncHandler(fn)).
 */
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/** 404 handler — mount after all routes, before the error middleware. */
function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: `No route for ${req.method} ${req.path}.`,
      trace_id: req.id,
    },
  });
}

/**
 * Terminal error-handling middleware. Must be mounted last and must keep the
 * 4-arg signature so Express recognizes it as an error handler.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const isAppError = err instanceof AppError;
  const status = isAppError ? err.status : 500;

  // Log full detail for unexpected errors; AppErrors are expected control flow.
  if (!isAppError || status >= 500) {
    if (req.log) req.log.error({ err }, 'request failed');
  }

  res.status(status).json({
    error: {
      code: isAppError ? err.code : 'INTERNAL_ERROR',
      message: isAppError ? err.message : 'An unexpected error occurred.',
      ...(isAppError && err.field ? { field: err.field } : {}),
      trace_id: req.id,
    },
  });
}

module.exports = {
  AppError,
  errors,
  asyncHandler,
  notFoundHandler,
  errorHandler,
  CODE_STATUS,
};
