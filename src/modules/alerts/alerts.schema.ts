/**
 * Zod schemas and inferred types for the alerts module.
 *
 * Schemas:
 *   - alertIdParamsSchema              params for /:id routes
 *   - listAlertsQuerySchema            query for GET /api/alerts
 *   - createReplenishmentBodySchema    body for POST /api/alerts/:id/create-replenishment
 *
 * Design decisions:
 *   - Pagination follows the project-wide convention: { page, limit } (NOT pageSize).
 *   - resolved filter accepts 'true' | 'false' | 'all' as string (query param);
 *     default is 'false' (open alerts only).
 *   - AlertDto fields mirror the Alert model exactly; resolvedByUserId is null
 *     for system-triggered auto-resolves.
 */
import { z } from 'zod';
import { AlertType } from '@prisma/client';
import { paginationQuerySchema } from '../../shared/pagination/index.js';

// ---------------------------------------------------------------------------
// Params schemas
// ---------------------------------------------------------------------------

/** Params for /:id routes. */
export const alertIdParamsSchema = z.object({
  id: z.string().cuid({ message: 'Alert id must be a valid cuid.' }),
});

// ---------------------------------------------------------------------------
// Query schemas
// ---------------------------------------------------------------------------

/**
 * Query schema for GET /api/alerts.
 *
 * resolved: 'true' | 'false' | 'all' — default 'false' (open alerts only).
 * type:     optional AlertType enum filter.
 * productId: optional cuid filter.
 * page + limit: from shared paginationQuerySchema (project convention).
 */
export const listAlertsQuerySchema = paginationQuerySchema
  .pick({ page: true, limit: true })
  .extend({
    resolved: z
      .enum(['true', 'false', 'all'], {
        errorMap: () => ({ message: 'resolved must be one of: true, false, all.' }),
      })
      .default('false'),
    type: z
      .nativeEnum(AlertType, {
        errorMap: () => ({
          message: `type must be one of: ${Object.values(AlertType).join(', ')}.`,
        }),
      })
      .optional(),
    productId: z.string().cuid({ message: 'productId must be a valid cuid.' }).optional(),
  });

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/**
 * Body for POST /api/alerts/:id/create-replenishment.
 *
 * supplierId: required cuid.
 * notes:      optional, trimmed, max 1000 chars.
 */
export const createReplenishmentBodySchema = z.object({
  supplierId: z.string().cuid({ message: 'supplierId must be a valid cuid.' }),
  notes: z
    .string()
    .trim()
    .max(1000, { message: 'notes must be at most 1000 characters.' })
    .optional(),
});

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type AlertIdParams = z.infer<typeof alertIdParamsSchema>;
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;
export type CreateReplenishmentBody = z.infer<typeof createReplenishmentBodySchema>;

// ---------------------------------------------------------------------------
// Response DTO types
// ---------------------------------------------------------------------------

/**
 * Single alert DTO returned by list and get-by-id endpoints.
 *
 * resolvedAt / resolvedByUserId are null for open alerts.
 * resolvedByUserId is also null when resolved automatically by the system
 * (no user actor — REQ-3, REQ-4).
 */
export interface AlertDto {
  id: string;
  productId: string;
  type: AlertType;
  message: string;
  resolved: boolean;
  resolvedAt: string | null; // ISO 8601
  resolvedByUserId: string | null;
  createdAt: string; // ISO 8601
}
