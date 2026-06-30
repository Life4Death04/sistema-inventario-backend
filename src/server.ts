/**
 * HTTP listener — starts the Express server.
 *
 * Responsibilities:
 *   - Imports `env` (validated at boot — fails fast if vars are missing).
 *   - Starts `app.listen()` on env.PORT.
 *   - Logs a structured startup message via Pino.
 *   - Handles SIGTERM and SIGINT for graceful shutdown:
 *       1. Stop accepting new connections (server.close).
 *       2. Disconnect Prisma to release the connection pool.
 *       3. Exit with code 0.
 *
 * Import this module ONLY from the process entry point (src/index.ts or
 * directly via `npm run dev`). Tests should import `app` from app.ts instead.
 */
import { app } from './app.js';
import { env } from './config/env.js';
import logger from './shared/logger/index.js';
import { prisma } from './shared/utils/prisma.js';

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'Server started');
});

// ── Graceful shutdown ────────────────────────────────────────────────────────

function shutdown(signal: string): void {
  logger.info({ signal }, 'Shutdown signal received — closing server');

  // Force-exit if graceful close takes too long (e.g. lingering connections).
  const forceExitTimer = setTimeout(() => {
    logger.error('Graceful shutdown timed out — forcing exit');
    process.exit(1);
  }, 10_000);

  server.close(() => {
    clearTimeout(forceExitTimer);
    logger.info('HTTP server closed');
    prisma
      .$disconnect()
      .then(() => {
        logger.info('Prisma disconnected — process exiting');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, 'Error disconnecting Prisma');
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
