/**
 * Alerts controller — HTTP handlers.
 *
 * Handler responsibilities:
 *   - Parse validated params/query/body from the request (set by validate() middleware).
 *   - Extract req.user populated by authenticate middleware.
 *   - Delegate to the service layer.
 *   - Map results to JSON responses with correct HTTP status codes.
 *
 * Error propagation:
 *   - Service throws AppError (ALERT_NOT_FOUND, etc.).
 *   - express-async-errors forwards thrown errors to the global errorHandler.
 *   - This controller does NOT catch AppErrors — let them bubble.
 *
 * Handlers:
 *   listAlertsController              GET /api/alerts
 *   getAlertController                GET /api/alerts/:id
 *   createReplenishmentController     POST /api/alerts/:id/create-replenishment
 */
import type { Request, Response } from 'express';
import { alertsService } from './alerts.service.js';
import type { AlertIdParams, ListAlertsQuery, CreateReplenishmentBody } from './alerts.schema.js';

// ── GET /api/alerts ────────────────────────────────────────────────────────────

/**
 * List alerts with optional filters and pagination.
 * Returns 200 with the paginated envelope { data, meta }.
 * Auth: authenticate (any role).
 */
export async function listAlertsController(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListAlertsQuery;
  const result = await alertsService.list(query);
  res.status(200).json(result);
}

// ── GET /api/alerts/:id ───────────────────────────────────────────────────────

/**
 * Get a single alert by id.
 * Returns 200 { alert: AlertDto } or lets AppError bubble as 404.
 * Auth: authenticate (any role).
 */
export async function getAlertController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as AlertIdParams;
  const alert = await alertsService.getById(id);
  res.status(200).json({ alert });
}

// ── POST /api/alerts/:id/create-replenishment ─────────────────────────────────

/**
 * Create a replenishment request from an alert's product context.
 * Returns 201 { replenishmentRequest } mirroring the replenishment DTO.
 * Auth: authenticate + requireRole('ADMIN', 'MANAGER').
 */
export async function createReplenishmentController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as AlertIdParams;
  const body = req.body as CreateReplenishmentBody;
  const { id: actorId } = req.user!;
  const replenishmentRequest = await alertsService.createReplenishment(id, body, actorId);
  res.status(201).json({ replenishmentRequest });
}
