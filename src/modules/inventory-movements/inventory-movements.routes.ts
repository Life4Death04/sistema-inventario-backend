/**
 * Inventory movements router — mounts the /api/inventory-movements endpoints.
 *
 * Route table:
 *   POST   /                  Create movement   (ADMIN, MANAGER, OPERATOR)
 *   GET    /                  List movements    (ADMIN, MANAGER, OPERATOR)
 *   GET    /:id               Get by id         (ADMIN, MANAGER, OPERATOR)
 *   *      /:id               → 405 Method Not Allowed (Allow: GET)
 *
 * Design decisions:
 *   D2 — router.all('/:id', methodNotAllowed) is registered AFTER router.get('/:id', ...)
 *        so that GET requests are handled and all other methods receive 405.
 *   D4 — OPERATOR type guard lives in the service, not here. The route admits
 *        OPERATOR to POST; the service rejects non-OUT movements with 403.
 */
import { type Request, type RequestHandler, type Response, Router } from 'express';
import { validate } from '../../shared/validation/validate.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requireRole } from '../../shared/middleware/requireRole.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import {
  createMovementSchema,
  listMovementsQuerySchema,
  movementIdParamsSchema,
} from './inventory-movements.schema.js';
import {
  createMovementController,
  getMovementController,
  listMovementsController,
} from './inventory-movements.controller.js';

export const inventoryMovementsRouter = Router();

const ALL_ROLES = ['ADMIN', 'MANAGER', 'OPERATOR'] as const;

// ── POST /api/inventory-movements ──────────────────────────────────────────

inventoryMovementsRouter.post(
  '/',
  authenticate,
  requireRole(...ALL_ROLES),
  validate(createMovementSchema, 'body'),
  createMovementController as RequestHandler,
);

// ── GET /api/inventory-movements ───────────────────────────────────────────

inventoryMovementsRouter.get(
  '/',
  authenticate,
  requireRole(...ALL_ROLES),
  validate(listMovementsQuerySchema, 'query'),
  listMovementsController as RequestHandler,
);

// ── GET /api/inventory-movements/:id ──────────────────────────────────────
// MUST be declared before the router.all('/:id', ...) catch-all below.

inventoryMovementsRouter.get(
  '/:id',
  authenticate,
  requireRole(...ALL_ROLES),
  validate(movementIdParamsSchema, 'params'),
  getMovementController as RequestHandler,
);

// ── 405 catch-all for /:id (PATCH / PUT / DELETE / etc.) ─────────────────
//
// Registered AFTER the GET handler so Express matches GET first.
// Per design D2 and spec R5: movements are immutable; corrections are
// compensating ADJUSTMENT movements, not in-place edits.

function methodNotAllowed(req: Request, res: Response): void {
  res
    .set('Allow', 'GET')
    .status(405)
    .json({
      error: ERROR_CODES.METHOD_NOT_ALLOWED,
      message: `Method ${req.method} is not allowed on this resource. Allowed: GET.`,
      statusCode: 405,
    });
}

inventoryMovementsRouter.all('/:id', methodNotAllowed as RequestHandler);
