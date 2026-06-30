/**
 * AuthRepository — Prisma data-access layer for authentication.
 *
 * DESIGN NOTE (design.md §6):
 *   RefreshToken.id (@id @default(cuid())) IS the JWT jti claim.
 *   There is no separate jti column. The DB auto-generates a cuid on INSERT.
 *   After createRefreshToken() returns, use the row's `.id` as the jti
 *   when calling authService.signRefreshToken(userId, row.id).
 *
 * All methods are pure data-access; no business logic lives here.
 * Services/controllers apply rules on the returned data.
 */
import type { RefreshToken, User } from '@prisma/client';
import { prisma } from '../../shared/utils/prisma.js';

export class AuthRepository {
  // ── User queries ────────────────────────────────────────────────────────────

  /**
   * Find a user by email address.
   * Returns null when no match — service decides whether that is an error.
   */
  async findUserByEmail(email: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { email } });
  }

  /**
   * Find a user by primary key.
   * Returns null when not found — service decides handling.
   */
  async findUserById(id: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  }

  // ── RefreshToken queries ───────────────────────────────────────────────────

  /**
   * Persist a new RefreshToken row.
   *
   * Prisma auto-generates the row's `id` as a cuid (see schema RefreshToken.id).
   * The returned `row.id` IS the jti that must be embedded in the refresh JWT.
   *
   * @param userId    Owner of the token.
   * @param expiresAt Expiry matching the JWT exp (for cleanup queries).
   * @param userAgent Optional UA string for audit trail.
   * @param ip        Optional client IP for audit trail.
   */
  async createRefreshToken(params: {
    userId: string;
    expiresAt: Date;
    userAgent?: string;
    ip?: string;
  }): Promise<RefreshToken> {
    return prisma.refreshToken.create({
      data: {
        userId: params.userId,
        expiresAt: params.expiresAt,
        userAgent: params.userAgent,
        ip: params.ip,
      },
    });
  }

  /**
   * Find a RefreshToken by its id (= jti claim embedded in the JWT).
   * Returns null when the row does not exist (reuse-detection or already purged).
   */
  async findRefreshTokenByJti(jti: string): Promise<RefreshToken | null> {
    return prisma.refreshToken.findUnique({ where: { id: jti } });
  }

  /**
   * Mark a single RefreshToken row as revoked.
   *
   * Idempotent — calling again on an already-revoked row is harmless.
   * Returns null when the row was not found (e.g. logout without a stored token).
   */
  async revokeRefreshToken(jti: string): Promise<RefreshToken | null> {
    try {
      return await prisma.refreshToken.update({
        where: { id: jti },
        data: { revoked: true, revokedAt: new Date() },
      });
    } catch {
      // P2025 — record not found; treat as already revoked (idempotent).
      return null;
    }
  }

  /**
   * Revoke ALL active refresh tokens for a user.
   *
   * Called during reuse-detection: if a previously-rotated jti is presented
   * again, the entire token family is revoked as a compromise defense.
   * (design.md §6 — "revoca TODOS los del user")
   */
  async revokeAllUserRefreshTokens(userId: string): Promise<void> {
    await prisma.refreshToken.updateMany({
      where: { userId, revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
  }
}

/** Singleton instance used by the auth controller. */
export const authRepository = new AuthRepository();
