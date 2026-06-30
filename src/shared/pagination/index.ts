/**
 * Pagination utilities.
 *
 * Exports:
 *   - paginationQuerySchema   Reusable Zod schema for list endpoint query params.
 *   - paginate<T>()           Assembles the standard paginated response envelope.
 *   - PaginatedResponse<T>    TypeScript type for the envelope.
 *
 * Standard envelope:
 *   {
 *     "data": T[],
 *     "meta": { "page": 1, "limit": 20, "total": 137, "totalPages": 7 }
 *   }
 *
 * Query param validation:
 *   page    ≥ 1           (default 1)
 *   limit   1–100         (default 20)
 *   sort    field:asc|desc  (format validated by regex)
 *   search  free text
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

export const paginationQuerySchema = z.object({
  page: z.coerce
    .number({ invalid_type_error: 'page must be a number' })
    .int('page must be an integer')
    .min(1, 'page must be at least 1')
    .default(1),

  limit: z.coerce
    .number({ invalid_type_error: 'limit must be a number' })
    .int('limit must be an integer')
    .min(1, 'limit must be at least 1')
    .max(100, 'limit must be at most 100')
    .default(20),

  /** Format: "field:asc" or "field:desc". Multiple separated by comma. */
  sort: z
    .string()
    .regex(
      /^[a-zA-Z_][a-zA-Z0-9_]*(:(asc|desc))(,[a-zA-Z_][a-zA-Z0-9_]*(:(asc|desc)))*$/,
      'sort must be in format field:asc|desc (e.g. "createdAt:desc")',
    )
    .optional(),

  /** Full-text search string — each module decides which fields to target. */
  search: z.string().max(200).optional(),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

// ---------------------------------------------------------------------------
// Response type
// ---------------------------------------------------------------------------

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: PaginationMeta;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

interface PaginateArgs<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}

/**
 * Assembles a PaginatedResponse envelope from already-fetched data.
 *
 * The caller is responsible for fetching `data` (sliced) and `total` (count).
 * This helper only computes the meta fields and wraps everything in the
 * standard envelope shape.
 */
export function paginate<T>({ data, total, page, limit }: PaginateArgs<T>): PaginatedResponse<T> {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return {
    data,
    meta: { page, limit, total, totalPages },
  };
}
