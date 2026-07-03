/**
 * Replenishment requests router.
 *
 * Route table:
 *   POST  /                      Create request          (ADMIN, MANAGER)
 *   GET   /                      List requests           (any authenticated)
 *   GET   /:id                   Get by id               (any authenticated)
 *   POST  /:id/send              Transition PENDING → SENT        (ADMIN, MANAGER)
 *   POST  /:id/receive           Transition SENT → RECEIVED       (ADMIN, MANAGER)
 *   POST  /:id/cancel            Transition PENDING|SENT → CANCELLED  (ADMIN, MANAGER)
 *
 * Middleware chain:
 *   authenticate → requireRole → validate → controller
 *
 * Supplier-scoped list is mounted inside suppliers.routes.ts (not here).
 *
 * This router is mounted at /api/replenishment-requests in app.ts.
 */
import { type RequestHandler, Router } from 'express';
import { validate } from '../../shared/validation/validate.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requireRole } from '../../shared/middleware/requireRole.js';
import {
  createReplenishmentRequestSchema,
  listReplenishmentRequestsQuerySchema,
  replenishmentRequestIdParamsSchema,
  receiveReplenishmentRequestSchema,
} from './replenishment-requests.schema.js';
import {
  createReplenishmentRequestController,
  listReplenishmentRequestsController,
  getReplenishmentRequestController,
  sendReplenishmentRequestController,
  receiveReplenishmentRequestController,
  cancelReplenishmentRequestController,
} from './replenishment-requests.controller.js';

export const replenishmentRequestsRouter = Router();

// ── POST /api/replenishment-requests ──────────────────────────────────────────

replenishmentRequestsRouter.post(
  '/',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(createReplenishmentRequestSchema, 'body'),
  createReplenishmentRequestController as RequestHandler,
);

// ── GET /api/replenishment-requests ───────────────────────────────────────────

replenishmentRequestsRouter.get(
  '/',
  authenticate,
  validate(listReplenishmentRequestsQuerySchema, 'query'),
  listReplenishmentRequestsController as RequestHandler,
);

// ── GET /api/replenishment-requests/:id ───────────────────────────────────────

replenishmentRequestsRouter.get(
  '/:id',
  authenticate,
  validate(replenishmentRequestIdParamsSchema, 'params'),
  getReplenishmentRequestController as RequestHandler,
);

// ── POST /api/replenishment-requests/:id/send ─────────────────────────────────

replenishmentRequestsRouter.post(
  '/:id/send',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(replenishmentRequestIdParamsSchema, 'params'),
  sendReplenishmentRequestController as RequestHandler,
);

// ── POST /api/replenishment-requests/:id/receive ──────────────────────────────

replenishmentRequestsRouter.post(
  '/:id/receive',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(replenishmentRequestIdParamsSchema, 'params'),
  validate(receiveReplenishmentRequestSchema, 'body'),
  receiveReplenishmentRequestController as RequestHandler,
);

// ── POST /api/replenishment-requests/:id/cancel ───────────────────────────────

replenishmentRequestsRouter.post(
  '/:id/cancel',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(replenishmentRequestIdParamsSchema, 'params'),
  cancelReplenishmentRequestController as RequestHandler,
);
