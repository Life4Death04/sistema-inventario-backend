/**
 * Replenishment requests controller — HTTP handlers.
 *
 * Handler responsibilities:
 *   - Parse validated params/query/body from the request (set by validate() middleware).
 *   - Extract req.user populated by authenticate middleware.
 *   - Delegate to the service layer.
 *   - Map results to JSON responses with correct HTTP status codes.
 *
 * Error propagation:
 *   - Service throws AppError (REPLENISHMENT_REQUEST_NOT_FOUND, UNIT_PRICE_REQUIRED, etc.).
 *   - express-async-errors forwards thrown errors to the global errorHandler.
 *   - This controller does NOT catch AppErrors — let them bubble.
 *
 * Phase 1 handlers (read side):
 *   createReplenishmentRequestController
 *   listReplenishmentRequestsController
 *   getReplenishmentRequestController
 *   listReplenishmentRequestsBySupplierController
 *
 * Phase 2 handlers (state transitions) — added in PR 2:
 *   sendReplenishmentRequestController
 *   receiveReplenishmentRequestController
 *   cancelReplenishmentRequestController
 */
import type { Request, Response } from 'express';
import { replenishmentRequestsService } from './replenishment-requests.service.js';
import type {
  CreateReplenishmentRequestBody,
  ListReplenishmentRequestsQuery,
  ReplenishmentRequestIdParams,
  SupplierIdParams,
} from './replenishment-requests.schema.js';

// ── POST /api/replenishment-requests ──────────────────────────────────────────

/**
 * Create a new PENDING replenishment request.
 * Returns 201 with { request } on success.
 * Roles: ADMIN, MANAGER (enforced by route middleware).
 */
export async function createReplenishmentRequestController(
  req: Request,
  res: Response,
): Promise<void> {
  const body = req.body as CreateReplenishmentRequestBody;
  const { id: actorId } = req.user!;
  const request = await replenishmentRequestsService.create(body, actorId);
  res.status(201).json({ request });
}

// ── GET /api/replenishment-requests ───────────────────────────────────────────

/**
 * List replenishment requests with optional filters and pagination.
 * Returns 200 with the paginated envelope { data, meta }.
 * Roles: ADMIN, MANAGER, OPERATOR.
 */
export async function listReplenishmentRequestsController(
  req: Request,
  res: Response,
): Promise<void> {
  const query = req.query as unknown as ListReplenishmentRequestsQuery;
  const result = await replenishmentRequestsService.list(query);
  res.status(200).json(result);
}

// ── GET /api/replenishment-requests/:id ───────────────────────────────────────

/**
 * Get a single replenishment request by id (with items embedded).
 * Returns 200 with { request } or lets AppError bubble as 404.
 * Roles: ADMIN, MANAGER, OPERATOR.
 */
export async function getReplenishmentRequestController(
  req: Request,
  res: Response,
): Promise<void> {
  const { id } = req.params as ReplenishmentRequestIdParams;
  const request = await replenishmentRequestsService.getById(id);
  res.status(200).json({ request });
}

// ── GET /api/suppliers/:supplierId/replenishment-requests ─────────────────────

/**
 * List replenishment requests for a specific supplier (sub-resource handler).
 * Mounted inside suppliersRouter at /:supplierId/replenishment-requests.
 *
 * Combines supplierId from params with pagination query.
 * Returns 200 with the paginated envelope { data, meta }.
 * Roles: ADMIN, MANAGER, OPERATOR.
 */
export async function listReplenishmentRequestsBySupplierController(
  req: Request,
  res: Response,
): Promise<void> {
  const { supplierId } = req.params as SupplierIdParams;
  const query = req.query as unknown as ListReplenishmentRequestsQuery;
  const result = await replenishmentRequestsService.listBySupplier(supplierId, query);
  res.status(200).json(result);
}
