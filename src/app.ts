/**
 * Express application factory.
 *
 * Builds and exports the Express `app` instance WITHOUT calling `listen()`.
 * Import this in tests (Supertest) to run requests without opening a TCP port.
 * Only `src/server.ts` calls `app.listen()`.
 *
 * Middleware order (per design.md §4):
 *   1. express-async-errors patch (import side-effect — must be first)
 *   2. helmet      — security headers
 *   3. cors        — cross-origin resource sharing
 *   4. cookie-parser — parses Cookie header into req.cookies
 *   5. express.json  — parse JSON request body (limit 1mb)
 *   6. express.urlencoded — parse URL-encoded bodies
 *   7. pino-http   — structured request logging with requestId
 *   8. rate-limit  — applied to /api/* prefix
 *   9. Route mounts
 *  10. notFound    — 404 catch-all
 *  11. errorHandler — converts thrown errors to JSON envelopes (MUST be last)
 */
import 'express-async-errors';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { pinoHttp } from 'pino-http';

import { env } from './config/env.js';
import logger from './shared/logger/index.js';
import { notFound } from './shared/middleware/notFound.js';
import { errorHandler } from './shared/errors/errorHandler.js';
import { ERROR_CODES } from './shared/errors/errorCodes.js';

// Module routers
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { categoriesRouter } from './modules/categories/categories.routes.js';
import { suppliersRouter } from './modules/suppliers/suppliers.routes.js';
import { productsRouter } from './modules/products/products.routes.js';
import { inventoryMovementsRouter } from './modules/inventory-movements/inventory-movements.routes.js';
import { replenishmentRequestsRouter } from './modules/replenishment-requests/replenishment-requests.routes.js';
import { alertsRouter } from './modules/alerts/alerts.routes.js';

const app = express();

// ── Security headers ────────────────────────────────────────────────────────
app.use(helmet());

// ── CORS ────────────────────────────────────────────────────────────────────
app.use(
  cors({
    origin: env.FRONTEND_URL,
    credentials: true,
  }),
);

// ── Cookie parser (required for refresh token HttpOnly cookie) ──────────────
app.use(cookieParser());

// ── Body parsing ────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Structured HTTP logging (pino-http) ─────────────────────────────────────
// Injects req.id (UUID) and logs every request/response with structured fields.
app.use(
  pinoHttp({
    logger,
    // Generate a unique request ID for each incoming request.
    genReqId: (req) => {
      const existing = req.headers['x-request-id'];
      if (typeof existing === 'string' && existing.length > 0) return existing;
      return crypto.randomUUID();
    },
    // Suppress noisy access logs in test environment.
    autoLogging: env.NODE_ENV !== 'test',
    // Map HTTP status codes to log levels:
    //   5xx → error, 4xx → warn, others → info
    customLogLevel: (_req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
  }),
);

// ── Rate limiting (applied to all /api/* routes) ────────────────────────────
const apiRateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  max: env.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: ERROR_CODES.RATE_LIMIT_EXCEEDED,
    message: 'Too many requests, please try again later.',
    statusCode: 429,
  },
});

app.use('/api', apiRateLimiter);

// ── Route mounts ────────────────────────────────────────────────────────────
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/categories', categoriesRouter);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/products', productsRouter);
app.use('/api/inventory-movements', inventoryMovementsRouter);
app.use('/api/replenishment-requests', replenishmentRequestsRouter);
app.use('/api/alerts', alertsRouter);

// ── 404 fallback (after all routes, before error handler) ───────────────────
app.use(notFound);

// ── Global error handler (MUST be the last middleware registered) ────────────
app.use(errorHandler);

export { app };
