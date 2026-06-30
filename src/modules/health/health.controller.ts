/**
 * Health check controller.
 *
 * GET /api/health → always 200 if the process is alive.
 *
 * Performs a lightweight `SELECT 1` against Postgres via Prisma to report DB
 * connectivity. A DB failure does NOT cause the endpoint itself to fail — the
 * endpoint responds 200 with `db: 'down'` so liveness probes stay green while
 * a readiness alarm can be raised separately.
 *
 * Response shape:
 *   {
 *     "status": "ok",
 *     "timestamp": "2026-06-29T18:30:00.000Z",
 *     "uptime": 42.7,
 *     "db": "ok" | "down"
 *   }
 */
import type { Request, Response } from 'express';
import { prisma } from '../../shared/utils/prisma.js';

/** Milliseconds to wait for the DB ping before declaring it down. */
const DB_PING_TIMEOUT_MS = 2_000;

export async function healthController(_req: Request, res: Response): Promise<void> {
  let dbStatus: 'ok' | 'down' = 'down';

  try {
    // Race the Prisma ping against a timeout so a hung connection
    // does not block the health endpoint indefinitely.
    await Promise.race([
      prisma.$queryRaw`SELECT 1`,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('DB ping timeout')), DB_PING_TIMEOUT_MS),
      ),
    ]);
    dbStatus = 'ok';
  } catch {
    // DB unavailable or timed out — report down but keep endpoint healthy.
    dbStatus = 'down';
  }

  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    db: dbStatus,
  });
}
