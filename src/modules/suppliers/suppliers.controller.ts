/**
 * Suppliers controller — HTTP handlers for the 5 supplier CRUD endpoints.
 *
 * Endpoint map:
 *   POST   /api/suppliers        → createSupplierController
 *   GET    /api/suppliers        → listSuppliersController
 *   GET    /api/suppliers/:id    → getSupplierController
 *   PATCH  /api/suppliers/:id    → updateSupplierController
 *   DELETE /api/suppliers/:id    → deleteSupplierController
 *
 * All handlers:
 *   - Require the `authenticate` middleware (req.user is guaranteed non-null).
 *   - Require `requireRole(...)` per endpoint (enforced in the router, not here).
 *   - Delegate all business logic to SuppliersService.
 *   - Rely on express-async-errors to forward thrown AppErrors.
 */
import type { Request, Response } from 'express';
import { suppliersService } from './suppliers.service.js';
import type {
  CreateSupplierDto,
  UpdateSupplierDto,
  SupplierIdParams,
  ListSuppliersQuery,
} from './suppliers.schema.js';

// ── POST /api/suppliers ───────────────────────────────────────────────────────

/**
 * Create a new supplier.
 *
 * Body: CreateSupplierDto (validated upstream by validate(createSupplierSchema, 'body'))
 *
 * Responses:
 *   201 Created  — { supplier: SupplierRecord }
 *   409 Conflict — duplicate RIF
 */
export async function createSupplierController(req: Request, res: Response): Promise<void> {
  const dto = req.body as CreateSupplierDto;
  const supplier = await suppliersService.create(dto);
  res.status(201).json({ supplier });
}

// ── GET /api/suppliers ────────────────────────────────────────────────────────

/**
 * List suppliers with pagination, active filter, and optional search.
 *
 * Query: ListSuppliersQuery (validated upstream by validate(listSuppliersQuerySchema, 'query'))
 *
 * Response:
 *   200 OK — { data: SupplierRecord[], meta: PaginationMeta }
 */
export async function listSuppliersController(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListSuppliersQuery;
  const result = await suppliersService.list(query);
  res.status(200).json(result);
}

// ── GET /api/suppliers/:id ────────────────────────────────────────────────────

/**
 * Get a single supplier by id.
 * Returns the supplier regardless of active flag (historical/detail view).
 *
 * Params: SupplierIdParams (validated upstream by validate(supplierIdParamsSchema, 'params'))
 *
 * Responses:
 *   200 OK        — { supplier: SupplierRecord }
 *   404 Not Found — supplier does not exist
 */
export async function getSupplierController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as SupplierIdParams;
  const supplier = await suppliersService.getById(id);
  res.status(200).json({ supplier });
}

// ── PATCH /api/suppliers/:id ──────────────────────────────────────────────────

/**
 * Update a supplier by id (partial update).
 *
 * Params: SupplierIdParams (validated upstream)
 * Body:   UpdateSupplierDto (validated upstream)
 *
 * Responses:
 *   200 OK        — { supplier: SupplierRecord }
 *   404 Not Found — supplier does not exist
 *   409 Conflict  — duplicate RIF
 */
export async function updateSupplierController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as SupplierIdParams;
  const dto = req.body as UpdateSupplierDto;
  const supplier = await suppliersService.update(id, dto);
  res.status(200).json({ supplier });
}

// ── DELETE /api/suppliers/:id ─────────────────────────────────────────────────

/**
 * Soft-delete a supplier (sets active = false).
 *
 * Params: SupplierIdParams (validated upstream)
 *
 * Responses:
 *   204 No Content — soft-delete succeeded
 *   404 Not Found  — supplier does not exist or is already inactive
 */
export async function deleteSupplierController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as SupplierIdParams;
  await suppliersService.softDelete(id);
  res.status(204).end();
}
