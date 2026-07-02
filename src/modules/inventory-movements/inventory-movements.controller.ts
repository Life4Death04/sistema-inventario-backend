/**
 * Inventory movements controller — HTTP handlers for the inventory-movements module.
 *
 * Handler responsibilities:
 *   - Parse validated params/query/body from the request (set by validate() middleware).
 *   - Extract req.user populated by authenticate middleware.
 *   - Delegate to the service layer.
 *   - Map results to JSON responses with the correct HTTP status codes.
 *
 * Error propagation:
 *   - Service throws AppError (PRODUCT_NOT_FOUND, INSUFFICIENT_STOCK, etc.).
 *   - express-async-errors forwards thrown errors to the global errorHandler.
 *   - This controller does NOT catch AppErrors — let them bubble.
 */
import type { Request, Response } from 'express';
import { inventoryMovementsService } from './inventory-movements.service.js';
import type {
  CreateMovementDto,
  ListMovementsByProductQuery,
  ListMovementsQuery,
  MovementIdParams,
  MovementProductIdParams,
} from './inventory-movements.schema.js';

// ── POST /api/inventory-movements ──────────────────────────────────────────

/**
 * Create a new inventory movement.
 * Returns 201 with { movement } on success.
 * Roles: ADMIN, MANAGER, OPERATOR (service enforces OPERATOR can only create OUT).
 */
export async function createMovementController(req: Request, res: Response): Promise<void> {
  const dto = req.body as CreateMovementDto;
  // req.user is guaranteed by the authenticate middleware that precedes this handler.
  const { id: actorId, role: actorRole } = req.user!;
  const movement = await inventoryMovementsService.createMovement(dto, actorId, actorRole);
  res.status(201).json({ movement });
}

// ── GET /api/inventory-movements ───────────────────────────────────────────

/**
 * List all inventory movements with optional filters and pagination.
 * Returns 200 with the PaginatedResponse envelope { data, meta }.
 * Roles: ADMIN, MANAGER, OPERATOR.
 *
 * IMPORTANT: passes the Zod-parsed query object (not req.query) to the service
 * so that `limit` and `page` are already coerced to numbers by the schema.
 */
export async function listMovementsController(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListMovementsQuery;
  const result = await inventoryMovementsService.listMovements(query);
  res.status(200).json(result);
}

// ── GET /api/inventory-movements/:id ──────────────────────────────────────

/**
 * Get a single inventory movement by id.
 * Returns 200 with { movement } on success, or lets AppError bubble as 404.
 * Roles: ADMIN, MANAGER, OPERATOR.
 */
export async function getMovementController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as MovementIdParams;
  const movement = await inventoryMovementsService.getMovement(id);
  res.status(200).json({ movement });
}

// ── GET /api/products/:productId/inventory-movements ──────────────────────

/**
 * List movements for a specific product (sub-resource handler).
 * Mounted inside productsRouter at /:productId/inventory-movements.
 *
 * Combines productId from params with list query filters.
 * Returns 200 with the PaginatedResponse envelope { data, meta }.
 * Returns 404 PRODUCT_NOT_FOUND for missing or inactive products.
 * Roles: ADMIN, MANAGER, OPERATOR.
 */
export async function listMovementsByProductController(req: Request, res: Response): Promise<void> {
  const { productId } = req.params as MovementProductIdParams;
  const query = req.query as unknown as ListMovementsByProductQuery;
  const result = await inventoryMovementsService.listMovementsByProduct(productId, query);
  res.status(200).json(result);
}
