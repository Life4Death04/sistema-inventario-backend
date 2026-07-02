/**
 * Zod validation middleware factory.
 *
 * Usage:
 *   router.post('/login', validate(loginSchema, 'body'), loginController);
 *
 * On success: replaces req[target] with the Zod-parsed output (typed and
 *   coerced). Downstream handlers receive clean, type-safe data.
 *
 * On failure: calls next() with an AppError so the global errorHandler
 *   produces the standard error envelope:
 *
 *   {
 *     "error": "<code>",
 *     "message": "Invalid request <target>.",
 *     "statusCode": 400,
 *     "details": { "fieldName": "error message" }   // only for VALIDATION_ERROR
 *   }
 *
 * Sentinel mapping:
 *   When a Zod issue message exactly equals a known sentinel string, the
 *   middleware maps it to a specific AppError code instead of the generic
 *   VALIDATION_ERROR. Currently mapped sentinels:
 *
 *   "REPLENISHMENT_ITEMS_REQUIRED" → AppError(REPLENISHMENT_ITEMS_REQUIRED, 400)
 *
 *   Sentinel matching is exact and case-sensitive, scoped to the known list
 *   below. All other Zod failures still produce VALIDATION_ERROR.
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodSchema } from 'zod';
import { AppError } from '../errors/AppError.js';
import { ERROR_CODES } from '../errors/errorCodes.js';

type Target = 'body' | 'params' | 'query';

/**
 * Known sentinel messages that map to a specific AppError code.
 * The key is the Zod issue message; the value is the target error code.
 * Add new sentinels here when a schema needs a specific error code.
 */
const SENTINEL_CODES: Record<string, string> = {
  REPLENISHMENT_ITEMS_REQUIRED: ERROR_CODES.REPLENISHMENT_ITEMS_REQUIRED,
};

export function validate(schema: ZodSchema, target: Target = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
      // Check all Zod issues for a sentinel message before falling back
      // to the generic VALIDATION_ERROR path.
      for (const issue of result.error.issues) {
        const sentinelCode = SENTINEL_CODES[issue.message];
        if (sentinelCode !== undefined) {
          next(new AppError(sentinelCode, 400, `Invalid request ${target}.`));
          return;
        }
      }

      // Flatten Zod issues to a simple { field: firstMessage } map.
      const rawFieldErrors = result.error.flatten().fieldErrors;
      const details: Record<string, string> = {};
      for (const [field, messages] of Object.entries(rawFieldErrors)) {
        if (messages && messages.length > 0) {
          details[field] = messages[0] ?? 'Invalid value';
        }
      }

      next(new AppError(ERROR_CODES.VALIDATION_ERROR, 400, `Invalid request ${target}.`, details));
      return;
    }

    // Replace the raw input with the parsed (and potentially transformed) output.
    // Express types req[target] as loosely typed; cast is unavoidable here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment
    (req as any)[target] = result.data;
    next();
  };
}
