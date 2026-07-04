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

  /** Authenticated user account is inactive. */
  USER_INACTIVE: 'USER_INACTIVE',

  /** JWT access token has expired — client should refresh. */
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',

  /**
   * JWT access token signature is invalid or the token is malformed.
   * Alias: TOKEN_INVALID (design §5) — same semantic, spec uses INVALID_TOKEN.
   */
  INVALID_TOKEN: 'INVALID_TOKEN',

  /** @deprecated Use INVALID_TOKEN. Kept for backward-compat with design §5 refs. */
  TOKEN_INVALID: 'INVALID_TOKEN',

  /** No Bearer token was provided on a protected route. */
  MISSING_TOKEN: 'MISSING_TOKEN',

  /** @deprecated Use MISSING_TOKEN. Kept for backward-compat with prior Slice 3 code. */
  UNAUTHORIZED: 'MISSING_TOKEN',

  /** Refresh token cookie is absent on POST /api/auth/refresh. */
  MISSING_REFRESH_TOKEN: 'MISSING_REFRESH_TOKEN',

  /** Refresh token JWT is invalid, expired, revoked, or not found in DB. */
  INVALID_REFRESH_TOKEN: 'INVALID_REFRESH_TOKEN',

  /** Refresh token owner is inactive or no longer exists in DB. */
  USER_INACTIVE_OR_DELETED: 'USER_INACTIVE_OR_DELETED',

  /** Token is valid but the role is insufficient for this route. */
  FORBIDDEN: 'FORBIDDEN',

  /** Requested resource does not exist. */
  NOT_FOUND: 'NOT_FOUND',

  /** An inventory movement with the given id does not exist. */
  MOVEMENT_NOT_FOUND: 'MOVEMENT_NOT_FOUND',

  /**
   * The target product does not exist or is soft-deleted (inactive).
   * Used by the inventory-movements module for both createMovement and
   * listMovementsByProduct pre-checks.
   */
  PRODUCT_NOT_FOUND: 'PRODUCT_NOT_FOUND',

  /** Unique constraint or conflicting business state. */
  CONFLICT: 'CONFLICT',

  /** Too many requests from this IP within the configured window. */
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',

  /** Unhandled or unexpected server-side error. */
  INTERNAL_ERROR: 'INTERNAL_ERROR',

  // ---------------------------------------------------------------------------
  // Inventory movements
  // ---------------------------------------------------------------------------

  /**
   * The requested OUT or ADJUSTMENT operation would result in negative stock.
   * 409 — includes details: { productId, currentStock, attemptedDelta }.
   */
  INSUFFICIENT_STOCK: 'INSUFFICIENT_STOCK',

  /**
   * Optimistic-lock retry exhausted: another transaction updated the product
   * stock between the read and the write, and the retry attempt also lost the
   * race. 409.
   */
  STOCK_CONCURRENCY_CONFLICT: 'STOCK_CONCURRENCY_CONFLICT',

  /**
   * The authenticated user's role does not allow this movement type.
   * OPERATOR may only create OUT movements. 403.
   */
  FORBIDDEN_MOVEMENT_TYPE: 'FORBIDDEN_MOVEMENT_TYPE',

  /**
   * The HTTP method used is not allowed for this resource.
   * Returned as 405 with an `Allow` header listing permitted methods.
   */
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',

  // ---------------------------------------------------------------------------
  // Replenishment requests
  // ---------------------------------------------------------------------------

  /**
   * The requested ReplenishmentRequest does not exist. 404.
   */
  REPLENISHMENT_REQUEST_NOT_FOUND: 'REPLENISHMENT_REQUEST_NOT_FOUND',

  /**
   * State-machine transition not allowed from the current status, or the
   * status-CAS (updateMany) matched 0 rows (concurrent transition). 409.
   */
  INVALID_STATE_TRANSITION: 'INVALID_STATE_TRANSITION',

  /**
   * An item omits unitPrice and no ProductSupplier.referencePrice exists for
   * the (supplierId, productId) pair. 400.
   */
  UNIT_PRICE_REQUIRED: 'UNIT_PRICE_REQUIRED',

  /**
   * A receivedQuantity value is negative or greater than the item quantity. 400.
   */
  PARTIAL_RECEIPT_INVALID: 'PARTIAL_RECEIPT_INVALID',

  /**
   * Send was called but the supplier's whatsapp field is null or blank. 422.
   */
  SUPPLIER_HAS_NO_WHATSAPP: 'SUPPLIER_HAS_NO_WHATSAPP',

  /**
   * The create body has an empty items array (items:[]).
   * Mapped from a Zod .min(1) sentinel in the validate middleware. 400.
   */
  REPLENISHMENT_ITEMS_REQUIRED: 'REPLENISHMENT_ITEMS_REQUIRED',

  /**
   * The receive body references an item id not belonging to the request. 400.
   */
  REPLENISHMENT_ITEM_NOT_FOUND: 'REPLENISHMENT_ITEM_NOT_FOUND',

  // ---------------------------------------------------------------------------
  // Alerts
  // ---------------------------------------------------------------------------

  /**
   * No alert with the given id exists. 404.
   */
  ALERT_NOT_FOUND: 'ALERT_NOT_FOUND',
} as const;

/** Union type of all valid error codes. */
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
