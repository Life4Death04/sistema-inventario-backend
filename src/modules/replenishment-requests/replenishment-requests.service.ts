/**
 * ReplenishmentRequestsService — business logic for the replenishment-requests module.
 *
 * Responsibilities (Phase 1 — read side):
 *   - create()            Resolve unitPrices, persist request + items.
 *   - list()              Paginated global list with filters.
 *   - getById()           Point read with 404 guard.
 *   - listBySupplier()    Supplier-scoped paginated list.
 *
 * Phase 2 (state transitions) — added in PR 2:
 *   send, receive, cancel.
 *
 * unitPrice resolution (spec §Create Request):
 *   1. Use the unitPrice provided in the request body item.
 *   2. If absent, look up ProductSupplier.referencePrice(supplierId, productId).
 *   3. If neither exists → 400 UNIT_PRICE_REQUIRED; nothing is persisted.
 *
 * This service does NOT import Express. Consumed by replenishment-requests.controller.ts.
 */
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { replenishmentRequestsRepository } from './replenishment-requests.repository.js';
import type {
  CreateReplenishmentRequestBody,
  ListReplenishmentRequestsQuery,
  ReplenishmentRequestDto,
  ReplenishmentRequestWithItemsDto,
  ReplenishmentRequestItemDto,
  PaginatedReplenishmentRequestsResponse,
} from './replenishment-requests.schema.js';
import type {
  ReplenishmentRequestRow,
  ReplenishmentRequestWithItemsRow,
  ReplenishmentRequestItemRow,
} from './replenishment-requests.repository.js';

// ---------------------------------------------------------------------------
// DTO mappers
// ---------------------------------------------------------------------------

/** Map a Date or null to ISO string or null. */
function toIso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

/** Map a raw request row to the API DTO (no items). */
function toDto(row: ReplenishmentRequestRow): ReplenishmentRequestDto {
  return {
    id: row.id,
    supplierId: row.supplierId,
    requestedByUserId: row.requestedByUserId,
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    sentAt: toIso(row.sentAt),
    receivedAt: toIso(row.receivedAt),
    receivedByUserId: row.receivedByUserId,
    cancelledAt: toIso(row.cancelledAt),
    cancelledByUserId: row.cancelledByUserId,
    notes: row.notes,
  };
}

/** Map a raw item row to the item DTO. */
function toItemDto(item: ReplenishmentRequestItemRow): ReplenishmentRequestItemDto {
  return {
    id: item.id,
    productId: item.productId,
    requestedQuantity: item.requestedQuantity,
    receivedQuantity: item.receivedQuantity,
    unitPrice: item.unitPrice.toNumber(),
  };
}

/** Map a raw request row with items to the full DTO. */
function toWithItemsDto(row: ReplenishmentRequestWithItemsRow): ReplenishmentRequestWithItemsDto {
  return {
    ...toDto(row),
    items: row.items.map(toItemDto),
  };
}

/** Assemble a pageSize-based paginated response. */
function paginateRequests(
  data: ReplenishmentRequestDto[],
  total: number,
  page: number,
  pageSize: number,
): PaginatedReplenishmentRequestsResponse {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return {
    data,
    meta: { page, pageSize, total, totalPages },
  };
}

// ---------------------------------------------------------------------------
// ReplenishmentRequestsService
// ---------------------------------------------------------------------------

export class ReplenishmentRequestsService {
  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a PENDING replenishment request.
   *
   * For each item:
   *   1. Use body.unitPrice when provided.
   *   2. Else look up ProductSupplier.referencePrice.
   *   3. Else throw 400 UNIT_PRICE_REQUIRED (nothing persisted).
   *
   * @param body     Validated request body.
   * @param actorId  Authenticated user id.
   */
  async create(
    body: CreateReplenishmentRequestBody,
    actorId: string,
  ): Promise<ReplenishmentRequestWithItemsDto> {
    // Resolve unitPrice for every item before touching the DB.
    const resolvedItems: Array<{
      productId: string;
      requestedQuantity: number;
      unitPrice: number;
    }> = [];

    for (const item of body.items) {
      let unitPrice: number;

      if (item.unitPrice !== undefined) {
        unitPrice = item.unitPrice;
      } else {
        const referencePrice = await replenishmentRequestsRepository.findReferencePrice(
          body.supplierId,
          item.productId,
        );

        if (referencePrice === null) {
          throw new AppError(
            ERROR_CODES.UNIT_PRICE_REQUIRED,
            400,
            `No unitPrice provided and no referencePrice found for product ${item.productId} with supplier ${body.supplierId}.`,
          );
        }

        unitPrice = referencePrice;
      }

      resolvedItems.push({
        productId: item.productId,
        requestedQuantity: item.requestedQuantity,
        unitPrice,
      });
    }

    const row = await replenishmentRequestsRepository.create({
      supplierId: body.supplierId,
      requestedByUserId: actorId,
      notes: body.notes,
      items: resolvedItems,
    });

    return toWithItemsDto(row);
  }

  // ── List ───────────────────────────────────────────────────────────────────

  /**
   * Paginated list of all requests with optional filters.
   */
  async list(
    query: ListReplenishmentRequestsQuery,
  ): Promise<PaginatedReplenishmentRequestsResponse> {
    const { page, pageSize, status, supplierId, dateFrom, dateTo } = query;

    const [rows, total] = await replenishmentRequestsRepository.findMany(
      { status, supplierId, dateFrom, dateTo },
      { page, pageSize },
    );

    return paginateRequests(rows.map(toDto), total, page, pageSize);
  }

  // ── Get by id ──────────────────────────────────────────────────────────────

  /**
   * Get a single request by id, embedding items.
   * Throws 404 REPLENISHMENT_REQUEST_NOT_FOUND when the request does not exist.
   */
  async getById(id: string): Promise<ReplenishmentRequestWithItemsDto> {
    const row = await replenishmentRequestsRepository.findById(id, { includeItems: true });

    if (!row) {
      throw new AppError(
        ERROR_CODES.REPLENISHMENT_REQUEST_NOT_FOUND,
        404,
        `Replenishment request not found: ${id}.`,
      );
    }

    return toWithItemsDto(row as ReplenishmentRequestWithItemsRow);
  }

  // ── Supplier-scoped list ───────────────────────────────────────────────────

  /**
   * Paginated list of requests for a specific supplier.
   */
  async listBySupplier(
    supplierId: string,
    query: ListReplenishmentRequestsQuery,
  ): Promise<PaginatedReplenishmentRequestsResponse> {
    const { page, pageSize } = query;

    const [rows, total] = await replenishmentRequestsRepository.findManyBySupplier(supplierId, {
      page,
      pageSize,
    });

    return paginateRequests(rows.map(toDto), total, page, pageSize);
  }
}

/** Singleton instance consumed by the replenishment-requests controller. */
export const replenishmentRequestsService = new ReplenishmentRequestsService();
