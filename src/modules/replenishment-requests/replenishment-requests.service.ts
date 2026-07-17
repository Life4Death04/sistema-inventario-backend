/**
 * ReplenishmentRequestsService — business logic for the replenishment-requests module.
 *
 * Responsibilities:
 *   - create()            Resolve unitPrices, persist request + items.
 *   - list()              Paginated global list with filters.
 *   - getById()           Point read with 404 guard.
 *   - listBySupplier()    Supplier-scoped paginated list.
 *   - send()              Transition PENDING → SENT; fire WhatsApp after commit.
 *   - receive()           Transition SENT → RECEIVED in a single $transaction with stock posting.
 *   - cancel()            Transition PENDING|SENT → CANCELLED; fire WhatsApp only when prior SENT.
 *
 * unitPrice resolution (spec §Create Request):
 *   1. Use the unitPrice provided in the request body item.
 *   2. If absent, look up ProductSupplier.referencePrice(supplierId, productId).
 *   3. If neither exists → unitPrice is stored as null (price is optional).
 *
 * Twilio timing: fire-and-forget AFTER commit (.catch(logger.error)).
 *   DB truth > delivery guarantee (design §Architecture Decisions).
 *
 * This service does NOT import Express. Consumed by replenishment-requests.controller.ts.
 */
import { AppError } from '../../shared/errors/AppError.js';
import { Prisma } from '@prisma/client';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { prisma } from '../../shared/utils/prisma.js';
import logger from '../../shared/logger/index.js';
import { alertsRepository } from '../alerts/alerts.repository.js';
import {
  notificationService,
  normalizeE164,
  buildSentTemplate,
  buildCancelledTemplate,
} from '../../shared/notifications/index.js';
import { inventoryMovementsRepository } from '../inventory-movements/inventory-movements.repository.js';
import { replenishmentRequestsRepository } from './replenishment-requests.repository.js';
import type {
  CreateReplenishmentRequestBody,
  ListReplenishmentRequestsQuery,
  ReceiveReplenishmentRequestBody,
  ReplenishmentProductSummaryDto,
  ReplenishmentRequestDto,
  ReplenishmentRequestItemDto,
  ReplenishmentRequestWithItemsDto,
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

function toProductSummaryDto(
  product: ReplenishmentRequestItemRow['product'],
): ReplenishmentProductSummaryDto {
  return {
    id: product.id,
    name: product.name,
    code: product.code,
  };
}

function toDecimalString(
  value: Prisma.Decimal | { toNumber(): number } | { toString(): string },
): string {
  if (typeof value === 'object' && 'toNumber' in value) {
    return value.toNumber().toString();
  }

  return value.toString();
}

function calculateRequestMetrics(
  items: Array<{
    requestedQuantity: number;
    unitPrice: Prisma.Decimal | { toNumber(): number } | { toString(): string } | null;
  }>,
): {
  itemsCount: number;
  estimatedTotal: string;
} {
  const estimatedTotal = items.reduce(
    (total, item) =>
      item.unitPrice != null
        ? total.plus(
            new Prisma.Decimal(toDecimalString(item.unitPrice)).mul(item.requestedQuantity),
          )
        : total,
    new Prisma.Decimal(0),
  );

  return {
    itemsCount: items.length,
    estimatedTotal: estimatedTotal.toString(),
  };
}

/** Map a raw request row to the API DTO (no items). */
function toDto(row: ReplenishmentRequestRow): ReplenishmentRequestDto {
  const { itemsCount, estimatedTotal } = calculateRequestMetrics(row.items);

  return {
    id: row.id,
    supplierId: row.supplierId,
    requestedByUserId: row.requestedByUserId,
    supplier: row.supplier,
    requestedByUser: {
      id: row.requestedByUser.id,
      fullName: row.requestedByUser.fullName,
    },
    status: row.status,
    requestedAt: row.requestedAt.toISOString(),
    sentAt: toIso(row.sentAt),
    receivedAt: toIso(row.receivedAt),
    receivedByUserId: row.receivedByUserId,
    cancelledAt: toIso(row.cancelledAt),
    cancelledByUserId: row.cancelledByUserId,
    notes: row.notes,
    itemsCount,
    estimatedTotal,
  };
}

/** Map a raw item row to the item DTO. */
function toItemDto(item: ReplenishmentRequestItemRow): ReplenishmentRequestItemDto {
  return {
    id: item.id,
    productId: item.productId,
    product: toProductSummaryDto(item.product),
    requestedQuantity: item.requestedQuantity,
    receivedQuantity: item.receivedQuantity,
    unitPrice: item.unitPrice != null ? item.unitPrice.toNumber() : null,
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
   *   3. If neither exists → unitPrice is stored as null (price is optional).
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
      unitPrice: number | null;
    }> = [];

    for (const item of body.items) {
      let unitPrice: number | null;

      if (item.unitPrice !== undefined) {
        unitPrice = item.unitPrice;
      } else {
        const referencePrice = await replenishmentRequestsRepository.findReferencePrice(
          body.supplierId,
          item.productId,
        );
        unitPrice = referencePrice; // null when no referencePrice — allowed, price is optional
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

  // ── Send (PENDING → SENT) ──────────────────────────────────────────────────

  /**
   * Transition a PENDING request to SENT and fire a WhatsApp notification.
   *
   * Flow:
   *  1. Load request — 404 if missing.
   *  2. Pre-check supplier.whatsapp — 422 SUPPLIER_HAS_NO_WHATSAPP if blank.
   *  3. Status-CAS PENDING → SENT in a minimal $transaction (no stock changes).
   *  4. Respond with the updated DTO.
   *  5. Fire-and-forget WhatsApp AFTER response is built (.catch(logger.error)).
   *
   * Notification failure does NOT roll back the DB (design §Twilio timing).
   *
   * @param id      Replenishment request id.
   * @param actorId Authenticated user id performing the send.
   */
  async send(id: string, actorId: string): Promise<ReplenishmentRequestWithItemsDto> {
    // 1. Load request with items (need items for the WhatsApp template).
    const existing = await replenishmentRequestsRepository.findById(id, { includeItems: true });

    if (!existing) {
      throw new AppError(
        ERROR_CODES.REPLENISHMENT_REQUEST_NOT_FOUND,
        404,
        `Replenishment request not found: ${id}.`,
      );
    }

    const withItems = existing as ReplenishmentRequestWithItemsRow;

    // 2. Pre-check supplier WhatsApp — load supplier record for phone + name.
    const supplier = await prisma.supplier.findUnique({
      where: { id: withItems.supplierId },
      select: { id: true, name: true, whatsapp: true },
    });

    if (!supplier?.whatsapp || normalizeE164(supplier.whatsapp) === null) {
      throw new AppError(
        ERROR_CODES.SUPPLIER_HAS_NO_WHATSAPP,
        422,
        `Supplier ${withItems.supplierId} has no valid WhatsApp number.`,
      );
    }

    const whatsappTo = `whatsapp:${normalizeE164(supplier.whatsapp)}`;

    // 3. Status-CAS: PENDING → SENT.
    const count = await prisma.$transaction(async (tx) => {
      return replenishmentRequestsRepository.transitionToSent(tx, id, actorId);
    });

    if (count === 0) {
      throw new AppError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        409,
        `Cannot send request ${id}: it is not in PENDING status or was concurrently updated.`,
      );
    }

    // 4. Reload and return updated DTO.
    const updated = await replenishmentRequestsRepository.findById(id, { includeItems: true });
    const dto = toWithItemsDto(updated as ReplenishmentRequestWithItemsRow);

    // 5. Fire-and-forget WhatsApp notification AFTER DB is committed.
    const body = buildSentTemplate(
      {
        id,
        items: withItems.items.map((item) => ({
          requestedQuantity: item.requestedQuantity,
          unitPrice: item.unitPrice,
        })),
      },
      { name: supplier.name },
    );

    notificationService
      .sendWhatsAppMessage(whatsappTo, body)
      .catch((err: unknown) =>
        logger.error({ err, requestId: id }, 'WhatsApp SEND notification failed'),
      );

    return dto;
  }

  // ── Receive (SENT → RECEIVED) ──────────────────────────────────────────────

  /**
   * Transition a SENT request to RECEIVED, posting IN inventory movements.
   *
   * All DB operations run in a single $transaction (spec §Receive, design §RECEIVE):
   *  1. Status-CAS SENT → RECEIVED (stamps receivedAt, receivedByUserId).
   *  2. For each item: resolve received quantity, validate range, update item,
   *     attempt stock update (CAS), insert IN movement.
   *  3. Return the fully updated DTO with items.
   *
   * No WhatsApp notification on RECEIVE (spec §Receive).
   *
   * @param id      Replenishment request id.
   * @param actorId Authenticated user id performing the receive.
   * @param body    Optional item overrides for received quantities.
   */
  async receive(
    id: string,
    actorId: string,
    body: ReceiveReplenishmentRequestBody,
  ): Promise<ReplenishmentRequestWithItemsDto> {
    // Load request with items before starting the transaction.
    const existing = await replenishmentRequestsRepository.findById(id, { includeItems: true });

    if (!existing) {
      throw new AppError(
        ERROR_CODES.REPLENISHMENT_REQUEST_NOT_FOUND,
        404,
        `Replenishment request not found: ${id}.`,
      );
    }

    const withItems = existing as ReplenishmentRequestWithItemsRow;

    // Validate body item overrides before entering the transaction.
    // Any unknown item id must abort immediately (spec §Receive — REPLENISHMENT_ITEM_NOT_FOUND).
    if (body.items) {
      for (const override of body.items) {
        const found = withItems.items.find((i) => i.id === override.id);
        if (!found) {
          throw new AppError(
            ERROR_CODES.REPLENISHMENT_ITEM_NOT_FOUND,
            400,
            `Item ${override.id} does not belong to request ${id}.`,
          );
        }
        // Validate receivedQuantity: must be non-negative (no upper bound — may receive more than requested).
        const qty = override.receivedQuantity ?? found.requestedQuantity;
        if (qty < 0) {
          throw new AppError(
            ERROR_CODES.PARTIAL_RECEIPT_INVALID,
            400,
            `receivedQuantity ${qty} for item ${override.id} must be >= 0.`,
          );
        }
      }
    }

    // Run the entire RECEIVE flow in one transaction.
    const result = await prisma.$transaction(async (tx) => {
      // 1. CAS: SENT → RECEIVED.
      const count = await replenishmentRequestsRepository.transitionToReceived(tx, id, actorId);

      if (count === 0) {
        throw new AppError(
          ERROR_CODES.INVALID_STATE_TRANSITION,
          409,
          `Cannot receive request ${id}: it is not in SENT status or was concurrently updated.`,
        );
      }

      // 2. Process each item: update receivedQuantity + post IN movement.
      for (const item of withItems.items) {
        const override = body.items?.find((o) => o.id === item.id);
        const receivedQty = override?.receivedQuantity ?? item.requestedQuantity;

        // Persist receivedQuantity on the item.
        await replenishmentRequestsRepository.updateItemReceivedQuantity(tx, item.id, receivedQty);

        // Post IN movement: read current stock, attempt CAS, insert movement.
        const product = await tx.product.findUnique({
          where: { id: item.productId },
          select: { id: true, stock: true, minStock: true, active: true },
        });

        if (!product) {
          // Product row was deleted between the request being created and received.
          // Treat as a transactional failure — abort the entire receive so no
          // partial stock updates or movements are committed (design §RECEIVE).
          throw new AppError(
            ERROR_CODES.PRODUCT_NOT_FOUND,
            404,
            `Product ${item.productId} not found during receive of request ${id}.`,
          );
        }

        const observedStock = product.stock;
        const nextStock = observedStock + receivedQty;

        // Fix 1: CAS result MUST be checked — count===0 means a concurrent
        // transaction already changed this product's stock between our read and
        // write. Throw to abort the $transaction so nothing is half-applied.
        const stockCount = await inventoryMovementsRepository.attemptStockUpdate(
          tx,
          item.productId,
          observedStock,
          nextStock,
        );

        if (stockCount === 0) {
          throw new AppError(
            ERROR_CODES.INVALID_STATE_TRANSITION,
            409,
            `Stock CAS failed for product ${item.productId} during receive of request ${id}. Concurrent update detected.`,
          );
        }

        await inventoryMovementsRepository.insertMovement(tx, {
          productId: item.productId,
          userId: actorId,
          type: 'IN',
          adjustmentDirection: null,
          quantity: receivedQty,
          resultingStock: nextStock,
          reason: `Received from replenishment request #${id}`,
        });

        // Advisory alert reconcile per item (REQ-RR-hook, REQ-5).
        // Failures are logged and swallowed — they must NOT roll back the stock update.
        try {
          await alertsRepository.reconcile(tx, item.productId, nextStock, product.minStock);
        } catch (reconcileErr: unknown) {
          logger.error(
            { err: reconcileErr, productId: item.productId, nextStock },
            '[alerts.reconcile] Non-critical reconcile failure inside receive() tx — swallowed.',
          );
        }
      }

      // 3. Return updated request with items for DTO mapping.
      return replenishmentRequestsRepository.findById(id, { includeItems: true });
    });

    return toWithItemsDto(result as ReplenishmentRequestWithItemsRow);
  }

  // ── Cancel (PENDING|SENT → CANCELLED) ─────────────────────────────────────

  /**
   * Transition a PENDING or SENT request to CANCELLED.
   *
   * Flow:
   *  1. Load request — 404 if missing.
   *  2. Guard: RECEIVED and CANCELLED are terminal — reject with 409.
   *  3. Status-CAS (priorStatus) → CANCELLED.
   *  4. If prior status was SENT, fire-and-forget WhatsApp CANCELLED notification.
   *
   * No notification when cancelling a PENDING request (spec §Cancel).
   *
   * @param id      Replenishment request id.
   * @param actorId Authenticated user id performing the cancellation.
   */
  async cancel(id: string, actorId: string): Promise<ReplenishmentRequestWithItemsDto> {
    // 1. Load request with items (need items for potential WhatsApp template).
    const existing = await replenishmentRequestsRepository.findById(id, { includeItems: true });

    if (!existing) {
      throw new AppError(
        ERROR_CODES.REPLENISHMENT_REQUEST_NOT_FOUND,
        404,
        `Replenishment request not found: ${id}.`,
      );
    }

    const withItems = existing as ReplenishmentRequestWithItemsRow;
    const priorStatus = withItems.status;

    // 2. Guard against terminal states.
    if (priorStatus === 'RECEIVED' || priorStatus === 'CANCELLED') {
      throw new AppError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        409,
        `Cannot cancel request ${id}: current status '${priorStatus}' is terminal.`,
      );
    }

    // At this point priorStatus is narrowed to 'PENDING' | 'SENT' by the guard above.
    // 3. Status-CAS: priorStatus → CANCELLED.
    const count = await prisma.$transaction(async (tx) => {
      return replenishmentRequestsRepository.transitionToCancelled(tx, id, actorId, priorStatus);
    });

    if (count === 0) {
      throw new AppError(
        ERROR_CODES.INVALID_STATE_TRANSITION,
        409,
        `Cannot cancel request ${id}: it was concurrently updated.`,
      );
    }

    // 4. Reload and build DTO.
    const updated = await replenishmentRequestsRepository.findById(id, { includeItems: true });
    const dto = toWithItemsDto(updated as ReplenishmentRequestWithItemsRow);

    // 5. Fire-and-forget WhatsApp ONLY when prior status was SENT.
    if (priorStatus === 'SENT') {
      const supplier = await prisma.supplier.findUnique({
        where: { id: withItems.supplierId },
        select: { name: true, whatsapp: true },
      });

      const normalizedPhone = supplier?.whatsapp ? normalizeE164(supplier.whatsapp) : null;

      if (normalizedPhone) {
        const whatsappTo = `whatsapp:${normalizedPhone}`;
        const body = buildCancelledTemplate({ id, items: [] }, { name: supplier!.name });

        notificationService
          .sendWhatsAppMessage(whatsappTo, body)
          .catch((err: unknown) =>
            logger.error({ err, requestId: id }, 'WhatsApp CANCEL notification failed'),
          );
      }
    }

    return dto;
  }
}

/** Singleton instance consumed by the replenishment-requests controller. */
export const replenishmentRequestsService = new ReplenishmentRequestsService();
