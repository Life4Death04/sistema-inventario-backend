/**
 * AlertsService — business logic for the alerts module.
 *
 * Responsibilities:
 *   - list()                 Paginated list with resolved/type/productId filters.
 *   - getById()              Point read with 404 guard.
 *   - createReplenishment()  Find alert+product, compute quantity, delegate to replenishmentRequestsService.
 *
 * This service does NOT import Express. Consumed by alerts.controller.ts.
 *
 * REQ-8 note: createReplenishment works for BOTH open and resolved alerts.
 * The alert state is not mutated by this action — it is purely a shortcut
 * that pre-fills the replenishment request with the alert's product and
 * the computed quantity = max(1, minStock - stock).
 */
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { paginate, type PaginatedResponse } from '../../shared/pagination/index.js';
import { alertsRepository } from './alerts.repository.js';
import { replenishmentRequestsService } from '../replenishment-requests/replenishment-requests.service.js';
import type { ListAlertsQuery, AlertDto, CreateReplenishmentBody } from './alerts.schema.js';
import type { ReplenishmentRequestWithItemsDto } from '../replenishment-requests/replenishment-requests.schema.js';

export class AlertsService {
  // ── List ───────────────────────────────────────────────────────────────────

  /**
   * Paginated list of alerts with optional filters.
   * Default: resolved=false (open alerts only), page=1, limit=20.
   */
  async list(query: ListAlertsQuery): Promise<PaginatedResponse<AlertDto>> {
    const [data, total] = await alertsRepository.findMany(query);
    return paginate({ data, total, page: query.page, limit: query.limit });
  }

  // ── Get by id ──────────────────────────────────────────────────────────────

  /**
   * Get a single alert by id.
   * Throws 404 ALERT_NOT_FOUND when the alert does not exist.
   */
  async getById(id: string): Promise<AlertDto> {
    const alert = await alertsRepository.findById(id);
    if (!alert) {
      throw new AppError(ERROR_CODES.ALERT_NOT_FOUND, 404, `Alert not found: ${id}.`);
    }
    return alert;
  }

  // ── Create replenishment from alert ────────────────────────────────────────

  /**
   * Create a replenishment request using the alert's product as a shortcut.
   *
   * Steps:
   *  1. Find alert (with product) — 404 if missing.
   *  2. Compute requestedQuantity = max(1, product.minStock - product.stock).
   *  3. Delegate to replenishmentRequestsService.create() with the computed item.
   *  4. Return the created replenishment DTO (201 in controller).
   *
   * Works for BOTH open and resolved alerts (REQ-8 — alert is NOT mutated).
   * Downstream errors (UNIT_PRICE_REQUIRED, PRODUCT_NOT_FOUND, etc.) surface verbatim.
   *
   * @param alertId  The alert id from URL params.
   * @param body     { supplierId, notes? } from the request body.
   * @param actorId  Authenticated user id.
   */
  async createReplenishment(
    alertId: string,
    body: CreateReplenishmentBody,
    actorId: string,
  ): Promise<ReplenishmentRequestWithItemsDto> {
    // 1. Load alert + product stock data.
    const result = await alertsRepository.findByIdWithProduct(alertId);
    if (!result) {
      throw new AppError(ERROR_CODES.ALERT_NOT_FOUND, 404, `Alert not found: ${alertId}.`);
    }

    const { alert, product } = result;

    // 2. Compute quantity: max(1, minStock - stock).
    const requestedQuantity = Math.max(1, product.minStock - product.stock);

    // 3. Delegate to replenishment service — errors surface verbatim.
    return replenishmentRequestsService.create(
      {
        supplierId: body.supplierId,
        notes: body.notes,
        items: [
          {
            productId: alert.productId,
            requestedQuantity,
          },
        ],
      },
      actorId,
    );
  }
}

/** Singleton instance consumed by the alerts controller. */
export const alertsService = new AlertsService();
