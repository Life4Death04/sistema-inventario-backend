/**
 * Auth router — mounts the 4 auth endpoints under /api/auth.
 *
 * Endpoint map (spec summary):
 *   POST /login   → validate body → loginController
 *   POST /refresh → refreshController  (reads cookie, no body validation)
 *   POST /logout  → logoutController   (no auth required)
 *   GET  /me      → authenticate → meController
 *
 * This router is mounted at /api/auth in app.ts:
 *   app.use('/api/auth', authRouter);
 *
 * Note: async controllers are cast to RequestHandler because express-async-errors
 * (imported in app.ts) patches Express to forward promise rejections to the
 * global errorHandler. The cast suppresses the no-misused-promises lint error
 * that occurs because Router.post/get expects synchronous void handlers.
 */
import { type RequestHandler, Router } from 'express';
import { validate } from '../../shared/validation/validate.js';
import { authenticate } from '../../shared/middleware/authenticate.js';
import { loginSchema } from './auth.schema.js';
import {
  loginController,
  refreshController,
  logoutController,
  meController,
} from './auth.controller.js';

export const authRouter = Router();

/**
 * POST /api/auth/login
 * Body: { email, password }
 * Validates body with loginSchema before reaching the controller.
 */
authRouter.post('/login', validate(loginSchema, 'body'), loginController as RequestHandler);

/**
 * POST /api/auth/refresh
 * Reads refresh_token from HttpOnly cookie.
 * No body validation needed — body is empty.
 */
authRouter.post('/refresh', refreshController as RequestHandler);

/**
 * POST /api/auth/logout
 * No auth required — must work even with an expired access token.
 * Returns 204 No Content.
 */
authRouter.post('/logout', logoutController as RequestHandler);

/**
 * GET /api/auth/me
 * Protected by authenticate — requires valid Bearer token.
 */
authRouter.get('/me', authenticate, meController as RequestHandler);
