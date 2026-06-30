/**
 * requireRole — role-based access control middleware factory.
 *
 * MUST be used AFTER the authenticate middleware. If req.user is not set
 * when this middleware runs, it is a configuration bug and returns 500.
 *
 * Spec (specs/auth/spec.md — Requirement: Middleware requireRole):
 *   - req.user missing         → 500 INTERNAL_ERROR (misconfiguration guard)
 *   - role not in allowed list → 403 FORBIDDEN
 *   - role is allowed          → calls next()
 *
 * Usage:
 *   router.get('/admin-only', authenticate, requireRole('ADMIN'), handler)
 *   router.post('/report',    authenticate, requireRole('ADMIN', 'MANAGER'), handler)
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { UserRole } from '@prisma/client';
import { AppError } from '../errors/AppError.js';
import { ERROR_CODES } from '../errors/errorCodes.js';

export function requireRole(...allowed: UserRole[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    // Defense-in-profundity: requireRole without authenticate is a wiring bug.
    if (!req.user) {
      throw new AppError(
        ERROR_CODES.INTERNAL_ERROR,
        500,
        'requireRole called without authenticate — missing req.user (configuration error).',
      );
    }

    if (!allowed.includes(req.user.role)) {
      throw new AppError(
        ERROR_CODES.FORBIDDEN,
        403,
        'You do not have permission to perform this action.',
      );
    }

    next();
  };
}
