/**
 * Canonical error codes for the API.
 *
 * These string constants are the stable, machine-readable `error` field
 * returned in every error response envelope. Clients should branch on these
 * values, not on HTTP status codes alone.
 *
 * Usage:
 *   throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Product not found');
 */
export const ERROR_CODES = {
  /** Zod validation failed on body, params, or query. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',

  /** Email or password does not match any active user. */
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',

  /** JWT access token has expired — client should refresh. */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  /** JWT signature is invalid or the token is malformed. */
  TOKEN_INVALID: 'TOKEN_INVALID',

  /** No Bearer token was provided on a protected route. */
  UNAUTHORIZED: 'UNAUTHORIZED',

  /** Token is valid but the role is insufficient for this route. */
  FORBIDDEN: 'FORBIDDEN',

  /** Requested resource does not exist. */
  NOT_FOUND: 'NOT_FOUND',

  /** Unique constraint or conflicting business state. */
  CONFLICT: 'CONFLICT',

  /** Too many requests from this IP within the configured window. */
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  /** Unhandled or unexpected server-side error. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

/** Union type of all valid error codes. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
