/**
 * Users controller — HTTP handlers for the 5 user CRUD endpoints.
 *
 * Endpoint map:
 *   POST   /api/users        → createUserController
 *   GET    /api/users        → listUsersController
 *   GET    /api/users/:id    → getUserController
 *   PATCH  /api/users/:id    → updateUserController
 *   DELETE /api/users/:id    → deleteUserController
 *
 * All handlers:
 *   - Require the `authenticate` middleware (req.user is guaranteed non-null).
 *   - Require `requireRole('ADMIN')` (enforced in the router, not here).
 *   - Delegate all business logic to UsersService.
 *   - Rely on express-async-errors to forward thrown AppErrors.
 *   - NEVER return the password field in any response.
 *
 * The authenticate middleware populates req.user = { id, role }.
 * Controllers read req.user.id as the requesterId for guard checks.
 */
import type { Request, Response } from 'express';
import { usersService } from './users.service.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import type { CreateUserDto, UpdateUserDto, UserIdParams, ListUsersQuery } from './users.schema.js';

// ── POST /api/users ───────────────────────────────────────────────────────────

/**
 * Create a new user.
 *
 * Body: CreateUserDto (validated upstream by validate(createUserSchema, 'body'))
 *
 * Responses:
 *   201 Created  — { user: PublicUser }
 *   409 Conflict — duplicate email
 */
export async function createUserController(req: Request, res: Response): Promise<void> {
  const dto = req.body as CreateUserDto;
  const user = await usersService.create(dto);
  res.status(201).json({ user });
}

// ── GET /api/users ────────────────────────────────────────────────────────────

/**
 * List users with pagination and optional filters.
 *
 * Query: ListUsersQuery (validated upstream by validate(listUsersQuerySchema, 'query'))
 *
 * Response:
 *   200 OK — { data: PublicUser[], meta: PaginationMeta }
 */
export async function listUsersController(req: Request, res: Response): Promise<void> {
  const query = req.query as unknown as ListUsersQuery;
  const result = await usersService.list(query);
  res.status(200).json(result);
}

// ── GET /api/users/:id ────────────────────────────────────────────────────────

/**
 * Get a single user by id.
 *
 * Params: UserIdParams (validated upstream by validate(userIdParamsSchema, 'params'))
 *
 * Responses:
 *   200 OK       — { user: PublicUser }
 *   404 Not Found — user does not exist
 */
export async function getUserController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as UserIdParams;
  const user = await usersService.getById(id);
  res.status(200).json({ user });
}

// ── PATCH /api/users/:id ──────────────────────────────────────────────────────

/**
 * Update a user by id (partial update).
 *
 * Params: UserIdParams (validated upstream)
 * Body:   UpdateUserDto (validated upstream)
 *
 * Responses:
 *   200 OK       — { user: PublicUser }
 *   403 Forbidden — self-demotion / self-deactivation attempt
 *   404 Not Found — user does not exist
 *   409 Conflict  — last-admin guard | duplicate email
 */
export async function updateUserController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as UserIdParams;
  const dto = req.body as UpdateUserDto;

  // req.user is guaranteed by authenticate middleware.
  if (!req.user) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 500, 'Authentication state missing.');
  }

  const user = await usersService.update(id, dto, req.user.id);
  res.status(200).json({ user });
}

// ── DELETE /api/users/:id ─────────────────────────────────────────────────────

/**
 * Soft-delete a user (sets active = false).
 *
 * Params: UserIdParams (validated upstream)
 *
 * Responses:
 *   204 No Content — soft-delete succeeded
 *   403 Forbidden  — self-deactivation attempt
 *   404 Not Found  — user does not exist
 *   409 Conflict   — last-admin guard
 */
export async function deleteUserController(req: Request, res: Response): Promise<void> {
  const { id } = req.params as UserIdParams;

  // req.user is guaranteed by authenticate middleware.
  if (!req.user) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 500, 'Authentication state missing.');
  }

  await usersService.softDelete(id, req.user.id);
  res.status(204).end();
}
