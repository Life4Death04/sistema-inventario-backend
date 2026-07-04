/**
 * ReplenishmentRequestsRepository — Prisma data-access layer.
 *
 * Responsibilities:
 *   - create()                        Insert request + items; resolve unitPrice from body.
 *   - findById()                      Point read with optional items include.
 *   - findMany()                      Paginated list with filters (AND-combined).
 *   - findManyBySupplier()            Supplier-scoped paginated list.
 *   - transitionToSent()              Status-CAS PENDING → SENT; returns updateMany count.
 *   - transitionToReceived()          Status-CAS SENT → RECEIVED; stamps audit fields.
 *   - transitionToCancelled()         Status-CAS PENDING|SENT → CANCELLED; stamps audit fields.
 *   - updateItemReceivedQuantity()    Persist receivedQuantity on a single item inside a tx.
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

const SUPPLIER_SUMMARY_SELECT = {
  id: true,
  name: true,
} as const;

const USER_SUMMARY_SELECT = {
  id: true,
  fullName: true,
} as const;

const PRODUCT_SUMMARY_SELECT = {
  id: true,
  name: true,
  code: true,
} as const;

/** Fields selected for a request row (base scalar fields). */
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

const LIST_ITEM_METRICS_SELECT = {
  requestedQuantity: true,
  unitPrice: true,
} as const;

/** Fields selected for an item row. */
const ITEM_SELECT = {
  id: true,
  productId: true,
  requestedQuantity: true,
  receivedQuantity: true,
  unitPrice: true,
} as const;

const REQUEST_LIST_SELECT = {
  ...REQUEST_SELECT,
  supplier: { select: SUPPLIER_SUMMARY_SELECT },
  requestedByUser: { select: USER_SUMMARY_SELECT },
  items: { select: LIST_ITEM_METRICS_SELECT },
} as const;

/** Request select with detail relations embedded. */
const REQUEST_WITH_ITEMS_SELECT = {
  ...REQUEST_SELECT,
  supplier: { select: SUPPLIER_SUMMARY_SELECT },
  requestedByUser: { select: USER_SUMMARY_SELECT },
  items: {
    select: {
      ...ITEM_SELECT,
      product: { select: PRODUCT_SUMMARY_SELECT },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Internal data types returned by selects
// ---------------------------------------------------------------------------

/** Raw row from REQUEST_SELECT (dates as Date, unitPrice as Prisma.Decimal). */
type DecimalLike = { toNumber(): number };

export type ReplenishmentSupplierSummaryRow = {
  id: string;
  name: string;
};

export type ReplenishmentUserSummaryRow = {
  id: string;
  fullName: string;
};

export type ReplenishmentProductSummaryRow = {
  id: string;
  name: string;
  code: string;
};

type ReplenishmentRequestBaseRow = {
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
  supplier: ReplenishmentSupplierSummaryRow;
  requestedByUser: ReplenishmentUserSummaryRow;
};

export type ReplenishmentRequestRow = ReplenishmentRequestBaseRow & {
  items: Array<{
    requestedQuantity: number;
    unitPrice: DecimalLike;
  }>;
};

export type ReplenishmentRequestItemRow = {
  id: string;
  productId: string;
  requestedQuantity: number;
  receivedQuantity: number | null;
  unitPrice: DecimalLike;
  product: ReplenishmentProductSummaryRow;
};

export type ReplenishmentRequestWithItemsRow = ReplenishmentRequestBaseRow & {
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
      select: REQUEST_LIST_SELECT,
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
        select: REQUEST_LIST_SELECT,
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
        select: REQUEST_LIST_SELECT,
        orderBy: { requestedAt: 'desc' },
        skip,
        take: pageSize,
      }),
      prisma.replenishmentRequest.count({ where }),
    ]);

    return [rows as ReplenishmentRequestRow[], total];
  }

  // ── State-transition methods (Phase 2 — PR 2) ─────────────────────────────

  /**
   * CAS transition: PENDING → SENT.
   *
   * Uses updateMany with the status guard so that a concurrent caller gets
   * count=0 and can throw INVALID_STATE_TRANSITION (409).
   *
   * @param tx      Prisma transaction client.
   * @param id      Request id.
   * @param userId  Actor that performed the send (stored in sentAt timestamp).
   * @returns       Number of rows updated (1 on success, 0 on race or wrong status).
   */
  async transitionToSent(
    tx: Prisma.TransactionClient,
    id: string,
    userId: string,
  ): Promise<number> {
    const result = await tx.replenishmentRequest.updateMany({
      where: { id, status: 'PENDING' },
      data: {
        status: 'SENT',
        sentAt: new Date(),
        // Note: sentByUserId is not a schema field; we use requestedByUserId for send actor context.
        // The audit trail uses sentAt alone for SEND (spec §Send does not define a sentByUserId field).
      },
    });
    // Suppress unused parameter warning — userId reserved for future audit expansion.
    void userId;
    return result.count;
  }

  /**
   * CAS transition: SENT → RECEIVED.
   *
   * Stamps receivedAt + receivedByUserId. Must run inside the same $transaction
   * as stock updates and movement inserts for atomicity.
   *
   * @param tx      Prisma transaction client.
   * @param id      Request id.
   * @param userId  Actor receiving the order (stored in receivedByUserId).
   * @returns       Number of rows updated (1 on success, 0 on race or wrong status).
   */
  async transitionToReceived(
    tx: Prisma.TransactionClient,
    id: string,
    userId: string,
  ): Promise<number> {
    const result = await tx.replenishmentRequest.updateMany({
      where: { id, status: 'SENT' },
      data: {
        status: 'RECEIVED',
        receivedAt: new Date(),
        receivedByUserId: userId,
      },
    });
    return result.count;
  }

  /**
   * CAS transition: PENDING|SENT → CANCELLED.
   *
   * The priorStatus guard prevents double-cancellation and ensures terminal
   * states (RECEIVED, CANCELLED) are rejected with count=0.
   *
   * @param tx           Prisma transaction client.
   * @param id           Request id.
   * @param userId       Actor cancelling the order (stored in cancelledByUserId).
   * @param priorStatus  The status the request must currently have ('PENDING' | 'SENT').
   * @returns            Number of rows updated (1 on success, 0 on race or wrong status).
   */
  async transitionToCancelled(
    tx: Prisma.TransactionClient,
    id: string,
    userId: string,
    priorStatus: 'PENDING' | 'SENT',
  ): Promise<number> {
    const result = await tx.replenishmentRequest.updateMany({
      where: { id, status: priorStatus },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        cancelledByUserId: userId,
      },
    });
    return result.count;
  }

  /**
   * Persist the received quantity on a single replenishment request item.
   * Must run inside the same $transaction as transitionToReceived and stock updates.
   *
   * @param tx      Prisma transaction client.
   * @param itemId  Item id to update.
   * @param qty     The quantity actually received.
   */
  async updateItemReceivedQuantity(
    tx: Prisma.TransactionClient,
    itemId: string,
    qty: number,
  ): Promise<void> {
    await tx.replenishmentRequestItem.update({
      where: { id: itemId },
      data: { receivedQuantity: qty },
    });
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
