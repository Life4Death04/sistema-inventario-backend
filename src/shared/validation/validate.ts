/**
 * Zod validation middleware factory.
 *
 * Usage:
 *   router.post('/login', validate(loginSchema, 'body'), loginController);
 *
 * On success: replaces req[target] with the Zod-parsed output (typed and
 *   coerced). Downstream handlers receive clean, type-safe data.
 *
 * On failure: calls next() with an AppError(VALIDATION_ERROR, 400, ...,
 *   details) so the global errorHandler produces the standard envelope:
 *
 *   {
 *     "error": "VALIDATION_ERROR",
 *     "message": "Invalid request <target>.",
 *     "statusCode": 400,
 *     "details": { "fieldName": "error message" }
 *   }
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodSchema } from 'zod';
import { AppError } from '../errors/AppError.js';
import { ERROR_CODES } from '../errors/errorCodes.js';

type Target = 'body' | 'params' | 'query';

export function validate(schema: ZodSchema, target: Target = 'body'): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const result = schema.safeParse(req[target]);

    if (!result.success) {
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
