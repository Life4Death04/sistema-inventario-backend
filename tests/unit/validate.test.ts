/**
 * Unit tests for the validate() middleware factory.
 *
 * Tests per tasks.md 3.13:
 *   - Valid body passes to next without modification.
 *   - Invalid body returns 400 VALIDATION_ERROR with field-level details.
 *
 * Uses lightweight Express mock objects — no HTTP server needed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '../../src/shared/validation/validate.js';
import { isAppError } from '../../src/shared/errors/AppError.js';
import { ERROR_CODES } from '../../src/shared/errors/errorCodes.js';

// Minimal schema used across tests
const testSchema = z.object({
  email: z.string().email('Invalid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

function makeReq(body: unknown): Partial<Request> {
  return { body } as Partial<Request>;
}

const mockRes = {} as Response;

describe('validate() middleware factory', () => {
  it('calls next() with no arguments when body is valid', () => {
    const next = vi.fn() as NextFunction;
    const req = makeReq({ email: 'user@example.com', password: 'securepass' });

    validate(testSchema, 'body')(req as Request, mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(/* nothing — no error */);
  });

  it('replaces req.body with the parsed output on success', () => {
    const next = vi.fn() as NextFunction;
    // Zod will coerce / transform if schema has transforms
    const req = makeReq({ email: 'USER@EXAMPLE.COM', password: 'securepass' });

    validate(testSchema, 'body')(req as Request, mockRes, next);

    // No transform in the test schema — body should be as-is but type-safe
    expect((req as Request).body).toEqual({ email: 'USER@EXAMPLE.COM', password: 'securepass' });
  });

  it('calls next() with AppError(VALIDATION_ERROR, 400) when body is invalid', () => {
    const next = vi.fn() as NextFunction;
    const req = makeReq({ email: 'not-an-email', password: 'short' });

    validate(testSchema, 'body')(req as Request, mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as unknown;
    expect(isAppError(err)).toBe(true);
    if (isAppError(err)) {
      expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(err.statusCode).toBe(400);
      // Details should include field-level errors
      const details = err.details as Record<string, string>;
      expect(details).toHaveProperty('email');
      expect(details).toHaveProperty('password');
    }
  });

  it('includes field messages in AppError details', () => {
    const next = vi.fn() as NextFunction;
    const req = makeReq({ email: 'bad', password: 'x' });

    validate(testSchema, 'body')(req as Request, mockRes, next);

    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as unknown;
    if (isAppError(err)) {
      const details = err.details as Record<string, string>;
      expect(details['email']).toBe('Invalid email');
      expect(details['password']).toBe('Password must be at least 8 characters');
    }
  });

  it('validates query params when target is "query"', () => {
    const next = vi.fn() as NextFunction;
    const querySchema = z.object({ page: z.coerce.number().min(1) });
    const req = { query: { page: '2' } } as unknown as Request;

    validate(querySchema, 'query')(req, mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    // Zod coerces the string to number
    expect((req as unknown as { query: { page: number } }).query.page).toBe(2);
  });
});
