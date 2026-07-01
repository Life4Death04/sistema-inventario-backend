/**
 * Zod schemas and inferred types for the categories module.
 *
 * Schemas:
 *   - createCategorySchema     body for POST /api/categories
 *   - updateCategorySchema     body for PATCH /api/categories/:id
 *   - categoryIdParamsSchema   params for /:id routes
 *   - listCategoriesQuerySchema query for GET /api/categories (extends paginationQuerySchema)
 */
import { z } from 'zod';
import { paginationQuerySchema } from '../../shared/pagination/index.js';

const CATEGORY_NAME_MIN_LENGTH = 2;
const CATEGORY_NAME_MAX_LENGTH = 120;
const CATEGORY_DESCRIPTION_MAX_LENGTH = 500;

const categoryNameSchema = z
  .string()
  .min(CATEGORY_NAME_MIN_LENGTH, { message: 'Category name must be at least 2 characters.' })
  .max(CATEGORY_NAME_MAX_LENGTH, { message: 'Category name must be at most 120 characters.' });

const categoryDescriptionSchema = z
  .string()
  .max(CATEGORY_DESCRIPTION_MAX_LENGTH, { message: 'Description must be at most 500 characters.' });

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/categories body.
 * name is required; description is optional.
 */
export const createCategorySchema = z.object({
  name: categoryNameSchema,
  description: categoryDescriptionSchema.optional(),
});

/**
 * Schema for PATCH /api/categories/:id body.
 * All fields optional — reject empty objects (at least 1 key required).
 * description can be explicitly set to null to clear it.
 */
export const updateCategorySchema = z
  .object({
    name: categoryNameSchema.optional(),
    description: categoryDescriptionSchema.nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update.',
  });

// ---------------------------------------------------------------------------
// Params schema
// ---------------------------------------------------------------------------

/** Schema for :id route param — must be a valid cuid. */
export const categoryIdParamsSchema = z.object({
  id: z.string().cuid({ message: 'Category id must be a valid cuid.' }),
});

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

/**
 * Schema for GET /api/categories query params.
 * Extends paginationQuerySchema with category-specific search filter.
 * search performs case-insensitive substring match on name OR description.
 */
export const listCategoriesQuerySchema = paginationQuerySchema.extend({
  search: z.string().max(200).optional(),
});

// ---------------------------------------------------------------------------
// Inferred DTO types
// ---------------------------------------------------------------------------

export type CreateCategoryDto = z.infer<typeof createCategorySchema>;
export type UpdateCategoryDto = z.infer<typeof updateCategorySchema>;
export type CategoryIdParams = z.infer<typeof categoryIdParamsSchema>;
export type ListCategoriesQuery = z.infer<typeof listCategoriesQuerySchema>;
