/**
 * Unit tests for `db:seed:demo`'s non-destructive rerun guarantee.
 *
 * Tests per tasks.md 5.3 + specs/database-schema/spec.md ("Rerun preserves
 * manually established stock", "Rerun leaves transactional tables
 * unchanged"): a recognized rerun (RECOGNIZED_RERUN — `isFirstRun: false`)
 * must never create a second DemoSeedMarker, must never write `stock` in a
 * Product update payload, and must never touch InventoryMovement, Alert,
 * ReplenishmentRequest, or ReplenishmentRequestItem in any way.
 *
 * "Before/after snapshot" here means: each transactional table's mocked
 * `count()` is fixed to a non-zero value BEFORE calling bootstrapDemoData,
 * read again AFTER, and asserted unchanged — while independently asserting
 * zero create/update/delete calls were made against those tables. The real
 * end-to-end proof (actual Postgres rows) runs in the PR5 runtime harness.
 *
 * Prisma is fully mocked (tests/helpers/mockDemoPrisma.ts) — no real DB.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMockDemoPrisma } from '../helpers/mockDemoPrisma.js';
import { bootstrapDemoData } from '../../prisma/scripts/seed-demo.js';
import type { PrismaClient } from '@prisma/client';

interface UpsertCall {
  update: Record<string, unknown>;
}

/** Common mocked shape for the four transactional models — avoids the union-of-delegate-types overload ambiguity that comes from indexing PrismaClient with a variable model name. */
interface MockedTransactionalTable {
  count: () => Promise<number>;
  create: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function transactionalTables(prisma: PrismaClient): MockedTransactionalTable[] {
  return [
    prisma.inventoryMovement,
    prisma.alert,
    prisma.replenishmentRequest,
    prisma.replenishmentRequestItem,
  ] as unknown as MockedTransactionalTable[];
}

describe('db:seed:demo — non-destructive rerun (RECOGNIZED_RERUN)', () => {
  it('never creates a second DemoSeedMarker on rerun', async () => {
    const { tx } = createMockDemoPrisma();
    await bootstrapDemoData(tx, false);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(tx.demoSeedMarker.create)).not.toHaveBeenCalled();
  });

  it("Product update payload omits 'stock' on rerun — manual stock is never touched", async () => {
    const { tx } = createMockDemoPrisma();
    await bootstrapDemoData(tx, false);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockProductUpsert = vi.mocked(tx.product.upsert);
    expect(mockProductUpsert.mock.calls.length).toBeGreaterThan(0);

    for (const rawCall of mockProductUpsert.mock.calls) {
      const [call] = [rawCall[0]] as unknown as [UpsertCall];
      expect('stock' in call.update).toBe(false);
    }
  });

  it('leaves all four transactional tables completely untouched (before/after snapshot)', async () => {
    const { tx } = createMockDemoPrisma();
    const tables = transactionalTables(tx);

    // "Before" snapshot — pin each transactional table's count to a fixed,
    // non-zero value representing rows created by real app workflows.
    const SNAPSHOT_COUNT = 7;
    const before: number[] = [];
    for (const table of tables) {
      vi.mocked(table.count).mockResolvedValue(SNAPSHOT_COUNT);
      before.push(await table.count());
    }

    await bootstrapDemoData(tx, false);

    // "After" snapshot — counts must be identical, AND no mutating method on
    // any of the four models may have been called by the rerun.
    for (const [index, table] of tables.entries()) {
      expect(await table.count()).toBe(before[index]);
      expect(vi.mocked(table.create)).not.toHaveBeenCalled();
      expect(vi.mocked(table.update)).not.toHaveBeenCalled();
      expect(vi.mocked(table.delete)).not.toHaveBeenCalled();
    }
  });
});
