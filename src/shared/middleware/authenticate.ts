/**
 * authenticate — JWT access token verification middleware.
 *
 * Reads the Authorization header, validates the Bearer token, and populates
 * req.user = { id, role, isDemo } for downstream handlers.
 *
 * Spec (specs/auth/spec.md — Requirement: Middleware authenticate):
 *   1. Missing or non-Bearer header → 401 MISSING_TOKEN.
 *   2. Invalid JWT signature        → 401 INVALID_TOKEN.
 *   3. Expired JWT                  → 401 TOKEN_EXPIRED.
 *   4. Valid token                  → sets req.user, calls next().
 *   5. After req.user is set, enforces the demo read-only policy via
 *      assertMutationAllowed(req) BEFORE calling next() — unsafe methods
 *      (non GET/HEAD/OPTIONS) for a demo user respond 403 DEMO_READ_ONLY
 *      and the business handler never runs. Non-demo users are unaffected.
 *
 * IMPORTANT: This middleware does NOT query the DB on every request.
 * The token payload is trusted after signature verification.
 * Endpoints that need fresh DB data (e.g. GET /me) perform their own lookup.
 *
 * express-async-errors is already registered in app.ts so thrown AppErrors
 * propagate to the global errorHandler automatically.
 */
import type { Request, Response, NextFunction } from 'express';
import { authService } from '../../modules/auth/auth.service.js';
import { AppError } from '../errors/AppError.js';
import { ERROR_CODES } from '../errors/errorCodes.js';
import { assertMutationAllowed } from './assertMutationAllowed.js';

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new AppError(
      ERROR_CODES.MISSING_TOKEN,
      401,
      'Authorization header is missing or malformed. Expected: Bearer <token>',
    );
  }

  const token = authHeader.slice(7); // Remove 'Bearer ' prefix

  // verifyAccessToken throws AppError(TOKEN_EXPIRED | INVALID_TOKEN) on failure.
  const payload = authService.verifyAccessToken(token);

  // Populate req.user for downstream middleware and controllers.
  req.user = { id: payload.sub, role: payload.role, isDemo: payload.isDemo };

  // Demo read-only enforcement — throws 403 DEMO_READ_ONLY and skips next()
  // for unsafe methods on the shared demo account. No-op for non-demo users.
  assertMutationAllowed(req);

  next();
}
