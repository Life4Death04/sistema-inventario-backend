/**
 * Users router — mounts the 5 CRUD endpoints under /api/users.
 *
 * Endpoint map (all protected by authenticate + requireRole('ADMIN')):
 *   POST   /        → validate body    → createUserController
 *   GET    /        → validate query   → listUsersController
 *   GET    /:id     → validate params  → getUserController
 *   PATCH  /:id     → validate params + body → updateUserController
 *   DELETE /:id     → validate params  → deleteUserController
 *
 * This router is mounted at /api/users in app.ts:
 *   app.use('/api/users', usersRouter);
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
  createUserSchema,
  updateUserSchema,
  userIdParamsSchema,
  listUsersQuerySchema,
} from './users.schema.js';
import {
  createUserController,
  listUsersController,
  getUserController,
  updateUserController,
  deleteUserController,
} from './users.controller.js';

export const usersRouter = Router();

// All users endpoints require authentication and ADMIN role.
usersRouter.use(authenticate, requireRole('ADMIN'));

/**
 * POST /api/users
 * Body: { fullName, email, password, role?, phone? }
 * Creates a new user. Hashes password. Rejects duplicate email with 409.
 */
usersRouter.post('/', validate(createUserSchema, 'body'), createUserController as RequestHandler);

/**
 * GET /api/users
 * Query: { page?, limit?, search?, role?, active? }
 * Returns paginated user list with optional filters.
 */
usersRouter.get(
  '/',
  validate(listUsersQuerySchema, 'query'),
  listUsersController as RequestHandler,
);

/**
 * GET /api/users/:id
 * Params: { id: cuid }
 * Returns a single user. 404 if not found.
 */
usersRouter.get(
  '/:id',
  validate(userIdParamsSchema, 'params'),
  getUserController as RequestHandler,
);

/**
 * PATCH /api/users/:id
 * Params: { id: cuid }
 * Body: partial { fullName?, email?, password?, role?, phone?, active? }
 * Applies partial update. Enforces self-modification and last-admin guards.
 */
usersRouter.patch(
  '/:id',
  validate(userIdParamsSchema, 'params'),
  validate(updateUserSchema, 'body'),
  updateUserController as RequestHandler,
);

/**
 * DELETE /api/users/:id
 * Params: { id: cuid }
 * Soft-delete (sets active=false). Returns 204. Enforces last-admin guard.
 */
usersRouter.delete(
  '/:id',
  validate(userIdParamsSchema, 'params'),
  deleteUserController as RequestHandler,
);
