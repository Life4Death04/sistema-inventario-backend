/**
 * Alerts router.
 *
 * Route table:
 *   GET  /                              List alerts           (any authenticated)
 *   GET  /:id                           Get by id             (any authenticated)
 *   POST /:id/create-replenishment      Create replenishment  (ADMIN, MANAGER)
 *
 * Middleware chain:
 *   authenticate → requireRole (when applicable) → validate → controller
 *
 * This router is mounted at /api/alerts in app.ts.
 */
import { type RequestHandler, Router } from 'express';
import { validate } from '../../shared/validation/validate.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requireRole } from '../../shared/middleware/requireRole.js';
import {
  alertIdParamsSchema,
  listAlertsQuerySchema,
  createReplenishmentBodySchema,
} from './alerts.schema.js';
import {
  listAlertsController,
  getAlertController,
  createReplenishmentController,
} from './alerts.controller.js';

export const alertsRouter = Router();

// ── GET /api/alerts ────────────────────────────────────────────────────────────

alertsRouter.get(
  '/',
  authenticate,
  validate(listAlertsQuerySchema, 'query'),
  listAlertsController as RequestHandler,
);

// ── GET /api/alerts/:id ───────────────────────────────────────────────────────

alertsRouter.get(
  '/:id',
  authenticate,
  validate(alertIdParamsSchema, 'params'),
  getAlertController as RequestHandler,
);

// ── POST /api/alerts/:id/create-replenishment ─────────────────────────────────

alertsRouter.post(
  '/:id/create-replenishment',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(alertIdParamsSchema, 'params'),
  validate(createReplenishmentBodySchema, 'body'),
  createReplenishmentController as RequestHandler,
);
