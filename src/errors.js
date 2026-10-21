'use strict';

/**
 * A business error with an HTTP status and a stable machine-readable code.
 * Every error response uses one shape: { code, message, request_id }.
 */
class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

function errorBody(code, message, requestId) {
  return { code, message, request_id: requestId };
}

module.exports = { AppError, errorBody };
