/**
 * Unit tests for the assertMutationAllowed() guard.
 *
 * Tests per tasks.md 2.4 + specs/auth/spec.md
 * (Requirement: Middleware `authenticate`, scenarios 5-7):
 *   - Safe methods (GET/HEAD/OPTIONS) never throw, demo or not.
 *   - Unsafe verb + isDemo:true → throws AppError(DEMO_READ_ONLY, 403).
 *   - Unsafe verb + isDemo:false (or missing req.user) never throws.
 *
 * Lightweight Express Request mock — no HTTP server needed, matches the
 * pattern used by tests/unit/validate.test.ts and requireRole's unit
 * assertions in tests/smoke/auth.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { assertMutationAllowed } from '../../src/shared/middleware/assertMutationAllowed.js';
import { isAppError } from '../../src/shared/errors/AppError.js';
import { ERROR_CODES } from '../../src/shared/errors/errorCodes.js';

function makeReq(method: string, isDemo?: boolean): Request {
  return {
    method,
    user: isDemo === undefined ? undefined : { id: 'cuid-user-1', role: 'ADMIN' as const, isDemo },
  } as unknown as Request;
}

describe('assertMutationAllowed()', () => {
  describe('safe methods are always a no-op', () => {
    it.each(['GET', 'HEAD', 'OPTIONS'])(
      '%s does not throw when req.user.isDemo is true',
      (method) => {
        expect(() => assertMutationAllowed(makeReq(method, true))).not.toThrow();
      },
    );

    it.each(['GET', 'HEAD', 'OPTIONS'])(
      '%s does not throw when req.user.isDemo is false',
      (method) => {
        expect(() => assertMutationAllowed(makeReq(method, false))).not.toThrow();
      },
    );
  });

  describe('unsafe verb + isDemo:true throws DEMO_READ_ONLY', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      '%s throws AppError(DEMO_READ_ONLY, 403)',
      (method) => {
        let caught: unknown;
        try {
          assertMutationAllowed(makeReq(method, true));
          expect.fail('Should have thrown');
        } catch (e) {
          caught = e;
        }
        expect(isAppError(caught)).toBe(true);
        if (isAppError(caught)) {
          expect(caught.code).toBe(ERROR_CODES.DEMO_READ_ONLY);
          expect(caught.statusCode).toBe(403);
        }
      },
    );

    it('an arbitrary unsafe verb (e.g. TRACE) also throws', () => {
      let caught: unknown;
      try {
        assertMutationAllowed(makeReq('TRACE', true));
        expect.fail('Should have thrown');
      } catch (e) {
        caught = e;
      }
      expect(isAppError(caught)).toBe(true);
      if (isAppError(caught)) {
        expect(caught.code).toBe(ERROR_CODES.DEMO_READ_ONLY);
      }
    });
  });

  describe('non-demo users never throw', () => {
    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      '%s does not throw when req.user.isDemo is false',
      (method) => {
        expect(() => assertMutationAllowed(makeReq(method, false))).not.toThrow();
      },
    );

    it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
      '%s does not throw when req.user is not set (defensive default)',
      (method) => {
        expect(() => assertMutationAllowed(makeReq(method, undefined))).not.toThrow();
      },
    );
  });
});
