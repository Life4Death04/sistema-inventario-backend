/**
 * Zod schemas and inferred types for the replenishment-requests module.
 *
 * Schemas:
 *   - createReplenishmentRequestSchema       body for POST /api/replenishment-requests
 *   - listReplenishmentRequestsQuerySchema   query for GET /api/replenishment-requests
 *   - receiveReplenishmentRequestSchema      body for POST /api/replenishment-requests/:id/receive
 *   - replenishmentRequestIdParamsSchema     params for /:id routes
 *   - supplierIdParamsSchema                 params for /api/suppliers/:supplierId routes
 *
 * Design decisions:
 *   - Pagination uses `page` + `pageSize` (spec §List and Retrieve), NOT the project-wide
 *     `limit` convention. This is intentional: spec is authoritative for this module.
 *   - items.min(1) uses the sentinel message "REPLENISHMENT_ITEMS_REQUIRED" so the
 *     validate middleware can map it to the specific AppError code (not VALIDATION_ERROR).
 *   - unitPrice is optional; the service resolves it from ProductSupplier.referencePrice.
 */
import { z } from 'zod';
import type { ReplenishmentStatus } from '@prisma/client';

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/** Single item in a create request body. */
const createItemSchema = z.object({
  productId: z.string().cuid({ message: 'productId must be a valid cuid.' }),
  requestedQuantity: z
    .number({ invalid_type_error: 'requestedQuantity must be a number.' })
    .int({ message: 'requestedQuantity must be an integer.' })
    .min(1, { message: 'requestedQuantity must be at least 1.' }),
  unitPrice: z
    .number({ invalid_type_error: 'unitPrice must be a number.' })
    .positive({ message: 'unitPrice must be greater than 0.' })
    .optional(),
});

/**
 * Body for POST /api/replenishment-requests.
 *
 * items.min(1) uses the REPLENISHMENT_ITEMS_REQUIRED sentinel so the validate
 * middleware emits the specific error code instead of the generic VALIDATION_ERROR.
 */
export const createReplenishmentRequestSchema = z.object({
  supplierId: z.string().cuid({ message: 'supplierId must be a valid cuid.' }),
  notes: z
    .string()
    .trim()
    .max(1000, { message: 'notes must be at most 1000 characters.' })
    .optional(),
  items: z.array(createItemSchema).min(1, { message: 'REPLENISHMENT_ITEMS_REQUIRED' }),
});

/**
 * Query schema for GET /api/replenishment-requests and supplier-scoped list.
 *
 * Uses `pageSize` (spec-mandated), not the project-wide `limit`.
 */
export const listReplenishmentRequestsQuerySchema = z.object({
  page: z.coerce
    .number({ invalid_type_error: 'page must be a number.' })
    .int('page must be an integer.')
    .min(1, 'page must be at least 1.')
    .default(1),
  pageSize: z.coerce
    .number({ invalid_type_error: 'pageSize must be a number.' })
    .int('pageSize must be an integer.')
    .min(1, 'pageSize must be at least 1.')
    .max(100, 'pageSize must be at most 100.')
    .default(20),
  status: z
    .enum(['PENDING', 'SENT', 'RECEIVED', 'CANCELLED'], {
      errorMap: () => ({ message: 'status must be one of: PENDING, SENT, RECEIVED, CANCELLED.' }),
    })
    .optional(),
  supplierId: z.string().cuid({ message: 'supplierId must be a valid cuid.' }).optional(),
  dateFrom: z.coerce
    .date({ invalid_type_error: 'dateFrom must be a valid ISO 8601 date.' })
    .optional(),
  dateTo: z.coerce.date({ invalid_type_error: 'dateTo must be a valid ISO 8601 date.' }).optional(),
});

/** Single item in a receive request body. */
const receiveItemSchema = z.object({
  id: z.string().cuid({ message: 'item id must be a valid cuid.' }),
  receivedQuantity: z
    .number({ invalid_type_error: 'receivedQuantity must be a number.' })
    .int({ message: 'receivedQuantity must be an integer.' })
    .min(0, { message: 'receivedQuantity must be at least 0.' })
    .optional(),
});

/** Body for POST /api/replenishment-requests/:id/receive. */
export const receiveReplenishmentRequestSchema = z.object({
  items: z.array(receiveItemSchema).optional(),
});

// ---------------------------------------------------------------------------
// Params schemas
// ---------------------------------------------------------------------------

/** Params for /:id routes. */
export const replenishmentRequestIdParamsSchema = z.object({
  id: z.string().cuid({ message: 'Replenishment request id must be a valid cuid.' }),
});

/** Params for /api/suppliers/:supplierId/replenishment-requests. */
export const supplierIdParamsSchema = z.object({
  supplierId: z.string().cuid({ message: 'supplierId must be a valid cuid.' }),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type CreateReplenishmentRequestBody = z.infer<typeof createReplenishmentRequestSchema>;
export type ListReplenishmentRequestsQuery = z.infer<typeof listReplenishmentRequestsQuerySchema>;
export type ReceiveReplenishmentRequestBody = z.infer<typeof receiveReplenishmentRequestSchema>;
export type ReplenishmentRequestIdParams = z.infer<typeof replenishmentRequestIdParamsSchema>;
export type SupplierIdParams = z.infer<typeof supplierIdParamsSchema>;

// ---------------------------------------------------------------------------
// Response DTO types
// ---------------------------------------------------------------------------

export interface ReplenishmentSupplierSummaryDto {
  id: string;
  name: string;
}

export interface ReplenishmentUserSummaryDto {
  id: string;
  fullName: string;
}

export interface ReplenishmentProductSummaryDto {
  id: string;
  name: string;
  code: string;
}

/** Base DTO for a single replenishment request (without items). */
export interface ReplenishmentRequestDto {
  id: string;
  supplierId: string;
  requestedByUserId: string;
  supplier: ReplenishmentSupplierSummaryDto;
  requestedByUser: ReplenishmentUserSummaryDto;
  status: ReplenishmentStatus;
  requestedAt: string;
  sentAt: string | null;
  receivedAt: string | null;
  receivedByUserId: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  notes: string | null;
  itemsCount: number;
  estimatedTotal: string;
}

/** DTO for a single replenishment request item. */
export interface ReplenishmentRequestItemDto {
  id: string;
  productId: string;
  product: ReplenishmentProductSummaryDto;
  requestedQuantity: number;
  receivedQuantity: number | null;
  unitPrice: number | null;
}

/** DTO with embedded items (used by getById). */
export interface ReplenishmentRequestWithItemsDto extends ReplenishmentRequestDto {
  items: ReplenishmentRequestItemDto[];
}

/** Paginated list envelope using pageSize (spec-mandated). */
export interface ReplenishmentRequestsPageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface PaginatedReplenishmentRequestsResponse {
  data: ReplenishmentRequestDto[];
  meta: ReplenishmentRequestsPageMeta;
}
