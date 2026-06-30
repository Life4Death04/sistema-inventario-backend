/**
 * Global Express error middleware.
 *
 * Registered LAST in app.ts (after all routes and the notFound handler).
 * Converts any thrown value into a structured JSON error envelope:
 *
 *   { error, message, statusCode, details? }
 *
 * Mapping rules:
 *   - AppError              → use its code/statusCode/details directly
 *   - ZodError              → 400 VALIDATION_ERROR with field-level details
 *   - PrismaClientKnownRequestError
 *       P2002 (unique)      → 409 CONFLICT
 *       P2025 (not found)   → 404 NOT_FOUND
 *       others              → 500 INTERNAL_ERROR (logged)
 *   - Unknown errors        → 500 INTERNAL_ERROR; stack logged; no leak to client
 *
 * Development mode: stack trace is included in `details.stack` for unknown
 * errors to aid debugging. Never sent in production.
 */
import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { isAppError } from './AppError.js';
import { ERROR_CODES } from './errorCodes.js';
import logger from '../logger/index.js';
import { env } from '../../config/env.js';

/** Standard error response envelope sent to clients. */
interface ErrorEnvelope {
  error: string;
  message: string;
  statusCode: number;
  details?: unknown;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  // ── AppError ────────────────────────────────────────────────────────────
  if (isAppError(err)) {
    const body: ErrorEnvelope = {
      error: err.code,
      message: err.message,
      statusCode: err.statusCode,
      ...(err.details !== undefined && { details: err.details }),
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // ── ZodError (should rarely reach here — validate() catches them first) ──
  if (err instanceof ZodError) {
    const fieldErrors = err.flatten().fieldErrors;
    const body: ErrorEnvelope = {
      error: ERROR_CODES.VALIDATION_ERROR,
      message: 'Validation failed.',
      statusCode: 400,
      details: { fieldErrors },
    };
    res.status(400).json(body);
    return;
  }

  // ── Prisma known request errors ─────────────────────────────────────────
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === 'P2002') {
      // Unique constraint violation
      const body: ErrorEnvelope = {
        error: ERROR_CODES.CONFLICT,
        message: 'A record with that value already exists.',
        statusCode: 409,
      };
      res.status(409).json(body);
      return;
    }

    if (err.code === 'P2025') {
      // Record not found
      const body: ErrorEnvelope = {
        error: ERROR_CODES.NOT_FOUND,
        message: 'The requested record was not found.',
        statusCode: 404,
      };
      res.status(404).json(body);
      return;
    }

    // Other known Prisma errors → log and return 500
    logger.error({ err, reqId: req.id }, 'Unhandled Prisma error');
    const body: ErrorEnvelope = {
      error: ERROR_CODES.INTERNAL_ERROR,
      message: 'An unexpected error occurred.',
      statusCode: 500,
    };
    res.status(500).json(body);
    return;
  }

  // ── Unknown / unexpected errors ─────────────────────────────────────────
  const error = err instanceof Error ? err : new Error(String(err));
  logger.error({ err: error, reqId: req.id }, 'Unhandled server error');

  const body: ErrorEnvelope = {
    error: ERROR_CODES.INTERNAL_ERROR,
    message: 'An unexpected error occurred.',
    statusCode: 500,
    ...(env.NODE_ENV !== 'production' && {
      details: { stack: error.stack },
    }),
  };
  res.status(500).json(body);
}
