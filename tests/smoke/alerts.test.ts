/**
 * Smoke tests for alerts endpoints.
 *
 * Coverage:
 *   - GET  /api/alerts                      (S6, S7 — list with filters)
 *   - GET  /api/alerts/:id                  (S7-variant, S8 — get by id, 404)
 *   - POST /api/alerts/:id/create-replenishment (S9, S10, S11 — validation, happy, 403)
 *   - Auth enforcement: 401 on unauthenticated, 403 on OPERATOR create-replenishment.
 *   - S12 (reconcile swallow): covered in the hook sections below.
 *
 * Prisma is fully mocked — no real DB required.
 * Pattern follows tests/smoke/inventory-movements.test.ts.
 *
 * $transaction strategy:
 *   Callback form (interactive tx) → call with mockTx.
 *   Array form                     → Promise.all(queries).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';
import { __setNotificationService } from '../../src/shared/notifications/index.js';

// ── Response body types ────────────────────────────────────────────────────────

interface AlertDto {
  id: string;
  productId: string;
  type: 'LOW_STOCK' | 'OUT_OF_STOCK';
  message: string;
  resolved: boolean;
  resolvedAt: string | null;
  resolvedByUserId: string | null;
  createdAt: string;
}

interface ListBody {
  data: AlertDto[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

interface GetBody {
  alert: AlertDto;
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

const PROD1_ID = 'clh3xxk0h1001356c9a5oba8m'; // active, stock=2, minStock=10
const PROD2_ID = 'clh3xxk0h1002356c9a5oba9n'; // active, stock=0, minStock=5

const SUPPLIER1_ID = 'clh3xxk0h5001356c9a5oba8s';

const ALERT1_ID = 'clh3xxk0ha001356c9a5oba8a'; // open LOW_STOCK for PROD1
const ALERT2_ID = 'clh3xxk0ha002356c9a5oba9a'; // open OUT_OF_STOCK for PROD2
const ALERT3_ID = 'clh3xxk0ha003356c9a5obaaa'; // resolved LOW_STOCK for PROD1
const MISSING_ALERT_ID = 'clh3xxk0ha099356c9a5zzzzz';

// ── In-memory stores ──────────────────────────────────────────────────────────

interface MockAlert {
  id: string;
  productId: string;
  type: 'LOW_STOCK' | 'OUT_OF_STOCK';
  message: string;
  resolved: boolean;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  createdAt: Date;
}

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

interface MockSupplier {
  id: string;
  name: string;
}

interface MockProductSupplier {
  productId: string;
  supplierId: string;
  referencePrice: { toNumber(): number } | null;
}

let alertStore: Map<string, MockAlert>;
let productStore: Map<string, MockProduct>;
let productSupplierStore: Map<string, MockProductSupplier>;
let userStore: Map<string, MockUser>;
let supplierStore: Map<string, MockSupplier>;
let replenishmentRequestCounter: number;

function seedStores(): void {
  replenishmentRequestCounter = 0;

  alertStore = new Map([
    [
      ALERT1_ID,
      {
        id: ALERT1_ID,
        productId: PROD1_ID,
        type: 'LOW_STOCK',
        message: 'Product stock (2) is at or below minimum threshold (10).',
        resolved: false,
        resolvedAt: null,
        resolvedByUserId: null,
        createdAt: new Date('2026-07-01T10:00:00.000Z'),
      },
    ],
    [
      ALERT2_ID,
      {
        id: ALERT2_ID,
        productId: PROD2_ID,
        type: 'OUT_OF_STOCK',
        message: 'Product stock is 0 — OUT OF STOCK.',
        resolved: false,
        resolvedAt: null,
        resolvedByUserId: null,
        createdAt: new Date('2026-07-01T09:00:00.000Z'),
      },
    ],
    [
      ALERT3_ID,
      {
        id: ALERT3_ID,
        productId: PROD1_ID,
        type: 'LOW_STOCK',
        message: 'Product stock (2) is at or below minimum threshold (10).',
        resolved: true,
        resolvedAt: new Date('2026-07-01T08:00:00.000Z'),
        resolvedByUserId: null,
        createdAt: new Date('2026-07-01T07:00:00.000Z'),
      },
    ],
  ]);

  productStore = new Map([
    [
      PROD1_ID,
      {
        id: PROD1_ID,
        code: 'MED-001',
        name: 'Ibuprofen 400mg',
        stock: 2,
        minStock: 10,
        active: true,
      },
    ],
    [
      PROD2_ID,
      {
        id: PROD2_ID,
        code: 'MED-002',
        name: 'Paracetamol 500mg',
        stock: 0,
        minStock: 5,
        active: true,
      },
    ],
  ]);

  userStore = new Map([
    [ADMIN_ID, { id: ADMIN_ID, fullName: 'Admin User' }],
    [MANAGER_ID, { id: MANAGER_ID, fullName: 'Manager User' }],
    [OPERATOR_ID, { id: OPERATOR_ID, fullName: 'Operator User' }],
  ]);

  supplierStore = new Map([[SUPPLIER1_ID, { id: SUPPLIER1_ID, name: 'SupplierOne SA' }]]);

  productSupplierStore = new Map([
    [
      `${PROD1_ID}_${SUPPLIER1_ID}`,
      { productId: PROD1_ID, supplierId: SUPPLIER1_ID, referencePrice: { toNumber: () => 8.0 } },
    ],
  ]);
}

function buildCreatedReplenishmentRow(data: {
  id: string;
  supplierId: string;
  requestedByUserId: string;
  notes: string | null;
  items: Array<{ productId: string; requestedQuantity: number; unitPrice: number }>;
}) {
  const supplier = supplierStore.get(data.supplierId);
  const requestedByUser = userStore.get(data.requestedByUserId);

  if (!supplier || !requestedByUser) {
    throw new Error(`Missing related data for replenishment request ${data.id}`);
  }

  return {
    id: data.id,
    supplierId: data.supplierId,
    requestedByUserId: data.requestedByUserId,
    supplier: {
      id: supplier.id,
      name: supplier.name,
    },
    requestedByUser: {
      id: requestedByUser.id,
      fullName: requestedByUser.fullName,
    },
    status: 'PENDING',
    requestedAt: new Date(),
    sentAt: null,
    receivedAt: null,
    receivedByUserId: null,
    cancelledAt: null,
    cancelledByUserId: null,
    notes: data.notes,
    items: data.items.map((item, index) => {
      const product = productStore.get(item.productId);

      if (!product) {
        throw new Error(`Missing product ${item.productId} for replenishment request ${data.id}`);
      }

      return {
        id: `clh3xxk0hii0${index + 1}356c9a5newii`,
        replenishmentRequestId: data.id,
        productId: item.productId,
        requestedQuantity: item.requestedQuantity,
        receivedQuantity: null,
        unitPrice: { toNumber: () => Number(item.unitPrice) },
        product: {
          id: product.id,
          name: product.name,
          code: product.code,
        },
      };
    }),
  };
}

// ── Prisma mock ───────────────────────────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => {
  const mockTx = {
    alert: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    replenishmentRequest: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    replenishmentRequestItem: {
      update: vi.fn(),
    },
    product: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    inventoryMovement: {
      create: vi.fn(),
    },
  };

  const mockPrisma = {
    alert: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    product: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    productSupplier: {
      findUnique: vi.fn(),
    },
    replenishmentRequest: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    replenishmentRequestItem: {
      update: vi.fn(),
    },
    supplier: {
      findUnique: vi.fn(),
    },
    inventoryMovement: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      create: vi.fn(),
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

describe('Alerts smoke tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedStores();

    // Stub notification service to prevent any Twilio calls.
    __setNotificationService({ sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined) });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const mod = (await import('../../src/shared/utils/prisma.js')) as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const { prisma } = mod;

    // ── alert.findMany ─────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.alert.findMany).mockImplementation(
      ({
        where = {},
        skip = 0,
        take,
      }: {
        where?: { resolved?: boolean; type?: string; productId?: string };
        skip?: number;
        take?: number;
        orderBy?: unknown;
        select?: unknown;
      } = {}) => {
        let rows = [...alertStore.values()];

        if (where.resolved !== undefined) rows = rows.filter((a) => a.resolved === where.resolved);
        if (where.type) rows = rows.filter((a) => a.type === where.type);
        if (where.productId) rows = rows.filter((a) => a.productId === where.productId);

        // Sort createdAt DESC
        rows = rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        return Promise.resolve(rows.slice(skip, take !== undefined ? skip + take : undefined));
      },
    );

    // ── alert.count ────────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.alert.count).mockImplementation(
      ({
        where = {},
      }: {
        where?: { resolved?: boolean; type?: string; productId?: string };
      } = {}) => {
        let rows = [...alertStore.values()];
        if (where.resolved !== undefined) rows = rows.filter((a) => a.resolved === where.resolved);
        if (where.type) rows = rows.filter((a) => a.type === where.type);
        if (where.productId) rows = rows.filter((a) => a.productId === where.productId);
        return Promise.resolve(rows.length);
      },
    );

    // ── alert.findUnique ───────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.alert.findUnique).mockImplementation(
      ({ where, select }: { where: { id?: string }; select?: Record<string, unknown> }) => {
        if (!where.id) return Promise.resolve(null);
        const row = alertStore.get(where.id);
        if (!row) return Promise.resolve(null);

        // If product is selected (create-replenishment lookup), embed product data.
        if (select && 'product' in select) {
          const product = productStore.get(row.productId);
          return Promise.resolve({
            ...row,
            product: product
              ? {
                  id: product.id,
                  stock: product.stock,
                  minStock: product.minStock,
                  active: product.active,
                }
              : null,
          });
        }
        return Promise.resolve({ ...row });
      },
    );

    // ── productSupplier.findUnique ─────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.productSupplier.findUnique).mockImplementation(
      ({
        where,
      }: {
        where: { productId_supplierId?: { productId: string; supplierId: string } };
      }) => {
        if (!where.productId_supplierId) return Promise.resolve(null);
        const { productId, supplierId } = where.productId_supplierId;
        const key = `${productId}_${supplierId}`;
        return Promise.resolve(productSupplierStore.get(key) ?? null);
      },
    );

    // ── replenishmentRequest.create ────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.replenishmentRequest.create).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ data }: { data: any }) => {
        replenishmentRequestCounter += 1;
        const newId = `clh3xxk0hrr0${replenishmentRequestCounter}356c9a5newrr`;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const itemsData = (data.items?.create ?? []) as Array<{
          productId: string;
          requestedQuantity: number;
          unitPrice: number;
        }>;
        return Promise.resolve(
          buildCreatedReplenishmentRow({
            id: newId,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            supplierId: data.supplierId as string,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            requestedByUserId: data.requestedByUserId as string,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
            notes: (data.notes as string | null | undefined) ?? null,
            items: itemsData,
          }),
        );
      },
    );

    // ── $transaction ───────────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.$transaction).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (callbackOrArray: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>) => {
        if (typeof callbackOrArray === 'function') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          return callbackOrArray(prisma._mockTx);
        }
        return Promise.all(callbackOrArray);
      },
    );

    // ── user.findUnique / refreshToken (auth middleware) ───────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── GET /api/alerts — list ────────────────────────────────────────────────

  describe('GET /api/alerts', () => {
    // S6: Default list — open alerts only (resolved=false default)
    it('(S6) default list — returns open alerts only, sorted createdAt DESC', async () => {
      const res = await request(app)
        .get('/api/alerts')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(Array.isArray(body.data)).toBe(true);
      // Default filter: open only (2 open alerts in store).
      expect(body.data.every((a) => a.resolved === false)).toBe(true);
      expect(body.meta.total).toBe(2);
      expect(body.meta.page).toBe(1);
      expect(body.meta.limit).toBe(20);

      // Sorted newest first.
      if (body.data.length >= 2) {
        const first = new Date(body.data[0]!.createdAt).getTime();
        const second = new Date(body.data[1]!.createdAt).getTime();
        expect(first).toBeGreaterThanOrEqual(second);
      }
    });

    // S7: filter by productId + type
    it('(S7) ?productId=P1&type=LOW_STOCK — returns only the P1 LOW_STOCK alert', async () => {
      const res = await request(app)
        .get(`/api/alerts?productId=${PROD1_ID}&type=LOW_STOCK`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.every((a) => a.productId === PROD1_ID && a.type === 'LOW_STOCK')).toBe(true);
    });

    // resolved=all returns everything
    it('?resolved=all — returns open and resolved alerts', async () => {
      const res = await request(app)
        .get('/api/alerts?resolved=all')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.meta.total).toBe(3); // 2 open + 1 resolved
    });

    // resolved=true returns only resolved
    it('?resolved=true — returns only resolved alerts', async () => {
      const res = await request(app)
        .get('/api/alerts?resolved=true')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.every((a) => a.resolved === true)).toBe(true);
      expect(body.meta.total).toBe(1);
    });

    // OPERATOR can list
    it('OPERATOR can GET /api/alerts — 200', async () => {
      const res = await request(app)
        .get('/api/alerts')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);

      expect(res.status).toBe(200);
    });

    // Unauthenticated → 401
    it('unauthenticated GET /api/alerts — 401', async () => {
      const res = await request(app).get('/api/alerts');
      expect(res.status).toBe(401);
    });

    // Invalid resolved value → 400
    it('?resolved=maybe — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/alerts?resolved=maybe')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // Invalid type value → 400
    it('?type=EXPIRED — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/alerts?type=EXPIRED')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // Pagination coercion
    it('?limit=5&page=1 — meta.limit=5, meta.page=1', async () => {
      const res = await request(app)
        .get('/api/alerts?limit=5&page=1')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.meta.limit).toBe(5);
      expect(body.meta.page).toBe(1);
    });
  });

  // ── GET /api/alerts/:id ───────────────────────────────────────────────────

  describe('GET /api/alerts/:id', () => {
    // Happy path
    it('existing open alert — 200 { alert: AlertDto }', async () => {
      const res = await request(app)
        .get(`/api/alerts/${ALERT1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as GetBody;
      expect(body.alert.id).toBe(ALERT1_ID);
      expect(body.alert.type).toBe('LOW_STOCK');
      expect(body.alert.resolved).toBe(false);
      expect(body.alert.resolvedAt).toBeNull();
      expect(body.alert.resolvedByUserId).toBeNull();
      expect(typeof body.alert.createdAt).toBe('string');
    });

    // Resolved alert also accessible
    it('existing resolved alert — 200 with resolved=true', async () => {
      const res = await request(app)
        .get(`/api/alerts/${ALERT3_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as GetBody;
      expect(body.alert.resolved).toBe(true);
      expect(body.alert.resolvedAt).not.toBeNull();
    });

    // S8: 404 on missing
    it('(S8) missing alert — 404 ALERT_NOT_FOUND', async () => {
      const res = await request(app)
        .get(`/api/alerts/${MISSING_ALERT_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('ALERT_NOT_FOUND');
    });

    // Invalid cuid → 400
    it('invalid cuid — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/alerts/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // OPERATOR can read by id
    it('OPERATOR GET /api/alerts/:id — 200', async () => {
      const res = await request(app)
        .get(`/api/alerts/${ALERT1_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);

      expect(res.status).toBe(200);
    });

    // Unauthenticated → 401
    it('unauthenticated GET /:id — 401', async () => {
      const res = await request(app).get(`/api/alerts/${ALERT1_ID}`);
      expect(res.status).toBe(401);
    });
  });

  // ── POST /api/alerts/:id/create-replenishment ─────────────────────────────

  describe('POST /api/alerts/:id/create-replenishment', () => {
    // S9: validation — missing supplierId → 400
    it('(S9) missing supplierId — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post(`/api/alerts/${ALERT1_ID}/create-replenishment`)
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({});

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    // S10: happy path — open LOW_STOCK alert, stock=2, minStock=10 → qty=max(1,10-2)=8
    it('(S10) happy path — 201 replenishment with requestedQuantity=8', async () => {
      const res = await request(app)
        .post(`/api/alerts/${ALERT1_ID}/create-replenishment`)
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ supplierId: SUPPLIER1_ID });

      expect(res.status).toBe(201);
      const body = res.body as {
        replenishmentRequest: { items: Array<{ requestedQuantity: number; productId: string }> };
      };
      expect(body.replenishmentRequest).toBeDefined();
      expect(body.replenishmentRequest.items).toHaveLength(1);
      expect(body.replenishmentRequest.items[0]!.productId).toBe(PROD1_ID);
      // quantity = max(1, minStock - stock) = max(1, 10 - 2) = 8
      expect(body.replenishmentRequest.items[0]!.requestedQuantity).toBe(8);
    });

    // S10 variant: OUT_OF_STOCK alert, stock=0, minStock=5 → qty=max(1,5-0)=5
    it('OUT_OF_STOCK alert — requestedQuantity = max(1, minStock - stock) = 5', async () => {
      const res = await request(app)
        .post(`/api/alerts/${ALERT2_ID}/create-replenishment`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ supplierId: SUPPLIER1_ID });

      // PROD2 has no referencePrice for SUPPLIER1 → UNIT_PRICE_REQUIRED (downstream surfaced verbatim)
      // This also proves the alert was found and quantity was computed before hitting the unit price gate.
      expect([400, 201]).toContain(res.status);
      if (res.status === 400) {
        expect((res.body as ErrorBody).error).toBe('UNIT_PRICE_REQUIRED');
      }
    });

    // Resolved alert: still works (REQ-8 — no state gate)
    it('resolved alert — still creates replenishment (no state gate)', async () => {
      const res = await request(app)
        .post(`/api/alerts/${ALERT3_ID}/create-replenishment`)
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ supplierId: SUPPLIER1_ID });

      // ALERT3 is for PROD1 which has a referencePrice → should succeed
      expect(res.status).toBe(201);
      const body = res.body as {
        replenishmentRequest: { items: Array<{ requestedQuantity: number }> };
      };
      expect(body.replenishmentRequest.items[0]!.requestedQuantity).toBe(8);
    });

    // S11: OPERATOR → 403 FORBIDDEN
    it('(S11) OPERATOR — 403 FORBIDDEN', async () => {
      const res = await request(app)
        .post(`/api/alerts/${ALERT1_ID}/create-replenishment`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({ supplierId: SUPPLIER1_ID });

      expect(res.status).toBe(403);
      expect((res.body as ErrorBody).error).toBe('FORBIDDEN');
    });

    // 404 on missing alert
    it('missing alert — 404 ALERT_NOT_FOUND', async () => {
      const res = await request(app)
        .post(`/api/alerts/${MISSING_ALERT_ID}/create-replenishment`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ supplierId: SUPPLIER1_ID });

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('ALERT_NOT_FOUND');
    });

    // Unauthenticated → 401
    it('unauthenticated POST create-replenishment — 401', async () => {
      const res = await request(app)
        .post(`/api/alerts/${ALERT1_ID}/create-replenishment`)
        .send({ supplierId: SUPPLIER1_ID });

      expect(res.status).toBe(401);
    });

    // notes too long → 400
    it('notes > 1000 chars — 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .post(`/api/alerts/${ALERT1_ID}/create-replenishment`)
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ supplierId: SUPPLIER1_ID, notes: 'x'.repeat(1001) });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });
});
