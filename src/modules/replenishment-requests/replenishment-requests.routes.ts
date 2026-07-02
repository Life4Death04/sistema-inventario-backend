/**
 * Replenishment requests router — mounts Phase 1 (read side) endpoints.
 *
 * Route table:
 *   POST  /                      Create request          (ADMIN, MANAGER)
 *   GET   /                      List requests           (ADMIN, MANAGER, OPERATOR)
 *   GET   /:id                   Get by id               (ADMIN, MANAGER, OPERATOR)
 *
 * Phase 2 routes (state transitions) — added in PR 2:
 *   POST  /:id/send              Transition PENDING → SENT
 *   POST  /:id/receive           Transition SENT → RECEIVED
 *   POST  /:id/cancel            Transition PENDING|SENT → CANCELLED
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
} from './replenishment-requests.schema.js';
import {
  createReplenishmentRequestController,
  listReplenishmentRequestsController,
  getReplenishmentRequestController,
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
