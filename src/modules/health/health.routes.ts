/**
 * Health router.
 *
 * Mounted at /api/health in app.ts.
 * No authentication middleware — liveness probes must be unauthenticated.
 */
import { type RequestHandler, Router } from 'express';
import { healthController } from './health.controller.js';

const healthRouter = Router();

// GET /api/health
// Cast to RequestHandler: express-async-errors (imported in app.ts) patches
// Express to forward promise rejections to the error handler automatically.
healthRouter.get('/', healthController as RequestHandler);

export { healthRouter };
