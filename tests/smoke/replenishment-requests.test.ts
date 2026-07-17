/**
 * Smoke tests for replenishment-requests endpoints.
 *
 * Phase 1 coverage (read side):
 *   - POST   /api/replenishment-requests          (create: success, fallback, no price, empty items, role)
 *   - GET    /api/replenishment-requests          (list with filters, pagination)
 *   - GET    /api/replenishment-requests/:id      (get by id: found, 404)
 *   - GET    /api/suppliers/:supplierId/replenishment-requests  (supplier-scoped list)
 *
 * Phase 2 coverage (state transitions):
 *   - POST   /api/replenishment-requests/:id/send     (PENDING → SENT + WhatsApp)
 *   - POST   /api/replenishment-requests/:id/receive  (SENT → RECEIVED + stock IN)
 *   - POST   /api/replenishment-requests/:id/cancel   (PENDING|SENT → CANCELLED)
 *
 * Prisma is fully mocked — no real DB required.
 * Follows the mocked-Prisma pattern from tests/smoke/inventory-movements.test.ts.
 *
 * $transaction strategy:
 *   Callback form (interactive tx) → call with mockTx.
 *   Array form (batch/parallel)    → Promise.all(queries).
 *
 * NotificationService is stubbed via __setNotificationService to prevent any
 * real Twilio calls. For failure scenarios, sendWhatsAppMessage is overridden
 * to reject so we can verify the DB transition still holds.
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
  supplier: {
    id: string;
    name: string;
  };
  requestedByUser: {
    id: string;
    fullName: string;
  };
  status: 'PENDING' | 'SENT' | 'RECEIVED' | 'CANCELLED';
  requestedAt: string;
  sentAt: string | null;
  receivedAt: string | null;
  receivedByUserId: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  notes: string | null;
  itemsCount: number;
  estimatedTotal: string;
}

interface RequestItemDto {
  id: string;
  productId: string;
  product: {
    id: string;
    name: string;
    code: string;
  };
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

const REQ1_ID = 'clh3xxk0h8001356c9a5oba8r'; // PENDING — used for SEND/CANCEL tests
const REQ2_ID = 'clh3xxk0h8002356c9a5oba9r'; // SENT   — used for RECEIVE/CANCEL tests
const REQ3_ID = 'clh3xxk0h8003356c9a5obatr'; // RECEIVED (terminal)
const REQ4_ID = 'clh3xxk0h8004356c9a5obaur'; // CANCELLED (terminal)
const MISSING_REQ_ID = 'clh3xxk0h8099356c9a5zzzzz';

const ITEM1_ID = 'clh3xxk0h9001356c9a5oba8i'; // item on REQ1 (PROD1, qty=10)
const ITEM2_ID = 'clh3xxk0h9002356c9a5oba9i'; // item on REQ2 (PROD2, qty=20)
const ITEM3_ID = 'clh3xxk0h9003356c9a5obabi'; // item on REQ2 (PROD1, qty=10) — second item for multi-item tests
const UNKNOWN_ITEM_ID = 'clh3xxk0h9099356c9a5zzzzz';

// ── In-memory stores ──────────────────────────────────────────────────────────

interface MockMovement {
  id: string;
  productId: string;
  userId: string;
  type: string;
  adjustmentDirection: string | null;
  quantity: number;
  resultingStock: number;
  reason: string;
  createdAt: Date;
}

let movementStore: MockMovement[];

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
  unitPrice: { toNumber(): number } | null;
}

interface MockProductSupplier {
  productId: string;
  supplierId: string;
  referencePrice: { toNumber(): number } | null;
}

interface MockSupplier {
  id: string;
  name: string;
  whatsapp: string | null;
}

interface MockUser {
  id: string;
  fullName: string;
  email: string;
}

interface MockProduct {
  id: string;
  code: string;
  name: string;
  stock: number;
  active: boolean;
}

let requestStore: Map<string, MockRequest>;
let itemStore: Map<string, MockItem>;
let productSupplierStore: Map<string, MockProductSupplier>;
let supplierStore: Map<string, MockSupplier>;
let userStore: Map<string, MockUser>;
let productStore: Map<string, MockProduct>;
let requestCounter: number;
let itemCounter: number;

function seedStores(): void {
  requestCounter = 0;
  itemCounter = 0;
  movementStore = [];

  supplierStore = new Map([
    [SUPPLIER1_ID, { id: SUPPLIER1_ID, name: 'SupplierOne SA', whatsapp: '+14155238886' }],
    [SUPPLIER2_ID, { id: SUPPLIER2_ID, name: 'SupplierTwo SRL', whatsapp: null }],
  ]);

  userStore = new Map([
    [ADMIN_ID, { id: ADMIN_ID, fullName: 'Admin User', email: 'admin@example.com' }],
    [MANAGER_ID, { id: MANAGER_ID, fullName: 'Manager User', email: 'manager@example.com' }],
    [OPERATOR_ID, { id: OPERATOR_ID, fullName: 'Operator User', email: 'operator@example.com' }],
  ]);

  productStore = new Map([
    [PROD1_ID, { id: PROD1_ID, code: 'MED-001', name: 'Ibuprofen 400mg', stock: 50, active: true }],
    [
      PROD2_ID,
      { id: PROD2_ID, code: 'MED-002', name: 'Paracetamol 500mg', stock: 20, active: true },
    ],
  ]);

  requestStore = new Map([
    [
      REQ1_ID,
      {
        id: REQ1_ID,
        supplierId: SUPPLIER1_ID, // has WhatsApp → send succeeds
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
        supplierId: SUPPLIER1_ID, // SENT → can be received or cancelled
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
    [
      REQ3_ID,
      {
        id: REQ3_ID,
        supplierId: SUPPLIER1_ID,
        requestedByUserId: ADMIN_ID,
        status: 'RECEIVED',
        requestedAt: new Date('2026-07-01T07:00:00.000Z'),
        sentAt: new Date('2026-07-01T08:00:00.000Z'),
        receivedAt: new Date('2026-07-01T12:00:00.000Z'),
        receivedByUserId: ADMIN_ID,
        cancelledAt: null,
        cancelledByUserId: null,
        notes: null,
      },
    ],
    [
      REQ4_ID,
      {
        id: REQ4_ID,
        supplierId: SUPPLIER1_ID,
        requestedByUserId: MANAGER_ID,
        status: 'CANCELLED',
        requestedAt: new Date('2026-06-30T10:00:00.000Z'),
        sentAt: null,
        receivedAt: null,
        receivedByUserId: null,
        cancelledAt: new Date('2026-06-30T11:00:00.000Z'),
        cancelledByUserId: MANAGER_ID,
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
    [
      ITEM3_ID,
      {
        id: ITEM3_ID,
        replenishmentRequestId: REQ2_ID,
        productId: PROD1_ID,
        requestedQuantity: 10,
        receivedQuantity: null,
        unitPrice: { toNumber: () => 5.5 },
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

function buildRequestRelations(request: MockRequest) {
  const supplier = supplierStore.get(request.supplierId);
  const requestedByUser = userStore.get(request.requestedByUserId);

  if (!supplier || !requestedByUser) {
    throw new Error(`Missing related data for request ${request.id}`);
  }

  return {
    supplier: {
      id: supplier.id,
      name: supplier.name,
    },
    requestedByUser: {
      id: requestedByUser.id,
      fullName: requestedByUser.fullName,
    },
  };
}

function buildRequestItems(requestId: string) {
  return [...itemStore.values()]
    .filter((item) => item.replenishmentRequestId === requestId)
    .map((item) => {
      const product = productStore.get(item.productId);

      if (!product) {
        throw new Error(`Missing product ${item.productId} for request item ${item.id}`);
      }

      return {
        ...item,
        product: {
          id: product.id,
          code: product.code,
          name: product.name,
        },
      };
    });
}

function buildRequestRow(request: MockRequest, includeItems: boolean) {
  return {
    ...request,
    ...buildRequestRelations(request),
    items: includeItems ? buildRequestItems(request.id) : [],
  };
}

// ── Prisma mock ───────────────────────────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => {
  // Transaction client — used in $transaction callback calls.
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
      findUnique: vi.fn(),
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
    supplier: {
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

describe('Replenishment Requests smoke tests', () => {
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
          unitPrice: number | null;
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
            unitPrice:
              itemData.unitPrice != null ? { toNumber: () => Number(itemData.unitPrice) } : null,
          };
          itemStore.set(itemId, item);
          return item;
        });

        // Return shape matching REQUEST_WITH_ITEMS_SELECT
        return Promise.resolve({
          ...buildRequestRow(newRequest, false),
          items: newItems.map((item) => {
            const product = productStore.get(item.productId);

            if (!product) {
              throw new Error(
                `Missing product ${item.productId} for created request item ${item.id}`,
              );
            }

            return {
              ...item,
              product: {
                id: product.id,
                code: product.code,
                name: product.name,
              },
            };
          }),
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

        const needsItems = Boolean(select && 'items' in select);
        return Promise.resolve(buildRequestRow(row, needsItems));
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
        return Promise.resolve(
          rows
            .slice(skip, take !== undefined ? skip + take : undefined)
            .map((row) => buildRequestRow(row, true)),
        );
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

    // ── supplier.findUnique ─────────────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma.supplier.findUnique).mockImplementation(
      ({ where }: { where: { id?: string } }) => {
        if (!where.id) return Promise.resolve(null);
        return Promise.resolve(supplierStore.get(where.id) ?? null);
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

    // ── mockTx.replenishmentRequest.updateMany ──────────────────────────────
    // Default: CAS succeeds (count=1). Override per-test for race scenarios.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma._mockTx.replenishmentRequest.updateMany).mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id?: string; status?: string };
        data: Record<string, unknown>;
      }) => {
        if (!where.id) return Promise.resolve({ count: 0 });
        const row = requestStore.get(where.id);
        if (!row || (where.status && row.status !== where.status)) {
          return Promise.resolve({ count: 0 });
        }
        // Apply the update to the in-memory store.
        Object.assign(row, data);
        return Promise.resolve({ count: 1 });
      },
    );

    // ── mockTx.replenishmentRequestItem.update ──────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma._mockTx.replenishmentRequestItem.update).mockImplementation(
      ({ where, data }: { where: { id?: string }; data: { receivedQuantity?: number } }) => {
        if (!where.id) return Promise.resolve(null);
        const item = itemStore.get(where.id);
        if (item && data.receivedQuantity !== undefined) {
          item.receivedQuantity = data.receivedQuantity;
        }
        return Promise.resolve(item ?? null);
      },
    );

    // ── mockTx.product.findUnique ──────────────────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma._mockTx.product.findUnique).mockImplementation(
      ({ where }: { where: { id?: string } }) => {
        if (!where.id) return Promise.resolve(null);
        return Promise.resolve(productStore.get(where.id) ?? null);
      },
    );

    // ── mockTx.product.updateMany (stock CAS) ─────────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma._mockTx.product.updateMany).mockImplementation(
      ({
        where,
        data,
      }: {
        where: { id?: string; stock?: number; active?: boolean };
        data: { stock?: number };
      }) => {
        if (!where.id) return Promise.resolve({ count: 0 });
        const product = productStore.get(where.id);
        if (!product || !product.active) return Promise.resolve({ count: 0 });
        if (where.stock !== undefined && product.stock !== where.stock) {
          return Promise.resolve({ count: 0 });
        }
        if (data.stock !== undefined) {
          product.stock = data.stock;
        }
        return Promise.resolve({ count: 1 });
      },
    );

    // ── mockTx.inventoryMovement.create ───────────────────────────────────
    // Tracks each created movement so tests can assert productId and count.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
    vi.mocked(prisma._mockTx.inventoryMovement.create).mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ({ data }: { data: any }) => {
        const movement: MockMovement = {
          id: `clh3xxk0hm${movementStore.length.toString().padStart(3, '0')}356c9a5newmv`,
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
        };
        movementStore.push(movement);
        return Promise.resolve(movement);
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
      expect(body.request.supplier).toEqual({ id: SUPPLIER1_ID, name: 'SupplierOne SA' });
      expect(body.request.requestedByUser).toEqual({
        id: MANAGER_ID,
        fullName: 'Manager User',
      });
      expect(body.request.items).toHaveLength(1);
      expect(body.request.items[0]!.unitPrice).toBe(15.0);
      expect(body.request.items[0]!.product).toEqual({
        id: PROD1_ID,
        code: 'MED-001',
        name: 'Ibuprofen 400mg',
      });
      expect(body.request.itemsCount).toBe(1);
      expect(body.request.estimatedTotal).toBe('75');
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

    it('(C3) Create without unitPrice and no referencePrice → 201 with null unitPrice', async () => {
      // SUPPLIER1 + PROD2 has no referencePrice — price is now optional, stored as null
      const res = await request(app)
        .post('/api/replenishment-requests')
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({
          supplierId: SUPPLIER1_ID,
          items: [{ productId: PROD2_ID, requestedQuantity: 2 }], // no unitPrice, no referencePrice
        });

      expect(res.status).toBe(201);
      const body = res.body as CreateBody;
      expect(body.request.items[0]!.unitPrice).toBeNull();
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
      /* eslint-disable @typescript-eslint/no-unsafe-assignment */
      expect(body.data[0]).toEqual(
        expect.objectContaining({
          supplier: expect.objectContaining({ id: expect.any(String), name: expect.any(String) }),
          requestedByUser: expect.objectContaining({
            id: expect.any(String),
            fullName: expect.any(String),
          }),
          itemsCount: expect.any(Number),
          estimatedTotal: expect.any(String),
        }),
      );
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */
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
      expect(body.request.supplier).toEqual({ id: SUPPLIER1_ID, name: 'SupplierOne SA' });
      expect(body.request.requestedByUser).toEqual({
        id: MANAGER_ID,
        fullName: 'Manager User',
      });
      expect(body.request.items[0]!.product).toEqual({
        id: PROD1_ID,
        code: 'MED-001',
        name: 'Ibuprofen 400mg',
      });
      expect(body.request.itemsCount).toBe(1);
      expect(body.request.estimatedTotal).toBe('55');
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
      /* eslint-disable @typescript-eslint/no-unsafe-assignment */
      expect(body.data[0]).toEqual(
        expect.objectContaining({
          supplier: expect.objectContaining({ id: SUPPLIER1_ID, name: 'SupplierOne SA' }),
          requestedByUser: expect.objectContaining({ fullName: expect.any(String) }),
          itemsCount: expect.any(Number),
          estimatedTotal: expect.any(String),
        }),
      );
      /* eslint-enable @typescript-eslint/no-unsafe-assignment */
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

  // ── SEND smoke tests (task 3.4) ───────────────────────────────────────────

  describe('POST /api/replenishment-requests/:id/send', () => {
    it('(SN1) Happy path: PENDING → SENT, returns 200, WhatsApp fired with correct phone+body', async () => {
      const fakeSend = vi.fn().mockResolvedValue(undefined);
      __setNotificationService({ sendWhatsAppMessage: fakeSend });

      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ1_ID}/send`)
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as { request: RequestDto };
      expect(body.request.status).toBe('SENT');
      expect(body.request.sentAt).not.toBeNull();

      // Allow fire-and-forget microtask to settle before asserting notification.
      await Promise.resolve();

      // NotificationService MUST have been called exactly once.
      expect(fakeSend).toHaveBeenCalledOnce();

      // First arg: E.164 phone prefixed with 'whatsapp:'.
      // SUPPLIER1 whatsapp = '+14155238886' → normalizeE164 returns '+14155238886'.
      const [toArg, bodyArg] = fakeSend.mock.calls[0] as [string, string];
      expect(toArg).toBe('whatsapp:+14155238886');

      // Body must contain the request id and supplier name (from buildSentTemplate).
      expect(bodyArg).toContain(REQ1_ID);
      expect(bodyArg).toContain('SupplierOne SA');
    });

    it('(SN2) Supplier has no WhatsApp → 422 SUPPLIER_HAS_NO_WHATSAPP', async () => {
      // REQ1 is on SUPPLIER1 (has WhatsApp). We need a request on SUPPLIER2 (no WhatsApp).
      // Inject a PENDING request pointing to SUPPLIER2.
      const noWaId = 'clh3xxk0h8010356c9a5nowrr';
      requestStore.set(noWaId, {
        id: noWaId,
        supplierId: SUPPLIER2_ID, // no whatsapp
        requestedByUserId: MANAGER_ID,
        status: 'PENDING',
        requestedAt: new Date(),
        sentAt: null,
        receivedAt: null,
        receivedByUserId: null,
        cancelledAt: null,
        cancelledByUserId: null,
        notes: null,
      });

      const res = await request(app)
        .post(`/api/replenishment-requests/${noWaId}/send`)
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`);

      expect(res.status).toBe(422);
      expect((res.body as ErrorBody).error).toBe('SUPPLIER_HAS_NO_WHATSAPP');
    });

    it('(SN3) Non-PENDING request → 409 INVALID_STATE_TRANSITION', async () => {
      // REQ2 is SENT — cannot be sent again.
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ2_ID}/send`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toBe('INVALID_STATE_TRANSITION');
    });

    it('(SN4) Concurrent CAS: first caller succeeds, second gets 409', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const mod = (await import('../../src/shared/utils/prisma.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const { prisma: p } = mod;

      // First call returns count=1 (wins the race); second returns count=0.
      /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
      vi.mocked(p._mockTx.replenishmentRequest.updateMany)
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/replenishment-requests/${REQ1_ID}/send`)
          .set('Authorization', `Bearer ${ADMIN_TOKEN()}`),
        request(app)
          .post(`/api/replenishment-requests/${REQ1_ID}/send`)
          .set('Authorization', `Bearer ${ADMIN_TOKEN()}`),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);
    });

    it('(SN5) Twilio failure keeps SENT status (DB committed before notification)', async () => {
      // Override notification service to reject.
      __setNotificationService({
        sendWhatsAppMessage: vi.fn().mockRejectedValue(new Error('Twilio unavailable')),
      });

      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ1_ID}/send`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      // DB transition succeeds regardless of Twilio failure.
      expect(res.status).toBe(200);
      expect((res.body as { request: RequestDto }).request.status).toBe('SENT');
    });

    it('(SN6) OPERATOR cannot send → 403', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ1_ID}/send`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);

      expect(res.status).toBe(403);
    });

    it('(SN7) Missing request → 404', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${MISSING_REQ_ID}/send`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('REPLENISHMENT_REQUEST_NOT_FOUND');
    });
  });

  // ── RECEIVE smoke tests (task 3.5) ────────────────────────────────────────

  describe('POST /api/replenishment-requests/:id/receive', () => {
    it('(RV1) Canonical multi-item: 2 IN movements created, stock updated on both products', async () => {
      // REQ2 is SENT with TWO items:
      //   ITEM2 → PROD2 (qty=20, initial stock=20)
      //   ITEM3 → PROD1 (qty=10, initial stock=50)
      // No body overrides → both items use their requestedQuantity as receivedQuantity.
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ2_ID}/receive`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({}); // no overrides → default qty

      expect(res.status).toBe(200);
      const body = res.body as { request: RequestWithItemsDto };
      expect(body.request.status).toBe('RECEIVED');
      expect(body.request.receivedAt).not.toBeNull();
      expect(body.request.receivedByUserId).toBe(ADMIN_ID);

      // Two items must be marked received with their requested quantities.
      const item2 = itemStore.get(ITEM2_ID);
      expect(item2?.receivedQuantity).toBe(20);
      const item3 = itemStore.get(ITEM3_ID);
      expect(item3?.receivedQuantity).toBe(10);

      // TWO IN movements must have been inserted — one per item.
      expect(movementStore).toHaveLength(2);
      const movProductIds = movementStore.map((m) => m.productId).sort();
      expect(movProductIds).toEqual([PROD1_ID, PROD2_ID].sort());
      expect(movementStore.every((m) => m.type === 'IN')).toBe(true);

      // Stock delta on BOTH products.
      const prod2 = productStore.get(PROD2_ID);
      expect(prod2?.stock).toBe(40); // 20 original + 20 received

      const prod1 = productStore.get(PROD1_ID);
      expect(prod1?.stock).toBe(60); // 50 original + 10 received
    });

    it('(RV2) Partial receipt with override quantity', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ2_ID}/receive`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ items: [{ id: ITEM2_ID, receivedQuantity: 7 }] });

      expect(res.status).toBe(200);
      const body = res.body as { request: RequestWithItemsDto };
      expect(body.request.status).toBe('RECEIVED');

      // Item receivedQuantity updated.
      const item = itemStore.get(ITEM2_ID);
      expect(item?.receivedQuantity).toBe(7);

      // Stock: 20 + 7 = 27.
      const product = productStore.get(PROD2_ID);
      expect(product?.stock).toBe(27);
    });

    it('(RV3) receivedQuantity > requestedQuantity → 400 PARTIAL_RECEIPT_INVALID', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ2_ID}/receive`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ items: [{ id: ITEM2_ID, receivedQuantity: 999 }] }); // 999 > 20

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('PARTIAL_RECEIPT_INVALID');
    });

    it('(RV4) Unknown item id in body → 400 REPLENISHMENT_ITEM_NOT_FOUND', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ2_ID}/receive`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ items: [{ id: UNKNOWN_ITEM_ID, receivedQuantity: 5 }] });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('REPLENISHMENT_ITEM_NOT_FOUND');
    });

    it('(RV5) Non-SENT request → 409 INVALID_STATE_TRANSITION', async () => {
      // REQ1 is PENDING — cannot receive.
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ1_ID}/receive`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({});

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toBe('INVALID_STATE_TRANSITION');
    });

    it('(RV6) Concurrent idempotency: second receive on same request → 409', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment
      const mod = (await import('../../src/shared/utils/prisma.js')) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
      const { prisma: p } = mod;

      // Second caller's CAS returns count=0.
      /* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
      vi.mocked(p._mockTx.replenishmentRequest.updateMany)
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      /* eslint-enable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

      const [res1, res2] = await Promise.all([
        request(app)
          .post(`/api/replenishment-requests/${REQ2_ID}/receive`)
          .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
          .send({}),
        request(app)
          .post(`/api/replenishment-requests/${REQ2_ID}/receive`)
          .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
          .send({}),
      ]);

      const statuses = [res1.status, res2.status].sort();
      expect(statuses).toEqual([200, 409]);
    });

    it('(RV7) Missing request → 404', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${MISSING_REQ_ID}/receive`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({});

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('REPLENISHMENT_REQUEST_NOT_FOUND');
    });

    it('(RV8) OPERATOR cannot receive → 403, no state change', async () => {
      // Capture REQ2 status before the attempt.
      const beforeStatus = requestStore.get(REQ2_ID)?.status;

      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ2_ID}/receive`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        .send({});

      expect(res.status).toBe(403);

      // No side effects: request must still be in its original state.
      expect(requestStore.get(REQ2_ID)?.status).toBe(beforeStatus);

      // No IN movements should have been inserted.
      expect(movementStore).toHaveLength(0);
    });
  });

  // ── CANCEL smoke tests (task 3.6) ─────────────────────────────────────────

  describe('POST /api/replenishment-requests/:id/cancel', () => {
    it('(CA1) PENDING cancel is silent (no WhatsApp) → 200 CANCELLED', async () => {
      const fakeSend = vi.fn().mockResolvedValue(undefined);
      __setNotificationService({ sendWhatsAppMessage: fakeSend });

      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ1_ID}/cancel`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as { request: RequestDto };
      expect(body.request.status).toBe('CANCELLED');
      // No notification for PENDING cancel.
      expect(fakeSend).not.toHaveBeenCalled();
    });

    it('(CA2) SENT cancel notifies supplier via WhatsApp', async () => {
      const fakeSend = vi.fn().mockResolvedValue(undefined);
      __setNotificationService({ sendWhatsAppMessage: fakeSend });

      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ2_ID}/cancel`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      expect((res.body as { request: RequestDto }).request.status).toBe('CANCELLED');

      // Allow fire-and-forget microtask to settle.
      await Promise.resolve();
      expect(fakeSend).toHaveBeenCalledOnce();
    });

    it('(CA3) Twilio failure on SENT cancel keeps CANCELLED DB state', async () => {
      __setNotificationService({
        sendWhatsAppMessage: vi.fn().mockRejectedValue(new Error('Twilio down')),
      });

      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ2_ID}/cancel`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      // DB transition committed regardless of Twilio error.
      expect(res.status).toBe(200);
      expect((res.body as { request: RequestDto }).request.status).toBe('CANCELLED');
    });

    it('(CA4) RECEIVED (terminal) → 409 INVALID_STATE_TRANSITION', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ3_ID}/cancel`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toBe('INVALID_STATE_TRANSITION');
    });

    it('(CA5) CANCELLED (terminal) → 409 INVALID_STATE_TRANSITION', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ4_ID}/cancel`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(409);
      expect((res.body as ErrorBody).error).toBe('INVALID_STATE_TRANSITION');
    });

    it('(CA6) Missing request → 404', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${MISSING_REQ_ID}/cancel`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(404);
      expect((res.body as ErrorBody).error).toBe('REPLENISHMENT_REQUEST_NOT_FOUND');
    });

    it('(CA7) OPERATOR cannot cancel → 403', async () => {
      const res = await request(app)
        .post(`/api/replenishment-requests/${REQ1_ID}/cancel`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);

      expect(res.status).toBe(403);
    });
  });
});
