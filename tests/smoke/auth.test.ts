/**
 * Smoke tests for the auth endpoints.
 *
 * Tests per tasks.md 4.13 + specs/auth/spec.md scenarios:
 *   - POST /api/auth/login   OK
 *   - POST /api/auth/login   wrong password   → 401
 *   - POST /api/auth/login   unknown email    → 401 (same message)
 *   - POST /api/auth/login   inactive user    → 403
 *   - POST /api/auth/refresh OK (rotated cookie)
 *   - POST /api/auth/refresh no cookie        → 401
 *   - POST /api/auth/refresh revoked token    → 401
 *   - POST /api/auth/logout  clears cookie    → 204
 *   - POST /api/auth/refresh after logout     → 401
 *   - GET  /api/auth/me      with Bearer      → 200 (no password field)
 *   - GET  /api/auth/me      no header        → 401 MISSING_TOKEN
 *   - requireRole: ADMIN allowed              → passes (200)
 *   - requireRole: OPERATOR denied on admin route → 403 FORBIDDEN
 *
 * Prisma is fully mocked — no real DB required.
 * The mock simulates an ADMIN user 'admin@highmeds.local' with bcrypt hash.
 *
 * DESIGN NOTE (design.md §6 — id == jti):
 *   RefreshToken rows use their Prisma-generated cuid id as the jti.
 *   The mock returns rows with predictable ids so token round-trips work.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';
import { isAppError } from '../../src/shared/errors/AppError.js';
import { requireRole } from '../../src/shared/middleware/requireRole.js';

// ── Response body types ───────────────────────────────────────────────────────

interface LoginBody {
  user: {
    id: string;
    fullName: string;
    email: string;
    role: string;
    active: boolean;
    phone: string | null;
    createdAt: string;
    password?: string;
  };
  token: string;
}

interface RefreshBody {
  token: string;
}

interface MeBody {
  user: {
    id: string;
    fullName: string;
    email: string;
    role: string;
    active: boolean;
    phone: string | null;
    createdAt: string;
    password?: string;
  };
}

interface ErrorBody {
  error: string;
  message: string;
  statusCode: number;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PASSWORD_PLAIN = 'ChangeMe123!';
// Pre-hash at cost 4 for speed in tests.
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD_PLAIN, 4);

const MOCK_USER_ACTIVE = {
  id: 'cuid-user-admin-001',
  fullName: 'Administrador',
  email: 'admin@highmeds.local',
  password: PASSWORD_HASH,
  role: 'ADMIN' as const,
  active: true,
  phone: null as string | null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const MOCK_USER_INACTIVE = {
  ...MOCK_USER_ACTIVE,
  id: 'cuid-user-inactive-002',
  email: 'inactive@highmeds.local',
  active: false,
};

const MOCK_USER_OPERATOR = {
  ...MOCK_USER_ACTIVE,
  id: 'cuid-user-operator-003',
  email: 'operator@highmeds.local',
  role: 'OPERATOR' as const,
};

// ── RefreshToken mock store ───────────────────────────────────────────────────

type MockRefreshToken = {
  id: string;
  userId: string;
  expiresAt: Date;
  revoked: boolean;
  revokedAt: Date | null;
  createdAt: Date;
  userAgent: string | null;
  ip: string | null;
};

let refreshTokenStore: Map<string, MockRefreshToken>;
let refreshTokenRowCounter: number;

function makeRefreshTokenRow(userId: string): MockRefreshToken {
  refreshTokenRowCounter += 1;
  return {
    id: `cuid-refresh-token-${String(refreshTokenRowCounter)}`,
    userId,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
    revoked: false,
    revokedAt: null,
    createdAt: new Date(),
    userAgent: null,
    ip: null,
  };
}

// ── Mock Prisma ───────────────────────────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => {
  const mockPrisma = {
    user: {
      findUnique: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { prisma: mockPrisma };
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAccessToken(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, role },
    process.env['JWT_ACCESS_SECRET'] ?? 'dev-access-secret-minimum-32-chars-ok',
    { algorithm: 'HS256', expiresIn: '15m' },
  );
}

/**
 * Build a valid refresh JWT with a given sub and jti.
 * Used to craft tokens whose DB row we can then control independently
 * (e.g. remove from the store to simulate reuse, or tie to an inactive user).
 */
function makeRefreshToken(userId: string, jti: string): string {
  return jwt.sign(
    { sub: userId, jti },
    process.env['JWT_REFRESH_SECRET'] ?? 'dev-refresh-secret-minimum-32-chars-ok',
    { algorithm: 'HS256', expiresIn: '7d' },
  );
}

function getCookieValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string {
  const setCookieHeader = headers['set-cookie'];
  const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader ?? ''];
  const found = cookies.find((c) => c.startsWith(`${name}=`));
  return found ? (found.split(';')[0] ?? '') : '';
}

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('Auth endpoints smoke tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    refreshTokenStore = new Map();
    refreshTokenRowCounter = 0;

    const { prisma } = await import('../../src/shared/utils/prisma.js');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockUserFindUnique = vi.mocked(prisma.user.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockRtCreate = vi.mocked(prisma.refreshToken.create);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockRtFindUnique = vi.mocked(prisma.refreshToken.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockRtUpdate = vi.mocked(prisma.refreshToken.update);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockRtUpdateMany = vi.mocked(prisma.refreshToken.updateMany);

    // User lookup by email or id.
    mockUserFindUnique.mockImplementation(
      ({ where }: { where: { email?: string; id?: string } }) => {
        if (where.email === MOCK_USER_ACTIVE.email) return Promise.resolve(MOCK_USER_ACTIVE);
        if (where.email === MOCK_USER_INACTIVE.email) return Promise.resolve(MOCK_USER_INACTIVE);
        if (where.email === MOCK_USER_OPERATOR.email) return Promise.resolve(MOCK_USER_OPERATOR);
        if (where.id === MOCK_USER_ACTIVE.id) return Promise.resolve(MOCK_USER_ACTIVE);
        if (where.id === MOCK_USER_INACTIVE.id) return Promise.resolve(MOCK_USER_INACTIVE);
        if (where.id === MOCK_USER_OPERATOR.id) return Promise.resolve(MOCK_USER_OPERATOR);
        return Promise.resolve(null);
      },
    );

    // create: auto-generate row and store it.
    mockRtCreate.mockImplementation(
      ({
        data,
      }: {
        data: { userId: string; expiresAt: Date; userAgent?: string; ip?: string };
      }) => {
        const row = makeRefreshTokenRow(data.userId);
        refreshTokenStore.set(row.id, row);
        return Promise.resolve(row);
      },
    );

    // findUnique on refreshToken (by id = jti).
    mockRtFindUnique.mockImplementation(({ where }: { where: { id: string } }) =>
      Promise.resolve(refreshTokenStore.get(where.id) ?? null),
    );

    // update (revoke single token).
    mockRtUpdate.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Partial<MockRefreshToken> }) => {
        const row = refreshTokenStore.get(where.id);
        if (!row) throw Object.assign(new Error('P2025'), { code: 'P2025' });
        const updated: MockRefreshToken = { ...row, ...data };
        refreshTokenStore.set(where.id, updated);
        return Promise.resolve(updated);
      },
    );

    // updateMany (revoke all for user).
    mockRtUpdateMany.mockImplementation(
      ({ where }: { where: { userId: string; revoked: boolean } }) => {
        let count = 0;
        for (const [id, row] of refreshTokenStore.entries()) {
          if (row.userId === where.userId && !row.revoked) {
            refreshTokenStore.set(id, { ...row, revoked: true, revokedAt: new Date() });
            count++;
          }
        }
        return Promise.resolve({ count });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── POST /api/auth/login ───────────────────────────────────────────────────

  describe('POST /api/auth/login', () => {
    it('(a) login OK — returns 200 with { user, token } and sets refresh cookie', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: MOCK_USER_ACTIVE.email, password: PASSWORD_PLAIN });

      expect(res.status).toBe(200);
      const body = res.body as LoginBody;
      expect(typeof body.token).toBe('string');
      expect(body.user.id).toBe(MOCK_USER_ACTIVE.id);
      expect(body.user.email).toBe(MOCK_USER_ACTIVE.email);
      expect(body.user.role).toBe('ADMIN');
      expect(body.user.active).toBe(true);
      // password MUST NOT be in response
      expect(body.user.password).toBeUndefined();
      // Refresh token cookie must be set
      const cookieVal = getCookieValue(
        res.headers as Record<string, string | string[] | undefined>,
        'refresh_token',
      );
      expect(cookieVal).toBeTruthy();
      expect(cookieVal.startsWith('refresh_token=')).toBe(true);
    });

    it('(b) wrong password — returns 401 INVALID_CREDENTIALS', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: MOCK_USER_ACTIVE.email, password: 'WrongPassword!' });

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('INVALID_CREDENTIALS');
      expect(body.message).toBe('Email or password is incorrect.');
    });

    it('(c) unknown email — returns 401 INVALID_CREDENTIALS (same message as wrong password)', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'nobody@nowhere.com', password: 'whatever' });

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('INVALID_CREDENTIALS');
      expect(body.message).toBe('Email or password is incorrect.');
    });

    it('(d) inactive user — returns 403 USER_INACTIVE after correct password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: MOCK_USER_INACTIVE.email, password: PASSWORD_PLAIN });

      expect(res.status).toBe(403);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('USER_INACTIVE');
    });

    it('(e) invalid body (missing email) — returns 400 VALIDATION_ERROR', async () => {
      const res = await request(app).post('/api/auth/login').send({ password: 'something' });

      expect(res.status).toBe(400);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('VALIDATION_ERROR');
    });
  });

  // ── POST /api/auth/refresh ─────────────────────────────────────────────────

  describe('POST /api/auth/refresh', () => {
    it('(a) refresh OK — returns 200 with new access token and rotated cookie', async () => {
      // First login to get a cookie.
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: MOCK_USER_ACTIVE.email, password: PASSWORD_PLAIN });

      expect(loginRes.status).toBe(200);

      // Extract the cookie value from login response.
      const oldCookiePair = getCookieValue(
        loginRes.headers as Record<string, string | string[] | undefined>,
        'refresh_token',
      );
      expect(oldCookiePair).toBeTruthy();

      const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', oldCookiePair);

      expect(refreshRes.status).toBe(200);
      const body = refreshRes.body as RefreshBody;
      expect(typeof body.token).toBe('string');
      // Cookie should be rotated (new value set)
      const newCookiePair = getCookieValue(
        refreshRes.headers as Record<string, string | string[] | undefined>,
        'refresh_token',
      );
      expect(newCookiePair).toBeTruthy();
      // The new cookie should differ from the old one (rotation)
      expect(newCookiePair).not.toBe(oldCookiePair);
    });

    it('(b) no cookie — returns 401 MISSING_REFRESH_TOKEN', async () => {
      const res = await request(app).post('/api/auth/refresh');

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('MISSING_REFRESH_TOKEN');
    });

    it('(c) invalid/expired cookie — returns 401 INVALID_REFRESH_TOKEN', async () => {
      const expiredToken = jwt.sign(
        { sub: MOCK_USER_ACTIVE.id, jti: 'some-jti' },
        process.env['JWT_REFRESH_SECRET'] ?? 'dev-refresh-secret-minimum-32-chars-ok',
        { algorithm: 'HS256', expiresIn: -1 },
      );

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${expiredToken}`);

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('INVALID_REFRESH_TOKEN');
    });

    it('(d) revoked token — returns 401 INVALID_REFRESH_TOKEN', async () => {
      // Login to get a valid token row in the store.
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: MOCK_USER_ACTIVE.email, password: PASSWORD_PLAIN });

      const cookiePair = getCookieValue(
        loginRes.headers as Record<string, string | string[] | undefined>,
        'refresh_token',
      );

      // Manually revoke all tokens in the store.
      for (const [id, row] of refreshTokenStore.entries()) {
        refreshTokenStore.set(id, { ...row, revoked: true, revokedAt: new Date() });
      }

      const res = await request(app).post('/api/auth/refresh').set('Cookie', cookiePair);

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('INVALID_REFRESH_TOKEN');
    });

    it('(e) refresh reuse detection — returns 401 and revokes ALL user tokens', async () => {
      /**
       * Scenario: an already-rotated (or stolen) refresh token is presented.
       * The JWT is cryptographically valid but the DB row is gone (jti not found).
       * The controller MUST call revokeAllUserRefreshTokens(userId) as a
       * compromise defense and return 401 INVALID_REFRESH_TOKEN.
       *
       * We craft a refresh JWT whose jti we never insert into refreshTokenStore,
       * so findRefreshTokenByJti returns null — the reuse-detection branch.
       */
      const { prisma } = await import('../../src/shared/utils/prisma.js');
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const mockRtUpdateMany = vi.mocked(prisma.refreshToken.updateMany);

      // Add another active token for the same user so the compromise sweep has
      // concrete state to revoke, not just a mocked method call.
      const siblingTokenRow = makeRefreshTokenRow(MOCK_USER_ACTIVE.id);
      refreshTokenStore.set(siblingTokenRow.id, siblingTokenRow);

      const otherUserTokenRow = makeRefreshTokenRow(MOCK_USER_OPERATOR.id);
      refreshTokenStore.set(otherUserTokenRow.id, otherUserTokenRow);

      // A jti that does NOT exist in the mock store — simulates an already-rotated token.
      const orphanJti = 'cuid-orphan-jti-never-stored';
      const orphanToken = makeRefreshToken(MOCK_USER_ACTIVE.id, orphanJti);

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${orphanToken}`);

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('INVALID_REFRESH_TOKEN');

      // revokeAllUserRefreshTokens must have been called with the owner's userId.
      const updateManyCalls = mockRtUpdateMany.mock.calls as unknown as Array<
        [
          {
            where: { userId: string; revoked: boolean };
            data: { revoked: boolean; revokedAt: Date };
          },
        ]
      >;
      expect(
        updateManyCalls.some(
          ([call]) =>
            call.where.userId === MOCK_USER_ACTIVE.id &&
            call.where.revoked === false &&
            call.data.revoked === true,
        ),
      ).toBe(true);
      expect(refreshTokenStore.get(siblingTokenRow.id)?.revoked).toBe(true);
      expect(refreshTokenStore.get(otherUserTokenRow.id)?.revoked).toBe(false);
    });

    it('(f) refresh with inactive user — returns 401 USER_INACTIVE_OR_DELETED', async () => {
      /**
       * Scenario: the refresh JWT is valid and the DB row exists and is not revoked,
       * but the user record fetched from DB has active=false (or is null).
       * The controller MUST return 401 USER_INACTIVE_OR_DELETED.
       *
       * We insert a row for MOCK_USER_INACTIVE (active=false) into the store,
       * craft a matching token, and send it to /refresh.
       */
      // Create a DB row for the inactive user in the mock store.
      const inactiveTokenRow = makeRefreshTokenRow(MOCK_USER_INACTIVE.id);
      refreshTokenStore.set(inactiveTokenRow.id, inactiveTokenRow);

      const inactiveToken = makeRefreshToken(MOCK_USER_INACTIVE.id, inactiveTokenRow.id);

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('Cookie', `refresh_token=${inactiveToken}`);

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('USER_INACTIVE_OR_DELETED');
    });
  });

  // ── POST /api/auth/logout ──────────────────────────────────────────────────

  describe('POST /api/auth/logout', () => {
    it('(a) logout with valid cookie — returns 204 and clears cookie', async () => {
      // First login to get a valid refresh cookie.
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: MOCK_USER_ACTIVE.email, password: PASSWORD_PLAIN });

      const cookiePair = getCookieValue(
        loginRes.headers as Record<string, string | string[] | undefined>,
        'refresh_token',
      );

      const logoutRes = await request(app).post('/api/auth/logout').set('Cookie', cookiePair);

      expect(logoutRes.status).toBe(204);
      // Response should set an expired/cleared cookie
      const clearedCookie = getCookieValue(
        logoutRes.headers as Record<string, string | string[] | undefined>,
        'refresh_token',
      );
      // Max-Age=0 in cookie means cleared
      const setCookieRaw = logoutRes.headers['set-cookie'] as string[] | string | undefined;
      const cookiesArr = Array.isArray(setCookieRaw) ? setCookieRaw : [setCookieRaw ?? ''];
      const refreshCookieFull = cookiesArr.find((c) => c.startsWith('refresh_token='));
      expect(refreshCookieFull).toBeDefined();
      expect(refreshCookieFull).toMatch(/Max-Age=0/i);
      // The value should be kept for TS
      expect(clearedCookie).toBeDefined();
    });

    it('(b) logout without cookie — returns 204 (idempotent)', async () => {
      const res = await request(app).post('/api/auth/logout');
      expect(res.status).toBe(204);
    });

    it('(c) subsequent refresh after logout — returns 401', async () => {
      // Login → get cookie.
      const loginRes = await request(app)
        .post('/api/auth/login')
        .send({ email: MOCK_USER_ACTIVE.email, password: PASSWORD_PLAIN });

      const cookiePair = getCookieValue(
        loginRes.headers as Record<string, string | string[] | undefined>,
        'refresh_token',
      );

      // Logout — revokes the DB row.
      await request(app).post('/api/auth/logout').set('Cookie', cookiePair);

      // Try to refresh with the now-revoked token.
      const refreshRes = await request(app).post('/api/auth/refresh').set('Cookie', cookiePair);

      expect(refreshRes.status).toBe(401);
    });
  });

  // ── GET /api/auth/me ───────────────────────────────────────────────────────

  describe('GET /api/auth/me', () => {
    it('(a) valid Bearer token — returns 200 with user (no password field)', async () => {
      const token = makeAccessToken(MOCK_USER_ACTIVE.id, MOCK_USER_ACTIVE.role);

      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);

      expect(res.status).toBe(200);
      const body = res.body as MeBody;
      expect(body.user.id).toBe(MOCK_USER_ACTIVE.id);
      expect(body.user.email).toBe(MOCK_USER_ACTIVE.email);
      // password MUST NOT appear in response
      expect((body.user as { password?: string }).password).toBeUndefined();
    });

    it('(b) no Authorization header — returns 401 MISSING_TOKEN', async () => {
      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('MISSING_TOKEN');
    });

    it('(c) malformed Bearer token — returns 401 INVALID_TOKEN', async () => {
      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', 'Bearer totally.invalid.token');

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('INVALID_TOKEN');
    });

    it('(d) expired access token — returns 401 TOKEN_EXPIRED', async () => {
      const expiredToken = jwt.sign(
        { sub: MOCK_USER_ACTIVE.id, role: 'ADMIN' },
        process.env['JWT_ACCESS_SECRET'] ?? 'dev-access-secret-minimum-32-chars-ok',
        { algorithm: 'HS256', expiresIn: -1 },
      );

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${expiredToken}`);

      expect(res.status).toBe(401);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('TOKEN_EXPIRED');
    });
  });

  // ── requireRole guard ──────────────────────────────────────────────────────

  describe('requireRole guard', () => {
    it('(a) ADMIN token reaches /me — 200 (role not blocked)', async () => {
      const token = makeAccessToken(MOCK_USER_ACTIVE.id, 'ADMIN');
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it('(b) OPERATOR token reaches /me — 200 (no requireRole on /me)', async () => {
      const token = makeAccessToken(MOCK_USER_OPERATOR.id, 'OPERATOR');
      const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
      // /me has no requireRole guard — OPERATOR gets through.
      expect(res.status).toBe(200);
    });

    it('(c) requireRole blocks OPERATOR on ADMIN-only route (unit assertion)', () => {
      /**
       * Test requireRole('ADMIN') directly in unit style.
       * The middleware is synchronous and throws AppError — not calls next(err).
       * express-async-errors only forwards async promise rejections.
       */
      const mockReq = { user: { id: 'cuid-op', role: 'OPERATOR' as const } };
      const next = vi.fn();

      let caught: unknown;
      try {
        requireRole('ADMIN')(mockReq as never, {} as never, next);
      } catch (e) {
        caught = e;
      }

      // next should NOT have been called — error was thrown synchronously.
      expect(next).not.toHaveBeenCalled();
      expect(isAppError(caught)).toBe(true);
      if (isAppError(caught)) {
        expect(caught.code).toBe('FORBIDDEN');
        expect(caught.statusCode).toBe(403);
      }
    });

    it('(d) requireRole passes when role is in allowed list', () => {
      const mockReq = { user: { id: 'cuid-admin', role: 'ADMIN' as const } };
      const next = vi.fn();

      requireRole('ADMIN', 'MANAGER')(mockReq as never, {} as never, next);

      // next called with no argument (no error).
      expect(next).toHaveBeenCalledWith();
    });

    it('(e) requireRole without authenticate (no req.user) → 500 INTERNAL_ERROR', () => {
      const mockReq = {} as never; // no .user
      const next = vi.fn();

      let caught: unknown;
      try {
        requireRole('ADMIN')(mockReq, {} as never, next);
      } catch (e) {
        caught = e;
      }

      expect(next).not.toHaveBeenCalled();
      expect(isAppError(caught)).toBe(true);
      if (isAppError(caught)) {
        expect(caught.code).toBe('INTERNAL_ERROR');
        expect(caught.statusCode).toBe(500);
      }
    });
  });
});
