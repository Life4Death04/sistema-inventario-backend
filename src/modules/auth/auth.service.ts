/**
 * AuthService — pure business logic for authentication.
 *
 * Responsibilities:
 *   - Password hashing and comparison (bcrypt, cost from env, default 10).
 *   - JWT access token signing and verification (HS256, TTL from env).
 *   - JWT refresh token signing and verification (HS256, TTL from env).
 *
 * CRITICAL design constraints (design.md §6):
 *   - RefreshToken.id (@id @default(cuid())) IS the JWT jti claim.
 *   - There is NO separate jti column — the row's PK equals the jti.
 *   - Caller flow for login/refresh:
 *       1. Create RefreshToken row in DB (Prisma auto-generates cuid id).
 *       2. Use returned row.id as the jti argument to signRefreshToken().
 *       3. Store the resulting JWT in the cookie.
 *
 * This service does NOT import Express or interact with the HTTP layer.
 * It is consumed by auth.controller.ts.
 */
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import type { UserRole } from '@prisma/client';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { env } from '../../config/env.js';

// ── Token payload types ───────────────────────────────────────────────────────

/** Claims embedded in the short-lived access token. */
export interface AccessTokenPayload {
  sub: string;
  role: UserRole;
  iat: number;
  exp: number;
}

/**
 * Claims embedded in the long-lived refresh token.
 * NOTE: jti = RefreshToken.id (cuid) from the DB row — NOT a separately
 * generated ID. Always store the DB row first, then sign with its id.
 */
export interface RefreshTokenPayload {
  sub: string;
  jti: string;
  iat: number;
  exp: number;
}

// ── AuthService ───────────────────────────────────────────────────────────────

export class AuthService {
  // ── Password utilities ──────────────────────────────────────────────────────

  /**
   * Hash a plain-text password.
   * Cost factor comes from env.BCRYPT_COST (default 10, validated 8-14 by Zod).
   * Never log or store the plain-text value.
   */
  async hashPassword(plain: string): Promise<string> {
    return bcrypt.hash(plain, env.BCRYPT_COST);
  }

  /**
   * Compare a plain-text password against a stored bcrypt hash.
   * Returns true when they match; false otherwise.
   * Constant-time comparison — safe against timing attacks.
   */
  async comparePassword(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }

  // ── Access token ─────────────────────────────────────────────────────────────

  /**
   * Sign a short-lived access JWT.
   *
   * Payload: { sub: userId, role, iat, exp }
   * Algorithm: HS256.
   * TTL: env.JWT_ACCESS_TTL (default '15m').
   * Transport: Authorization: Bearer <token> header.
   *
   * @param userId  The user's cuid primary key.
   * @param role    The user's current role (embedded in token — NOT re-read on each request).
   */
  signAccessToken(userId: string, role: UserRole): string {
    const payload = { sub: userId, role };
    return jwt.sign(payload, env.JWT_ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
    });
  }

  /**
   * Verify and decode an access JWT.
   *
   * Throws AppError on failure — never returns undefined:
   *   - Expired:          TOKEN_EXPIRED  (401)
   *   - Invalid/tampered: INVALID_TOKEN  (401)
   *
   * @param token  Raw JWT string from the Authorization header (without 'Bearer ').
   */
  verifyAccessToken(token: string): { sub: string; role: UserRole } {
    try {
      const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET, {
        algorithms: ['HS256'],
      }) as AccessTokenPayload;
      return { sub: decoded.sub, role: decoded.role };
    } catch (err) {
      if (err instanceof jwt.TokenExpiredError) {
        throw new AppError(ERROR_CODES.TOKEN_EXPIRED, 401, 'Access token has expired.');
      }
      throw new AppError(ERROR_CODES.INVALID_TOKEN, 401, 'Access token is invalid.');
    }
  }

  // ── Refresh token ─────────────────────────────────────────────────────────────

  /**
   * Sign a long-lived refresh JWT.
   *
   * IMPORTANT: The jti MUST be the id of the already-persisted RefreshToken
   * row (Prisma @default(cuid())).  Persist the DB row BEFORE calling this.
   *
   * Payload: { sub: userId, jti, iat, exp }
   * Algorithm: HS256.
   * TTL: env.JWT_REFRESH_TTL (default '7d').
   * Transport: Set-Cookie: refresh_token=<jwt>; HttpOnly; ...
   *
   * @param userId  The user's cuid primary key.
   * @param jti     The RefreshToken.id from the DB row (= the allowlist key).
   */
  signRefreshToken(userId: string, jti: string): string {
    const payload = { sub: userId, jti };
    return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
      algorithm: 'HS256',
      expiresIn: env.JWT_REFRESH_TTL as jwt.SignOptions['expiresIn'],
    });
  }

  /**
   * Verify and decode a refresh JWT.
   *
   * Throws AppError(INVALID_REFRESH_TOKEN, 401) for any failure (expired or
   * invalid). The spec treats both identically — client must re-authenticate.
   *
   * @param token  Raw JWT string from the refresh_token cookie.
   */
  verifyRefreshToken(token: string): { sub: string; jti: string } {
    try {
      const decoded = jwt.verify(token, env.JWT_REFRESH_SECRET, {
        algorithms: ['HS256'],
      }) as RefreshTokenPayload;
      return { sub: decoded.sub, jti: decoded.jti };
    } catch {
      // Both expired and tampered refresh tokens → same client-facing error.
      throw new AppError(
        ERROR_CODES.INVALID_REFRESH_TOKEN,
        401,
        'Refresh token is invalid or expired.',
      );
    }
  }

  // ── Cookie helper ─────────────────────────────────────────────────────────────

  /**
   * Parse a JWT-style TTL string into the corresponding number of seconds.
   *
   * Used to compute the cookie Max-Age value so it matches the JWT exp.
   * Examples: '7d' → 604800,  '15m' → 900,  '3600' → 3600 (raw seconds).
   */
  parseTtlToSeconds(ttl: string): number {
    const match = /^(\d+)([smhd]?)$/.exec(ttl);
    if (!match) return 7 * 24 * 60 * 60; // fallback 7d in seconds

    const value = parseInt(match[1] ?? '0', 10);
    const unit = match[2] ?? 's';

    const multipliers: Record<string, number> = {
      s: 1,
      m: 60,
      h: 3_600,
      d: 86_400,
    };

    return value * (multipliers[unit] ?? 1);
  }

  /**
   * Compute the expiresAt Date for a new RefreshToken DB row.
   * Derived from env.JWT_REFRESH_TTL so the DB row and JWT stay in sync.
   */
  computeRefreshTokenExpiry(): Date {
    const seconds = this.parseTtlToSeconds(env.JWT_REFRESH_TTL);
    return new Date(Date.now() + seconds * 1_000);
  }
}

/** Singleton instance consumed by the auth controller and authenticate middleware. */
export const authService = new AuthService();
