/**
 * Smoke tests for alert reconcile hook behavior.
 *
 * Coverage:
 *   - S1:  createMovement drops stock from >minStock to 0<stock<=minStock → LOW_STOCK created.
 *   - S2:  createMovement drops stock to 0 with existing LOW_STOCK → LOW_STOCK closed + OUT_OF_STOCK created.
 *   - S3:  createMovement raises stock from 0 to 0<stock<=minStock → OUT_OF_STOCK closed + LOW_STOCK created.
 *   - S4:  createMovement raises stock above minStock → open alert auto-resolved.
 *   - S5:  replenishmentRequestsService.receive() triggers reconcile per item.
 *   - S12: reconcile failure inside tx does NOT rollback the movement (swallow-and-log).
 *
 * Strategy:
 *   Each test controls alert.findFirst / alert.create / alert.update on the mockTx
 *   to simulate the reconcile state machine. The tx client must expose all three
 *   alert methods plus product.findUnique/updateMany and inventoryMovement.create.
 *
 *   For S5, the replenishment receive() flow is driven through the HTTP layer
 *   (POST /api/replenishment-requests/:id/receive) so it uses the full mock stack.
 *
 * Prisma is fully mocked — no real DB required.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';
import { __setNotificationService } from '../../src/shared/notifications/index.js';

// ── Response body types ────────────────────────────────────────────────────────

interface MovementBody {
  movement: {
    id: string;
    productId: string;
    type: string;
    resultingStock: number;
  };
}

interface _ErrorBody {
  error: string;
  message: string;
  statusCode: number;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const ADMIN_ID = 'clh3xxk0h0000356c9a5oba7k';
const MANAGER_ID = 'cjld2cjxh0000qzrmn831i7rn';

// Products — each designed for a specific scenario
const PROD_S1_ID = 'clh3xxk0hh001356c9a5obs1a'; // stock=10, minStock=5 → OUT movement of 6 → nextStock=4
const PROD_S2_ID = 'clh3xxk0hh002356c9a5obs2a'; // stock=3, minStock=5, open LOW_STOCK → OUT of 3 → nextStock=0
const PROD_S3_ID = 'clh3xxk0hh003356c9a5obs3a'; // stock=0, minStock=5, open OUT_OF_STOCK → IN of 3 → nextStock=3
const PROD_S4_ID = 'clh3xxk0hh004356c9a5obs4a'; // stock=2, minStock=5, open LOW_STOCK → IN of 10 → nextStock=12
const PROD_S12_ID = 'clh3xxk0hh012356c9a5obs12'; // stock=10, minStock=5 → reconcile throws

const ALERT_OPEN_LOW_ID = 'clh3xxk0haa01356c9a5low00';
const ALERT_OPEN_OUT_ID = 'clh3xxk0haa02356c9a5out00';

const SUPPLIER1_ID = 'clh3xxk0h5001356c9a5oba8s';
const REQ_S5_ID = 'clh3xxk0h8s05356c9a5obs5r'; // SENT request for S5
const ITEM_S5_ID = 'clh3xxk0h9s05356c9a5obs5i'; // item: PROD_S5, qty=8
const PROD_S5_ID = 'clh3xxk0hh005356c9a5obs5a'; // stock=0, minStock=5, open OUT_OF_STOCK → IN of 8 → nextStock=8>minStock

// ── In-memory stores ──────────────────────────────────────────────────────────

interface MockProduct {
  id: string;
  stock: number;
  minStock: number;
  active: boolean;
}

// Track what reconcile operations were called on the tx
interface AlertTxCall {
  operation: 'findFirst' | 'create' | 'update';
  args: unknown;
}

let productStore: Map<string, MockProduct>;
let alertTxCalls: AlertTxCall[];
let movementCounter: number;

// Tracks state per product: the "current open alert" for findFirst to return
let openAlertState: Map<string, { id: string; type: 'LOW_STOCK' | 'OUT_OF_STOCK' } | null>;

// ── Replenishment stores for S5 ───────────────────────────────────────────────

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

let requestStore: Map<string, MockRequest>;
let itemStore: Map<string, MockItem>;

function seedStores(): void {
  movementCounter = 0;
  alertTxCalls = [];

  openAlertState = new Map([
    [PROD_S1_ID, null], // S1: no open alert initially
    [PROD_S2_ID, { id: ALERT_OPEN_LOW_ID, type: 'LOW_STOCK' }], // S2: LOW_STOCK open
    [PROD_S3_ID, { id: ALERT_OPEN_OUT_ID, type: 'OUT_OF_STOCK' }], // S3: OUT_OF_STOCK open
    [PROD_S4_ID, { id: ALERT_OPEN_LOW_ID, type: 'LOW_STOCK' }], // S4: LOW_STOCK open
    [PROD_S12_ID, null], // S12: will throw in reconcile
    [PROD_S5_ID, { id: ALERT_OPEN_OUT_ID, type: 'OUT_OF_STOCK' }], // S5: OUT_OF_STOCK open
  ]);

  productStore = new Map([
    [PROD_S1_ID, { id: PROD_S1_ID, stock: 10, minStock: 5, active: true }],
    [PROD_S2_ID, { id: PROD_S2_ID, stock: 3, minStock: 5, active: true }],
    [PROD_S3_ID, { id: PROD_S3_ID, stock: 0, minStock: 5, active: true }],
    [PROD_S4_ID, { id: PROD_S4_ID, stock: 2, minStock: 5, active: true }],
    [PROD_S12_ID, { id: PROD_S12_ID, stock: 10, minStock: 5, active: true }],
    [PROD_S5_ID, { id: PROD_S5_ID, stock: 0, minStock: 5, active: true }],
  ]);

  requestStore = new Map([
    [
      REQ_S5_ID,
      {
        id: REQ_S5_ID,
        supplierId: SUPPLIER1_ID,
        requestedByUserId: MANAGER_ID,
        status: 'SENT',
        requestedAt: new Date('2026-07-01T10:00:00.000Z'),
        sentAt: new Date('2026-07-01T11:00:00.000Z'),
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
      ITEM_S5_ID,
      {
        id: ITEM_S5_ID,
        replenishmentRequestId: REQ_S5_ID,
        productId: PROD_S5_ID,
        requestedQuantity: 8,
        receivedQuantity: null,
        unitPrice: { toNumber: () => 10.0 },
      },
    ],
  ]);
}

// ── Prisma mock ───────────────────────────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => {
  // tx client — must include alert.* for reconcile plus product/movement for stock operations
  const mockTx = {
    alert: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    product: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    inventoryMovement: {
      create: vi.fn(),
    },
    replenishmentRequest: {
      updateMany: vi.fn(),
    },
    replenishmentRequestItem: {
      update: vi.fn(),
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
      create: vi.fn(),
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
    productSupplier: {
      findUnique: vi.fn(),
    },
    supplier: {
      findUnique: vi.fn(),
    },
    alert: {
      findMany: vi.fn(),
      count: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
const _MANAGER_TOKEN = () => makeAccessToken(MANAGER_ID, 'MANAGER');

// ── Setup ─────────────────────────────────────────────────────────────────────

describe('Alerts hook smoke tests (S1-S5, S12)', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockTx: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    seedStores();

    __setNotificationService({ sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined) });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
    const mod = (await import('../../src/shared/utils/prisma.js')) as any;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    prisma = mod.prisma;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    mockTx = prisma._mockTx;

    // ── product.findUnique (outside tx) — for inventory-movements findProductActive ──
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.product.findUnique).mockImplementation(
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

    // ── tx.product.findUnique — for replenishment receive() per-item stock read ──
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(mockTx.product.findUnique).mockImplementation(
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

    // ── tx.product.updateMany — CAS stock update ──────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(mockTx.product.updateMany).mockImplementation(
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

    // ── tx.inventoryMovement.create ───────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(mockTx.inventoryMovement.create).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ data }: { data: any; select?: unknown }) => {
        movementCounter += 1;
        return Promise.resolve({
          id: `clh3xxk0hmov${movementCounter}356c9a5hook`,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          productId: data.productId as string,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          userId: data.userId as string,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          type: data.type as string,
          adjustmentDirection: null,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          quantity: data.quantity as number,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          resultingStock: data.resultingStock as number,
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          reason: data.reason as string,
          createdAt: new Date(),
        });
      },
    );

    // ── tx.alert.findFirst — returns the open alert state for a product ────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(mockTx.alert.findFirst).mockImplementation(
      ({ where }: { where: { productId?: string; resolved?: boolean } }) => {
        alertTxCalls.push({ operation: 'findFirst', args: { where } });
        if (!where.productId) return Promise.resolve(null);
        const alertState = openAlertState.get(where.productId);
        if (!alertState) return Promise.resolve(null);
        return Promise.resolve({
          id: alertState.id,
          productId: where.productId,
          type: alertState.type,
          message: `Alert for ${where.productId}`,
          resolved: false,
          resolvedAt: null,
          resolvedByUserId: null,
          createdAt: new Date(),
        });
      },
    );

    // ── tx.alert.update — marks an alert resolved ─────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(mockTx.alert.update).mockImplementation(
      ({ where, data }: { where: { id?: string }; data: unknown }) => {
        alertTxCalls.push({ operation: 'update', args: { where, data } });
        return Promise.resolve({ id: where.id });
      },
    );

    // ── tx.alert.create — inserts a new alert ────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(mockTx.alert.create).mockImplementation(({ data }: { data: unknown }) => {
      alertTxCalls.push({ operation: 'create', args: { data } });
      return Promise.resolve({ id: 'clh3xxk0hnewalt356c9a5new', ...(data as object) });
    });

    // ── $transaction — callback form with full mockTx ─────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.$transaction).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async (callbackOrArray: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>) => {
        if (typeof callbackOrArray === 'function') {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-return
          return callbackOrArray(mockTx);
        }
        return Promise.all(callbackOrArray);
      },
    );

    // ── Auth middleware stubs ─────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue(null);

    // ── Replenishment stubs for S5 ────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.replenishmentRequest.findUnique).mockImplementation(
      ({ where, select }: { where: { id?: string }; select?: Record<string, unknown> }) => {
        if (!where.id) return Promise.resolve(null);
        const row = requestStore.get(where.id);
        if (!row) return Promise.resolve(null);
        const needsItems = select && 'items' in select;
        if (needsItems) {
          const items = [...itemStore.values()].filter((i) => i.replenishmentRequestId === row.id);
          return Promise.resolve({ ...row, items });
        }
        return Promise.resolve({ ...row });
      },
    );

    // tx.replenishmentRequest.updateMany — CAS transition SENT → RECEIVED
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(mockTx.replenishmentRequest.updateMany).mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: { status: string; receivedAt?: Date; receivedByUserId?: string };
      }) => {
        const row = requestStore.get(where.id);
        if (!row || row.status !== where.status) return Promise.resolve({ count: 0 });
        requestStore.set(where.id, {
          ...row,
          status: data.status as 'PENDING' | 'SENT' | 'RECEIVED' | 'CANCELLED',
          receivedAt: data.receivedAt ?? null,
          receivedByUserId: data.receivedByUserId ?? null,
        });
        return Promise.resolve({ count: 1 });
      },
    );

    // tx.replenishmentRequestItem.update — persist receivedQuantity
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(mockTx.replenishmentRequestItem.update).mockImplementation(
      ({ where, data }: { where: { id: string }; data: { receivedQuantity: number } }) => {
        const item = itemStore.get(where.id);
        if (item) {
          itemStore.set(where.id, { ...item, receivedQuantity: data.receivedQuantity });
        }
        return Promise.resolve({ id: where.id });
      },
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── S1: Movement drops stock >minStock to 0<stock<=minStock → LOW_STOCK created ──

  describe('S1 — createMovement drops stock to LOW_STOCK range → LOW_STOCK alert created', () => {
    it('(S1) OUT movement stock 10→4 (minStock=5): no prior alert → tx.alert.create called with LOW_STOCK', async () => {
      // PROD_S1: stock=10, minStock=5. OUT of 6 → nextStock=4. No prior open alert.
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD_S1_ID, type: 'OUT', quantity: 6, reason: 'Sale S1' });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.movement.resultingStock).toBe(4);

      // reconcile must have been called: findFirst returned null → create LOW_STOCK
      const creates = alertTxCalls.filter((c) => c.operation === 'create');
      expect(creates).toHaveLength(1);
      const created = creates[0]!.args as { data: { type: string; productId: string } };
      expect(created.data.type).toBe('LOW_STOCK');
      expect(created.data.productId).toBe(PROD_S1_ID);

      // No update (close) was needed
      const updates = alertTxCalls.filter((c) => c.operation === 'update');
      expect(updates).toHaveLength(0);
    });
  });

  // ── S2: stock→0 with existing LOW_STOCK → LOW_STOCK closed + OUT_OF_STOCK created ──

  describe('S2 — createMovement drops stock to 0 with open LOW_STOCK → transition to OUT_OF_STOCK', () => {
    it('(S2) OUT movement stock 3→0 (minStock=5, open LOW_STOCK): LOW_STOCK resolved + OUT_OF_STOCK created', async () => {
      // PROD_S2: stock=3, minStock=5. OUT of 3 → nextStock=0. Open LOW_STOCK exists.
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD_S2_ID, type: 'OUT', quantity: 3, reason: 'Sale S2' });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.movement.resultingStock).toBe(0);

      // reconcile: findFirst → LOW_STOCK (wrong type) → update (close) → create OUT_OF_STOCK
      const updates = alertTxCalls.filter((c) => c.operation === 'update');
      expect(updates).toHaveLength(1);
      const updateArgs = updates[0]!.args as { where: { id: string }; data: { resolved: boolean } };
      expect(updateArgs.where.id).toBe(ALERT_OPEN_LOW_ID);
      expect(updateArgs.data.resolved).toBe(true);

      const creates = alertTxCalls.filter((c) => c.operation === 'create');
      expect(creates).toHaveLength(1);
      const created = creates[0]!.args as { data: { type: string } };
      expect(created.data.type).toBe('OUT_OF_STOCK');
    });
  });

  // ── S3: stock 0→3 (<=minStock) with open OUT_OF_STOCK → OUT_OF_STOCK closed + LOW_STOCK created ──

  describe('S3 — createMovement raises stock from 0 to LOW_STOCK range → transition to LOW_STOCK', () => {
    it('(S3) IN movement stock 0→3 (minStock=5, open OUT_OF_STOCK): OUT_OF_STOCK resolved + LOW_STOCK created', async () => {
      // PROD_S3: stock=0, minStock=5. IN of 3 → nextStock=3. Open OUT_OF_STOCK exists.
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD_S3_ID, type: 'IN', quantity: 3, reason: 'Partial restock S3' });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.movement.resultingStock).toBe(3);

      // reconcile: findFirst → OUT_OF_STOCK (wrong type) → update (close) → create LOW_STOCK
      const updates = alertTxCalls.filter((c) => c.operation === 'update');
      expect(updates).toHaveLength(1);
      const updateArgs = updates[0]!.args as { where: { id: string }; data: { resolved: boolean } };
      expect(updateArgs.where.id).toBe(ALERT_OPEN_OUT_ID);
      expect(updateArgs.data.resolved).toBe(true);

      const creates = alertTxCalls.filter((c) => c.operation === 'create');
      expect(creates).toHaveLength(1);
      const created = creates[0]!.args as { data: { type: string } };
      expect(created.data.type).toBe('LOW_STOCK');
    });
  });

  // ── S4: stock raises above minStock → open alert auto-resolved, no new alert ──

  describe('S4 — createMovement raises stock above minStock → open alert auto-resolved', () => {
    it('(S4) IN movement stock 2→12 (minStock=5, open LOW_STOCK): LOW_STOCK resolved, no create', async () => {
      // PROD_S4: stock=2, minStock=5. IN of 10 → nextStock=12>minStock. Open LOW_STOCK.
      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD_S4_ID, type: 'IN', quantity: 10, reason: 'Full restock S4' });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.movement.resultingStock).toBe(12);

      // reconcile: nextStock>minStock → close open alert, no new alert
      const updates = alertTxCalls.filter((c) => c.operation === 'update');
      expect(updates).toHaveLength(1);
      const updateArgs = updates[0]!.args as { where: { id: string }; data: { resolved: boolean } };
      expect(updateArgs.where.id).toBe(ALERT_OPEN_LOW_ID);
      expect(updateArgs.data.resolved).toBe(true);

      const creates = alertTxCalls.filter((c) => c.operation === 'create');
      expect(creates).toHaveLength(0);
    });
  });

  // ── S5: replenishmentRequestsService.receive() triggers reconcile per item ──

  describe('S5 — receive() triggers reconcile per item', () => {
    it('(S5) RECEIVE raises stock 0→8 (minStock=5, open OUT_OF_STOCK): OUT_OF_STOCK resolved, no new alert', async () => {
      // REQ_S5: SENT, one item (PROD_S5, qty=8). stock=0→8>minStock=5.
      // OUT_OF_STOCK open → should be resolved. No new alert created (8>5).
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ_S5_ID}/receive`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({});

      expect(res.status).toBe(200);

      // Stock must have updated
      expect(productStore.get(PROD_S5_ID)?.stock).toBe(8);

      // reconcile: nextStock=8 > minStock=5 → close OUT_OF_STOCK, no create
      const updates = alertTxCalls.filter((c) => c.operation === 'update');
      expect(updates).toHaveLength(1);
      const updateArgs = updates[0]!.args as { where: { id: string }; data: { resolved: boolean } };
      expect(updateArgs.where.id).toBe(ALERT_OPEN_OUT_ID);
      expect(updateArgs.data.resolved).toBe(true);

      const creates = alertTxCalls.filter((c) => c.operation === 'create');
      expect(creates).toHaveLength(0);
    });
  });

  // ── S12: reconcile failure does NOT rollback the movement ─────────────────────

  describe('S12 — reconcile failure inside tx does NOT rollback the movement', () => {
    it('(S12) alert.findFirst throws → movement committed, stock updated, no 500 to caller', async () => {
      // Override tx.alert.findFirst to throw for PROD_S12 to simulate a reconcile failure.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      vi.mocked(mockTx.alert.findFirst).mockImplementation(
        ({ where }: { where: { productId?: string } }) => {
          if (where.productId === PROD_S12_ID) {
            return Promise.reject(new Error('Simulated reconcile failure — duplicate constraint'));
          }
          return Promise.resolve(null);
        },
      );

      const stockBefore = productStore.get(PROD_S12_ID)?.stock ?? 0;

      const res = await request(app)
        .post('/api/inventory-movements')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ productId: PROD_S12_ID, type: 'OUT', quantity: 3, reason: 'Sale S12' });

      // Movement must succeed — reconcile failure is advisory and swallowed
      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.movement.resultingStock).toBe(stockBefore - 3);

      // Stock was updated in the store (movement persisted)
      expect(productStore.get(PROD_S12_ID)?.stock).toBe(stockBefore - 3);
    });
  });
});
