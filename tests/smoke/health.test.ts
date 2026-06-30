/**
 * Smoke tests for GET /api/health.
 *
 * Uses Supertest against the Express `app` (no real TCP port opened).
 *
 * Test cases per tasks.md 3.12:
 *   (a) GET /api/health with DB ok → 200 + correct shape
 *   (b) GET /api/health with DB mocked down → 200 + db:'down'
 *   (c) GET /api/health without Authorization → 200 (no auth required)
 *
 * DB connectivity is mocked via vi.mock so these tests run without Postgres.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';

/** Shape returned by GET /api/health */
interface HealthBody {
  status: string;
  timestamp: string;
  uptime: number;
  db: 'ok' | 'down';
}

// Mock the Prisma singleton so health tests do not need a real DB.
vi.mock('../../src/shared/utils/prisma.js', () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  },
}));

describe('GET /api/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) returns 200 with correct shape when DB is available', async () => {
    const { prisma } = await import('../../src/shared/utils/prisma.js');
    // Default mock already resolves successfully — DB up.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ '?column?': 1 }]);

    const res = await request(app).get('/api/health');
    const body = res.body as HealthBody;

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.db).toBe('ok');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.uptime).toBe('number');
    // Validate ISO 8601 format
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp);
  });

  it('(b) returns 200 with db:"down" when Prisma ping fails', async () => {
    const { prisma } = await import('../../src/shared/utils/prisma.js');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(app).get('/api/health');
    const body = res.body as HealthBody;

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.db).toBe('down');
    expect(typeof body.timestamp).toBe('string');
    expect(typeof body.uptime).toBe('number');
  });

  it('(c) returns 200 without Authorization header (no auth required)', async () => {
    const res = await request(app).get('/api/health');
    const body = res.body as HealthBody;
    // Must not 401 — health endpoint is public
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
  });
});
