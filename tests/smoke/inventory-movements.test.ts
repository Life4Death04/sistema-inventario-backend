/**
 * Smoke tests for inventory movements endpoints.
 *
 * Coverage:
 *   - POST   /api/inventory-movements          (R1: create — 15 scenarios)
 *   - GET    /api/inventory-movements          (R2: list — 10 scenarios)
 *   - GET    /api/inventory-movements/:id      (R3: get one — 4 scenarios)
 *   - GET    /api/products/:productId/inventory-movements  (R4: product-scoped list — 5 scenarios)
 *   - R5: 405 immutability + rollback/concurrency (4.3 rollback cases)
 *
 * Prisma is fully mocked — no real DB required.
 * Mirrors the pattern established in tests/smoke/products.test.ts.
 *
 * $transaction mock strategy:
 *   The inventory-movements service uses the callback form of $transaction
 *   (interactive transactions). The mock detects whether the argument is a
 *   function (callback pattern) or an array (batch pattern) and handles each:
 *     - function → calls it with the mock tx client
 *     - array    → Promise.all(queries) for listMovements parallel count/findMany
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';

// ── Response body types ────────────────────────────────────────────────────────

interface MovementRecord {
  id: string;
  productId: string;
  userId: string;
  product: {
    id: string;
    name: string;
    code: string;
  };
  user: {
    id: string;
    fullName: string;
  };
  type: 'IN' | 'OUT' | 'ADJUSTMENT';
  adjustmentDirection: 'INCREASE' | 'DECREASE' | null;
  quantity: number;
  resultingStock: number;
  reason: string;
  createdAt: string;
}

interface MovementBody {
  movement: MovementRecord;
}

interface ListBody {
  data: MovementRecord[];
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

const ADMIN_ID = 'clh3xxk0h0000356c9a5oba7k';
const MANAGER_ID = 'cjld2cjxh0000qzrmn831i7rn';
const OPERATOR_ID = 'cjld2cyuq0000t3rmniod1foy';

const PROD1_ID = 'clh3xxk0h1001356c9a5oba8m'; // active, stock = 20
const PROD2_ID = 'clh3xxk0h1002356c9a5oba9n'; // active, stock = 2  (near-zero for insufficient tests)
const PROD3_ID = 'clh3xxk0h1003356c9a5obaan'; // inactive
const MISSING_PROD_ID = 'clh3xxk0h1099356c9a5zzzzz';

const MOV1_ID = 'clh3xxk0h2001356c9a5oba8m';
const MOV2_ID = 'clh3xxk0h2002356c9a5oba9n';
const MISSING_MOV_ID = 'clh3xxk0h2099356c9a5zzzzz';

// ── In-memory stores ──────────────────────────────────────────────────────────

interface MockProduct {
  id: string;
  code: string;
  name: string;
  stock: number;
  minStock: number;
  active: boolean;
}

interface MockUser {
  id: string;
  fullName: string;
}

interface MockMovement {
  id: string;
  productId: string;
  userId: string;
  type: 'IN' | 'OUT' | 'ADJUSTMENT';
  adjustmentDirection: 'INCREASE' | 'DECREASE' | null;
  quantity: number;
  resultingStock: number;
  reason: string;
  createdAt: Date;
}

let productStore: Map<string, MockProduct>;
let movementStore: Map<string, MockMovement>;
let userStore: Map<string, MockUser>;
let movementCounter: number;

function seedStore(): void {
  movementCounter = 0;

  productStore = new Map([
    [
      PROD1_ID,
      {
        id: PROD1_ID,
        code: 'MED-001',
        name: 'Ibuprofen 400mg',
        stock: 20,
        minStock: 5,
        active: true,
      },
    ],
    [
      PROD2_ID,
      {
        id: PROD2_ID,
        code: 'MED-002',
        name: 'Paracetamol 500mg',
        stock: 2,
        minStock: 3,
        active: true,
      },
    ],
    [
      PROD3_ID,
      {
        id: PROD3_ID,
        code: 'MED-003',
        name: 'Amoxicillin 500mg',
        stock: 99,
        minStock: 10,
        active: false,
      },
    ],
  ]);

  userStore = new Map([
    [ADMIN_ID, { id: ADMIN_ID, fullName: 'Admin User' }],
    [MANAGER_ID, { id: MANAGER_ID, fullName: 'Manager User' }],
    [OPERATOR_ID, { id: OPERATOR_ID, fullName: 'Operator User' }],
  ]);

  movementStore = new Map([
    [
      MOV1_ID,
      {
        id: MOV1_ID,
        productId: PROD1_ID,
        userId: ADMIN_ID,
        type: 'IN',
        adjustmentDirection: null,
        quantity: 10,
        resultingStock: 20,
        reason: 'Initial stock',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    [
      MOV2_ID,
      {
        id: MOV2_ID,
        productId: PROD2_ID,
        userId: ADMIN_ID,
        type: 'OUT',
        adjustmentDirection: null,
        quantity: 5,
        resultingStock: 2,
        reason: 'Sale',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ],
  ]);
}

function buildMovementRow(movement: MockMovement) {
  const product = productStore.get(movement.productId);
  const user = userStore.get(movement.userId);

  if (!product || !user) {
    throw new Error(`Missing related data for movement ${movement.id}`);
  }

  return {
    id: movement.id,
    productId: movement.productId,
    userId: movement.userId,
    product: {
      id: product.id,
      name: product.name,
      code: product.code,
    },
    user: {
      id: user.id,
      fullName: user.fullName,
    },
    type: movement.type,
    adjustmentDirection: movement.adjustmentDirection,
    quantity: movement.quantity,
    resultingStock: movement.resultingStock,
    reason: movement.reason,
    createdAt: movement.createdAt,
  };
}

// ── Prisma mock ───────────────────────────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => {
  // tx client mirrors the operations the service calls inside $transaction
  const mockTx = {
    product: {
      updateMany: vi.fn(),
    },
    inventoryMovement: {
      create: vi.fn(),
    },
  };

  const mockPrisma = {
    product: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    inventoryMovement: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
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
    // Dual-mode $transaction:
    //   callback form (interactive tx) → call with mockTx
    //   array form (batch)             → Promise.all(queries)
    $transaction: vi.fn(),
    _mockTx: mockTx,
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

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('Inventory Movements smoke tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedStore();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const mod = (await import('../../src/shared/utils/prisma.js')) as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const { prisma } = mod;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mockTx = prisma._mockTx;

    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mockProductFindUnique = vi.mocked(prisma.product.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mockMovementFindUnique = vi.mocked(prisma.inventoryMovement.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mockMovementFindMany = vi.mocked(prisma.inventoryMovement.findMany);
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mockMovementCount = vi.mocked(prisma.inventoryMovement.count);
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mockTransaction = vi.mocked(prisma.$transaction);
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mockTxProductUpdateMany = vi.mocked(mockTx.product.updateMany);
    // eslint-disable-next-line @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mockTxMovementCreate = vi.mocked(mockTx.inventoryMovement.create);

    // product.findUnique — used by findProductActive() (reads product.id + stock + minStock + active).
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    mockProductFindUnique.mockImplementation(
      ({ where }: { where: { id?: string }; select?: Record<string, boolean> }) => {
        if (!where.id) return Promise.resolve(null);
        const product = productStore.get(where.id);
        if (!product) return Promise.resolve(null);
        return Promise.resolve({
          id: product.id,
          stock: product.stock,
          minStock: product.minStock,
          active: product.active,
        });
      },
    );

    // inventoryMovement.findUnique — used by findMovementById().
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    mockMovementFindUnique.mockImplementation(({ where }: { where: { id?: string } }) => {
      if (!where.id) return Promise.resolve(null);
      const movement = movementStore.get(where.id);
      return Promise.resolve(movement ? buildMovementRow(movement) : null);
    });

    // inventoryMovement.findMany — used by listMovements() and listMovementsByProduct().
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    mockMovementFindMany.mockImplementation(
      ({
        where = {},
        skip = 0,
        take,
      }: {
        where?: {
          productId?: string;
          type?: string;
          createdAt?: { gte?: Date; lte?: Date };
        };
        skip?: number;
        take?: number;
        orderBy?: unknown;
        select?: unknown;
      } = {}) => {
        let rows = [...movementStore.values()];

        if (where.productId) {
          rows = rows.filter((m) => m.productId === where.productId);
        }
        if (where.type) {
          rows = rows.filter((m) => m.type === where.type);
        }
        if (where.createdAt?.gte) {
          rows = rows.filter((m) => m.createdAt >= where.createdAt!.gte!);
        }
        if (where.createdAt?.lte) {
          rows = rows.filter((m) => m.createdAt <= where.createdAt!.lte!);
        }

        // Sort createdAt DESC.
        rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return Promise.resolve(
          rows.slice(skip, take !== undefined ? skip + take : undefined).map(buildMovementRow),
        );
      },
    );

    // inventoryMovement.count — used in the parallel list queries.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    mockMovementCount.mockImplementation(
      ({
        where = {},
      }: {
        where?: {
          productId?: string;
          type?: string;
          createdAt?: { gte?: Date; lte?: Date };
        };
      } = {}) => {
        let rows = [...movementStore.values()];
        if (where.productId) rows = rows.filter((m) => m.productId === where.productId);
        if (where.type) rows = rows.filter((m) => m.type === where.type);
        if (where.createdAt?.gte) {
          rows = rows.filter((m) => m.createdAt >= where.createdAt!.gte!);
        }
        if (where.createdAt?.lte) {
          rows = rows.filter((m) => m.createdAt <= where.createdAt!.lte!);
        }
        return Promise.resolve(rows.length);
      },
    );

    // tx.product.updateMany — CAS update inside the transaction.
    // Returns { count: 1 } when observed stock matches; { count: 0 } otherwise.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    mockTxProductUpdateMany.mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string; stock: number; active: boolean };
        data: { stock: number };
      }) => {
        const product = productStore.get(where.id);
        if (!product || product.stock !== where.stock || product.active !== where.active) {
          return Promise.resolve({ count: 0 });
        }
        productStore.set(where.id, { ...product, stock: data.stock });
        return Promise.resolve({ count: 1 });
      },
    );

    // tx.inventoryMovement.create — insert movement record atomically.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    mockTxMovementCreate.mockImplementation(
      ({ data }: { data: Omit<MockMovement, 'id' | 'createdAt'>; select?: unknown }) => {
        movementCounter += 1;
        const movement: MockMovement = {
          id: `clh3xxk0h300${movementCounter}356c9a5oba8m`,
          productId: data.productId,
          userId: data.userId,
          type: data.type,
          adjustmentDirection: data.adjustmentDirection ?? null,
          quantity: data.quantity,
          resultingStock: data.resultingStock,
          reason: data.reason,
          createdAt: new Date(),
        };
        movementStore.set(movement.id, movement);
        return Promise.resolve(buildMovementRow(movement));
      },
    );

    // $transaction: dual-mode implementation.
    //   - callback form (createMovement interactive tx): call with mockTx
    //   - array form (listMovements parallel queries): Promise.all(queries)
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    mockTransaction.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (callbackOrArray: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>) => {
        if (typeof callbackOrArray === 'function') {
          return callbackOrArray(mockTx);
        }
        return Promise.all(callbackOrArray);
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── R1: Create Movement (POST /api/inventory-movements) ───────────────────────

  describe('R1 — POST /api/inventory-movements', () => {
    // S1: ADMIN creates IN increases stock
    it('(S1) ADMIN creates IN movement — returns 201, resultingStock = 30, product stock updated', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'IN', quantity: 10, reason: 'Restock' });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.movement.type).toBe('IN');
      expect(body.movement.product).toEqual({
        id: PROD1_ID,
        name: 'Ibuprofen 400mg',
        code: 'MED-001',
      });
      expect(body.movement.user).toEqual({ id: ADMIN_ID, fullName: 'Admin User' });
      expect(body.movement.quantity).toBe(10);
      expect(body.movement.resultingStock).toBe(30);
      expect(body.movement.adjustmentDirection).toBeNull();
      // Product stock was updated in the store.
      expect(productStore.get(PROD1_ID)?.stock).toBe(30);
    });

    // S2: OPERATOR creates OUT with sufficient stock
    it('(S2) OPERATOR creates OUT — returns 201, resultingStock = 15', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'OUT', quantity: 5, reason: 'Sale' });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.movement.type).toBe('OUT');
      expect(body.movement.user).toEqual({ id: OPERATOR_ID, fullName: 'Operator User' });
      expect(body.movement.resultingStock).toBe(15);
      expect(productStore.get(PROD1_ID)?.stock).toBe(15);
    });

    // S3: OUT with insufficient stock — 409 INSUFFICIENT_STOCK, stock unchanged
    it('(S3) OUT insufficient stock — 409 INSUFFICIENT_STOCK, product stock unchanged', async () => {
      // PROD2 has stock=2; trying to take 5.
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD2_ID, type: 'OUT', quantity: 5, reason: 'Sale' });

      expect(res.status).toBe(409);
      const body = res.body as ErrorBody;
      expect(body.error).toBe('INSUFFICIENT_STOCK');
      // Atomicity: no movement row inserted.
      expect([...movementStore.values()].filter((m) => m.productId === PROD2_ID)).toHaveLength(1);
      // Stock unchanged.
      expect(productStore.get(PROD2_ID)?.stock).toBe(2);
    });

    // S4: MANAGER posts positive ADJUSTMENT — INCREASE direction
    it('(S4) MANAGER ADJUSTMENT +3 — 201, adjustmentDirection = INCREASE, stock = 23', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'ADJUSTMENT', quantity: 3, reason: 'Recount surplus' });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.movement.adjustmentDirection).toBe('INCREASE');
      expect(body.movement.quantity).toBe(3);
      expect(body.movement.resultingStock).toBe(23);
      expect(productStore.get(PROD1_ID)?.stock).toBe(23);
    });

    // S5: MANAGER posts negative ADJUSTMENT — DECREASE direction
    it('(S5) MANAGER ADJUSTMENT -2 — 201, adjustmentDirection = DECREASE, stock = 18', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({
          productId: PROD1_ID,
          type: 'ADJUSTMENT',
          quantity: -2,
          reason: 'Recount shortage',
        });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.movement.adjustmentDirection).toBe('DECREASE');
      expect(body.movement.quantity).toBe(2);
      expect(body.movement.resultingStock).toBe(18);
      expect(productStore.get(PROD1_ID)?.stock).toBe(18);
    });

    // S6: ADJUSTMENT with quantity = 0 is rejected
    it('(S6) ADJUSTMENT quantity=0 — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'ADJUSTMENT', quantity: 0, reason: 'Bad recount' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // S7: ADJUSTMENT that would leave stock negative
    it('(S7) ADJUSTMENT-DOWN that would make stock negative — 409 INSUFFICIENT_STOCK, stock unchanged', async () => {
      // PROD2 stock=2; ADJUSTMENT -10 would result in -8.
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD2_ID, type: 'ADJUSTMENT', quantity: -10, reason: 'Recount loss' });

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toBe('INSUFFICIENT_STOCK');
      expect(productStore.get(PROD2_ID)?.stock).toBe(2);
    });

    // S8: OPERATOR posting IN is forbidden
    it('(S8) OPERATOR POST IN — 403 FORBIDDEN_MOVEMENT_TYPE', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'IN', quantity: 5, reason: 'Restock' });

      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN_MOVEMENT_TYPE');
    });

    // S9: OPERATOR posting ADJUSTMENT is forbidden
    it('(S9) OPERATOR POST ADJUSTMENT — 403 FORBIDDEN_MOVEMENT_TYPE', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'ADJUSTMENT', quantity: 5, reason: 'Recount' });

      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN_MOVEMENT_TYPE');
    });

    // S10: Unauthenticated request
    it('(S10) Unauthenticated POST — 401', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .send({ productId: PROD1_ID, type: 'IN', quantity: 5, reason: 'Restock' });

      expect(res.status).toBe(401);
    });

    // S11: Missing reason is rejected for all types
    it('(S11a) Missing reason on IN — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'IN', quantity: 5 });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(S11b) Empty reason on OUT — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'OUT', quantity: 5, reason: '' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(S11c) Whitespace-only reason on ADJUSTMENT — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'ADJUSTMENT', quantity: 3, reason: '   ' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // S12: Quantity out of bounds
    it('(S12a) IN quantity=0 — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'IN', quantity: 0, reason: 'Bad' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(S12b) OUT quantity > 1_000_000 — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'OUT', quantity: 1_000_001, reason: 'Too many' });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // S13: Nonexistent product
    it('(S13) Nonexistent product — 404 PRODUCT_NOT_FOUND', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: MISSING_PROD_ID, type: 'IN', quantity: 5, reason: 'Restock' });

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('PRODUCT_NOT_FOUND');
    });

    // S14: Inactive product treated as not found
    it('(S14) Inactive product — 404 PRODUCT_NOT_FOUND', async () => {
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD3_ID, type: 'IN', quantity: 5, reason: 'Restock' });

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('PRODUCT_NOT_FOUND');
    });

    // S15: ADMIN can create IN, OUT, and ADJUSTMENT (role matrix — full coverage)
    it('(S15) ADMIN can create all three movement types', async () => {
      const inRes = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'IN', quantity: 1, reason: 'Test IN' });

      // Reset stock to known value before next movement.
      productStore.set(PROD1_ID, { ...productStore.get(PROD1_ID)!, stock: 20 });

      const outRes = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'OUT', quantity: 1, reason: 'Test OUT' });

      productStore.set(PROD1_ID, { ...productStore.get(PROD1_ID)!, stock: 20 });

      const adjRes = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'ADJUSTMENT', quantity: 1, reason: 'Test ADJ' });

      expect(inRes.status).toBe(201);
      expect(outRes.status).toBe(201);
      expect(adjRes.status).toBe(201);
    });

    // MANAGER can create all types too
    it('MANAGER can create IN, OUT, and ADJUSTMENT', async () => {
      const inRes = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'IN', quantity: 1, reason: 'Manager IN' });

      productStore.set(PROD1_ID, { ...productStore.get(PROD1_ID)!, stock: 20 });

      const outRes = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'OUT', quantity: 1, reason: 'Manager OUT' });

      productStore.set(PROD1_ID, { ...productStore.get(PROD1_ID)!, stock: 20 });

      const adjRes = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'ADJUSTMENT', quantity: -1, reason: 'Manager ADJ' });

      expect(inRes.status).toBe(201);
      expect(outRes.status).toBe(201);
      expect(adjRes.status).toBe(201);
    });
  });

  // ── R2: List Movements (GET /api/inventory-movements) ─────────────────────────

  describe('R2 — GET /api/inventory-movements', () => {
    // S16: Default list returns newest first
    it('(S16) Default list — 200, data array sorted createdAt DESC, meta.limit present', async () => {
      const res = await request(app)
        .get('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta.limit).toBe(20); // default limit
      expect(body.meta.page).toBe(1);
      expect(typeof body.meta.total).toBe('number');
      expect(typeof body.meta.totalPages).toBe('number');
      /* eslint-disable @typescript-eslint/no-unsafe-assignment */
      expect(body.data[0]).toEqual(
        expect.objectContaining({
          product: expect.objectContaining({
            id: expect.any(String),
            name: expect.any(String),
            code: expect.any(String),
          }),
          user: expect.objectContaining({ id: expect.any(String), fullName: expect.any(String) }),
        }),
      );
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */

      // Sorted newest first: MOV2 (Jan 2) before MOV1 (Jan 1).
      if (body.data.length >= 2) {
        const first = new Date(body.data[0]!.createdAt).getTime();
        const second = new Date(body.data[1]!.createdAt).getTime();
        expect(first).toBeGreaterThanOrEqual(second);
      }
    });

    // S17: Filter by productId
    it('(S17) ?productId filter — returns only movements for that product', async () => {
      const res = await request(app)
        .get(`/api/inventory-movements?productId=${PROD1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.every((m) => m.productId === PROD1_ID)).toBe(true);
    });

    // S18: Filter by type
    it('(S18) ?type=OUT — returns only OUT movements', async () => {
      const res = await request(app)
        .get('/api/inventory-movements?type=OUT')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.every((m) => m.type === 'OUT')).toBe(true);
    });

    // S19: Inclusive date range filter
    it('(S19) ?from + ?to date range — returns movements within the range', async () => {
      const res = await request(app)
        .get('/api/inventory-movements?from=2026-01-01&to=2026-01-02')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.length).toBeGreaterThan(0);
    });

    // S20: Combined AND filters
    it('(S20) combined ?productId + ?type — AND-combined filter', async () => {
      const res = await request(app)
        .get(`/api/inventory-movements?productId=${PROD1_ID}&type=IN`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.every((m) => m.productId === PROD1_ID && m.type === 'IN')).toBe(true);
    });

    // S21: Invalid pageSize is rejected
    it('(S21a) ?limit=0 — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/inventory-movements?limit=0')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(S21b) ?limit=101 — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/inventory-movements?limit=101')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // S22: Invalid type value
    it('(S22) ?type=TRANSFER — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/inventory-movements?type=TRANSFER')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // S23: Invalid date format
    it('(S23) ?from=not-a-date — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/inventory-movements?from=not-a-date')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // S24: Empty result is valid 200
    it('(S24) filter that matches nothing — 200 with data=[] and total=0', async () => {
      const res = await request(app)
        .get(`/api/inventory-movements?productId=${MISSING_PROD_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data).toHaveLength(0);
      expect(body.meta.total).toBe(0);
    });

    // S25: Unauthenticated list
    it('(S25) Unauthenticated GET list — 401', async () => {
      const res = await request(app).get('/api/inventory-movements');
      expect(res.status).toBe(401);
    });

    // Zod coercion flows to service — pagination coercion check
    it('?limit=5&page=2 coerces numbers — meta.limit=5, meta.page=2', async () => {
      // Seed more than 5 movements so pagination is meaningful.
      for (let i = 0; i < 6; i++) {
        const mid = `clhtest00${i}xxk0h0000356c9a5oba7k`;
        movementStore.set(mid, {
          id: mid,
          productId: PROD1_ID,
          userId: ADMIN_ID,
          type: 'IN',
          adjustmentDirection: null,
          quantity: 1,
          resultingStock: 20 + i,
          reason: `Batch ${i}`,
          createdAt: new Date(`2026-02-0${i + 1}T00:00:00.000Z`),
        });
      }

      const res = await request(app)
        .get('/api/inventory-movements?limit=5&page=2')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      // The coerced numbers reached the service.
      expect(body.meta.limit).toBe(5);
      expect(body.meta.page).toBe(2);
    });

    // OPERATOR can list movements
    it('OPERATOR can GET /api/inventory-movements — 200', async () => {
      const res = await request(app)
        .get('/api/inventory-movements')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);

      expect(res.status).toBe(200);
    });
  });

  // ── R3: Get Movement by Id (GET /api/inventory-movements/:id) ─────────────────

  describe('R3 — GET /api/inventory-movements/:id', () => {
    // S26: Existing movement is returned
    it('(S26) Existing movement — 200 with full movement including resultingStock', async () => {
      const res = await request(app)
        .get(`/api/inventory-movements/${MOV1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as MovementBody;
      expect(body.movement.id).toBe(MOV1_ID);
      expect(body.movement.product).toEqual({
        id: PROD1_ID,
        name: 'Ibuprofen 400mg',
        code: 'MED-001',
      });
      expect(body.movement.user).toEqual({ id: ADMIN_ID, fullName: 'Admin User' });
      expect(body.movement.type).toBe('IN');
      expect(typeof body.movement.resultingStock).toBe('number');
      expect(body.movement.adjustmentDirection).toBeNull();
    });

    // ADJUSTMENT movement includes adjustmentDirection
    it('GET ADJUSTMENT movement — includes adjustmentDirection field', async () => {
      // Seed an ADJUSTMENT movement.
      const adjId = 'clh3xxk0hadjust56c9a5oba8m';
      movementStore.set(adjId, {
        id: adjId,
        productId: PROD1_ID,
        userId: ADMIN_ID,
        type: 'ADJUSTMENT',
        adjustmentDirection: 'INCREASE',
        quantity: 5,
        resultingStock: 25,
        reason: 'Recount',
        createdAt: new Date(),
      });

      const res = await request(app)
        .get(`/api/inventory-movements/${adjId}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as MovementBody;
      expect(body.movement.adjustmentDirection).toBe('INCREASE');
    });

    // S27: Nonexistent movement returns 404
    it('(S27) Nonexistent movement — 404 MOVEMENT_NOT_FOUND', async () => {
      const res = await request(app)
        .get(`/api/inventory-movements/${MISSING_MOV_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('MOVEMENT_NOT_FOUND');
    });

    // S28: Invalid id format
    it('(S28) Invalid cuid — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/inventory-movements/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // S29: Unauthenticated get
    it('(S29) Unauthenticated GET /:id — 401', async () => {
      const res = await request(app).get(`/api/inventory-movements/${MOV1_ID}`);
      expect(res.status).toBe(401);
    });
  });

  // ── R4: List Product Movements (GET /api/products/:productId/inventory-movements) ──

  describe('R4 — GET /api/products/:productId/inventory-movements', () => {
    // S30: Existing product with movements returns scoped page
    it('(S30) Existing product with movements — 200 scoped to that product', async () => {
      const res = await request(app)
        .get(`/api/products/${PROD1_ID}/inventory-movements`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      // Sub-resource must not return movements from other products.
      expect(body.data.every((m) => m.productId === PROD1_ID)).toBe(true);
      expect(Array.isArray(body.data)).toBe(true);
    });

    // S31: Existing product with no movements returns empty list
    it('(S31) Product with no movements — 200 with data=[] and pagination.total=0', async () => {
      // PROD1 exists and is active; remove its movements from the store.
      for (const [id, m] of movementStore.entries()) {
        if (m.productId === PROD1_ID) movementStore.delete(id);
      }

      const res = await request(app)
        .get(`/api/products/${PROD1_ID}/inventory-movements`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data).toHaveLength(0);
      expect(body.meta.total).toBe(0);
    });

    // S32: Nonexistent product returns 404
    it('(S32) Nonexistent product — 404 PRODUCT_NOT_FOUND', async () => {
      const res = await request(app)
        .get(`/api/products/${MISSING_PROD_ID}/inventory-movements`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('PRODUCT_NOT_FOUND');
    });

    // Inactive product returns 404
    it('Inactive product in sub-resource — 404 PRODUCT_NOT_FOUND', async () => {
      const res = await request(app)
        .get(`/api/products/${PROD3_ID}/inventory-movements`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('PRODUCT_NOT_FOUND');
    });

    // S33: Invalid productId format
    it('(S33) Invalid productId cuid — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/products/not-a-valid-cuid/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // S34: Unauthenticated request
    it('(S34) Unauthenticated sub-resource — 401', async () => {
      const res = await request(app).get(`/api/products/${PROD1_ID}/inventory-movements`);
      expect(res.status).toBe(401);
    });

    // Sub-resource routing: confirm the route does not shadow /:id on productsRouter
    it('Sub-resource route resolves correctly — does not fall through to /:id', async () => {
      const res = await request(app)
        .get(`/api/products/${PROD1_ID}/inventory-movements`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      // 200 confirms the sub-resource route was matched (not 400/404 from the /:id handler).
      expect(res.status).toBe(200);
      expect((res.body as ListBody).data).toBeDefined();
    });
  });

  // ── R5: Immutability — 405 on PATCH / PUT / DELETE ────────────────────────────

  describe('R5 — Movement immutability (405 Method Not Allowed)', () => {
    // S35: PATCH on a movement is rejected
    it('(S35) PATCH /api/inventory-movements/:id — 405 with Allow: GET header', async () => {
      const res = await request(app)
        .patch(`/api/inventory-movements/${MOV1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ reason: 'Tamper' });

      expect(res.status).toBe(405);
      expect(res.headers['allow']).toBe('GET');
      expect((res.body as ErrorBody).error).toBe('METHOD_NOT_ALLOWED');
    });

    // S36: PUT on a movement is rejected
    it('(S36) PUT /api/inventory-movements/:id — 405 with Allow: GET header', async () => {
      const res = await request(app)
        .put(`/api/inventory-movements/${MOV1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ reason: 'Tamper' });

      expect(res.status).toBe(405);
      expect(res.headers['allow']).toBe('GET');
      expect((res.body as ErrorBody).error).toBe('METHOD_NOT_ALLOWED');
    });

    // S37: DELETE on a movement is rejected
    it('(S37) DELETE /api/inventory-movements/:id — 405 with Allow: GET header', async () => {
      const res = await request(app)
        .delete(`/api/inventory-movements/${MOV1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(405);
      expect(res.headers['allow']).toBe('GET');
      expect((res.body as ErrorBody).error).toBe('METHOD_NOT_ALLOWED');
    });

    // Route ordering guard: verify GET /:id still works after router.all('/:id') is registered
    it('GET /:id still accessible after router.all catch-all — 200 expected', async () => {
      const res = await request(app)
        .get(`/api/inventory-movements/${MOV1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
    });
  });

  // ── 4.3: Rollback / Concurrency smoke cases ───────────────────────────────────

  describe('4.3 — Rollback and concurrency', () => {
    // Insufficient stock atomicity: pre-check triggers, stock unchanged, no movement inserted.
    it('Insufficient stock — stock unchanged and no movement row inserted (atomicity)', async () => {
      const stockBefore = productStore.get(PROD2_ID)?.stock ?? 0;
      const movementsBefore = [...movementStore.values()].filter(
        (m) => m.productId === PROD2_ID,
      ).length;

      // Attempt OUT that would require stock=10, but only 2 available.
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD2_ID, type: 'OUT', quantity: 10, reason: 'Overdrawn' });

      const stockAfter = productStore.get(PROD2_ID)?.stock ?? 0;
      const movementsAfter = [...movementStore.values()].filter(
        (m) => m.productId === PROD2_ID,
      ).length;

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toBe('INSUFFICIENT_STOCK');
      // Atomicity assertions.
      expect(stockAfter).toBe(stockBefore);
      expect(movementsAfter).toBe(movementsBefore);
    });

    // Concurrency retry-loss: force updateMany to return { count: 0 } twice.
    // The service should exhaust its 2 retries and return 409 STOCK_CONCURRENCY_CONFLICT.
    // No movement row should be inserted.
    it('CAS miss twice — 409 STOCK_CONCURRENCY_CONFLICT, no movement inserted', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const mod = (await import('../../src/shared/utils/prisma.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const mockTx = mod.prisma._mockTx;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method
      const mockTxProductUpdateMany = vi.mocked(mockTx.product.updateMany);

      const movementsBefore = movementStore.size;

      // Override: updateMany always returns count=0 (simulates perpetual race).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      mockTxProductUpdateMany.mockResolvedValue({ count: 0 });

      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'OUT', quantity: 1, reason: 'Race test' });

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toBe('STOCK_CONCURRENCY_CONFLICT');
      // No movement was inserted.
      expect(movementStore.size).toBe(movementsBefore);
    });

    // Insert failure rollback: force tx.inventoryMovement.create to throw after updateMany succeeds.
    // Verifies the transaction rolls back: stock should return to its pre-tx value.
    // NOTE: This test uses in-process state to verify the $transaction boundary.
    //   The mock $transaction calls the callback directly (no real DB isolation),
    //   so we simulate rollback by checking the stock was NOT persisted in the store
    //   when create throws. Because our mock $transaction does not actually roll back
    //   the updateMany that already ran, we assert behavior at the mock level only:
    //   the service must propagate the create error and not return 201.
    it('Insert failure after stock update — service propagates error (not 201)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const mod = (await import('../../src/shared/utils/prisma.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const mockTx = mod.prisma._mockTx;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/unbound-method
      const mockTxMovementCreate = vi.mocked(mockTx.inventoryMovement.create);

      // Force movement.create to throw (simulates DB constraint failure mid-transaction).
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      mockTxMovementCreate.mockRejectedValueOnce(new Error('Simulated insert failure'));

      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD1_ID, type: 'OUT', quantity: 1, reason: 'Rollback test' });

      // The service must not return 201 — it must surface the error.
      expect(res.status).not.toBe(201);
      // No movement DTO was returned.
      expect((res.body as Record<string, unknown>).movement).toBeUndefined();
    });
  });
});
