/**
 * Auth controller — HTTP handlers for the 4 auth endpoints.
 *
 * Flow per design.md §6:
 *   login    → verify credentials → create RefreshToken row → sign tokens → set cookie
 *   refresh  → verify JWT → lookup DB row → rotate token → set new cookie
 *   logout   → revoke DB row (if any) → clear cookie → 204
 *   me       → re-read user from DB → return sanitized shape
 *
 * All handlers rely on express-async-errors to propagate thrown AppErrors.
 * No try/catch is needed in happy-path logic.
 *
 * Cookie attributes per design.md §6 + spec:
 *   HttpOnly; Secure (production only); SameSite=Strict; Path=/api/auth; Max-Age=<seconds>
 */
import type { Request, Response, CookieOptions } from 'express';
import { authService } from './auth.service.js';
import { authRepository } from './auth.repository.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { env } from '../../config/env.js';
import type { LoginDto } from './auth.schema.js';

// ── Cookie configuration ──────────────────────────────────────────────────────

/** Build the Set-Cookie options for the refresh_token cookie. */
function refreshCookieOptions(maxAgeSeconds: number): CookieOptions {
  return {
    httpOnly: true,
    // Secure flag only in production — allows HTTP in dev/test (spec §54).
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: maxAgeSeconds * 1_000, // Express CookieOptions.maxAge is milliseconds
  };
}

/** Cookie options that immediately expire the cookie (logout / Max-Age=0). */
function clearCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: 0,
  };
}

// ── Sanitize user for API response ────────────────────────────────────────────

/**
 * Strip password (and updatedAt) from a User row before returning it to
 * the client. The spec shape: { id, fullName, email, role, active, phone, createdAt }.
 */
function sanitizeUser(user: {
  id: string;
  fullName: string;
  email: string;
  role: string;
  active: boolean;
  phone: string | null;
  createdAt: Date;
  [key: string]: unknown;
}) {
  return {
    id: user.id,
    fullName: user.fullName,
    email: user.email,
    role: user.role,
    active: user.active,
    phone: user.phone,
    createdAt: user.createdAt,
  };
}

// ── POST /api/auth/login ──────────────────────────────────────────────────────

/**
 * Login with email + password.
 *
 * Spec scenarios:
 *   - 200: active user with correct credentials → { user, token } + Set-Cookie
 *   - 401: email not found → INVALID_CREDENTIALS (same message as wrong password)
 *   - 401: wrong password → INVALID_CREDENTIALS
 *   - 403: inactive user → USER_INACTIVE
 *
 * Security note: email-not-found and wrong-password both return INVALID_CREDENTIALS
 * with the same message to prevent user enumeration attacks.
 */
export async function loginController(req: Request, res: Response): Promise<void> {
  const { email, password } = req.body as LoginDto;

  // Lookup user — use same error for not-found AND wrong-password.
  const user = await authRepository.findUserByEmail(email);
  if (!user) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 401, 'Email or password is incorrect.');
  }

  // Verify password before checking active status to avoid user enumeration.
  const passwordMatch = await authService.comparePassword(password, user.password);
  if (!passwordMatch) {
    throw new AppError(ERROR_CODES.INVALID_CREDENTIALS, 401, 'Email or password is incorrect.');
  }

  // After verifying credentials, check if the account is active.
  if (!user.active) {
    throw new AppError(
      ERROR_CODES.USER_INACTIVE,
      403,
      'This account is inactive. Contact an administrator.',
    );
  }

  // Create DB allowlist row first — get the cuid id that becomes the jti.
  const expiresAt = authService.computeRefreshTokenExpiry();
  const refreshTokenRow = await authRepository.createRefreshToken({
    userId: user.id,
    expiresAt,
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });

  // Sign both tokens.
  const accessToken = authService.signAccessToken(user.id, user.role);
  const refreshTokenJwt = authService.signRefreshToken(user.id, refreshTokenRow.id);

  // Set the refresh token cookie.
  const maxAgeSeconds = authService.parseTtlToSeconds(env.JWT_REFRESH_TTL);
  res.cookie('refresh_token', refreshTokenJwt, refreshCookieOptions(maxAgeSeconds));

  res.status(200).json({
    user: sanitizeUser(user),
    token: accessToken,
  });
}

// ── POST /api/auth/refresh ────────────────────────────────────────────────────

/**
 * Rotate the refresh token.
 *
 * Spec scenarios:
 *   - 200: valid, non-revoked cookie → { token } + new Set-Cookie (rotated)
 *   - 401 MISSING_REFRESH_TOKEN: no cookie
 *   - 401 INVALID_REFRESH_TOKEN: bad JWT signature, expired, or revoked
 *   - 401 USER_INACTIVE_OR_DELETED: user no longer active in DB
 *
 * Reuse detection (design.md §6):
 *   If jti is not found in DB (was already rotated), revoke ALL tokens for
 *   the user (possible token theft) and return 401.
 */
export async function refreshController(req: Request, res: Response): Promise<void> {
  const rawCookie: string | undefined = req.cookies['refresh_token'] as string | undefined;

  if (!rawCookie) {
    throw new AppError(ERROR_CODES.MISSING_REFRESH_TOKEN, 401, 'Refresh token cookie is missing.');
  }

  // Verify JWT signature + expiry.
  const { sub: userId, jti } = authService.verifyRefreshToken(rawCookie);

  // Lookup DB row — missing row means reuse (token already rotated).
  const tokenRow = await authRepository.findRefreshTokenByJti(jti);

  if (!tokenRow) {
    // Potential token reuse: rotate the old token but can't find it → revoke ALL.
    await authRepository.revokeAllUserRefreshTokens(userId);
    throw new AppError(
      ERROR_CODES.INVALID_REFRESH_TOKEN,
      401,
      'Refresh token has already been used or does not exist.',
    );
  }

  if (tokenRow.revoked) {
    // Token was explicitly revoked (logout, prior rotation, or compromise sweep).
    await authRepository.revokeAllUserRefreshTokens(userId);
    throw new AppError(ERROR_CODES.INVALID_REFRESH_TOKEN, 401, 'Refresh token has been revoked.');
  }

  // Check user still exists and is active.
  const user = await authRepository.findUserById(userId);
  if (!user || !user.active) {
    throw new AppError(
      ERROR_CODES.USER_INACTIVE_OR_DELETED,
      401,
      'User account is inactive or no longer exists.',
    );
  }

  // Revoke the consumed token row (rotation step).
  await authRepository.revokeRefreshToken(jti);

  // Issue new token family member.
  const expiresAt = authService.computeRefreshTokenExpiry();
  const newRow = await authRepository.createRefreshToken({
    userId: user.id,
    expiresAt,
    userAgent: req.headers['user-agent'],
    ip: req.ip,
  });

  const newAccessToken = authService.signAccessToken(user.id, user.role);
  const newRefreshJwt = authService.signRefreshToken(user.id, newRow.id);

  const maxAgeSeconds = authService.parseTtlToSeconds(env.JWT_REFRESH_TTL);
  res.cookie('refresh_token', newRefreshJwt, refreshCookieOptions(maxAgeSeconds));

  res.status(200).json({ token: newAccessToken });
}

// ── POST /api/auth/logout ─────────────────────────────────────────────────────

/**
 * Logout — clear the refresh_token cookie and revoke the DB row.
 *
 * Spec: 204 No Content. Idempotent (works without a cookie).
 * Auth NOT required — logout must work even with an expired access token.
 */
export async function logoutController(req: Request, res: Response): Promise<void> {
  const rawCookie: string | undefined = req.cookies['refresh_token'] as string | undefined;

  if (rawCookie) {
    // Best-effort: verify and revoke. If token is invalid/expired, still clear cookie.
    try {
      const { jti } = authService.verifyRefreshToken(rawCookie);
      await authRepository.revokeRefreshToken(jti);
    } catch {
      // Invalid/expired token — still clear the cookie below.
    }
  }

  // Clear the cookie unconditionally.
  res.clearCookie('refresh_token', clearCookieOptions());
  res.status(204).end();
}

// ── GET /api/auth/me ──────────────────────────────────────────────────────────

/**
 * Return the currently authenticated user.
 *
 * Protected by authenticate middleware → req.user is guaranteed populated.
 * Re-reads the user from DB for freshness (role/active may have changed).
 *
 * Spec: 200 { user: { id, fullName, email, role, active, phone, createdAt } }
 */
export async function meController(req: Request, res: Response): Promise<void> {
  // req.user is set by authenticate middleware — undefined here is a bug.
  if (!req.user) {
    throw new AppError(ERROR_CODES.INTERNAL_ERROR, 500, 'Authentication state missing.');
  }

  const user = await authRepository.findUserById(req.user.id);
  if (!user || !user.active) {
    throw new AppError(
      ERROR_CODES.USER_INACTIVE_OR_DELETED,
      401,
      'User account is inactive or no longer exists.',
    );
  }

  res.status(200).json({ user: sanitizeUser(user) });
}
