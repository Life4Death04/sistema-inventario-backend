/**
 * Categories router — mounts the 5 CRUD endpoints under /api/categories.
 *
 * Authorization matrix:
 *   Mutations (POST, PATCH, DELETE): ADMIN | MANAGER
 *   Reads    (GET list, GET by id):  ADMIN | MANAGER | OPERATOR
 *
 * Endpoint map:
 *   POST   /        → authenticate → requireRole(ADMIN,MANAGER) → validate body    → createCategoryController
 *   GET    /        → authenticate → requireRole(ADMIN,MANAGER,OPERATOR) → validate query  → listCategoriesController
 *   GET    /:id     → authenticate → requireRole(ADMIN,MANAGER,OPERATOR) → validate params → getCategoryController
 *   PATCH  /:id     → authenticate → requireRole(ADMIN,MANAGER) → validate params + body   → updateCategoryController
 *   DELETE /:id     → authenticate → requireRole(ADMIN,MANAGER) → validate params           → deleteCategoryController
 *
 * This router is mounted at /api/categories in app.ts:
 *   app.use('/api/categories', categoriesRouter);
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
  createCategorySchema,
  updateCategorySchema,
  categoryIdParamsSchema,
  listCategoriesQuerySchema,
} from './categories.schema.js';
import {
  createCategoryController,
  listCategoriesController,
  getCategoryController,
  updateCategoryController,
  deleteCategoryController,
} from './categories.controller.js';

export const categoriesRouter = Router();

/**
 * POST /api/categories
 * Body: { name, description? }
 * Creates a new category. Rejects duplicate name with 409.
 * Roles: ADMIN, MANAGER
 */
categoriesRouter.post(
  '/',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(createCategorySchema, 'body'),
  createCategoryController as RequestHandler,
);

/**
 * GET /api/categories
 * Query: { page?, limit?, search? }
 * Returns paginated category list with optional search on name/description.
 * Roles: ADMIN, MANAGER, OPERATOR
 */
categoriesRouter.get(
  '/',
  authenticate,
  requireRole('ADMIN', 'MANAGER', 'OPERATOR'),
  validate(listCategoriesQuerySchema, 'query'),
  listCategoriesController as RequestHandler,
);

/**
 * GET /api/categories/:id
 * Params: { id: cuid }
 * Returns a single category. 404 if not found.
 * Roles: ADMIN, MANAGER, OPERATOR
 */
categoriesRouter.get(
  '/:id',
  authenticate,
  requireRole('ADMIN', 'MANAGER', 'OPERATOR'),
  validate(categoryIdParamsSchema, 'params'),
  getCategoryController as RequestHandler,
);

/**
 * PATCH /api/categories/:id
 * Params: { id: cuid }
 * Body: partial { name?, description? | null }
 * Applies partial update. Rejects duplicate name with 409.
 * Roles: ADMIN, MANAGER
 */
categoriesRouter.patch(
  '/:id',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(categoryIdParamsSchema, 'params'),
  validate(updateCategorySchema, 'body'),
  updateCategoryController as RequestHandler,
);

/**
 * DELETE /api/categories/:id
 * Params: { id: cuid }
 * Hard-delete. Returns 204. Rejects with 409 if products exist.
 * Roles: ADMIN, MANAGER
 */
categoriesRouter.delete(
  '/:id',
  authenticate,
  requireRole('ADMIN', 'MANAGER'),
  validate(categoryIdParamsSchema, 'params'),
  deleteCategoryController as RequestHandler,
);
