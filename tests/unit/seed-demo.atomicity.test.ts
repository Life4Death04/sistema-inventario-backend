/**
 * Unit tests proving `db:seed:demo`'s transaction ATOMICITY correction
 * (independent-validation remediation — failed evidence revision
 * `sha256:35c0fbe86bd1e2863bbdcb951b208ab384613b84af4000115ce12c5a14ccd7ba`).
 *
 * The original PR5 candidate read the marker/identity/ten-model counts via
 * `Promise.all` on the ROOT Prisma client BEFORE opening `$transaction`,
 * then only wrapped the WRITES in a transaction — a concurrent-first-run
 * TOCTOU window: two processes could both read "empty, no marker" before
 * either had written, then both attempt a first-run bootstrap.
 *
 * These tests prove the corrected contract directly against `runSeedDemo`,
 * using the ordered `operationLog` from `tests/helpers/mockDemoPrisma.ts`
 * (NOT repeated mock-argument assertions):
 *   - ALL reads and writes happen on the SAME transaction-scoped client
 *     (`tx`) — the root client's model methods are NEVER called.
 *   - The `DemoSeedMarker` count is read FIRST, before any of the ten
 *     approved application-model counts.
 *   - A recognized rerun (valid marker) SKIPS the ten application-model
 *     counts entirely — they never appear in the operation log.
 *   - Every abort path (`ABORT_UNMARKED`, `ABORT_MISMATCH`) performs ZERO
 *     writes (no `.upsert`/`.create` call anywhere in the log).
 *   - The whole read→resolve→write sequence happens inside exactly one
 *     `$transaction` call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockDemoPrisma } from '../helpers/mockDemoPrisma.js';
import { runSeedDemo, REQUIRED_CONFIRMATION } from '../../prisma/scripts/seed-demo.js';

/** The 9 approved application-model counts that are unambiguous by log tag alone (user.count is ambiguous — asserted separately via call count). */
const UNAMBIGUOUS_APPLICATION_COUNT_TAGS = [
  'tx:refreshToken.count',
  'tx:category.count',
  'tx:product.count',
  'tx:supplier.count',
  'tx:productSupplier.count',
  'tx:inventoryMovement.count',
  'tx:alert.count',
  'tx:replenishmentRequest.count',
  'tx:replenishmentRequestItem.count',
];

const isWriteOp = (op: string): boolean => op.endsWith('.upsert') || op.endsWith('.create');

/**
 * Queues a one-time resolved count value WHILE still recording the call in
 * `operationLog`. A bare `mockResolvedValueOnce` replaces the mock's default
 * implementation (which is what pushes to the log), so it would silently
 * erase the very read this suite exists to order-check. This helper keeps
 * both: a controllable return value AND a truthful operation log entry.
 */
function queueLoggedCount(
  model: { count: (...args: never[]) => Promise<number> },
  log: string[],
  tag: string,
  value: number,
): void {
  // The real Prisma delegate's `count` accepts a model-specific args object,
  // narrower than `(...args: never[])`. Structural widening here is
  // test-mock-only — `model.count` is always one of `mockDemoPrisma.ts`'s
  // `vi.fn()` stubs at every call site, never a real Prisma delegate.
  vi.mocked(model.count as (...args: never[]) => Promise<number>).mockImplementationOnce(() => {
    log.push(tag);
    return Promise.resolve(value);
  });
}

beforeEach(() => {
  process.env['DEMO_SEED_CONFIRM'] = REQUIRED_CONFIRMATION;
});

afterEach(() => {
  delete process.env['DEMO_SEED_CONFIRM'];
});

describe('db:seed:demo — single-transaction atomicity (marker-first routing)', () => {
  it('FIRST_RUN: reads and writes all happen on tx, never on root, within exactly one $transaction', async () => {
    const { prisma, tx, operationLog } = createMockDemoPrisma();

    await runSeedDemo(prisma);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(prisma.$transaction)).toHaveBeenCalledTimes(1);
    expect(operationLog.length).toBeGreaterThan(0);
    expect(operationLog.every((op) => op.startsWith('tx:'))).toBe(true);

    // Marker count is the very first operation — read FIRST, before anything else.
    expect(operationLog[0]).toBe('tx:demoSeedMarker.count');

    // The empty-DB check ran (markerCount was 0): the ten-model counts appear.
    for (const tag of UNAMBIGUOUS_APPLICATION_COUNT_TAGS) {
      expect(operationLog).toContain(tag);
    }
    // user.count is called exactly once on FIRST_RUN — the bare empty-check
    // count, not the (skipped) identity-matching counts.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(tx.user.count)).toHaveBeenCalledTimes(1);

    // Writes happened, and only via tx.
    expect(operationLog).toContain('tx:demoSeedMarker.create');
    expect(operationLog).toContain('tx:user.upsert');
  });

  it('RECOGNIZED_RERUN: skips all ten application-model counts entirely, writes still via tx only', async () => {
    const { prisma, tx, operationLog } = createMockDemoPrisma();
    queueLoggedCount(tx.demoSeedMarker, operationLog, 'tx:demoSeedMarker.count', 1);
    queueLoggedCount(tx.demoSeedMarker, operationLog, 'tx:demoSeedMarker.count', 1);
    queueLoggedCount(tx.user, operationLog, 'tx:user.count', 1);
    queueLoggedCount(tx.user, operationLog, 'tx:user.count', 1);

    await runSeedDemo(prisma);

    expect(operationLog[0]).toBe('tx:demoSeedMarker.count');
    for (const tag of UNAMBIGUOUS_APPLICATION_COUNT_TAGS) {
      expect(operationLog).not.toContain(tag);
    }
    // user.count called exactly twice — both identity-matching reads, no bare empty-check call.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(tx.user.count)).toHaveBeenCalledTimes(2);
    // demoSeedMarker.count called exactly twice — total, then matching-version.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(vi.mocked(tx.demoSeedMarker.count)).toHaveBeenCalledTimes(2);

    expect(operationLog).toContain('tx:user.upsert');
    expect(operationLog).not.toContain('tx:demoSeedMarker.create'); // rerun never creates a 2nd marker
    expect(operationLog.every((op) => op.startsWith('tx:'))).toBe(true);
  });

  it('ABORT_UNMARKED performs zero writes anywhere', async () => {
    const { prisma, tx, operationLog } = createMockDemoPrisma();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(tx.category.count).mockResolvedValue(1); // non-empty, no marker

    await expect(runSeedDemo(prisma)).rejects.toThrow();

    expect(operationLog.some(isWriteOp)).toBe(false);
  });

  it('ABORT_MISMATCH (marker present, version mismatch) performs zero writes anywhere', async () => {
    const { prisma, tx, operationLog } = createMockDemoPrisma();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(tx.demoSeedMarker.count).mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(tx.user.count).mockResolvedValueOnce(1).mockResolvedValueOnce(1);

    await expect(runSeedDemo(prisma)).rejects.toThrow();

    expect(operationLog.some(isWriteOp)).toBe(false);
    // The mismatch check itself must still have run inside the transaction.
    for (const tag of UNAMBIGUOUS_APPLICATION_COUNT_TAGS) {
      expect(operationLog).not.toContain(tag);
    }
  });
});
