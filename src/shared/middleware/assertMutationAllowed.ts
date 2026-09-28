/**
 * assertMutationAllowed — universal read-only guard for the demo account.
 *
 * Spec (specs/auth/spec.md — Requirement: Middleware authenticate, point 5):
 *   After req.user is populated, if req.user.isDemo is true and the request
 *   method is not a safe method (GET, HEAD, OPTIONS), respond 403
 *   DEMO_READ_ONLY and never call next() — no state is mutated. Safe methods
 *   are always allowed. Non-demo users are unaffected by this policy.
 *
 * design.md — Architecture Decisions:
 *   Extracted as a small, named, unit-testable function so it can be called
 *   from a single chokepoint (`authenticate`, the universally-first
 *   middleware on every protected route) instead of a per-route allowlist
 *   or a separate global app.ts guard (which would require a second decode).
 *
 * This function throws synchronously (does not call next(err)) — matching
 * the existing requireRole pattern. express-async-errors only patches async
 * handlers; synchronous throws inside a RequestHandler are caught natively
 * by Express and forwarded to the global errorHandler.
 */
import type { Request } from 'express';
import { AppError } from '../errors/AppError.js';
import { ERROR_CODES } from '../errors/errorCodes.js';

/** HTTP methods that never mutate state — always allowed for demo users. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function assertMutationAllowed(req: Request): void {
  // Defensive default: no req.user (misconfigured caller) is never demo.
  if (!req.user?.isDemo) return;

  if (SAFE_METHODS.has(req.method)) return;

  throw new AppError(
    ERROR_CODES.DEMO_READ_ONLY,
    403,
    'The shared demo account is read-only. Mutating requests are not allowed.',
  );
}
