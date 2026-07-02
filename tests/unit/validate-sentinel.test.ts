/**
 * Unit tests for validate() sentinel mapping behavior.
 *
 * Verifies that Zod issue messages matching known sentinel strings are
 * mapped to specific AppError codes instead of the generic VALIDATION_ERROR.
 *
 * Currently tested sentinels:
 *   "REPLENISHMENT_ITEMS_REQUIRED" → AppError code REPLENISHMENT_ITEMS_REQUIRED (400)
 */
import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { validate } from '../../src/shared/validation/validate.js';
import { isAppError } from '../../src/shared/errors/AppError.js';
import { ERROR_CODES } from '../../src/shared/errors/errorCodes.js';

const mockRes = {} as Response;

function makeReq(body: unknown): Partial<Request> {
  return { body } as Partial<Request>;
}

// Schema that uses the REPLENISHMENT_ITEMS_REQUIRED sentinel message on min(1).
const itemsSchema = z.object({
  supplierId: z.string(),
  items: z
    .array(z.object({ productId: z.string(), requestedQuantity: z.number() }))
    .min(1, { message: 'REPLENISHMENT_ITEMS_REQUIRED' }),
});

describe('validate() sentinel mapping', () => {
  it('maps REPLENISHMENT_ITEMS_REQUIRED sentinel to specific AppError code (not VALIDATION_ERROR)', () => {
    const next = vi.fn() as NextFunction;
    const req = makeReq({ supplierId: 'cld2cjxh0000qzrmn831i7rn', items: [] });

    validate(itemsSchema, 'body')(req as Request, mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as unknown;
    expect(isAppError(err)).toBe(true);
    if (isAppError(err)) {
      expect(err.code).toBe(ERROR_CODES.REPLENISHMENT_ITEMS_REQUIRED);
      expect(err.statusCode).toBe(400);
      // Sentinel errors do NOT carry field-level details.
      expect(err.details).toBeUndefined();
    }
  });

  it('still produces VALIDATION_ERROR for non-sentinel Zod failures', () => {
    const next = vi.fn() as NextFunction;
    // supplierId is missing → generic validation failure
    const req = makeReq({ items: [{ productId: 'cld', requestedQuantity: 1 }] });

    validate(itemsSchema, 'body')(req as Request, mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as unknown;
    expect(isAppError(err)).toBe(true);
    if (isAppError(err)) {
      expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
      expect(err.statusCode).toBe(400);
    }
  });

  it('sentinel takes priority over other field errors in the same parse failure', () => {
    const next = vi.fn() as NextFunction;
    // Both supplierId is missing AND items is empty → sentinel wins
    const req = makeReq({ items: [] });

    validate(itemsSchema, 'body')(req as Request, mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    const err = (next as ReturnType<typeof vi.fn>).mock.calls[0][0] as unknown;
    expect(isAppError(err)).toBe(true);
    if (isAppError(err)) {
      expect(err.code).toBe(ERROR_CODES.REPLENISHMENT_ITEMS_REQUIRED);
    }
  });

  it('passes through when items array has at least one item', () => {
    const next = vi.fn() as NextFunction;
    const req = makeReq({
      supplierId: 'cld2cjxh0000qzrmn831i7rn',
      items: [{ productId: 'cld2cjxh0001qzrmn831i7rn', requestedQuantity: 2 }],
    });

    validate(itemsSchema, 'body')(req as Request, mockRes, next);

    expect(next).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalledWith(/* no error */);
  });
});
