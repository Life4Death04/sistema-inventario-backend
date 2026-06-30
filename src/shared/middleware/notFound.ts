/**
 * 404 catch-all handler.
 *
 * Registered in app.ts AFTER all route mounts and BEFORE errorHandler.
 * Any request that reaches this middleware did not match a registered route;
 * respond with a structured NOT_FOUND envelope.
 */
import type { NextFunction, Request, Response } from 'express';
import { ERROR_CODES } from '../errors/errorCodes.js';

export function notFound(req: Request, res: Response, _next: NextFunction): void {
  res.status(404).json({
    error: ERROR_CODES.NOT_FOUND,
    message: `Route ${req.method} ${req.path} not found.`,
    statusCode: 404,
  });
}
