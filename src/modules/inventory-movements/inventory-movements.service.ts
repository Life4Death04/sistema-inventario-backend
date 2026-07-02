/**
 * InventoryMovementsService — business logic for the inventory-movements module.
 *
 * Responsibilities:
 *   - Role guard: OPERATOR may only create OUT movements (D4).
 *   - ADJUSTMENT translator: converts signed quantity → positive quantity + AdjustmentDirection.
 *   - createMovement(): transactional optimistic-lock retry loop (max 2 attempts) (D3).
 *   - getMovement(): point read with 404 guard.
 *   - listMovements(): paginated global list.
 *   - listMovementsByProduct(): paginated product-scoped list with product existence pre-check.
 *
 * Concurrency design (D3 — must match spec R1 exactly):
 *   Outer for-loop (max 2 attempts) wraps prisma.$transaction. Inside the tx:
 *     1. Read product (active only) — 404 if missing or inactive.
 *     2. Compute nextStock based on type and magnitude.
 *     3. Reject if nextStock < 0 → 409 INSUFFICIENT_STOCK (business rule, not a race).
 *     4. attemptStockUpdate() — compare-and-swap via updateMany.
 *     5. If count = 0 → throw ConcurrencyRetryError sentinel (rolls back tx, signals retry).
 *     6. If count = 1 → insertMovement() atomically.
 *   Outer loop catches ONLY ConcurrencyRetryError. After 2 misses → 409 STOCK_CONCURRENCY_CONFLICT.
 *
 * This service does NOT import Express. Consumed by inventory-movements.controller.ts.
 */
import { AdjustmentDirection, MovementType } from '@prisma/client';
import type { UserRole } from '@prisma/client';
import { prisma } from '../../shared/utils/prisma.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { paginate, type PaginatedResponse } from '../../shared/pagination/index.js';
import { inventoryMovementsRepository } from './inventory-movements.repository.js';
import type {
  CreateMovementDto,
  MovementDto,
  ListMovementsQuery,
  ListMovementsByProductQuery,
} from './inventory-movements.schema.js';

// ---------------------------------------------------------------------------
// Internal sentinel — signals a lost CAS race so the outer loop can retry
// ---------------------------------------------------------------------------

/** Thrown inside the tx when attemptStockUpdate returns count = 0. */
class ConcurrencyRetryError extends Error {
  constructor() {
    super('Stock compare-and-swap lost the race — retry.');
    this.name = 'ConcurrencyRetryError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Compute the stock delta from the validated DTO (signed for ADJUSTMENT, positive for IN/OUT). */
function computeDelta(dto: CreateMovementDto): number {
  switch (dto.type) {
    case 'IN':
      return dto.quantity; // positive — adds to stock
    case 'OUT':
      return -dto.quantity; // negative — subtracts from stock
    case 'ADJUSTMENT':
      return dto.quantity; // already signed; negative = DECREASE, positive = INCREASE
  }
}

/**
 * Translate a validated ADJUSTMENT DTO's signed quantity to:
 *   - adjustmentDirection: INCREASE | DECREASE
 *   - quantity: absolute magnitude (always positive for persistence)
 *
 * The API contract accepts a signed quantity; the DB stores direction + positive magnitude.
 */
function translateAdjustment(signedQty: number): {
  adjustmentDirection: AdjustmentDirection;
  quantity: number;
} {
  return signedQty > 0
    ? { adjustmentDirection: AdjustmentDirection.INCREASE, quantity: signedQty }
    : { adjustmentDirection: AdjustmentDirection.DECREASE, quantity: Math.abs(signedQty) };
}

// ---------------------------------------------------------------------------
// InventoryMovementsService
// ---------------------------------------------------------------------------

export class InventoryMovementsService {
  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a stock movement with optimistic-lock retry (max 2 attempts).
   *
   * Guards (in order):
   *   1. 403 FORBIDDEN_MOVEMENT_TYPE — OPERATOR may only create OUT.
   *   2. Retry loop (up to 2 attempts):
   *      a. 404 PRODUCT_NOT_FOUND — product does not exist or is inactive.
   *      b. 409 INSUFFICIENT_STOCK — resultingStock would be negative.
   *      c. compare-and-swap via updateMany; count=0 → retry sentinel.
   *      d. insert movement atomically with the stock update.
   *   3. 409 STOCK_CONCURRENCY_CONFLICT after 2 failed CAS attempts.
   *
   * @param dto      Validated and parsed request body (from createMovementSchema).
   * @param actorId  Authenticated user id (from req.user.id).
   * @param actorRole Authenticated user role (from req.user.role).
   */
  async createMovement(
    dto: CreateMovementDto,
    actorId: string,
    actorRole: UserRole,
  ): Promise<MovementDto> {
    // Guard 1: OPERATOR role restriction (D4).
    if (actorRole === 'OPERATOR' && dto.type !== MovementType.OUT) {
      throw new AppError(
        ERROR_CODES.FORBIDDEN_MOVEMENT_TYPE,
        403,
        `Role OPERATOR may only create OUT movements. Attempted: ${dto.type}.`,
      );
    }

    // Pre-compute the signed delta once — same value for all retry attempts.
    const delta = computeDelta(dto);

    // Resolve adjustmentDirection and stored quantity (ADJUSTMENT only).
    const { adjustmentDirection, storedQuantity } = resolveMovementFields(dto);

    // Retry loop — max 2 attempts (1 initial + 1 retry).
    const MAX_ATTEMPTS = 2;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const movement = await prisma.$transaction(async (tx) => {
          // Step a: Read product — must exist and be active.
          const product = await inventoryMovementsRepository.findProductActive(dto.productId);

          if (!product || !product.active) {
            throw new AppError(
              ERROR_CODES.PRODUCT_NOT_FOUND,
              404,
              `Product not found: ${dto.productId}.`,
            );
          }

          const observedStock = product.stock;
          const nextStock = observedStock + delta;

          // Step b: Business rule — stock must remain non-negative.
          if (nextStock < 0) {
            throw new AppError(
              ERROR_CODES.INSUFFICIENT_STOCK,
              409,
              `Insufficient stock. Cannot apply movement of ${delta} to current stock of ${observedStock}.`,
              {
                productId: dto.productId,
                currentStock: observedStock,
                attemptedDelta: delta,
              },
            );
          }

          // Step c: Compare-and-swap stock update.
          const count = await inventoryMovementsRepository.attemptStockUpdate(
            tx,
            dto.productId,
            observedStock,
            nextStock,
          );

          if (count === 0) {
            // Another transaction updated stock between our read and write.
            // Throw sentinel to roll back this tx and trigger the outer retry.
            throw new ConcurrencyRetryError();
          }

          // Step d: Append the movement record atomically.
          return inventoryMovementsRepository.insertMovement(tx, {
            productId: dto.productId,
            userId: actorId,
            type: dto.type as MovementType,
            adjustmentDirection,
            quantity: storedQuantity,
            resultingStock: nextStock,
            reason: dto.reason,
          });
        });

        return movement;
      } catch (err) {
        // Re-throw everything that is NOT our retry sentinel.
        if (!(err instanceof ConcurrencyRetryError)) {
          throw err;
        }

        // Last attempt exhausted — raise 409 STOCK_CONCURRENCY_CONFLICT.
        if (attempt === MAX_ATTEMPTS) {
          throw new AppError(
            ERROR_CODES.STOCK_CONCURRENCY_CONFLICT,
            409,
            'Stock update failed due to concurrent modification. Please retry the request.',
          );
        }

        // Otherwise loop continues for the next attempt.
      }
    }

    // TypeScript exhaustion guard — the loop always returns or throws.
    /* istanbul ignore next */
    throw new AppError(
      ERROR_CODES.INTERNAL_ERROR,
      500,
      'Unexpected exit from createMovement retry loop.',
    );
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  /**
   * Get a single movement by id.
   * Throws 404 MOVEMENT_NOT_FOUND when the movement does not exist.
   */
  async getMovement(id: string): Promise<MovementDto> {
    const movement = await inventoryMovementsRepository.findMovementById(id);
    if (!movement) {
      throw new AppError(ERROR_CODES.MOVEMENT_NOT_FOUND, 404, `Movement not found: ${id}.`);
    }
    return movement;
  }

  // ── Global list ────────────────────────────────────────────────────────────

  /**
   * Paginated list of all movements with optional filters.
   * No product existence check needed — productId filter is optional.
   */
  async listMovements(query: ListMovementsQuery): Promise<PaginatedResponse<MovementDto>> {
    const [data, total] = await inventoryMovementsRepository.listMovements(query);
    return paginate({ data, total, page: query.page, limit: query.limit });
  }

  // ── Product-scoped list ────────────────────────────────────────────────────

  /**
   * Paginated list of movements for a specific product.
   *
   * Pre-check (spec R4): the product must exist AND be active. If missing or
   * inactive → 404 PRODUCT_NOT_FOUND (matches products-crud idempotency guard from spec §Assumptions).
   * An empty movement history for a valid active product returns 200 data:[].
   */
  async listMovementsByProduct(
    productId: string,
    query: ListMovementsByProductQuery,
  ): Promise<PaginatedResponse<MovementDto>> {
    // Pre-check: product must exist and be active.
    const product = await inventoryMovementsRepository.findProductActive(productId);
    if (!product || !product.active) {
      throw new AppError(ERROR_CODES.PRODUCT_NOT_FOUND, 404, `Product not found: ${productId}.`);
    }

    const [data, total] = await inventoryMovementsRepository.listMovementsByProduct(
      productId,
      query,
    );
    return paginate({ data, total, page: query.page, limit: query.limit });
  }
}

// ---------------------------------------------------------------------------
// Internal field resolver (outside class to keep createMovement readable)
// ---------------------------------------------------------------------------

/**
 * Resolve adjustmentDirection and stored quantity for a movement DTO.
 * - IN / OUT: no direction, quantity stored as-is (already positive from schema).
 * - ADJUSTMENT: translate signed quantity to direction + absolute magnitude.
 */
function resolveMovementFields(dto: CreateMovementDto): {
  adjustmentDirection: AdjustmentDirection | null;
  storedQuantity: number;
} {
  if (dto.type === 'ADJUSTMENT') {
    const { adjustmentDirection, quantity: absQty } = translateAdjustment(dto.quantity);
    return { adjustmentDirection, storedQuantity: absQty };
  }
  // IN / OUT — quantity is already a positive integer from the schema.
  return { adjustmentDirection: null, storedQuantity: dto.quantity };
}

/** Singleton instance consumed by the inventory-movements controller. */
export const inventoryMovementsService = new InventoryMovementsService();
