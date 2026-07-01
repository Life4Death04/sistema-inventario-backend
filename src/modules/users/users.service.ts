/**
 * UsersService — business logic for user management.
 *
 * Responsibilities:
 *   - Orchestrate CRUD operations via UsersRepository.
 *   - Hash passwords using the same bcrypt helper from AuthService.
 *   - Enforce business guards:
 *       • Last-admin guard (DELETE + PATCH that demotes/deactivates an ADMIN)
 *       • Self-modification guard (ADMIN cannot demote or deactivate themselves)
 *       • Duplicate email check (409 on POST and PATCH)
 *   - Build paginated responses using the shared paginate() helper.
 *
 * This service does NOT import Express or interact with the HTTP layer.
 * It is consumed by users.controller.ts.
 */
import { authService } from '../auth/auth.service.js';
import { usersRepository, type PublicUser } from './users.repository.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { paginate, type PaginatedResponse } from '../../shared/pagination/index.js';
import type { CreateUserDto, UpdateUserDto, ListUsersQuery } from './users.schema.js';

export class UsersService {
  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a new user.
   *
   * Guards:
   *   - 409 CONFLICT if email already in use.
   *
   * Password is hashed with the same bcrypt cost as login (authService.hashPassword).
   */
  async create(dto: CreateUserDto): Promise<PublicUser> {
    // Duplicate email check.
    const existing = await usersRepository.findByEmail(dto.email);
    if (existing) {
      throw new AppError(ERROR_CODES.CONFLICT, 409, 'A user with this email already exists.');
    }

    // Hash password — reuse authService to ensure same bcrypt cost.
    const hashedPassword = await authService.hashPassword(dto.password);

    return usersRepository.create({
      fullName: dto.fullName,
      email: dto.email,
      password: hashedPassword,
      role: dto.role,
      phone: dto.phone,
    });
  }

  // ── List ───────────────────────────────────────────────────────────────────

  /**
   * List users with pagination and optional filters.
   * Returns a standard PaginatedResponse envelope.
   */
  async list(query: ListUsersQuery): Promise<PaginatedResponse<PublicUser>> {
    const [data, total] = await usersRepository.list(query);
    return paginate({ data, total, page: query.page, limit: query.limit });
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  /**
   * Get a single user by id.
   * Throws 404 NOT_FOUND when the user does not exist.
   */
  async getById(id: string): Promise<PublicUser> {
    const user = await usersRepository.findById(id);
    if (!user) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'User not found.');
    }
    return user;
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Update a user by id.
   *
   * Guards (checked in order):
   *   1. 404 NOT_FOUND — user must exist.
   *   2. 403 FORBIDDEN — self-modification guard (cannot demote own role or set own active=false).
   *   3. 409 CONFLICT  — last-admin guard (cannot demote/deactivate the last active ADMIN).
   *   4. 409 CONFLICT  — duplicate email guard (if email field is being changed).
   *
   * @param id           User being updated.
   * @param dto          Partial update payload (already validated).
   * @param requesterId  The authenticated user's id (from req.user.id).
   */
  async update(id: string, dto: UpdateUserDto, requesterId: string): Promise<PublicUser> {
    // 1. Ensure the target user exists.
    const target = await usersRepository.findById(id);
    if (!target) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'User not found.');
    }

    // 2. Self-modification guard.
    //    An ADMIN cannot deactivate themselves or demote their own role.
    if (id === requesterId) {
      const wantsToDeactivate = dto.active === false;
      const wantsToDemoteRole = dto.role !== undefined && dto.role !== 'ADMIN';
      if (wantsToDeactivate || wantsToDemoteRole) {
        throw new AppError(
          ERROR_CODES.FORBIDDEN,
          403,
          'You cannot deactivate or demote your own account.',
        );
      }
    }

    // 3. Last-admin guard.
    //    If the target is an ADMIN and the update would demote or deactivate them,
    //    ensure at least one other active ADMIN exists.
    const targetIsAdmin = target.role === 'ADMIN' && target.active;
    const wouldDemote = dto.role !== undefined && dto.role !== 'ADMIN';
    const wouldDeactivate = dto.active === false;

    if (targetIsAdmin && (wouldDemote || wouldDeactivate)) {
      const activeAdminCount = await usersRepository.countActiveAdmins();
      if (activeAdminCount <= 1) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          409,
          'Cannot remove the last active administrator.',
        );
      }
    }

    // 4. Duplicate email guard (only when email is being changed).
    if (dto.email !== undefined) {
      const emailConflict = await usersRepository.findByEmailExcludingId(dto.email, id);
      if (emailConflict) {
        throw new AppError(ERROR_CODES.CONFLICT, 409, 'A user with this email already exists.');
      }
    }

    // Hash password if it is being updated.
    const updatePayload: Partial<UpdateUserDto> & { password?: string } = { ...dto };
    if (dto.password !== undefined) {
      updatePayload.password = await authService.hashPassword(dto.password);
    }

    return usersRepository.update(id, updatePayload);
  }

  // ── Soft delete ────────────────────────────────────────────────────────────

  /**
   * Soft-delete a user (sets active = false).
   *
   * Guards (checked in order):
   *   1. 404 NOT_FOUND — user must exist.
   *   2. 403 FORBIDDEN — self-modification guard (cannot deactivate yourself).
   *   3. 409 CONFLICT  — last-admin guard (cannot deactivate the last active ADMIN).
   *
   * @param id           User being deleted.
   * @param requesterId  The authenticated user's id (from req.user.id).
   */
  async softDelete(id: string, requesterId: string): Promise<void> {
    // 1. Ensure the target user exists.
    const target = await usersRepository.findById(id);
    if (!target) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'User not found.');
    }

    // 2. Self-modification guard.
    if (id === requesterId) {
      throw new AppError(
        ERROR_CODES.FORBIDDEN,
        403,
        'You cannot deactivate or demote your own account.',
      );
    }

    // 3. Last-admin guard.
    if (target.role === 'ADMIN' && target.active) {
      const activeAdminCount = await usersRepository.countActiveAdmins();
      if (activeAdminCount <= 1) {
        throw new AppError(
          ERROR_CODES.CONFLICT,
          409,
          'Cannot remove the last active administrator.',
        );
      }
    }

    await usersRepository.softDelete(id);
  }
}

/** Singleton instance consumed by the users controller. */
export const usersService = new UsersService();
