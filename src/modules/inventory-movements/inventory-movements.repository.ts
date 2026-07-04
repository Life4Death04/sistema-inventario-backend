/**
 * InventoryMovementsRepository — Prisma data-access layer for the inventory-movements module.
 *
 * Responsibilities:
 *   - findProductActive()         Read product with active guard (for optimistic-lock loop).
 *   - attemptStockUpdate()        Compare-and-swap stock update inside a transaction.
 *   - insertMovement()            Append an immutable movement record inside a transaction.
 *   - findMovementById()          Point read for GET /api/inventory-movements/:id.
 *   - listMovements()             Paginated list with optional filters — parallel findMany + count.
 *   - listMovementsByProduct()    Product-scoped paginated list — parallel findMany + count.
 *
 * Concurrency design (D3):
 *   attemptStockUpdate uses updateMany with a WHERE clause that includes the observed stock
 *   value (compare-and-swap). If `count === 0`, the update lost the race and the service
 *   must retry. The method itself does NOT throw on count=0 — it returns the count so
 *   the caller decides (sentinel throw lives in the service transaction wrapper).
 *
 * All methods are pure data-access; no business logic here.
 * Services apply guards, retry loops, and role checks on top.
 */
import type { Prisma, AdjustmentDirection, MovementType } from '@prisma/client';
import { prisma } from '../../shared/utils/prisma.js';
import type {
  ListMovementsQuery,
  ListMovementsByProductQuery,
} from './inventory-movements.schema.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Minimal product record for the optimistic-lock read. */
export type ActiveProductRecord = {
  id: string;
  stock: number;
  minStock: number;
  active: boolean;
};

/** Data bag accepted by insertMovement — all values computed by the service. */
export type InsertMovementData = {
  productId: string;
  userId: string;
  type: MovementType;
  adjustmentDirection: AdjustmentDirection | null;
  quantity: number;
  resultingStock: number;
  reason: string;
};

export type MovementProductSummaryRow = {
  id: string;
  name: string;
  code: string;
};

export type MovementUserSummaryRow = {
  id: string;
  fullName: string;
};

export type MovementRow = {
  id: string;
  productId: string;
  userId: string;
  product: MovementProductSummaryRow;
  user: MovementUserSummaryRow;
  type: MovementType;
  adjustmentDirection: AdjustmentDirection | null;
  quantity: number;
  resultingStock: number;
  reason: string;
  createdAt: Date;
};

const PRODUCT_SUMMARY_SELECT = {
  id: true,
  name: true,
  code: true,
} as const;

const USER_SUMMARY_SELECT = {
  id: true,
  fullName: true,
} as const;

/** Fields selected for movement responses. */
const MOVEMENT_SELECT = {
  id: true,
  productId: true,
  userId: true,
  type: true,
  adjustmentDirection: true,
  quantity: true,
  resultingStock: true,
  reason: true,
  createdAt: true,
  product: { select: PRODUCT_SUMMARY_SELECT },
  user: { select: USER_SUMMARY_SELECT },
} as const;

// ---------------------------------------------------------------------------
// InventoryMovementsRepository
// ---------------------------------------------------------------------------

export class InventoryMovementsRepository {
  // ── Product read (for optimistic-lock loop) ────────────────────────────────

  /**
   * Fetch a product's id, stock, and active flag.
   * Returns null when the product does not exist at all (not just inactive).
   * Callers must check `active` separately to distinguish "not found" vs "inactive".
   */
  async findProductActive(productId: string): Promise<ActiveProductRecord | null> {
    return prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, stock: true, minStock: true, active: true },
    });
  }

  // ── Optimistic-lock stock update ───────────────────────────────────────────

  /**
   * Attempt a compare-and-swap stock update inside an open transaction.
   *
   * Uses updateMany with WHERE { id: productId, stock: observedStock, active: true }
   * so that the update is a no-op (count = 0) when another transaction already
   * changed the stock since we last read it.
   *
   * Returns the number of rows updated (0 or 1). Caller interprets:
   *   - 1 → update succeeded, continue to insert movement.
   *   - 0 → lost the race; service must retry or throw STOCK_CONCURRENCY_CONFLICT.
   *
   * @param tx            Prisma transaction client (from prisma.$transaction callback).
   * @param productId     Product to update.
   * @param observedStock Stock value read before this attempt — the guard value.
   * @param nextStock     New stock value to set if the guard passes.
   */
  async attemptStockUpdate(
    tx: Prisma.TransactionClient,
    productId: string,
    observedStock: number,
    nextStock: number,
  ): Promise<number> {
    const result = await tx.product.updateMany({
      where: { id: productId, stock: observedStock, active: true },
      data: { stock: nextStock },
    });
    return result.count;
  }

  // ── Movement insert (within a transaction) ─────────────────────────────────

  /**
   * Append an immutable InventoryMovement row inside an open transaction.
   * Must be called AFTER attemptStockUpdate returns count = 1 to ensure
   * stock and movement are committed atomically.
   *
   * @param tx    Prisma transaction client.
   * @param data  Computed movement values from the service.
   */
  async insertMovement(
    tx: Prisma.TransactionClient,
    data: InsertMovementData,
  ): Promise<MovementRow> {
    return tx.inventoryMovement.create({
      data: {
        productId: data.productId,
        userId: data.userId,
        type: data.type,
        adjustmentDirection: data.adjustmentDirection ?? undefined,
        quantity: data.quantity,
        resultingStock: data.resultingStock,
        reason: data.reason,
      },
      select: MOVEMENT_SELECT,
    }) as Promise<MovementRow>;
  }

  // ── Point read ─────────────────────────────────────────────────────────────

  /**
   * Find a single movement by primary key.
   * Returns null when not found.
   */
  async findMovementById(id: string): Promise<MovementRow | null> {
    return prisma.inventoryMovement.findUnique({
      where: { id },
      select: MOVEMENT_SELECT,
    }) as Promise<MovementRow | null>;
  }

  // ── Global list ────────────────────────────────────────────────────────────

  /**
   * Paginated list of movements with optional filters (AND-combined).
   *
   * Filters:
   *   productId — exact match
   *   type      — exact match on MovementType enum
   *   from      — createdAt >= from (inclusive)
   *   to        — createdAt <= to (inclusive)
   *
   * Sort: createdAt DESC (fixed, not configurable this slice).
   * Parallel findMany + count for efficient pagination.
   *
   * Returns [rows, total] tuple so the service can build the paginated envelope.
   */
  async listMovements(query: ListMovementsQuery): Promise<[MovementRow[], number]> {
    const { page, limit, productId, type, from, to } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.InventoryMovementWhereInput = {};

    if (productId) where.productId = productId;
    if (type) where.type = type;

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const [rows, total] = await Promise.all([
      prisma.inventoryMovement.findMany({
        where,
        select: MOVEMENT_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.inventoryMovement.count({ where }),
    ]);

    return [rows as MovementRow[], total];
  }

  // ── Product-scoped list ────────────────────────────────────────────────────

  /**
   * Paginated list of movements scoped to a single product.
   *
   * Same filter/sort logic as listMovements but productId comes from the URL
   * param (already validated) rather than an optional query param.
   * The caller (service) must verify the product exists and is active before
   * calling this method — the repo does NOT check product existence.
   *
   * Returns [rows, total] tuple.
   */
  async listMovementsByProduct(
    productId: string,
    query: ListMovementsByProductQuery,
  ): Promise<[MovementRow[], number]> {
    const { page, limit, type, from, to } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.InventoryMovementWhereInput = { productId };

    if (type) where.type = type;

    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = from;
      if (to) where.createdAt.lte = to;
    }

    const [rows, total] = await Promise.all([
      prisma.inventoryMovement.findMany({
        where,
        select: MOVEMENT_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.inventoryMovement.count({ where }),
    ]);

    return [rows as MovementRow[], total];
  }
}

/** Singleton instance consumed by the inventory-movements service. */
export const inventoryMovementsRepository = new InventoryMovementsRepository();
