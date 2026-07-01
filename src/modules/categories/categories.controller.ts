/**
 * Categories controller — HTTP handlers for the 5 category CRUD endpoints.
 *
 * Endpoint map:
 *   POST   /api/categories        → createCategoryController
 *   GET    /api/categories        → listCategoriesController
 *   GET    /api/categories/:id    → getCategoryController
 *   PATCH  /api/categories/:id    → updateCategoryController
 *   DELETE /api/categories/:id    → deleteCategoryController
 *
 * All handlers:
 *   - Require the `authenticate` middleware (req.user is guaranteed non-null).
 *   - Require `requireRole(...)` per endpoint (enforced in the router, not here).
 *   - Delegate all business logic to CategoriesService.
 *   - Rely on express-async-errors to forward thrown AppErrors.
 */
import type { Request, Response } from 'express';
import { categoriesService } from './categories.service.js';
import type {
  CreateCategoryDto,
  UpdateCategoryDto,
  CategoryIdParams,
  ListCategoriesQuery,
} from './categories.schema.js';

// ── POST /api/categories ──────────────────────────────────────────────────────

/**
 * Create a new category.
 *
 * Body: CreateCategoryDto (validated upstream by validate(createCategorySchema, 'body'))
 *
 * Responses:
 *   201 Created  — { category: CategoryRecord }
 *   409 Conflict — duplicate name
 */
export async function createCategoryController(req: Request, res: Response): Promise<void> {
  const dto = req.body as CreateCategoryDto;
  const category = await categoriesService.create(dto);
  res.status(201).json({ category });
}

// ── GET /api/categories ───────────────────────────────────────────────────────

/**
 * List categories with pagination and optional search filter.
 *
 * Query: ListCategoriesQuery (validated upstream by validate(listCategoriesQuerySchema, 'query'))
 *
 * Response:
 *   200 OK — { data: CategoryRecord[], meta: PaginationMeta }
 */
export async function listCategoriesController(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListCategoriesQuery;
  const result = await categoriesService.list(query);
  res.status(200).json(result);
}

// ── GET /api/categories/:id ───────────────────────────────────────────────────

/**
 * Get a single category by id.
 *
 * Params: CategoryIdParams (validated upstream by validate(categoryIdParamsSchema, 'params'))
 *
 * Responses:
 *   200 OK        — { category: CategoryRecord }
 *   404 Not Found — category does not exist
 */
export async function getCategoryController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as CategoryIdParams;
  const category = await categoriesService.getById(id);
  res.status(200).json({ category });
}

// ── PATCH /api/categories/:id ─────────────────────────────────────────────────

/**
 * Update a category by id (partial update).
 *
 * Params: CategoryIdParams (validated upstream)
 * Body:   UpdateCategoryDto (validated upstream)
 *
 * Responses:
 *   200 OK        — { category: CategoryRecord }
 *   404 Not Found — category does not exist
 *   409 Conflict  — duplicate name
 */
export async function updateCategoryController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as CategoryIdParams;
  const dto = req.body as UpdateCategoryDto;
  const category = await categoriesService.update(id, dto);
  res.status(200).json({ category });
}

// ── DELETE /api/categories/:id ────────────────────────────────────────────────

/**
 * Hard-delete a category.
 *
 * Params: CategoryIdParams (validated upstream)
 *
 * Responses:
 *   204 No Content — hard-delete succeeded
 *   404 Not Found  — category does not exist
 *   409 Conflict   — category has associated products
 */
export async function deleteCategoryController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as CategoryIdParams;
  await categoriesService.hardDelete(id);
  res.status(204).end();
}
