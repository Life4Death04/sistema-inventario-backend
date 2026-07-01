/**
 * Zod schemas and inferred types for the users module.
 *
 * Schemas:
 *   - createUserSchema     body for POST /api/users
 *   - updateUserSchema     body for PATCH /api/users/:id
 *   - userIdParamsSchema   params for /:id routes
 *   - listUsersQuerySchema query for GET /api/users (extends paginationQuerySchema)
 */
import { z } from 'zod';
import { UserRole } from '@prisma/client';
import { paginationQuerySchema } from '../../shared/pagination/index.js';

// ---------------------------------------------------------------------------
// Body schemas
// ---------------------------------------------------------------------------

/**
 * Schema for POST /api/users body.
 * All required except role (default OPERATOR) and phone.
 */
export const createUserSchema = z.object({
  fullName: z.string().min(2, { message: 'Full name must be at least 2 characters.' }),
  email: z.string().email({ message: 'Must be a valid email address.' }),
  password: z.string().min(8, { message: 'Password must be at least 8 characters.' }),
  role: z.nativeEnum(UserRole).optional().default(UserRole.OPERATOR),
  phone: z.string().optional(),
});

/**
 * Schema for PATCH /api/users/:id body.
 * All fields optional — reject empty objects (at least 1 key required).
 */
export const updateUserSchema = z
  .object({
    fullName: z.string().min(2, { message: 'Full name must be at least 2 characters.' }).optional(),
    email: z.string().email({ message: 'Must be a valid email address.' }).optional(),
    password: z.string().min(8, { message: 'Password must be at least 8 characters.' }).optional(),
    role: z.nativeEnum(UserRole).optional(),
    phone: z.string().optional(),
    active: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided for update.',
  });

// ---------------------------------------------------------------------------
// Params schema
// ---------------------------------------------------------------------------

/** Schema for :id route param — must be a valid cuid. */
export const userIdParamsSchema = z.object({
  id: z.string().cuid({ message: 'User id must be a valid cuid.' }),
});

// ---------------------------------------------------------------------------
// Query schema
// ---------------------------------------------------------------------------

/**
 * Schema for GET /api/users query params.
 * Extends paginationQuerySchema with users-specific filters.
 */
export const listUsersQuerySchema = paginationQuerySchema.extend({
  search: z.string().max(200).optional(),
  role: z.nativeEnum(UserRole).optional(),
  active: z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((val) => {
      if (val === undefined) return undefined;
      if (typeof val === 'boolean') return val;
      if (val === 'true') return true;
      if (val === 'false') return false;
      return undefined;
    }),
});

// ---------------------------------------------------------------------------
// Inferred DTO types
// ---------------------------------------------------------------------------

export type CreateUserDto = z.infer<typeof createUserSchema>;
export type UpdateUserDto = z.infer<typeof updateUserSchema>;
export type UserIdParams = z.infer<typeof userIdParamsSchema>;
export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
