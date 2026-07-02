/**
 * Suppliers router — mounts the 5 CRUD endpoints under /api/suppliers.
 *
 * Authorization matrix:
 *   Mutations (POST, PATCH, DELETE): ADMIN | MANAGER
 *   Reads    (GET list, GET by id):  ADMIN | MANAGER | OPERATOR
 *
 * Endpoint map:
 *   POST   /        → authenticate → requireRole(ADMIN,MANAGER) → validate body    → createSupplierController
 *   GET    /        → authenticate → requireRole(ADMIN,MANAGER,OPERATOR) → validate query  → listSuppliersController
 *   GET    /:id     → authenticate → requireRole(ADMIN,MANAGER,OPERATOR) → validate params → getSupplierController
 *   PATCH  /:id     → authenticate → requireRole(ADMIN,MANAGER) → validate params + body   → updateSupplierController
 *   DELETE /:id     → authenticate → requireRole(ADMIN,MANAGER) → validate params           → deleteSupplierController
 *
 * This router is mounted at /api/suppliers in app.ts:
 *   app.use('/api/suppliers', suppliersRouter);
 *
 * Note: async controllers are cast to RequestHandler because express-async-errors
 * (imported in app.ts) patches Express to forward promise rejections to the
 * global errorHandler. The cast suppresses the no-misused-promises lint error.
 */
import { type RequestHandler, Router } from 'express';
import { validate } from '../../shared/validation/validate.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { requireRole } from '../../shared/middleware/requireRole.js';
import {
  createSupplierSchema,
  updateSupplierSchema,
  supplierIdParamsSchema,
  listSuppliersQuerySchema,
} from './suppliers.schema.js';
import {
  createSupplierController,
  listSuppliersController,
  getSupplierController,
  updateSupplierController,
  deleteSupplierController,
} from './suppliers.controller.js';
import { listReplenishmentRequestsBySupplierController } from '../replenishment-requests/replenishment-requests.controller.js';
import {
  supplierIdParamsSchema as replenishmentSupplierIdParamsSchema,
  listReplenishmentRequestsQuerySchema,
} from '../replenishment-requests/replenishment-requests.schema.js';

export const suppliersRouter = Router();

/**
 * POST /api/suppliers
 * Body: { name, rif?, whatsapp?, address? }
 * Creates a new supplier. Rejects duplicate RIF with 409.
 * Roles: ADMIN, MANAGER
 */
suppliersRouter.post(
  '/',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(createSupplierSchema, 'body'),
  createSupplierController as RequestHandler,
);

/**
 * GET /api/suppliers
 * Query: { page?, limit?, search?, active? }
 * Returns paginated supplier list. Defaults to active=true.
 * Roles: ADMIN, MANAGER, OPERATOR
 */
suppliersRouter.get(
  '/',
  authenticate,
  requireRole('ADMIN', 'MANAGER', 'OPERATOR'),
  validate(listSuppliersQuerySchema, 'query'),
  listSuppliersController as RequestHandler,
);

/**
 * GET /api/suppliers/:id
 * Params: { id: cuid }
 * Returns a single supplier (active or inactive). 404 if not found.
 * Roles: ADMIN, MANAGER, OPERATOR
 */
suppliersRouter.get(
  '/:id',
  authenticate,
  requireRole('ADMIN', 'MANAGER', 'OPERATOR'),
  validate(supplierIdParamsSchema, 'params'),
  getSupplierController as RequestHandler,
);

/**
 * PATCH /api/suppliers/:id
 * Params: { id: cuid }
 * Body: partial { name?, rif? | null, whatsapp? | null, address? | null }
 * Applies partial update. Rejects duplicate RIF with 409.
 * Roles: ADMIN, MANAGER
 */
suppliersRouter.patch(
  '/:id',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(supplierIdParamsSchema, 'params'),
  validate(updateSupplierSchema, 'body'),
  updateSupplierController as RequestHandler,
);

/**
 * DELETE /api/suppliers/:id
 * Params: { id: cuid }
 * Soft-delete (sets active = false). Returns 204.
 * 404 if supplier not found or already inactive.
 * Roles: ADMIN, MANAGER
 */
suppliersRouter.delete(
  '/:id',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(supplierIdParamsSchema, 'params'),
  deleteSupplierController as RequestHandler,
);

/**
 * GET /api/suppliers/:supplierId/replenishment-requests
 * Params: { supplierId: cuid }
 * Query:  { page?, pageSize?, status?, dateFrom?, dateTo? }
 * Returns paginated replenishment requests for the given supplier.
 * Roles: ADMIN, MANAGER, OPERATOR
 *
 * Note: Uses supplierId (not id) to avoid shadowing the /:id param above.
 * The replenishment module's controller is mounted directly here (design §Supplier list route).
 */
suppliersRouter.get(
  '/:supplierId/replenishment-requests',
  authenticate,
  validate(replenishmentSupplierIdParamsSchema, 'params'),
  validate(listReplenishmentRequestsQuerySchema, 'query'),
  listReplenishmentRequestsBySupplierController as RequestHandler,
);
