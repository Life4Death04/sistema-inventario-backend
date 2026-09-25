/**
 * Unit tests for `db:seed:demo`'s master-data identity/integrity guarantees.
 *
 * Tests per tasks.md 5.1 + specs/database-schema/spec.md ("Non-destructive
 * master-data demo bootstrap", "Public credentials confined to one demo
 * identity", "New products start at zero stock") + design.md's upsert
 * contract (Supplier.rif deterministic non-null `J-<seq>`):
 *   - Exactly one `isDemo:true` public ADMIN (`role: ADMIN`) is ever upserted.
 *   - No other user upsert call ever sets `isDemo:true`.
 *   - Every newly created Product row has `stock: 0`.
 *   - Every Supplier upsert has a deterministic, non-null `rif` (`J-<seq>`),
 *     unique across suppliers.
 *
 * Prisma is fully mocked (tests/helpers/mockDemoPrisma.ts) — no real DB.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMockDemoPrisma } from '../helpers/mockDemoPrisma.js';
import { bootstrapDemoData } from '../../prisma/scripts/seed-demo.js';
import { DEMO_ADMIN_EMAIL } from '../../src/shared/demo/demoCredentials.js';

interface UpsertCall {
  where: Record<string, unknown>;
  update: Record<string, unknown>;
  create: Record<string, unknown>;
}

describe('db:seed:demo — identity & data integrity (first-run bootstrap)', () => {
  it('upserts exactly one user, and it is the public isDemo:true ADMIN', async () => {
    const { tx } = createMockDemoPrisma();
    await bootstrapDemoData(tx, true);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockUserUpsert = vi.mocked(tx.user.upsert);
    expect(mockUserUpsert).toHaveBeenCalledTimes(1);

    const [call] = mockUserUpsert.mock.calls[0] as unknown as [UpsertCall];
    expect(call.where['email']).toBe(DEMO_ADMIN_EMAIL);
    expect(call.create['isDemo']).toBe(true);
    expect(call.create['role']).toBe('ADMIN');
    expect(call.create['email']).toBe(DEMO_ADMIN_EMAIL);
    // The update branch must ALSO keep isDemo:true — a rerun must never
    // silently demote the public identity back to isDemo:false.
    expect(call.update['isDemo']).toBe(true);
  });

  it('never issues a second user upsert — no other row can be marked isDemo:true by this script', async () => {
    const { tx } = createMockDemoPrisma();
    await bootstrapDemoData(tx, true);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockUserUpsert = vi.mocked(tx.user.upsert);
    // The script structurally has ONE user.upsert call site — asserting the
    // call count is 1 is itself the proof that "every other user" (there are
    // none created by this script) stays isDemo:false.
    expect(mockUserUpsert).toHaveBeenCalledTimes(1);
  });

  it('every newly created Product row has stock: 0', async () => {
    const { tx } = createMockDemoPrisma();
    await bootstrapDemoData(tx, true);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockProductUpsert = vi.mocked(tx.product.upsert);
    expect(mockProductUpsert.mock.calls.length).toBeGreaterThan(0);

    for (const rawCall of mockProductUpsert.mock.calls) {
      const [call] = [rawCall[0]] as unknown as [UpsertCall];
      expect(call.create['stock']).toBe(0);
    }
  });

  it('every Supplier upsert has a deterministic, non-null, unique rif (J-<seq>)', async () => {
    const { tx } = createMockDemoPrisma();
    await bootstrapDemoData(tx, true);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockSupplierUpsert = vi.mocked(tx.supplier.upsert);
    expect(mockSupplierUpsert.mock.calls.length).toBeGreaterThan(0);

    const rifs: string[] = [];
    for (const rawCall of mockSupplierUpsert.mock.calls) {
      const [call] = [rawCall[0]] as unknown as [UpsertCall];
      const rif = call.create['rif'];
      expect(rif).toEqual(expect.stringMatching(/^J-\d+$/));
      expect(call.where['rif']).toBe(rif);
      rifs.push(rif as string);
    }
    expect(new Set(rifs).size).toBe(rifs.length); // no duplicate rifs
  });
});
