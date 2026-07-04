/* eslint-disable @typescript-eslint/unbound-method */
/**
 * Unit tests for AlertsRepository.reconcile() — state machine in isolation.
 *
 * Coverage (maps to spec S1-S4 state-machine level + REQ-1..4 invariants):
 *
 *   No-op paths:
 *   U-1  No open alert + nextStock > minStock       → no-op (no create, no update)
 *   U-8  Open LOW_STOCK  + same type still needed   → no-op (no duplicate create)
 *   U-9  Open OUT_OF_STOCK + nextStock === 0        → no-op
 *
 *   Create paths (REQ-1, REQ-2):
 *   U-2  No open alert + 0 < nextStock <= minStock  → create LOW_STOCK; message contains stock + minStock
 *   U-3  No open alert + nextStock === 0            → create OUT_OF_STOCK
 *
 *   Auto-resolve on recovery (REQ-4):
 *   U-4  Open LOW_STOCK  + nextStock > minStock     → resolve the open alert (resolved=true, resolvedAt set, resolvedByUserId=null)
 *   U-5  Open OUT_OF_STOCK + nextStock > minStock   → resolve
 *
 *   Close-before-create (REQ-3):
 *   U-6  Open LOW_STOCK  + nextStock === 0          → close LOW_STOCK (auto-resolve) AND create OUT_OF_STOCK
 *   U-7  Open OUT_OF_STOCK + 0 < nextStock <= minStock → close OUT_OF_STOCK AND create LOW_STOCK
 *
 * No Express, no supertest, no real DB.
 * Only tx.alert.findFirst / tx.alert.create / tx.alert.update are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AlertsRepository } from '../../../src/modules/alerts/alerts.repository.js';
import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Mock tx factory — typed to the surface reconcile actually uses
// ---------------------------------------------------------------------------

interface MockAlertRow {
  id: string;
  productId: string;
  type: 'LOW_STOCK' | 'OUT_OF_STOCK';
  message: string;
  resolved: boolean;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  createdAt: Date;
}

function makeMockTx(openAlert: MockAlertRow | null): Prisma.TransactionClient {
  return {
    alert: {
      findFirst: vi.fn().mockResolvedValue(openAlert),
      create: vi.fn().mockResolvedValue({ id: 'new-alert-id' }),
      update: vi.fn().mockResolvedValue({ id: openAlert?.id ?? 'resolved-id' }),
    },
  } as unknown as Prisma.TransactionClient;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PRODUCT_ID = 'clh3xxk0hprod356c9a5oba7k';

function makeOpenAlert(
  type: 'LOW_STOCK' | 'OUT_OF_STOCK',
  id = 'clh3xxk0halt356c9a5oba7k',
): MockAlertRow {
  return {
    id,
    productId: PRODUCT_ID,
    type,
    message: `Alert for ${PRODUCT_ID}`,
    resolved: false,
    resolvedAt: null,
    resolvedByUserId: null,
    createdAt: new Date('2026-07-01T10:00:00.000Z'),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AlertsRepository.reconcile() — state machine unit tests', () => {
  let repo: AlertsRepository;

  beforeEach(() => {
    repo = new AlertsRepository();
  });

  // ── No-op paths ────────────────────────────────────────────────────────────

  describe('U-1 — No open alert + nextStock > minStock → no-op', () => {
    it('does not call create or update when stock is healthy and no alert exists', async () => {
      const tx = makeMockTx(null);

      await repo.reconcile(tx, PRODUCT_ID, 10, 5);

      expect(tx.alert.create).not.toHaveBeenCalled();
      expect(tx.alert.update).not.toHaveBeenCalled();
    });
  });

  describe('U-8 — Open LOW_STOCK + nextStock still in LOW_STOCK range → no-op', () => {
    it('does not create duplicate LOW_STOCK when same type is already open', async () => {
      const openAlert = makeOpenAlert('LOW_STOCK');
      const tx = makeMockTx(openAlert);

      // nextStock=3, minStock=5 → LOW_STOCK zone, already open → no-op
      await repo.reconcile(tx, PRODUCT_ID, 3, 5);

      expect(tx.alert.create).not.toHaveBeenCalled();
      expect(tx.alert.update).not.toHaveBeenCalled();
    });

    it('does not create duplicate LOW_STOCK when nextStock equals minStock exactly', async () => {
      const openAlert = makeOpenAlert('LOW_STOCK');
      const tx = makeMockTx(openAlert);

      // nextStock === minStock → 0 < stock <= minStock → LOW_STOCK zone, no-op
      await repo.reconcile(tx, PRODUCT_ID, 5, 5);

      expect(tx.alert.create).not.toHaveBeenCalled();
      expect(tx.alert.update).not.toHaveBeenCalled();
    });
  });

  describe('U-9 — Open OUT_OF_STOCK + nextStock === 0 → no-op', () => {
    it('does not create duplicate OUT_OF_STOCK when same type is already open', async () => {
      const openAlert = makeOpenAlert('OUT_OF_STOCK');
      const tx = makeMockTx(openAlert);

      await repo.reconcile(tx, PRODUCT_ID, 0, 5);

      expect(tx.alert.create).not.toHaveBeenCalled();
      expect(tx.alert.update).not.toHaveBeenCalled();
    });
  });

  // ── Create paths ────────────────────────────────────────────────────────────

  describe('U-2 — No open alert + 0 < nextStock <= minStock → create LOW_STOCK', () => {
    it('creates a LOW_STOCK alert with message containing stock and minStock values', async () => {
      const tx = makeMockTx(null);

      await repo.reconcile(tx, PRODUCT_ID, 4, 5);

      expect(tx.alert.update).not.toHaveBeenCalled();
      expect(tx.alert.create).toHaveBeenCalledTimes(1);

      const createCall = vi.mocked(tx.alert.create).mock.calls[0]![0];
      expect(createCall.data.type).toBe('LOW_STOCK');
      expect(createCall.data.productId).toBe(PRODUCT_ID);
      // Message must reference the stock value and the minStock threshold (spec S1)
      expect(createCall.data.message).toContain('4');
      expect(createCall.data.message).toContain('5');
      // Must be open (resolved=false)
      expect(createCall.data.resolved).toBe(false);
      expect(createCall.data.resolvedAt).toBeNull();
      expect(createCall.data.resolvedByUserId).toBeNull();
    });

    it('creates LOW_STOCK when nextStock equals minStock exactly (boundary)', async () => {
      const tx = makeMockTx(null);

      await repo.reconcile(tx, PRODUCT_ID, 5, 5);

      expect(tx.alert.create).toHaveBeenCalledTimes(1);
      const createCall = vi.mocked(tx.alert.create).mock.calls[0]![0];
      expect(createCall.data.type).toBe('LOW_STOCK');
    });
  });

  describe('U-3 — No open alert + nextStock === 0 → create OUT_OF_STOCK', () => {
    it('creates an OUT_OF_STOCK alert when stock hits zero and no prior alert exists', async () => {
      const tx = makeMockTx(null);

      await repo.reconcile(tx, PRODUCT_ID, 0, 5);

      expect(tx.alert.update).not.toHaveBeenCalled();
      expect(tx.alert.create).toHaveBeenCalledTimes(1);

      const createCall = vi.mocked(tx.alert.create).mock.calls[0]![0];
      expect(createCall.data.type).toBe('OUT_OF_STOCK');
      expect(createCall.data.productId).toBe(PRODUCT_ID);
      expect(createCall.data.resolved).toBe(false);
      expect(createCall.data.resolvedAt).toBeNull();
      expect(createCall.data.resolvedByUserId).toBeNull();
    });
  });

  // ── Auto-resolve on recovery ────────────────────────────────────────────────

  describe('U-4 — Open LOW_STOCK + nextStock > minStock → auto-resolve, no create', () => {
    it('resolves the open LOW_STOCK alert with resolved=true, resolvedAt set, resolvedByUserId=null', async () => {
      const openAlert = makeOpenAlert('LOW_STOCK', 'clh3xxk0hlow356c9a5oba7k');
      const tx = makeMockTx(openAlert);

      await repo.reconcile(tx, PRODUCT_ID, 12, 5);

      // Must resolve — no new alert
      expect(tx.alert.create).not.toHaveBeenCalled();
      expect(tx.alert.update).toHaveBeenCalledTimes(1);

      const updateCall = vi.mocked(tx.alert.update).mock.calls[0]![0];
      expect(updateCall.where.id).toBe('clh3xxk0hlow356c9a5oba7k');
      expect(updateCall.data.resolved).toBe(true);
      expect(updateCall.data.resolvedAt).toBeInstanceOf(Date);
      expect(updateCall.data.resolvedByUserId).toBeNull();
    });
  });

  describe('U-5 — Open OUT_OF_STOCK + nextStock > minStock → auto-resolve, no create', () => {
    it('resolves the open OUT_OF_STOCK alert when stock fully recovers', async () => {
      const openAlert = makeOpenAlert('OUT_OF_STOCK', 'clh3xxk0hout356c9a5oba7k');
      const tx = makeMockTx(openAlert);

      await repo.reconcile(tx, PRODUCT_ID, 8, 5);

      expect(tx.alert.create).not.toHaveBeenCalled();
      expect(tx.alert.update).toHaveBeenCalledTimes(1);

      const updateCall = vi.mocked(tx.alert.update).mock.calls[0]![0];
      expect(updateCall.where.id).toBe('clh3xxk0hout356c9a5oba7k');
      expect(updateCall.data.resolved).toBe(true);
      expect(updateCall.data.resolvedAt).toBeInstanceOf(Date);
      expect(updateCall.data.resolvedByUserId).toBeNull();
    });
  });

  // ── Close-before-create (REQ-3) ─────────────────────────────────────────────

  describe('U-6 — Open LOW_STOCK + nextStock === 0 → close LOW_STOCK AND create OUT_OF_STOCK', () => {
    it('closes the LOW_STOCK alert then creates OUT_OF_STOCK (REQ-3 close-before-create)', async () => {
      const openAlert = makeOpenAlert('LOW_STOCK', 'clh3xxk0hlow356c9a5oba7k');
      const tx = makeMockTx(openAlert);

      await repo.reconcile(tx, PRODUCT_ID, 0, 5);

      // Must close the existing LOW_STOCK first
      expect(tx.alert.update).toHaveBeenCalledTimes(1);
      const updateCall = vi.mocked(tx.alert.update).mock.calls[0]![0];
      expect(updateCall.where.id).toBe('clh3xxk0hlow356c9a5oba7k');
      expect(updateCall.data.resolved).toBe(true);

      // Then create OUT_OF_STOCK
      expect(tx.alert.create).toHaveBeenCalledTimes(1);
      const createCall = vi.mocked(tx.alert.create).mock.calls[0]![0];
      expect(createCall.data.type).toBe('OUT_OF_STOCK');
      expect(createCall.data.productId).toBe(PRODUCT_ID);
    });
  });

  describe('U-7 — Open OUT_OF_STOCK + 0 < nextStock <= minStock → close OUT_OF_STOCK AND create LOW_STOCK', () => {
    it('closes the OUT_OF_STOCK alert then creates LOW_STOCK (REQ-3 close-before-create)', async () => {
      const openAlert = makeOpenAlert('OUT_OF_STOCK', 'clh3xxk0hout356c9a5oba7k');
      const tx = makeMockTx(openAlert);

      await repo.reconcile(tx, PRODUCT_ID, 3, 5);

      // Must close the existing OUT_OF_STOCK first
      expect(tx.alert.update).toHaveBeenCalledTimes(1);
      const updateCall = vi.mocked(tx.alert.update).mock.calls[0]![0];
      expect(updateCall.where.id).toBe('clh3xxk0hout356c9a5oba7k');
      expect(updateCall.data.resolved).toBe(true);

      // Then create LOW_STOCK
      expect(tx.alert.create).toHaveBeenCalledTimes(1);
      const createCall = vi.mocked(tx.alert.create).mock.calls[0]![0];
      expect(createCall.data.type).toBe('LOW_STOCK');
      expect(createCall.data.productId).toBe(PRODUCT_ID);
      // LOW_STOCK message must contain the stock and minStock values
      expect(createCall.data.message).toContain('3');
      expect(createCall.data.message).toContain('5');
    });
  });
});
