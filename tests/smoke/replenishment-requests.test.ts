/**
 * Smoke tests for replenishment-requests endpoints (Phase 1 — read side).
 *
 * Coverage:
 *   - POST   /api/replenishment-requests          (create: success, fallback, no price, empty items, role)
 *   - GET    /api/replenishment-requests          (list with filters, pagination)
 *   - GET    /api/replenishment-requests/:id      (get by id: found, 404)
 *   - GET    /api/suppliers/:supplierId/replenishment-requests  (supplier-scoped list)
 *
 * Prisma is fully mocked — no real DB required.
 * Follows the mocked-Prisma pattern from tests/smoke/inventory-movements.test.ts.
 *
 * $transaction strategy:
 *   Callback form (interactive tx) → call with mockTx.
 *   Array form (batch/parallel)    → Promise.all(queries).
 *
 * NotificationService is stubbed via __setNotificationService to prevent any
 * real Twilio calls (fire-and-forget in send/cancel — not exercised here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';
import { __setNotificationService } from '../../src/shared/notifications/index.js';

// ── Response body types ────────────────────────────────────────────────────────

interface RequestDto {
  id: string;
  supplierId: string;
  requestedByUserId: string;
  status: 'PENDING' | 'SENT' | 'RECEIVED' | 'CANCELLED';
  requestedAt: string;
  sentAt: string | null;
  receivedAt: string | null;
  receivedByUserId: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  notes: string | null;
}

interface RequestItemDto {
  id: string;
  productId: string;
  requestedQuantity: number;
  receivedQuantity: number | null;
  unitPrice: number;
}

interface RequestWithItemsDto extends RequestDto {
  items: RequestItemDto[];
}

interface CreateBody {
  request: RequestWithItemsDto;
}

interface GetBody {
  request: RequestWithItemsDto;
}

interface ListBody {
  data: RequestDto[];
  meta: {
    page: number;
    pageSize: number;
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

const SUPPLIER1_ID = 'clh3xxk0h5001356c9a5oba8s';
const SUPPLIER2_ID = 'clh3xxk0h5002356c9a5oba9t';

const PROD1_ID = 'clh3xxk0h1001356c9a5oba8m';
const PROD2_ID = 'clh3xxk0h1002356c9a5oba9n';

const REQ1_ID = 'clh3xxk0h8001356c9a5oba8r';
const REQ2_ID = 'clh3xxk0h8002356c9a5oba9r';
const MISSING_REQ_ID = 'clh3xxk0h8099356c9a5zzzzz';

const ITEM1_ID = 'clh3xxk0h9001356c9a5oba8i';
const ITEM2_ID = 'clh3xxk0h9002356c9a5oba9i';

// ── In-memory stores ──────────────────────────────────────────────────────────

interface MockRequest {
  id: string;
  supplierId: string;
  requestedByUserId: string;
  status: 'PENDING' | 'SENT' | 'RECEIVED' | 'CANCELLED';
  requestedAt: Date;
  sentAt: Date | null;
  receivedAt: Date | null;
  receivedByUserId: string | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  notes: string | null;
}

interface MockItem {
  id: string;
  replenishmentRequestId: string;
  productId: string;
  requestedQuantity: number;
  receivedQuantity: number | null;
  unitPrice: { toNumber(): number };
}

interface MockProductSupplier {
  productId: string;
  supplierId: string;
  referencePrice: { toNumber(): number } | null;
}

let requestStore: Map<string, MockRequest>;
let itemStore: Map<string, MockItem>;
let productSupplierStore: Map<string, MockProductSupplier>;
let requestCounter: number;
let itemCounter: number;

function seedStores(): void {
  requestCounter = 0;
  itemCounter = 0;

  requestStore = new Map([
    [
      REQ1_ID,
      {
        id: REQ1_ID,
        supplierId: SUPPLIER1_ID,
        requestedByUserId: MANAGER_ID,
        status: 'PENDING',
        requestedAt: new Date('2026-07-01T10:00:00.000Z'),
        sentAt: null,
        receivedAt: null,
        receivedByUserId: null,
        cancelledAt: null,
        cancelledByUserId: null,
        notes: 'First order',
      },
    ],
    [
      REQ2_ID,
      {
        id: REQ2_ID,
        supplierId: SUPPLIER2_ID,
        requestedByUserId: ADMIN_ID,
        status: 'SENT',
        requestedAt: new Date('2026-07-02T08:00:00.000Z'),
        sentAt: new Date('2026-07-02T09:00:00.000Z'),
        receivedAt: null,
        receivedByUserId: null,
        cancelledAt: null,
        cancelledByUserId: null,
        notes: null,
      },
    ],
  ]);

  itemStore = new Map([
    [
      ITEM1_ID,
      {
        id: ITEM1_ID,
        replenishmentRequestId: REQ1_ID,
        productId: PROD1_ID,
        requestedQuantity: 10,
        receivedQuantity: null,
        unitPrice: { toNumber: () => 5.5 },
      },
    ],
    [
      ITEM2_ID,
      {
        id: ITEM2_ID,
        replenishmentRequestId: REQ2_ID,
        productId: PROD2_ID,
        requestedQuantity: 20,
        receivedQuantity: null,
        unitPrice: { toNumber: () => 12.0 },
      },
    ],
  ]);

  productSupplierStore = new Map([
    // SUPPLIER1 + PROD1 → referencePrice 8.00
    [
      `${PROD1_ID}_${SUPPLIER1_ID}`,
      { productId: PROD1_ID, supplierId: SUPPLIER1_ID, referencePrice: { toNumber: () => 8.0 } },
    ],
    // SUPPLIER1 + PROD2 → no referencePrice (null)
    [
      `${PROD2_ID}_${SUPPLIER1_ID}`,
      { productId: PROD2_ID, supplierId: SUPPLIER1_ID, referencePrice: null },
    ],
  ]);
}

// ── Prisma mock ───────────────────────────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => {
  const mockTx = {
    replenishmentRequest: {
      create: vi.fn(),
      updateMany: vi.fn(),
    },
    replenishmentRequestItem: {
      update: vi.fn(),
    },
    inventoryMovement: {
      create: vi.fn(),
    },
    product: {
      updateMany: vi.fn(),
    },
  };

  const mockPrisma = {
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
    productSupplier: {
      findUnique: vi.fn(),
    },
    product: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
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

describe('Replenishment Requests smoke tests (Phase 1 — read side)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedStores();

    // Stub the notification service so no real Twilio calls happen.
    __setNotificationService({ sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined) });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const mod = (await import('../../src/shared/utils/prisma.js')) as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const { prisma } = mod;

    // ── productSupplier.findUnique ──────────────────────────────────────────
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
        const row = productSupplierStore.get(key);
        return Promise.resolve(row ?? null);
      },
    );

    // ── replenishmentRequest.create ─────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.replenishmentRequest.create).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ data }: { data: any; select?: any }) => {
        requestCounter += 1;
        const newId = `clh3xxk0h800${requestCounter}356c9a5newrr`;

        const newRequest: MockRequest = {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          id: newId,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          supplierId: data.supplierId as string,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          requestedByUserId: data.requestedByUserId as string,
          status: 'PENDING',
          requestedAt: new Date(),
          sentAt: null,
          receivedAt: null,
          receivedByUserId: null,
          cancelledAt: null,
          cancelledByUserId: null,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          notes: (data.notes as string | null | undefined) ?? null,
        };
        requestStore.set(newId, newRequest);

        // Build items from nested create data
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        const itemsData = (data.items?.create ?? []) as Array<{
          productId: string;
          requestedQuantity: number;
          unitPrice: number;
        }>;

        const newItems: MockItem[] = itemsData.map((itemData) => {
          itemCounter += 1;
          const itemId = `clh3xxk0h900${itemCounter}356c9a5newii`;
          const item: MockItem = {
            id: itemId,
            replenishmentRequestId: newId,
            productId: itemData.productId,
            requestedQuantity: itemData.requestedQuantity,
            receivedQuantity: null,
            unitPrice: { toNumber: () => Number(itemData.unitPrice) },
          };
          itemStore.set(itemId, item);
          return item;
        });

        // Return shape matching REQUEST_WITH_ITEMS_SELECT
        return Promise.resolve({
          ...newRequest,
          items: newItems,
        });
      },
    );

    // ── replenishmentRequest.findUnique ─────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.replenishmentRequest.findUnique).mockImplementation(
      ({ where, select }: { where: { id?: string }; select?: Record<string, unknown> }) => {
        if (!where.id) return Promise.resolve(null);
        const row = requestStore.get(where.id);
        if (!row) return Promise.resolve(null);

        // Check if items are requested in select
        const needsItems = select && 'items' in select;
        if (needsItems) {
          const items = [...itemStore.values()].filter((i) => i.replenishmentRequestId === row.id);
          return Promise.resolve({ ...row, items });
        }
        return Promise.resolve({ ...row });
      },
    );

    // ── replenishmentRequest.findMany ───────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.replenishmentRequest.findMany).mockImplementation(
      ({
        where = {},
        skip = 0,
        take,
      }: {
        where?: {
          status?: string;
          supplierId?: string;
          requestedAt?: { gte?: Date; lte?: Date };
        };
        skip?: number;
        take?: number;
        orderBy?: unknown;
        select?: unknown;
      } = {}) => {
        let rows = [...requestStore.values()];

        if (where.status) rows = rows.filter((r) => r.status === where.status);
        if (where.supplierId) rows = rows.filter((r) => r.supplierId === where.supplierId);
        if (where.requestedAt?.gte) {
          rows = rows.filter((r) => r.requestedAt >= where.requestedAt!.gte!);
        }
        if (where.requestedAt?.lte) {
          rows = rows.filter((r) => r.requestedAt <= where.requestedAt!.lte!);
        }

        // Sort requestedAt DESC
        rows = rows.sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
        return Promise.resolve(rows.slice(skip, take !== undefined ? skip + take : undefined));
      },
    );

    // ── replenishmentRequest.count ──────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.replenishmentRequest.count).mockImplementation(
      ({
        where = {},
      }: {
        where?: {
          status?: string;
          supplierId?: string;
          requestedAt?: { gte?: Date; lte?: Date };
        };
      } = {}) => {
        let rows = [...requestStore.values()];
        if (where.status) rows = rows.filter((r) => r.status === where.status);
        if (where.supplierId) rows = rows.filter((r) => r.supplierId === where.supplierId);
        if (where.requestedAt?.gte) {
          rows = rows.filter((r) => r.requestedAt >= where.requestedAt!.gte!);
        }
        if (where.requestedAt?.lte) {
          rows = rows.filter((r) => r.requestedAt <= where.requestedAt!.lte!);
        }
        return Promise.resolve(rows.length);
      },
    );

    // ── $transaction ────────────────────────────────────────────────────────
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

    // ── user.findUnique (required by authenticate middleware) ───────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    // ── refreshToken mocks (required by auth middleware) ────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Create request ─────────────────────────────────────────────────────────

  describe('POST /api/replenishment-requests', () => {
    it('(C1) MANAGER creates request with explicit unitPrice → 201 PENDING', async () => {
      const res = await request(app)
        .post('/api/replenishment-requests')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({
          supplierId: SUPPLIER1_ID,
          items: [{ productId: PROD1_ID, requestedQuantity: 5, unitPrice: 15.0 }],
        });

      expect(res.status).toBe(201);
      const body = res.body as CreateBody;
      expect(body.request.status).toBe('PENDING');
      expect(body.request.supplierId).toBe(SUPPLIER1_ID);
      expect(body.request.items).toHaveLength(1);
      expect(body.request.items[0]!.unitPrice).toBe(15.0);
      expect(body.request.receivedAt).toBeNull();
      expect(body.request.cancelledAt).toBeNull();
    });

    it('(C2) Create with referencePrice fallback → 201, stored unitPrice equals referencePrice', async () => {
      // SUPPLIER1 + PROD1 has referencePrice = 8.0
      const res = await request(app)
        .post('/api/replenishment-requests')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({
          supplierId: SUPPLIER1_ID,
          items: [{ productId: PROD1_ID, requestedQuantity: 3 }], // no unitPrice
        });

      expect(res.status).toBe(201);
      const body = res.body as CreateBody;
      expect(body.request.items[0]!.unitPrice).toBe(8.0);
    });

    it('(C3) Create without unitPrice and no referencePrice → 400 UNIT_PRICE_REQUIRED', async () => {
      // SUPPLIER1 + PROD2 has no referencePrice
      const res = await request(app)
        .post('/api/replenishment-requests')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({
          supplierId: SUPPLIER1_ID,
          items: [{ productId: PROD2_ID, requestedQuantity: 2 }], // no unitPrice, no referencePrice
        });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('UNIT_PRICE_REQUIRED');
    });

    it('(C4) Create with empty items → 400 REPLENISHMENT_ITEMS_REQUIRED', async () => {
      const res = await request(app)
        .post('/api/replenishment-requests')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({
          supplierId: SUPPLIER1_ID,
          items: [],
        });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('REPLENISHMENT_ITEMS_REQUIRED');
    });

    it('(C5) OPERATOR POSTs create → 403 FORBIDDEN', async () => {
      const res = await request(app)
        .post('/api/replenishment-requests')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({
          supplierId: SUPPLIER1_ID,
          items: [{ productId: PROD1_ID, requestedQuantity: 1, unitPrice: 5.0 }],
        });

      expect(res.status).toBe(403);
    });

    it('(C6) Unauthenticated POST → 401', async () => {
      const res = await request(app)
        .post('/api/replenishment-requests')
        .send({
          supplierId: SUPPLIER1_ID,
          items: [{ productId: PROD1_ID, requestedQuantity: 1, unitPrice: 5.0 }],
        });

      expect(res.status).toBe(401);
    });

    it('(C7) ADMIN creates request → 201', async () => {
      const res = await request(app)
        .post('/api/replenishment-requests')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({
          supplierId: SUPPLIER1_ID,
          items: [{ productId: PROD1_ID, requestedQuantity: 10, unitPrice: 20.0 }],
          notes: 'Admin test order',
        });

      expect(res.status).toBe(201);
      const body = res.body as CreateBody;
      expect(body.request.requestedByUserId).toBe(ADMIN_ID);
      expect(body.request.notes).toBe('Admin test order');
    });
  });

  // ── List requests ──────────────────────────────────────────────────────────

  describe('GET /api/replenishment-requests', () => {
    it('(L1) Default list → 200 with data array and meta (pageSize default=20)', async () => {
      const res = await request(app)
        .get('/api/replenishment-requests')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.meta.pageSize).toBe(20);
      expect(body.meta.page).toBe(1);
      expect(typeof body.meta.total).toBe('number');
      expect(typeof body.meta.totalPages).toBe('number');
    });

    it('(L2) Filter by status=PENDING → only PENDING requests', async () => {
      const res = await request(app)
        .get('/api/replenishment-requests?status=PENDING')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.every((r) => r.status === 'PENDING')).toBe(true);
    });

    it('(L3) Filter by supplierId → only that supplier', async () => {
      const res = await request(app)
        .get(`/api/replenishment-requests?supplierId=${SUPPLIER1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.every((r) => r.supplierId === SUPPLIER1_ID)).toBe(true);
    });

    it('(L4) Filter by dateFrom/dateTo range → returns matching requests', async () => {
      const res = await request(app)
        .get('/api/replenishment-requests?dateFrom=2026-07-01&dateTo=2026-07-02')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      expect((res.body as ListBody).data.length).toBeGreaterThan(0);
    });

    it('(L5) page=1&pageSize=1 → meta.pageSize=1, meta.page=1', async () => {
      const res = await request(app)
        .get('/api/replenishment-requests?page=1&pageSize=1')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.meta.pageSize).toBe(1);
      expect(body.meta.page).toBe(1);
      expect(body.data.length).toBeLessThanOrEqual(1);
    });

    it('(L6) OPERATOR can list → 200', async () => {
      const res = await request(app)
        .get('/api/replenishment-requests')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);

      expect(res.status).toBe(200);
    });

    it('(L7) Unauthenticated list → 401', async () => {
      const res = await request(app).get('/api/replenishment-requests');
      expect(res.status).toBe(401);
    });

    it('(L8) Combined status + supplierId filter → AND-combined', async () => {
      const res = await request(app)
        .get(`/api/replenishment-requests?status=PENDING&supplierId=${SUPPLIER1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.every((r) => r.status === 'PENDING' && r.supplierId === SUPPLIER1_ID)).toBe(
        true,
      );
    });

    it('(L9) Invalid status value → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/replenishment-requests?status=INVALID')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });

  // ── Get by id ──────────────────────────────────────────────────────────────

  describe('GET /api/replenishment-requests/:id', () => {
    it('(G1) Existing request → 200 with embedded items', async () => {
      const res = await request(app)
        .get(`/api/replenishment-requests/${REQ1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as GetBody;
      expect(body.request.id).toBe(REQ1_ID);
      expect(Array.isArray(body.request.items)).toBe(true);
      expect(body.request.items.length).toBeGreaterThan(0);
      expect(body.request.items[0]!.productId).toBe(PROD1_ID);
    });

    it('(G2) Missing request → 404 REPLENISHMENT_REQUEST_NOT_FOUND', async () => {
      const res = await request(app)
        .get(`/api/replenishment-requests/${MISSING_REQ_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('REPLENISHMENT_REQUEST_NOT_FOUND');
    });

    it('(G3) Invalid cuid format → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/replenishment-requests/not-a-valid-cuid')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });

    it('(G4) OPERATOR can get by id → 200', async () => {
      const res = await request(app)
        .get(`/api/replenishment-requests/${REQ1_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);

      expect(res.status).toBe(200);
    });

    it('(G5) Unauthenticated get → 401', async () => {
      const res = await request(app).get(`/api/replenishment-requests/${REQ1_ID}`);
      expect(res.status).toBe(401);
    });
  });

  // ── Supplier-scoped list ───────────────────────────────────────────────────

  describe('GET /api/suppliers/:supplierId/replenishment-requests', () => {
    it('(S1) Returns only requests for that supplier → 200', async () => {
      const res = await request(app)
        .get(`/api/suppliers/${SUPPLIER1_ID}/replenishment-requests`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data.every((r) => r.supplierId === SUPPLIER1_ID)).toBe(true);
      expect(body.meta.pageSize).toBe(20);
    });

    it('(S2) Different supplierId → filtered correctly', async () => {
      const res = await request(app)
        .get(`/api/suppliers/${SUPPLIER2_ID}/replenishment-requests`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.data.every((r) => r.supplierId === SUPPLIER2_ID)).toBe(true);
    });

    it('(S3) Pagination params work on supplier-scoped list', async () => {
      const res = await request(app)
        .get(`/api/suppliers/${SUPPLIER1_ID}/replenishment-requests?page=1&pageSize=5`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.meta.pageSize).toBe(5);
      expect(body.meta.page).toBe(1);
    });

    it('(S4) OPERATOR can access supplier-scoped list → 200', async () => {
      const res = await request(app)
        .get(`/api/suppliers/${SUPPLIER1_ID}/replenishment-requests`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);

      expect(res.status).toBe(200);
    });

    it('(S5) Unauthenticated supplier-scoped list → 401', async () => {
      const res = await request(app).get(`/api/suppliers/${SUPPLIER1_ID}/replenishment-requests`);
      expect(res.status).toBe(401);
    });

    it('(S6) Invalid supplierId cuid → 400 VALIDATION_ERROR', async () => {
      const res = await request(app)
        .get('/api/suppliers/not-a-valid-cuid/replenishment-requests')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
    });
  });
});
