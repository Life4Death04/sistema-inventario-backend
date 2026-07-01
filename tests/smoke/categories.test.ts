/**
 * Smoke tests for the categories CRUD endpoints.
 *
 * Coverage per scope:
 *   - POST   /api/categories         — create (happy path, 409 duplicate name)
 *   - GET    /api/categories         — list (happy path, pagination shape)
 *   - GET    /api/categories/:id     — get one (happy path, 404, invalid cuid)
 *   - PATCH  /api/categories/:id     — update (happy path, 409 dup name, 404, empty body, description:null)
 *   - DELETE /api/categories/:id     — hard-delete (204 no products, 409 has products, 404)
 *   - 401 unauthenticated on any protected endpoint
 *   - 403 forbidden: OPERATOR on mutations (POST, PATCH, DELETE)
 *   - 200 allowed: OPERATOR on reads (GET list, GET by id)
 *
 * Prisma is fully mocked — no real DB required.
 * Pattern mirrors tests/smoke/users.test.ts.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';

// ── Response body types ────────────────────────────────────────────────────────

interface CategoryRecord {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CategoryBody {
  category: CategoryRecord;
}

interface ListBody {
  data: CategoryRecord[];
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

/**
 * Canonical cuid-shaped ids for mock users and categories.
 * Must pass Zod's z.string().cuid() validation (starts with 'c', ~25 lowercase alphanum chars).
 */
const ADMIN_ID = 'clh3xxk0h0000356c9a5oba7k';
const MANAGER_ID = 'cjld2cjxh0000qzrmn831i7rn';
const OPERATOR_ID = 'cjld2cyuq0000t3rmniod1foy';

const CAT1_ID = 'clh3xxk0h0001356c9a5oba8m';
const CAT2_ID = 'clh3xxk0h0002356c9a5oba9n';
const NEW_CAT_ID = 'clh3xxk0h0003356c9a5obaan';

// ── Mock category store (in-memory) ───────────────────────────────────────────

type MockCategory = {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

let categoryStore: Map<string, MockCategory>;
// Tracks product counts per category for the delete guard.
let productCounts: Map<string, number>;

function seedStore() {
  categoryStore = new Map();
  categoryStore.set(CAT1_ID, {
    id: CAT1_ID,
    name: 'Analgesics',
    description: 'Pain relief medications',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  categoryStore.set(CAT2_ID, {
    id: CAT2_ID,
    name: 'Antibiotics',
    description: null,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  // Default: no products associated.
  productCounts = new Map();
  productCounts.set(CAT1_ID, 0);
  productCounts.set(CAT2_ID, 0);
}

// ── Mock Prisma ────────────────────────────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => {
  const mockPrisma = {
    category: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
      delete: vi.fn(),
    },
    product: {
      count: vi.fn(),
    },
    // Required by authenticate → auth.service → verifyAccessToken (no DB calls,
    // but the prisma import must exist for the module graph to resolve).
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
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
const MANAGER_TOKEN = () => makeAccessToken(MANAGER_ID, 'MANAGER');
const OPERATOR_TOKEN = () => makeAccessToken(OPERATOR_ID, 'OPERATOR');

// ── Setup ──────────────────────────────────────────────────────────────────────

describe('Categories CRUD smoke tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedStore();

    const { prisma } = await import('../../src/shared/utils/prisma.js');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockCategoryCreate = vi.mocked(prisma.category.create);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockCategoryFindMany = vi.mocked(prisma.category.findMany);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockCategoryFindUnique = vi.mocked(prisma.category.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockCategoryFindFirst = vi.mocked(prisma.category.findFirst);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockCategoryUpdate = vi.mocked(prisma.category.update);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockCategoryCount = vi.mocked(prisma.category.count);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockCategoryDelete = vi.mocked(prisma.category.delete);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockProductCount = vi.mocked(prisma.product.count);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockTransaction = vi.mocked(prisma.$transaction);

    // category.create — insert into store, return new category.
    mockCategoryCreate.mockImplementation(({ data }: { data: Partial<MockCategory> }) => {
      const newCat: MockCategory = {
        id: NEW_CAT_ID,
        name: data.name ?? '',
        description: data.description ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      categoryStore.set(newCat.id, newCat);
      productCounts.set(newCat.id, 0);
      return Promise.resolve(newCat);
    });

    // category.findMany — list all categories from store with optional search.
    mockCategoryFindMany.mockImplementation(
      ({
        where,
        skip = 0,
        take,
      }: {
        where?: { OR?: unknown[] };
        skip?: number;
        take?: number;
        orderBy?: unknown;
        select?: unknown;
      } = {}) => {
        const cats = [...categoryStore.values()];
        // Simple search simulation: if OR is present, filter by name containing search.
        // The real impl uses `contains + mode: insensitive`. Here we just pass all cats.
        // The mock's purpose is structure, not search accuracy.
        void where;
        const sliced = cats.slice(skip, take !== undefined ? skip + take : undefined);
        return Promise.resolve(sliced);
      },
    );

    // category.findUnique — lookup by id or name.
    mockCategoryFindUnique.mockImplementation(
      ({ where }: { where: { id?: string; name?: string } }) => {
        if (where.id) {
          const cat = categoryStore.get(where.id);
          return Promise.resolve(cat ?? null);
        }
        if (where.name) {
          const cat = [...categoryStore.values()].find((c) => c.name === where.name);
          return Promise.resolve(cat ?? null);
        }
        return Promise.resolve(null);
      },
    );

    // category.findFirst — by name excluding id (update uniqueness check).
    mockCategoryFindFirst.mockImplementation(
      ({ where }: { where: { name?: string; NOT?: { id?: string } } }) => {
        const cats = [...categoryStore.values()];
        const match = cats.find((c) => {
          if (where.name && c.name !== where.name) return false;
          if (where.NOT?.id && c.id === where.NOT.id) return false;
          return true;
        });
        return Promise.resolve(match ?? null);
      },
    );

    // category.update — patch category in store.
    mockCategoryUpdate.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Partial<MockCategory> }) => {
        const existing = categoryStore.get(where.id);
        if (!existing) throw Object.assign(new Error('P2025'), { code: 'P2025' });
        const updated: MockCategory = { ...existing, ...data, updatedAt: new Date() };
        categoryStore.set(where.id, updated);
        return Promise.resolve(updated);
      },
    );

    // category.count — used by $transaction for paginated list.
    mockCategoryCount.mockImplementation(() => {
      return Promise.resolve(categoryStore.size);
    });

    // category.delete — remove from store.
    mockCategoryDelete.mockImplementation(({ where }: { where: { id: string } }) => {
      const existing = categoryStore.get(where.id);
      if (!existing) throw Object.assign(new Error('P2025'), { code: 'P2025' });
      categoryStore.delete(where.id);
      return Promise.resolve(existing);
    });

    // product.count — returns associated product count for the category.
    mockProductCount.mockImplementation(({ where }: { where: { categoryId?: string } } = {}) => {
      if (where.categoryId) {
        return Promise.resolve(productCounts.get(where.categoryId) ?? 0);
      }
      return Promise.resolve(0);
    });

    // $transaction — run both queries for paginated list and return [rows, count].
    mockTransaction.mockImplementation(async (queries: Array<Promise<unknown>>) => {
      return Promise.all(queries);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 401 Unauthenticated ────────────────────────────────────────────────────

  describe('Unauthenticated requests (401)', () => {
    it('POST /api/categories without token → 401', async () => {
      const res = await request(app).post('/api/categories').send({ name: 'New Category' });
      expect(res.status).toBe(401);
    });

    it('GET /api/categories without token → 401', async () => {
      const res = await request(app).get('/api/categories');
      expect(res.status).toBe(401);
    });
  });

  // ── 403 OPERATOR on mutations ──────────────────────────────────────────────

  describe('OPERATOR on mutations (403 FORBIDDEN)', () => {
    it('POST /api/categories as OPERATOR → 403', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({ name: 'Vitamins' });
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN');
    });

    it('PATCH /api/categories/:id as OPERATOR → 403', async () => {
      const res = await request(app)
        .patch(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({ name: 'Renamed' });
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN');
    });

    it('DELETE /api/categories/:id as OPERATOR → 403', async () => {
      const res = await request(app)
        .delete(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN');
    });
  });

  // ── OPERATOR allowed on reads ──────────────────────────────────────────────

  describe('OPERATOR on reads (200 OK)', () => {
    it('GET /api/categories as OPERATOR → 200', async () => {
      const res = await request(app)
        .get('/api/categories')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      expect(res.status).toBe(200);
    });

    it('GET /api/categories/:id as OPERATOR → 200', async () => {
      const res = await request(app)
        .get(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      expect(res.status).toBe(200);
    });
  });

  // ── POST /api/categories ───────────────────────────────────────────────────

  describe('POST /api/categories', () => {
    it('(a) happy path — creates category, returns 201 with category', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Vitamins', description: 'Vitamin supplements' });

      expect(res.status).toBe(201);
      const body = res.body as CategoryBody;
      expect(body.category.id).toBe(NEW_CAT_ID);
      expect(body.category.name).toBe('Vitamins');
      expect(body.category.description).toBe('Vitamin supplements');
    });

    it('(b) happy path as MANAGER — creates category, returns 201', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ name: 'Vitamins' });

      expect(res.status).toBe(201);
      expect((res.body as CategoryBody).category.name).toBe('Vitamins');
    });

    it('(c) 409 duplicate name', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Analgesics' }); // already exists

      expect(res.status).toBe(409);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('CONFLICT');
      expect(body.message).toBe('Category name already exists.');
    });

    it('(d) 400 missing name → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ description: 'No name provided' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  // ── GET /api/categories ────────────────────────────────────────────────────

  describe('GET /api/categories', () => {
    it('(a) happy path — returns paginated list with meta', async () => {
      const res = await request(app)
        .get('/api/categories')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.meta.total).toBe('number');
      expect(typeof body.meta.page).toBe('number');
      expect(typeof body.meta.limit).toBe('number');
      expect(typeof body.meta.totalPages).toBe('number');
    });

    it('(b) pagination meta shape correct', async () => {
      const res = await request(app)
        .get('/api/categories?page=1&limit=10')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(10);
    });
  });

  // ── GET /api/categories/:id ────────────────────────────────────────────────

  describe('GET /api/categories/:id', () => {
    it('(a) happy path — returns category', async () => {
      const res = await request(app)
        .get(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as CategoryBody;
      expect(body.category.id).toBe(CAT1_ID);
      expect(body.category.name).toBe('Analgesics');
    });

    it('(b) 404 when category does not exist', async () => {
      const missingCuid = 'clh3xxk0h0099356c9a5zzzzz';
      const res = await request(app)
        .get(`/api/categories/${missingCuid}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('NOT_FOUND');
    });

    it('(c) 400 invalid cuid param → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/categories/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  // ── PATCH /api/categories/:id ──────────────────────────────────────────────

  describe('PATCH /api/categories/:id', () => {
    it('(a) happy path — updates name, returns 200 with category', async () => {
      const res = await request(app)
        .patch(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Pain Relievers' });

      expect(res.status).toBe(200);
      const body = res.body as CategoryBody;
      expect(body.category.name).toBe('Pain Relievers');
    });

    it('(b) 409 duplicate name — renaming to an existing category name', async () => {
      const res = await request(app)
        .patch(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Antibiotics' }); // CAT2 already has this name

      expect(res.status).toBe(409);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('CONFLICT');
      expect(body.message).toBe('Category name already exists.');
    });

    it('(c) PATCH with same name as own category → 200 (no false positive)', async () => {
      // Renaming to the row's own current name must be allowed.
      const res = await request(app)
        .patch(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Analgesics' }); // same as current

      expect(res.status).toBe(200);
    });

    it('(d) 404 when category does not exist', async () => {
      const missingCuid = 'clh3xxk0h0099356c9a5zzzzz';
      const res = await request(app)
        .patch(`/api/categories/${missingCuid}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'New Name' });

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('NOT_FOUND');
    });

    it('(e) 400 empty body → VALIDATION_ERROR (refine fires)', async () => {
      const res = await request(app)
        .patch(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({});

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(f) 400 invalid cuid param → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .patch('/api/categories/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Something' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(g) PATCH with description: null — clears description field', async () => {
      // CAT1 has description set — explicitly clear it with null.
      const res = await request(app)
        .patch(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ description: null });

      expect(res.status).toBe(200);
      const body = res.body as CategoryBody;
      expect(body.category.description).toBeNull();
    });
  });

  // ── DELETE /api/categories/:id ─────────────────────────────────────────────

  describe('DELETE /api/categories/:id', () => {
    it('(a) happy path — 204 when no associated products', async () => {
      // productCounts defaults to 0 for CAT1.
      const res = await request(app)
        .delete(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(204);
      // Verify category was removed from store.
      expect(categoryStore.has(CAT1_ID)).toBe(false);
    });

    it('(b) 409 — associated products exist → CONFLICT', async () => {
      // Seed product count > 0 for CAT1.
      productCounts.set(CAT1_ID, 3);

      const res = await request(app)
        .delete(`/api/categories/${CAT1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(409);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('CONFLICT');
      expect(body.message).toBe('Cannot delete category with associated products.');
    });

    it('(c) 404 when category does not exist', async () => {
      const missingCuid = 'clh3xxk0h0099356c9a5zzzzz';
      const res = await request(app)
        .delete(`/api/categories/${missingCuid}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('NOT_FOUND');
    });

    it('(d) 400 invalid cuid param → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .delete('/api/categories/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(e) MANAGER can delete a category with no products → 204', async () => {
      const res = await request(app)
        .delete(`/api/categories/${CAT2_ID}`)
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`);

      expect(res.status).toBe(204);
    });
  });
});
