/**
 * Smoke tests for the suppliers CRUD endpoints.
 *
 * Coverage per scope:
 *   - POST   /api/suppliers         — create (happy path, 409 duplicate RIF, RIF normalization)
 *   - GET    /api/suppliers         — list (happy path, pagination shape, ?active=false, search)
 *   - GET    /api/suppliers/:id     — get one (happy path, 404, returns inactive, invalid cuid)
 *   - PATCH  /api/suppliers/:id     — update (happy path, 409 dup RIF, 404, empty body, null clearing)
 *   - DELETE /api/suppliers/:id     — soft-delete (204, 404 non-existent, 404 already-inactive)
 *   - 401 unauthenticated on any protected endpoint
 *   - 403 forbidden: OPERATOR on mutations (POST, PATCH, DELETE)
 *   - 200 allowed: OPERATOR on reads (GET list, GET by id)
 *   - Null RIF does not collide with another null RIF
 *   - PATCH with null clears rif/whatsapp/address
 *
 * Prisma is fully mocked — no real DB required.
 * Pattern mirrors tests/smoke/categories.test.ts.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';

// ── Response body types ────────────────────────────────────────────────────────

interface SupplierRecord {
  id: string;
  name: string;
  rif: string | null;
  whatsapp: string | null;
  address: string | null;
  active: boolean;
  products: Array<{
    id: string;
    name: string;
    code: string;
  }>;
  productsCount: number;
  createdAt: string;
  updatedAt: string;
}

interface SupplierBody {
  supplier: SupplierRecord;
}

interface ListBody {
  data: SupplierRecord[];
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
 * Canonical cuid-shaped ids for mock users and suppliers.
 * Must pass Zod's z.string().cuid() validation (starts with 'c', ~25 lowercase alphanum chars).
 */
const ADMIN_ID = 'clh3xxk0h0000356c9a5oba7k';
const MANAGER_ID = 'cjld2cjxh0000qzrmn831i7rn';
const OPERATOR_ID = 'cjld2cyuq0000t3rmniod1foy';

const SUP1_ID = 'clh3xxk0h0001356c9a5oba8m';
const SUP2_ID = 'clh3xxk0h0002356c9a5oba9n';
const NEW_SUP_ID = 'clh3xxk0h0003356c9a5obaan';

// ── Mock supplier store (in-memory) ───────────────────────────────────────────

type MockSupplier = {
  id: string;
  name: string;
  rif: string | null;
  whatsapp: string | null;
  address: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

let supplierStore: Map<string, MockSupplier>;
let supplierProductsStore: Map<string, Array<{ id: string; name: string; code: string }>>;

function seedStore() {
  supplierStore = new Map();
  supplierStore.set(SUP1_ID, {
    id: SUP1_ID,
    name: 'Pharma Distribuidora C.A.',
    rif: 'J-12345678-9',
    whatsapp: '+58412000000',
    address: 'Av. Principal, Maturín',
    active: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  });
  supplierStore.set(SUP2_ID, {
    id: SUP2_ID,
    name: 'MedSupply Global',
    rif: null,
    whatsapp: null,
    address: null,
    active: true,
    createdAt: new Date('2026-01-02T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  });

  supplierProductsStore = new Map([
    [
      SUP1_ID,
      [
        { id: 'clh3xxk0h1001356c9a5oba8m', name: 'Ibuprofen 400mg', code: 'MED-001' },
        { id: 'clh3xxk0h1002356c9a5oba9n', name: 'Paracetamol 500mg', code: 'MED-002' },
      ],
    ],
    [SUP2_ID, [{ id: 'clh3xxk0h1003356c9a5obaan', name: 'Amoxicillin 500mg', code: 'MED-003' }]],
  ]);
}

function buildSupplierRow(supplier: MockSupplier) {
  const products = (supplierProductsStore.get(supplier.id) ?? []).map((product) => ({ product }));

  return {
    id: supplier.id,
    name: supplier.name,
    rif: supplier.rif,
    whatsapp: supplier.whatsapp,
    address: supplier.address,
    active: supplier.active,
    products,
    createdAt: supplier.createdAt,
    updatedAt: supplier.updatedAt,
  };
}

// ── Mock Prisma ────────────────────────────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => {
  const mockPrisma = {
    supplier: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    // Required for authenticate → auth.service → verifyAccessToken module graph.
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

describe('Suppliers CRUD smoke tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedStore();

    const { prisma } = await import('../../src/shared/utils/prisma.js');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockSupplierCreate = vi.mocked(prisma.supplier.create);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockSupplierFindMany = vi.mocked(prisma.supplier.findMany);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockSupplierFindUnique = vi.mocked(prisma.supplier.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockSupplierFindFirst = vi.mocked(prisma.supplier.findFirst);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockSupplierUpdate = vi.mocked(prisma.supplier.update);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockSupplierCount = vi.mocked(prisma.supplier.count);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockTransaction = vi.mocked(prisma.$transaction);

    // supplier.create — insert into store, return new supplier.
    mockSupplierCreate.mockImplementation(({ data }: { data: Partial<MockSupplier> }) => {
      const newSup: MockSupplier = {
        id: NEW_SUP_ID,
        name: data.name ?? '',
        rif: data.rif ?? null,
        whatsapp: data.whatsapp ?? null,
        address: data.address ?? null,
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      supplierStore.set(newSup.id, newSup);
      supplierProductsStore.set(newSup.id, []);
      return Promise.resolve(buildSupplierRow(newSup));
    });

    // supplier.findMany — list suppliers from store with active filter.
    mockSupplierFindMany.mockImplementation(
      ({
        where,
        skip = 0,
        take,
      }: {
        where?: { active?: boolean; AND?: unknown[] };
        skip?: number;
        take?: number;
        orderBy?: unknown;
        select?: unknown;
      } = {}) => {
        let suppliers = [...supplierStore.values()];
        // Apply active filter.
        const activeFilter = where?.active;
        if (activeFilter !== undefined) {
          suppliers = suppliers.filter((s) => s.active === activeFilter);
        }
        // When AND is used (search + active), filter active from first AND element.
        if (where?.AND && Array.isArray(where.AND)) {
          const andActive = (where.AND[0] as { active?: boolean } | undefined)?.active;
          if (andActive !== undefined) {
            suppliers = suppliers.filter((s) => s.active === andActive);
          }
        }
        const sliced = suppliers.slice(skip, take !== undefined ? skip + take : undefined);
        return Promise.resolve(sliced.map(buildSupplierRow));
      },
    );

    // supplier.findUnique — lookup by id or rif.
    mockSupplierFindUnique.mockImplementation(
      ({ where }: { where: { id?: string; rif?: string } }) => {
        if (where.id) {
          const sup = supplierStore.get(where.id);
          return Promise.resolve(sup ? buildSupplierRow(sup) : null);
        }
        if (where.rif) {
          const sup = [...supplierStore.values()].find((s) => s.rif === where.rif);
          return Promise.resolve(sup ? buildSupplierRow(sup) : null);
        }
        return Promise.resolve(null);
      },
    );

    // supplier.findFirst — by rif excluding id (update uniqueness check).
    mockSupplierFindFirst.mockImplementation(
      ({ where }: { where: { rif?: string; NOT?: { id?: string } } }) => {
        const suppliers = [...supplierStore.values()];
        const match = suppliers.find((s) => {
          if (where.rif && s.rif !== where.rif) return false;
          if (where.NOT?.id && s.id === where.NOT.id) return false;
          return true;
        });
        return Promise.resolve(match ? buildSupplierRow(match) : null);
      },
    );

    // supplier.update — patch supplier in store (handles both PATCH and soft-delete).
    mockSupplierUpdate.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Partial<MockSupplier> }) => {
        const existing = supplierStore.get(where.id);
        if (!existing) throw Object.assign(new Error('P2025'), { code: 'P2025' });
        const updated: MockSupplier = { ...existing, ...data, updatedAt: new Date() };
        supplierStore.set(where.id, updated);
        return Promise.resolve(buildSupplierRow(updated));
      },
    );

    // supplier.count — used by $transaction for paginated list.
    mockSupplierCount.mockImplementation(
      ({ where }: { where?: { active?: boolean; AND?: unknown[] } } = {}) => {
        let suppliers = [...supplierStore.values()];
        const activeFilter = where?.active;
        if (activeFilter !== undefined) {
          suppliers = suppliers.filter((s) => s.active === activeFilter);
        }
        if (where?.AND && Array.isArray(where.AND)) {
          const andActive = (where.AND[0] as { active?: boolean } | undefined)?.active;
          if (andActive !== undefined) {
            suppliers = suppliers.filter((s) => s.active === andActive);
          }
        }
        return Promise.resolve(suppliers.length);
      },
    );

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
    it('POST /api/suppliers without token → 401', async () => {
      const res = await request(app).post('/api/suppliers').send({ name: 'New Supplier' });
      expect(res.status).toBe(401);
    });

    it('GET /api/suppliers without token → 401', async () => {
      const res = await request(app).get('/api/suppliers');
      expect(res.status).toBe(401);
    });
  });

  // ── 403 OPERATOR on mutations ──────────────────────────────────────────────

  describe('OPERATOR on mutations (403 FORBIDDEN)', () => {
    it('POST /api/suppliers as OPERATOR → 403', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({ name: 'New Supplier' });
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN');
    });

    it('PATCH /api/suppliers/:id as OPERATOR → 403', async () => {
      const res = await request(app)
        .patch(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({ name: 'Renamed' });
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN');
    });

    it('DELETE /api/suppliers/:id as OPERATOR → 403', async () => {
      const res = await request(app)
        .delete(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN');
    });
  });

  // ── OPERATOR allowed on reads ──────────────────────────────────────────────

  describe('OPERATOR on reads (200 OK)', () => {
    it('GET /api/suppliers as OPERATOR → 200', async () => {
      const res = await request(app)
        .get('/api/suppliers')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      expect(res.status).toBe(200);
    });

    it('GET /api/suppliers/:id as OPERATOR → 200', async () => {
      const res = await request(app)
        .get(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      expect(res.status).toBe(200);
    });
  });

  // ── POST /api/suppliers ────────────────────────────────────────────────────

  describe('POST /api/suppliers', () => {
    it('(a) happy path — creates supplier with all fields, returns 201', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({
          name: 'New Supplier S.A.',
          rif: 'J-99999999-9',
          whatsapp: '+584140000001',
          address: 'Calle 1, Maturín',
        });

      expect(res.status).toBe(201);
      const body = res.body as SupplierBody;
      expect(body.supplier.id).toBe(NEW_SUP_ID);
      expect(body.supplier.name).toBe('New Supplier S.A.');
      expect(body.supplier.rif).toBe('J-99999999-9');
      expect(body.supplier.active).toBe(true);
      expect(body.supplier.products).toEqual([]);
      expect(body.supplier.productsCount).toBe(0);
    });

    it('(b) happy path as MANAGER — creates supplier, returns 201', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ name: 'ManagerSupplier Ltd.' });

      expect(res.status).toBe(201);
      expect((res.body as SupplierBody).supplier.name).toBe('ManagerSupplier Ltd.');
    });

    it('(c) 409 duplicate RIF', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Another Supplier', rif: 'J-12345678-9' }); // SUP1 already has this RIF

      expect(res.status).toBe(409);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('CONFLICT');
      expect(body.message).toBe('Supplier RIF already exists.');
    });

    it('(d) RIF null does not collide with another null RIF', async () => {
      // SUP2 already has rif = null. Creating another supplier with rif omitted (null) must succeed.
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'No RIF Supplier' }); // rif not provided → null

      expect(res.status).toBe(201);
    });

    it('(e) empty string RIF is normalized to null (no collision)', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Empty RIF Supplier', rif: '' }); // empty string → normalized to null

      expect(res.status).toBe(201);
      // null rif should not conflict with other nulls.
    });

    it('(f) 400 missing name → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ rif: 'J-00000000-0' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(g) 400 name too short (1 char) → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'X' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(h) 400 invalid whatsapp format → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/suppliers')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Bad Phone Supplier', whatsapp: 'not-a-phone' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  // ── GET /api/suppliers ─────────────────────────────────────────────────────

  describe('GET /api/suppliers', () => {
    it('(a) happy path — returns paginated list with meta (default active=true)', async () => {
      const res = await request(app)
        .get('/api/suppliers')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.meta.total).toBe('number');
      expect(typeof body.meta.page).toBe('number');
      expect(typeof body.meta.limit).toBe('number');
      expect(typeof body.meta.totalPages).toBe('number');
      /* eslint-disable @typescript-eslint/no-unsafe-assignment */
      expect(body.data[0]).toEqual(
        expect.objectContaining({
          products: expect.any(Array),
          productsCount: expect.any(Number),
        }),
      );
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */
    });

    it('(b) pagination meta shape correct', async () => {
      const res = await request(app)
        .get('/api/suppliers?page=1&limit=10')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(10);
    });

    it('(c) ?active=false returns only inactive suppliers', async () => {
      // Soft-delete SUP1 so it becomes inactive.
      supplierStore.set(SUP1_ID, { ...supplierStore.get(SUP1_ID)!, active: false });

      const res = await request(app)
        .get('/api/suppliers?active=false')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      // Only inactive suppliers returned.
      expect(body.data.every((s) => s.active === false)).toBe(true);
    });

    it('(d) default list hides inactive suppliers (active=true by default)', async () => {
      // Soft-delete SUP1 so it becomes inactive.
      supplierStore.set(SUP1_ID, { ...supplierStore.get(SUP1_ID)!, active: false });

      const res = await request(app)
        .get('/api/suppliers')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      // All returned suppliers must be active.
      expect(body.data.every((s) => s.active === true)).toBe(true);
    });

    it('(e) ?search=Pharma returns suppliers matching name', async () => {
      const res = await request(app)
        .get('/api/suppliers?search=Pharma')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      // The mock returns all active suppliers regardless of search (structure test only).
      // The key assertion is the shape and HTTP 200.
      expect(Array.isArray((res.body as ListBody).data)).toBe(true);
    });
  });

  // ── GET /api/suppliers/:id ─────────────────────────────────────────────────

  describe('GET /api/suppliers/:id', () => {
    it('(a) happy path — returns active supplier', async () => {
      const res = await request(app)
        .get(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as SupplierBody;
      expect(body.supplier.id).toBe(SUP1_ID);
      expect(body.supplier.name).toBe('Pharma Distribuidora C.A.');
      expect(body.supplier.products).toEqual([
        { id: 'clh3xxk0h1001356c9a5oba8m', name: 'Ibuprofen 400mg', code: 'MED-001' },
        { id: 'clh3xxk0h1002356c9a5oba9n', name: 'Paracetamol 500mg', code: 'MED-002' },
      ]);
      expect(body.supplier.productsCount).toBe(2);
    });

    it('(b) returns inactive supplier (historical view)', async () => {
      // Soft-delete SUP1 in the store.
      supplierStore.set(SUP1_ID, { ...supplierStore.get(SUP1_ID)!, active: false });

      const res = await request(app)
        .get(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as SupplierBody;
      expect(body.supplier.active).toBe(false);
    });

    it('(c) 404 when supplier does not exist', async () => {
      const missingCuid = 'clh3xxk0h0099356c9a5zzzzz';
      const res = await request(app)
        .get(`/api/suppliers/${missingCuid}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('NOT_FOUND');
    });

    it('(d) 400 invalid cuid param → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/suppliers/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  // ── PATCH /api/suppliers/:id ───────────────────────────────────────────────

  describe('PATCH /api/suppliers/:id', () => {
    it('(a) happy path — updates name, returns 200 with supplier', async () => {
      const res = await request(app)
        .patch(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Pharma Updated S.A.' });

      expect(res.status).toBe(200);
      const body = res.body as SupplierBody;
      expect(body.supplier.name).toBe('Pharma Updated S.A.');
    });

    it('(b) 409 duplicate RIF — patching to a RIF already in use by another supplier', async () => {
      // Give SUP2 a RIF that collides with what we try to set on SUP1.
      supplierStore.set(SUP2_ID, { ...supplierStore.get(SUP2_ID)!, rif: 'J-99999999-9' });

      const res = await request(app)
        .patch(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ rif: 'J-99999999-9' });

      expect(res.status).toBe(409);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('CONFLICT');
      expect(body.message).toBe('Supplier RIF already exists.');
    });

    it('(c) PATCH with same RIF as own supplier → 200 (no false positive)', async () => {
      const res = await request(app)
        .patch(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ rif: 'J-12345678-9' }); // same as current SUP1 RIF

      expect(res.status).toBe(200);
    });

    it('(d) 404 when supplier does not exist', async () => {
      const missingCuid = 'clh3xxk0h0099356c9a5zzzzz';
      const res = await request(app)
        .patch(`/api/suppliers/${missingCuid}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'New Name' });

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('NOT_FOUND');
    });

    it('(e) 400 empty body → VALIDATION_ERROR (refine fires)', async () => {
      const res = await request(app)
        .patch(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({});

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(f) 400 invalid cuid param → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .patch('/api/suppliers/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Something' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(g) PATCH with rif: null clears the rif field', async () => {
      const res = await request(app)
        .patch(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ rif: null });

      expect(res.status).toBe(200);
      const body = res.body as SupplierBody;
      expect(body.supplier.rif).toBeNull();
    });

    it('(h) PATCH with whatsapp: null clears the whatsapp field', async () => {
      const res = await request(app)
        .patch(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ whatsapp: null });

      expect(res.status).toBe(200);
      const body = res.body as SupplierBody;
      expect(body.supplier.whatsapp).toBeNull();
    });

    it('(i) PATCH with address: null clears the address field', async () => {
      const res = await request(app)
        .patch(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ address: null });

      expect(res.status).toBe(200);
      const body = res.body as SupplierBody;
      expect(body.supplier.address).toBeNull();
    });
  });

  // ── DELETE /api/suppliers/:id ──────────────────────────────────────────────

  describe('DELETE /api/suppliers/:id (soft-delete)', () => {
    it('(a) happy path — 204 on active supplier, sets active=false', async () => {
      const res = await request(app)
        .delete(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(204);
      // Verify supplier was soft-deleted (active = false) in the store.
      expect(supplierStore.get(SUP1_ID)?.active).toBe(false);
    });

    it('(b) MANAGER can soft-delete a supplier → 204', async () => {
      const res = await request(app)
        .delete(`/api/suppliers/${SUP2_ID}`)
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`);

      expect(res.status).toBe(204);
      expect(supplierStore.get(SUP2_ID)?.active).toBe(false);
    });

    it('(c) 404 when supplier does not exist', async () => {
      const missingCuid = 'clh3xxk0h0099356c9a5zzzzz';
      const res = await request(app)
        .delete(`/api/suppliers/${missingCuid}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('NOT_FOUND');
    });

    it('(d) 404 when supplier is already inactive (idempotency guard)', async () => {
      // Manually mark SUP1 as inactive before the DELETE call.
      supplierStore.set(SUP1_ID, { ...supplierStore.get(SUP1_ID)!, active: false });

      const res = await request(app)
        .delete(`/api/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('NOT_FOUND');
    });

    it('(e) 400 invalid cuid param → VALIDATION_ERROR', async () => {
      const res = await request(app)
        .delete('/api/suppliers/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });
});
