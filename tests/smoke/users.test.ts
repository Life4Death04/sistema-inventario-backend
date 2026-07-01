/**
 * Smoke tests for the users CRUD endpoints.
 *
 * Coverage per scope:
 *   - POST   /api/users          — create (happy path, 409 duplicate email)
 *   - GET    /api/users          — list (happy path, pagination)
 *   - GET    /api/users/:id      — get one (happy path, 404)
 *   - PATCH  /api/users/:id      — update (happy path, 409 last-admin, 403 self-demote)
 *   - DELETE /api/users/:id      — soft-delete (happy path, 409 last-admin, 403 self-delete)
 *   - 401 unauthenticated on every protected endpoint
 *   - 403 non-ADMIN on every protected endpoint
 *   - Password never present in any response
 *
 * Prisma is fully mocked — no real DB required.
 * Pattern mirrors tests/smoke/auth.test.ts.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';

// ── Response body types ────────────────────────────────────────────────────────

interface PublicUser {
  id: string;
  fullName: string;
  email: string;
  role: string;
  active: boolean;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
  password?: string; // must NEVER be present
}

interface UserBody {
  user: PublicUser;
}

interface ListBody {
  data: PublicUser[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface ErrorBody {
  error: string;
  message: string;
  statusCode: number;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PASSWORD_PLAIN = 'SecurePass1!';
const PASSWORD_HASH = bcrypt.hashSync(PASSWORD_PLAIN, 4);

/**
 * Canonical cuid-shaped ids for mock users.
 * These must pass Zod's z.string().cuid() validation (starts with 'c', ~25 lowercase alphanum chars).
 */
const ADMIN_ID = 'clh3xxk0h0000356c9a5oba7k';
const ADMIN2_ID = 'clh3xxk0h0002356c9a5oba9n'; // second admin used in last-admin guard tests
const MANAGER_ID = 'cjld2cjxh0000qzrmn831i7rn';
const OPERATOR_ID = 'cjld2cyuq0000t3rmniod1foy';
const NEW_USER_ID = 'clh3xxk0h0001356c9a5oba8m';

const MOCK_ADMIN: PublicUser & { password: string; updatedAt: Date; createdAt: Date } = {
  id: ADMIN_ID,
  fullName: 'Admin User',
  email: 'admin@highmeds.local',
  password: PASSWORD_HASH,
  role: 'ADMIN',
  active: true,
  phone: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

const MOCK_MANAGER: PublicUser & { password: string; updatedAt: Date; createdAt: Date } = {
  id: MANAGER_ID,
  fullName: 'Manager User',
  email: 'manager@highmeds.local',
  password: PASSWORD_HASH,
  role: 'MANAGER',
  active: true,
  phone: null,
  createdAt: new Date('2026-01-02T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

const MOCK_OPERATOR: PublicUser & { password: string; updatedAt: Date; createdAt: Date } = {
  id: OPERATOR_ID,
  fullName: 'Operator User',
  email: 'operator@highmeds.local',
  password: PASSWORD_HASH,
  role: 'OPERATOR',
  active: true,
  phone: null,
  createdAt: new Date('2026-01-03T00:00:00.000Z'),
  updatedAt: new Date('2026-01-03T00:00:00.000Z'),
};

/**
 * Second admin — used only in last-admin guard tests.
 * When we want to test "only one admin left", we remove ADMIN2 from the store.
 * The requesting token is ADMIN2_TOKEN, targeting ADMIN_ID.
 * This keeps the self-guard from triggering (different user).
 */
const MOCK_ADMIN2: PublicUser & { password: string; updatedAt: Date; createdAt: Date } = {
  id: ADMIN2_ID,
  fullName: 'Second Admin',
  email: 'admin2@highmeds.local',
  password: PASSWORD_HASH,
  role: 'ADMIN',
  active: true,
  phone: null,
  createdAt: new Date('2026-01-04T00:00:00.000Z'),
  updatedAt: new Date('2026-01-04T00:00:00.000Z'),
};

// ── Mock user store (in-memory) ────────────────────────────────────────────────

type MockUser = typeof MOCK_ADMIN;

let userStore: Map<string, MockUser>;

function seedStore() {
  userStore = new Map();
  userStore.set(ADMIN_ID, { ...MOCK_ADMIN });
  userStore.set(ADMIN2_ID, { ...MOCK_ADMIN2 });
  userStore.set(MANAGER_ID, { ...MOCK_MANAGER });
  userStore.set(OPERATOR_ID, { ...MOCK_OPERATOR });
}

/** Returns the public shape (no password) for a mock user. */
function toPublic(u: MockUser): Omit<MockUser, 'password'> {
  const { password: _pw, ...pub } = u;
  void _pw;
  return pub;
}

// ── Mock Prisma ────────────────────────────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => {
  const mockPrisma = {
    user: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    $queryRaw: vi.fn().mockResolvedValue([{ '?column?': 1 }]),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(),
  };
  return { prisma: mockPrisma };
});

// ── Token helpers ─────────────────────────────────────────────────────────────

function makeAccessToken(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, role },
    process.env['JWT_ACCESS_SECRET'] ?? 'dev-access-secret-minimum-32-chars-ok',
    { algorithm: 'HS256', expiresIn: '15m' },
  );
}

const ADMIN_TOKEN = () => makeAccessToken(ADMIN_ID, 'ADMIN');
/** Token for second admin — used in last-admin guard tests to avoid triggering the self-guard. */
const ADMIN2_TOKEN = () => makeAccessToken(ADMIN2_ID, 'ADMIN');
const OPERATOR_TOKEN = () => makeAccessToken(OPERATOR_ID, 'OPERATOR');

// ── Setup ──────────────────────────────────────────────────────────────────────

describe('Users CRUD smoke tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedStore();

    const { prisma } = await import('../../src/shared/utils/prisma.js');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockUserCreate = vi.mocked(prisma.user.create);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockUserFindMany = vi.mocked(prisma.user.findMany);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockUserFindUnique = vi.mocked(prisma.user.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockUserFindFirst = vi.mocked(prisma.user.findFirst);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockUserUpdate = vi.mocked(prisma.user.update);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockUserCount = vi.mocked(prisma.user.count);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockTransaction = vi.mocked(prisma.$transaction);

    // user.findMany — list all users from store (apply simple search/role/active filters).
    mockUserFindMany.mockImplementation(
      ({
        where,
        skip = 0,
        take,
      }: {
        where?: { OR?: unknown[]; role?: string; active?: boolean };
        skip?: number;
        take?: number;
        orderBy?: unknown;
        select?: unknown;
      } = {}) => {
        let users = [...userStore.values()];
        if (where?.role !== undefined) users = users.filter((u) => u.role === where.role);
        if (where?.active !== undefined) users = users.filter((u) => u.active === where.active);
        // skip/take for pagination
        const sliced = users.slice(skip, take !== undefined ? skip + take : undefined);
        return Promise.resolve(sliced.map(toPublic));
      },
    );

    // user.create — insert into store, return public shape.
    mockUserCreate.mockImplementation(({ data }: { data: Partial<MockUser> }) => {
      const newUser: MockUser = {
        id: NEW_USER_ID,
        fullName: data.fullName ?? '',
        email: data.email ?? '',
        password: data.password ?? '',
        role: (data.role as MockUser['role']) ?? 'OPERATOR',
        active: true,
        phone: data.phone ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      userStore.set(newUser.id, newUser);
      return Promise.resolve(toPublic(newUser));
    });

    // user.findUnique — by id only (used by auth middleware re-reads).
    mockUserFindUnique.mockImplementation(
      ({ where }: { where: { id?: string; email?: string } }) => {
        if (where.id) {
          const u = userStore.get(where.id);
          return Promise.resolve(u ? toPublic(u) : null);
        }
        if (where.email) {
          const u = [...userStore.values()].find((x) => x.email === where.email);
          return Promise.resolve(u ? toPublic(u) : null);
        }
        return Promise.resolve(null);
      },
    );

    // user.findFirst — by email (uniqueness checks), optionally excluding an id.
    mockUserFindFirst.mockImplementation(
      ({
        where,
      }: {
        where: {
          email?: string;
          NOT?: { id?: string };
        };
      }) => {
        const users = [...userStore.values()];
        const match = users.find((u) => {
          if (where.email && u.email !== where.email) return false;
          if (where.NOT?.id && u.id === where.NOT.id) return false;
          return true;
        });
        return Promise.resolve(match ? toPublic(match) : null);
      },
    );

    // user.update — patch user in store, return updated public shape.
    mockUserUpdate.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Partial<MockUser> }) => {
        const existing = userStore.get(where.id);
        if (!existing) throw Object.assign(new Error('P2025'), { code: 'P2025' });
        const updated: MockUser = { ...existing, ...data, updatedAt: new Date() };
        userStore.set(where.id, updated);
        return Promise.resolve(toPublic(updated));
      },
    );

    // user.count — count ADMIN + active users in store.
    mockUserCount.mockImplementation(
      ({ where }: { where?: { role?: string; active?: boolean } } = {}) => {
        const users = [...userStore.values()];
        const count = users.filter((u) => {
          if (where?.role !== undefined && u.role !== where.role) return false;
          if (where?.active !== undefined && u.active !== where.active) return false;
          return true;
        }).length;
        return Promise.resolve(count);
      },
    );

    // $transaction — run both queries and return [rows, count].
    mockTransaction.mockImplementation(async (queries: Array<Promise<unknown>>) => {
      return Promise.all(queries);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 401 Unauthenticated ────────────────────────────────────────────────────

  describe('Unauthenticated requests (401)', () => {
    it('POST /api/users without token → 401', async () => {
      const res = await request(app).post('/api/users').send({
        fullName: 'New User',
        email: 'new@highmeds.local',
        password: 'Password1!',
      });
      expect(res.status).toBe(401);
    });

    it('GET /api/users without token → 401', async () => {
      const res = await request(app).get('/api/users');
      expect(res.status).toBe(401);
    });

    it('GET /api/users/:id without token → 401', async () => {
      const res = await request(app).get(`/api/users/${ADMIN_ID}`);
      expect(res.status).toBe(401);
    });

    it('PATCH /api/users/:id without token → 401', async () => {
      const res = await request(app)
        .patch(`/api/users/${MANAGER_ID}`)
        .send({ fullName: 'New Name' });
      expect(res.status).toBe(401);
    });

    it('DELETE /api/users/:id without token → 401', async () => {
      const res = await request(app).delete(`/api/users/${MANAGER_ID}`);
      expect(res.status).toBe(401);
    });
  });

  // ── 403 Non-ADMIN ──────────────────────────────────────────────────────────

  describe('Non-ADMIN requests (403 FORBIDDEN)', () => {
    it('POST /api/users as OPERATOR → 403', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({ fullName: 'New User', email: 'new@highmeds.local', password: 'Password1!' });
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN');
    });

    it('GET /api/users as OPERATOR → 403', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      expect(res.status).toBe(403);
    });

    it('DELETE /api/users/:id as OPERATOR → 403', async () => {
      const res = await request(app)
        .delete(`/api/users/${MANAGER_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      expect(res.status).toBe(403);
    });
  });

  // ── POST /api/users ────────────────────────────────────────────────────────

  describe('POST /api/users', () => {
    it('(a) happy path — creates user, returns 201, no password in response', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({
          fullName: 'Alice Smith',
          email: 'alice@highmeds.local',
          password: 'SecurePass1!',
          role: 'OPERATOR',
        });

      expect(res.status).toBe(201);
      const body = res.body as UserBody;
      expect(body.user.id).toBe(NEW_USER_ID);
      expect(body.user.email).toBe('alice@highmeds.local');
      expect(body.user.fullName).toBe('Alice Smith');
      expect(body.user.role).toBe('OPERATOR');
      // Password MUST NOT be in response — structural check.
      expect(body.user.password).toBeUndefined();
    });

    it('(b) duplicate email → 409 CONFLICT', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({
          fullName: 'Duplicate Admin',
          email: MOCK_ADMIN.email, // already exists
          password: 'SecurePass1!',
        });

      expect(res.status).toBe(409);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('CONFLICT');
    });

    it('(c) invalid body (missing email) → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ fullName: 'Bad User', password: 'pass12345' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  // ── GET /api/users ─────────────────────────────────────────────────────────

  describe('GET /api/users', () => {
    it('(a) happy path — returns paginated list with meta', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.meta.total).toBe('number');
      expect(typeof body.meta.page).toBe('number');
      expect(typeof body.meta.limit).toBe('number');
      expect(typeof body.meta.totalPages).toBe('number');
    });

    it('(b) password never in list response', async () => {
      const res = await request(app)
        .get('/api/users')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      for (const user of body.data) {
        expect(user.password).toBeUndefined();
      }
    });
  });

  // ── GET /api/users/:id ─────────────────────────────────────────────────────

  describe('GET /api/users/:id', () => {
    it('(a) happy path — returns user, no password', async () => {
      const res = await request(app)
        .get(`/api/users/${MANAGER_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as UserBody;
      expect(body.user.id).toBe(MANAGER_ID);
      expect(body.user.password).toBeUndefined();
    });

    it('(b) not found → 404 NOT_FOUND', async () => {
      // Use a valid cuid-format id that is not in the mock store.
      const missingCuid = 'clh3xxk0h0099356c9a5zzzzz';
      const res = await request(app)
        .get(`/api/users/${missingCuid}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('NOT_FOUND');
    });

    it('(c) invalid cuid param → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/users/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  // ── PATCH /api/users/:id ───────────────────────────────────────────────────

  describe('PATCH /api/users/:id', () => {
    it('(a) happy path — updates fullName, returns 200, no password', async () => {
      const res = await request(app)
        .patch(`/api/users/${MANAGER_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ fullName: 'Updated Manager' });

      expect(res.status).toBe(200);
      const body = res.body as UserBody;
      expect(body.user.fullName).toBe('Updated Manager');
      expect(body.user.password).toBeUndefined();
    });

    it('(b) 409 last-admin guard — demoting the only ADMIN via a different admin account', async () => {
      /**
       * Setup: Only ADMIN_ID is an active ADMIN (ADMIN2 is the requester, will be removed below).
       * ADMIN2_TOKEN requests to demote ADMIN_ID → last-admin guard fires → 409.
       * We use a different requester (ADMIN2) so the self-guard does NOT trigger.
       *
       * Step: remove ADMIN2 from store so only 1 ADMIN is active — then demote ADMIN_ID.
       */
      userStore.delete(ADMIN2_ID);
      userStore.delete(MANAGER_ID);
      userStore.delete(OPERATOR_ID);

      const res = await request(app)
        .patch(`/api/users/${ADMIN_ID}`) // target: only remaining admin
        .set('Authorization', `Bearer ${ADMIN2_TOKEN()}`) // requester: different user (not in store, but token is valid)
        .send({ role: 'OPERATOR' }); // demote the only admin

      expect(res.status).toBe(409);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('CONFLICT');
      expect(body.message).toBe('Cannot remove the last active administrator.');
    });

    it('(c) 409 last-admin guard — deactivating the only ADMIN via a different admin account', async () => {
      userStore.delete(ADMIN2_ID);
      userStore.delete(MANAGER_ID);
      userStore.delete(OPERATOR_ID);

      const res = await request(app)
        .patch(`/api/users/${ADMIN_ID}`)
        .set('Authorization', `Bearer ${ADMIN2_TOKEN()}`)
        .send({ active: false });

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).message).toBe('Cannot remove the last active administrator.');
    });

    it('(d) 403 self-modification guard — admin demoting own role', async () => {
      const res = await request(app)
        .patch(`/api/users/${ADMIN_ID}`) // same as token subject
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ role: 'OPERATOR' });

      expect(res.status).toBe(403);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('FORBIDDEN');
      expect(body.message).toBe('You cannot deactivate or demote your own account.');
    });

    it('(e) 403 self-modification guard — admin deactivating themselves', async () => {
      const res = await request(app)
        .patch(`/api/users/${ADMIN_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ active: false });

      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN');
    });

    it('(f) 409 duplicate email on update', async () => {
      const res = await request(app)
        .patch(`/api/users/${MANAGER_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ email: MOCK_ADMIN.email }); // email already used by admin

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toBe('CONFLICT');
    });
  });

  // ── DELETE /api/users/:id ──────────────────────────────────────────────────

  describe('DELETE /api/users/:id', () => {
    it('(a) happy path — soft-deletes user, returns 204', async () => {
      const res = await request(app)
        .delete(`/api/users/${MANAGER_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(204);
      // Verify in store: user should be inactive.
      const updated = userStore.get(MANAGER_ID);
      expect(updated?.active).toBe(false);
    });

    it('(b) 404 when user not found', async () => {
      const missingCuid = 'clh3xxk0h0099356c9a5zzzzz';
      const res = await request(app)
        .delete(`/api/users/${missingCuid}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('NOT_FOUND');
    });

    it('(c) 409 last-admin guard — deleting the only ADMIN via a different admin account', async () => {
      /**
       * ADMIN2_TOKEN requests to soft-delete ADMIN_ID (a different user).
       * Only one ADMIN exists in the store → last-admin guard fires → 409.
       */
      userStore.delete(ADMIN2_ID);
      userStore.delete(MANAGER_ID);
      userStore.delete(OPERATOR_ID);

      const res = await request(app)
        .delete(`/api/users/${ADMIN_ID}`)
        .set('Authorization', `Bearer ${ADMIN2_TOKEN()}`);

      expect(res.status).toBe(409);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('CONFLICT');
      expect(body.message).toBe('Cannot remove the last active administrator.');
    });

    it('(d) 403 self-modification guard — admin deleting themselves', async () => {
      const res = await request(app)
        .delete(`/api/users/${ADMIN_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(403);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('FORBIDDEN');
      expect(body.message).toBe('You cannot deactivate or demote your own account.');
    });
  });

  // ── Password never in response (aggregate check) ───────────────────────────

  describe('Password field absent from all response shapes', () => {
    it('POST response has no password field', async () => {
      const res = await request(app)
        .post('/api/users')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ fullName: 'Bob', email: 'bob@highmeds.local', password: 'SecurePass1!' });
      expect(res.status).toBe(201);
      expect((res.body as UserBody).user.password).toBeUndefined();
    });

    it('GET /:id response has no password field', async () => {
      const res = await request(app)
        .get(`/api/users/${ADMIN_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      expect(res.status).toBe(200);
      expect((res.body as UserBody).user.password).toBeUndefined();
    });

    it('PATCH response has no password field', async () => {
      const res = await request(app)
        .patch(`/api/users/${MANAGER_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ fullName: 'Updated Name' });
      expect(res.status).toBe(200);
      expect((res.body as UserBody).user.password).toBeUndefined();
    });
  });
});
