/**
 * AppError — base operational error class.
 *
 * All domain errors thrown by services and controllers extend or instantiate
 * this class. The global errorHandler middleware identifies AppError instances
 * via the `isAppError()` type guard and maps them to structured JSON responses.
 *
 * @param code     Machine-readable error code (see errorCodes.ts).
 * @param statusCode  HTTP status code to respond with.
 * @param message  Human-readable explanation of the error.
 * @param details  Optional extra context (field errors, metadata). Omitted on
 *                 INTERNAL_ERROR responses to avoid leaking internals.
 */
export class AppError extends Error {
  public override readonly name = 'AppError';

  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    // Restore prototype chain so `instanceof AppError` works after transpilation.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Type guard — returns true when the value is an AppError instance.
 * Safe to use in error middleware where the thrown value is typed as `unknown`.
 */
export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
