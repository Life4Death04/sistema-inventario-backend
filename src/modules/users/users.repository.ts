/**
 * UsersRepository — Prisma data-access layer for user management.
 *
 * Responsibilities:
 *   - CRUD operations on the User model.
 *   - Pagination + filtering for the list endpoint.
 *   - Counting active admins (required by last-admin guard in service).
 *
 * All methods are pure data-access; no business logic here.
 * Services apply guards and rules on top of the returned data.
 *
 * Password is NEVER selected in public-facing queries — the select clause
 * omits it structurally. Only findByIdWithPassword (used internally for
 * credential checks) returns the hash.
 */
import type { UserRole, Prisma } from '@prisma/client';
import { prisma } from '../../shared/utils/prisma.js';
import type { CreateUserDto, UpdateUserDto, ListUsersQuery } from './users.schema.js';

// ---------------------------------------------------------------------------
// Public user shape (no password)
// ---------------------------------------------------------------------------

/** Fields selected on every public user query — password is structurally excluded. */
const PUBLIC_USER_SELECT = {
  id: true,
  fullName: true,
  email: true,
  role: true,
  active: true,
  phone: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Shape returned by all public repository methods. */
export type PublicUser = {
  id: string;
  fullName: string;
  email: string;
  role: UserRole;
  active: boolean;
  phone: string | null;
  createdAt: Date;
  updatedAt: Date;
};

// ---------------------------------------------------------------------------
// UsersRepository
// ---------------------------------------------------------------------------

export class UsersRepository {
  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Insert a new user row.
   * Expects the password to already be hashed by the service before calling this.
   */
  async create(data: Omit<CreateUserDto, 'password'> & { password: string }): Promise<PublicUser> {
    return prisma.user.create({
      data: {
        fullName: data.fullName,
        email: data.email,
        password: data.password,
        role: data.role,
        phone: data.phone,
      },
      select: PUBLIC_USER_SELECT,
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * Find a user by primary key — returns public shape (no password).
   * Returns null when not found.
   */
  async findById(id: string): Promise<PublicUser | null> {
    return prisma.user.findUnique({
      where: { id },
      select: PUBLIC_USER_SELECT,
    });
  }

  /**
   * Find a user by email — returns public shape (no password).
   * Used to check email uniqueness before create/update.
   * Returns null when not found.
   */
  async findByEmail(email: string): Promise<PublicUser | null> {
    return prisma.user.findFirst({
      where: { email },
      select: PUBLIC_USER_SELECT,
    });
  }

  /**
   * Find a user by email excluding a specific id — used for update uniqueness check.
   * Returns null when no conflict exists.
   */
  async findByEmailExcludingId(email: string, excludeId: string): Promise<PublicUser | null> {
    return prisma.user.findFirst({
      where: { email, NOT: { id: excludeId } },
      select: PUBLIC_USER_SELECT,
    });
  }

  /**
   * List users with pagination and optional filters.
   *
   * Filters (all optional):
   *   search — case-insensitive substring match on fullName OR email
   *   role   — exact UserRole match
   *   active — boolean exact match
   *
   * Returns [rows, total] tuple so the service can build the paginated envelope.
   */
  async list(query: ListUsersQuery): Promise<[PublicUser[], number]> {
    const { page, limit, search, role, active } = query;
    const skip = (page - 1) * limit;

    // Build the where clause from optional filters.
    const where: Prisma.UserWhereInput = {};

    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { email: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (role !== undefined) {
      where.role = role;
    }

    if (active !== undefined) {
      where.active = active;
    }

    const [rows, total] = await prisma.$transaction([
      prisma.user.findMany({
        where,
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);

    return [rows, total];
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Patch a user by id.
   * Expects the password (if present) to already be hashed by the service.
   * Returns the updated public user shape.
   */
  async update(
    id: string,
    data: Partial<UpdateUserDto> & { password?: string },
  ): Promise<PublicUser> {
    return prisma.user.update({
      where: { id },
      data: {
        ...(data.fullName !== undefined && { fullName: data.fullName }),
        ...(data.email !== undefined && { email: data.email }),
        ...(data.password !== undefined && { password: data.password }),
        ...(data.role !== undefined && { role: data.role }),
        ...(data.phone !== undefined && { phone: data.phone }),
        ...(data.active !== undefined && { active: data.active }),
      },
      select: PUBLIC_USER_SELECT,
    });
  }

  // ── Soft delete ────────────────────────────────────────────────────────────

  /**
   * Soft-delete a user by setting active = false.
   * Does NOT physically remove the row — preserves FK references (movements, etc.).
   */
  async softDelete(id: string): Promise<void> {
    await prisma.user.update({
      where: { id },
      data: { active: false },
    });
  }

  // ── Guards helpers ─────────────────────────────────────────────────────────

  /**
   * Count the number of currently active ADMIN users.
   * Used by the last-admin guard before deactivation or role demotion.
   */
  async countActiveAdmins(): Promise<number> {
    return prisma.user.count({
      where: { role: 'ADMIN', active: true },
    });
  }
}

/** Singleton instance consumed by the users controller. */
export const usersRepository = new UsersRepository();
