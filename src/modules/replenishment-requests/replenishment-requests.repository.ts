/**
 * ReplenishmentRequestsRepository — Prisma data-access layer.
 *
 * Responsibilities (Phase 1 — read side):
 *   - create()               Insert request + items in a transaction; resolve unitPrice from body.
 *   - findById()             Point read with optional items include.
 *   - findMany()             Paginated list with filters (AND-combined).
 *   - findManyBySupplier()   Supplier-scoped paginated list.
 *
 * Phase 2 (state transitions) — added in PR 2:
 *   transitionToSent, transitionToReceived, transitionToCancelled, updateItemReceivedQuantity.
 *
 * All methods are pure data-access; no business logic here.
 * Services apply guards, fallback resolution, and role checks on top.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/utils/prisma.js';
import type { ListReplenishmentRequestsQuery } from './replenishment-requests.schema.js';

// ---------------------------------------------------------------------------
// Select constants
// ---------------------------------------------------------------------------

/** Fields selected for a request row (no items). */
const REQUEST_SELECT = {
  id: true,
  supplierId: true,
  requestedByUserId: true,
  status: true,
  requestedAt: true,
  sentAt: true,
  receivedAt: true,
  receivedByUserId: true,
  cancelledAt: true,
  cancelledByUserId: true,
  notes: true,
} as const;

/** Fields selected for an item row. */
const ITEM_SELECT = {
  id: true,
  productId: true,
  requestedQuantity: true,
  receivedQuantity: true,
  unitPrice: true,
} as const;

/** Request select with items embedded. */
const REQUEST_WITH_ITEMS_SELECT = {
  ...REQUEST_SELECT,
  items: { select: ITEM_SELECT },
} as const;

// ---------------------------------------------------------------------------
// Internal data types returned by selects
// ---------------------------------------------------------------------------

/** Raw row from REQUEST_SELECT (dates as Date, unitPrice as Prisma.Decimal). */
export type ReplenishmentRequestRow = {
  id: string;
  supplierId: string;
  requestedByUserId: string;
  status: 'PENDING' | 'SENT' | 'RECEIVED' | 'CANCELLED';
  requestedAt: Date;
  sentAt: Date | null;
  receivedAt: Date | null;
  receivedByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  notes: string | null;
};

export type ReplenishmentRequestItemRow = {
  id: string;
  productId: string;
  requestedQuantity: number;
  receivedQuantity: number | null;
  unitPrice: { toNumber(): number };
};

export type ReplenishmentRequestWithItemsRow = ReplenishmentRequestRow & {
  items: ReplenishmentRequestItemRow[];
};

// ---------------------------------------------------------------------------
// Data bag for create
// ---------------------------------------------------------------------------

export type CreateRequestData = {
  supplierId: string;
  requestedByUserId: string;
  notes?: string;
  items: Array<{
    productId: string;
    requestedQuantity: number;
    /** Resolved unitPrice — must be provided (service resolves from body or referencePrice). */
    unitPrice: number;
  }>;
};

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class ReplenishmentRequestsRepository {
  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Insert a new replenishment request with its items in a single create call.
   * Prisma handles the nested create atomically.
   *
   * @param data  Resolved request data (unitPrices already resolved by service).
   * @param tx    Optional transaction client (for composition in future PR 2 transitions).
   */
  async create(
    data: CreateRequestData,
    tx?: Prisma.TransactionClient,
  ): Promise<ReplenishmentRequestWithItemsRow> {
    const client = tx ?? prisma;
    return client.replenishmentRequest.create({
      data: {
        supplierId: data.supplierId,
        requestedByUserId: data.requestedByUserId,
        notes: data.notes,
        items: {
          create: data.items.map((item) => ({
            productId: item.productId,
            requestedQuantity: item.requestedQuantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
      select: REQUEST_WITH_ITEMS_SELECT,
    }) as Promise<ReplenishmentRequestWithItemsRow>;
  }

  // ── Point read ─────────────────────────────────────────────────────────────

  /**
   * Find a single request by primary key.
   *
   * @param id            Request id.
   * @param includeItems  When true, embeds the items array.
   */
  async findById(
    id: string,
    options: { includeItems: boolean },
  ): Promise<ReplenishmentRequestWithItemsRow | ReplenishmentRequestRow | null> {
    if (options.includeItems) {
      return prisma.replenishmentRequest.findUnique({
        where: { id },
        select: REQUEST_WITH_ITEMS_SELECT,
      }) as Promise<ReplenishmentRequestWithItemsRow | null>;
    }

    return prisma.replenishmentRequest.findUnique({
      where: { id },
      select: REQUEST_SELECT,
    }) as Promise<ReplenishmentRequestRow | null>;
  }

  // ── Global paginated list ──────────────────────────────────────────────────

  /**
   * Paginated list of requests with optional filters (AND-combined).
   *
   * Filters:
   *   status      — exact match on ReplenishmentStatus enum
   *   supplierId  — exact match
   *   dateFrom    — requestedAt >= dateFrom (inclusive)
   *   dateTo      — requestedAt <= dateTo (inclusive)
   *
   * Sort: requestedAt DESC (fixed).
   * Returns [rows, total] tuple.
   */
  async findMany(
    filters: Pick<ListReplenishmentRequestsQuery, 'status' | 'supplierId' | 'dateFrom' | 'dateTo'>,
    pagination: { page: number; pageSize: number },
  ): Promise<[ReplenishmentRequestRow[], number]> {
    const { status, supplierId, dateFrom, dateTo } = filters;
    const { page, pageSize } = pagination;
    const skip = (page - 1) * pageSize;

    const where: Prisma.ReplenishmentRequestWhereInput = {};

    if (status) where.status = status;
    if (supplierId) where.supplierId = supplierId;

    if (dateFrom || dateTo) {
      where.requestedAt = {};
      if (dateFrom) where.requestedAt.gte = dateFrom;
      if (dateTo) where.requestedAt.lte = dateTo;
    }

    const [rows, total] = await Promise.all([
      prisma.replenishmentRequest.findMany({
        where,
        select: REQUEST_SELECT,
        orderBy: { requestedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.replenishmentRequest.count({ where }),
    ]);

    return [rows as ReplenishmentRequestRow[], total];
  }

  // ── Supplier-scoped list ───────────────────────────────────────────────────

  /**
   * Paginated list of requests scoped to a single supplier.
   * Shares the same select/sort as findMany but always filters by supplierId.
   * Returns [rows, total] tuple.
   */
  async findManyBySupplier(
    supplierId: string,
    pagination: { page: number; pageSize: number },
  ): Promise<[ReplenishmentRequestRow[], number]> {
    const { page, pageSize } = pagination;
    const skip = (page - 1) * pageSize;
    const where: Prisma.ReplenishmentRequestWhereInput = { supplierId };

    const [rows, total] = await Promise.all([
      prisma.replenishmentRequest.findMany({
        where,
        select: REQUEST_SELECT,
        orderBy: { requestedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.replenishmentRequest.count({ where }),
    ]);

    return [rows as ReplenishmentRequestRow[], total];
  }

  // ── ProductSupplier lookup (for unitPrice fallback) ────────────────────────

  /**
   * Find the referencePrice from the ProductSupplier join table.
   * Returns null when no row exists for the (supplierId, productId) pair,
   * or when the row exists but referencePrice is null.
   */
  async findReferencePrice(supplierId: string, productId: string): Promise<number | null> {
    const row = await prisma.productSupplier.findUnique({
      where: { productId_supplierId: { productId, supplierId } },
      select: { referencePrice: true },
    });

    if (!row || row.referencePrice === null) return null;
    return row.referencePrice.toNumber();
  }
}

/** Singleton instance consumed by the replenishment-requests service. */
export const replenishmentRequestsRepository = new ReplenishmentRequestsRepository();
