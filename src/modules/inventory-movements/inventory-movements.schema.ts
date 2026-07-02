/**
 * Zod schemas and inferred types for the inventory-movements module.
 *
 * Schemas:
 *   - createMovementSchema             body for POST /api/inventory-movements
 *   - movementIdParamsSchema           params for /:id routes
 *   - productIdParamsSchema            params for /products/:productId/inventory-movements
 *   - listMovementsQuerySchema         query for GET /api/inventory-movements (includes productId?)
 *   - listMovementsByProductQuerySchema query for GET /api/products/:productId/inventory-movements
 *
 * Design decisions:
 *   - Body uses discriminatedUnion('type') — IN/OUT share an identical shape; ADJUSTMENT
 *     accepts a signed non-zero quantity that the service translates to a positive quantity
 *     + adjustmentDirection (INCREASE | DECREASE).
 *   - reason is required on ALL types (R1 spec: "required for ALL types").
 *   - List query uses the shared paginationQuerySchema (page + limit) — NOT pageSize.
 *     The spec draft said "pageSize" but the project convention (products, users, suppliers)
 *     uses "limit". This schema aligns to the project convention.
 *   - from/to are ISO 8601 date-time strings validated by z.coerce.date().
 */
import { z } from 'zod';
import { MovementType } from '@prisma/client';
import { paginationQuerySchema, type PaginatedResponse } from '../../shared/pagination/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REASON_MAX_LENGTH = 500;
const QUANTITY_MAX = 1_000_000;

// ---------------------------------------------------------------------------
// Body schemas (discriminated union on "type")
// ---------------------------------------------------------------------------

/**
 * Shared fields present on every movement type.
 * productId: cuid — references Product.id (@default(cuid())).
 * reason:    required, trimmed, 1–500 chars.
 */
const movementBaseSchema = z.object({
  productId: z.string().cuid({ message: 'productId must be a valid cuid.' }),
  reason: z
    .string()
    .trim()
    .min(1, { message: 'reason is required.' })
    .max(REASON_MAX_LENGTH, { message: `reason must be at most ${REASON_MAX_LENGTH} characters.` }),
});

/**
 * Body for type = IN.
 * quantity: positive integer [1, 1_000_000].
 */
const createInMovementSchema = movementBaseSchema.extend({
  type: z.literal('IN'),
  quantity: z
    .number({ invalid_type_error: 'quantity must be a number.' })
    .int({ message: 'quantity must be an integer.' })
    .min(1, { message: 'quantity must be at least 1.' })
    .max(QUANTITY_MAX, { message: `quantity must be at most ${QUANTITY_MAX}.` }),
});

/**
 * Body for type = OUT.
 * quantity: positive integer [1, 1_000_000].
 */
const createOutMovementSchema = movementBaseSchema.extend({
  type: z.literal('OUT'),
  quantity: z
    .number({ invalid_type_error: 'quantity must be a number.' })
    .int({ message: 'quantity must be an integer.' })
    .min(1, { message: 'quantity must be at least 1.' })
    .max(QUANTITY_MAX, { message: `quantity must be at most ${QUANTITY_MAX}.` }),
});

/**
 * Body for type = ADJUSTMENT.
 * quantity: signed integer [-1_000_000, 1_000_000] excluding 0.
 *   Positive values → INCREASE direction.
 *   Negative values → DECREASE direction.
 * The service translates signed quantity → positive quantity + adjustmentDirection.
 */
const createAdjustmentMovementSchema = movementBaseSchema.extend({
  type: z.literal('ADJUSTMENT'),
  quantity: z
    .number({ invalid_type_error: 'quantity must be a number.' })
    .int({ message: 'quantity must be an integer.' })
    .min(-QUANTITY_MAX, { message: `quantity must be at least -${QUANTITY_MAX}.` })
    .max(QUANTITY_MAX, { message: `quantity must be at most ${QUANTITY_MAX}.` })
    .refine((v) => v !== 0, { message: 'quantity must not be zero for ADJUSTMENT movements.' }),
});

/**
 * Discriminated union on "type" for POST /api/inventory-movements body.
 * Zod picks the right branch based on the "type" literal.
 */
export const createMovementSchema = z.discriminatedUnion('type', [
  createInMovementSchema,
  createOutMovementSchema,
  createAdjustmentMovementSchema,
]);

// ---------------------------------------------------------------------------
// Params schemas
// ---------------------------------------------------------------------------

/**
 * Schema for :id route param — must be a valid cuid.
 * InventoryMovement.id is @default(cuid()) in prisma/schema.prisma.
 */
export const movementIdParamsSchema = z.object({
  id: z.string().cuid({ message: 'Movement id must be a valid cuid.' }),
});

/**
 * Schema for :productId route param (product-scoped sub-resource).
 * Product.id is @default(cuid()) in prisma/schema.prisma.
 */
export const movementProductIdParamsSchema = z.object({
  productId: z.string().cuid({ message: 'productId must be a valid cuid.' }),
});

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

/**
 * Schema for GET /api/inventory-movements query params.
 * Extends the shared paginationQuerySchema (page, limit, sort, search) with
 * inventory-specific filters:
 *   productId? — filter by product (cuid)
 *   type?      — filter by MovementType enum
 *   from?      — ISO 8601 start date (inclusive lower bound on createdAt)
 *   to?        — ISO 8601 end date (inclusive upper bound on createdAt)
 *
 * Filters are AND-combined. Sort is fixed to createdAt DESC in the repository.
 */
export const listMovementsQuerySchema = paginationQuerySchema.extend({
  productId: z.string().cuid({ message: 'productId must be a valid cuid.' }).optional(),

  type: z
    .nativeEnum(MovementType, {
      errorMap: () => ({
        message: `type must be one of: ${Object.values(MovementType).join(', ')}.`,
      }),
    })
    .optional(),

  from: z.coerce.date({ invalid_type_error: 'from must be a valid ISO 8601 date.' }).optional(),

  to: z.coerce.date({ invalid_type_error: 'to must be a valid ISO 8601 date.' }).optional(),
});

/**
 * Schema for GET /api/products/:productId/inventory-movements query params.
 * Same as listMovementsQuerySchema but without productId (it comes from the URL param).
 */
export const listMovementsByProductQuerySchema = listMovementsQuerySchema.omit({
  productId: true,
});

// ---------------------------------------------------------------------------
// Inferred DTO types
// ---------------------------------------------------------------------------

export type CreateMovementDto = z.infer<typeof createMovementSchema>;
export type MovementIdParams = z.infer<typeof movementIdParamsSchema>;
export type MovementProductIdParams = z.infer<typeof movementProductIdParamsSchema>;
export type ListMovementsQuery = z.infer<typeof listMovementsQuerySchema>;
export type ListMovementsByProductQuery = z.infer<typeof listMovementsByProductQuerySchema>;

// ---------------------------------------------------------------------------
// Response DTO types
// ---------------------------------------------------------------------------

/**
 * Shape of a single movement in API responses.
 * adjustmentDirection is null for IN/OUT; INCREASE or DECREASE for ADJUSTMENT.
 * resultingStock is the product stock snapshot after this movement was applied.
 */
export interface MovementDto {
  id: string;
  productId: string;
  userId: string;
  type: MovementType;
  adjustmentDirection: 'INCREASE' | 'DECREASE' | null;
  quantity: number;
  resultingStock: number;
  reason: string;
  createdAt: Date;
}

/** Paginated list envelope for movement lists. */
export type PaginatedMovementsResponse = PaginatedResponse<MovementDto>;
