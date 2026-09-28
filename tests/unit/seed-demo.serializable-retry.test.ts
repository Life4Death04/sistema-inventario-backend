/**
 * Unit tests for `db:seed:demo`'s Serializable isolation + bounded
 * transaction-conflict retry — the correction for a proven concurrency
 * defect (independent-validation remediation, diagnosis evidence revision
 * `sha256:266a1b20a09f9a77633ac99ce916272bdae82fce1743188d6c7cd5708ec3831c`).
 *
 * Fresh independent validation proved that a single interactive transaction
 * at PostgreSQL's default `ReadCommitted` isolation does NOT serialize
 * absence/predicate reads: two concurrent first-run processes can both read
 * "no marker, empty database" before either commits, then both attempt a
 * first-run bootstrap. These tests prove the JS-level half of the fix —
 * that `runSeedDemo` (a) opens every attempt at `Serializable` isolation and
 * (b) retries ONLY Prisma's retryable transaction-conflict code (`P2034`)
 * up to a small deterministic bound, rerunning the WHOLE
 * marker-first-read → resolve → write sequence in a fresh `$transaction`
 * call each time. The real cross-process proof (two actual concurrent OS
 * processes against a real disposable PostgreSQL database) lives in
 * `prisma/scripts/demo-seed-concurrency-harness.ts` — that is a database-level
 * serialization guarantee no JS-level mock can substitute for; this file
 * proves the retry/isolation WIRING is correct.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import { createMockDemoPrisma } from '../helpers/mockDemoPrisma.js';
import { runSeedDemo, REQUIRED_CONFIRMATION } from '../../prisma/scripts/seed-demo.js';

/** A real `PrismaClientKnownRequestError` shaped exactly like Prisma 5.22's serialization-conflict error. */
function p2034Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Transaction failed due to a write conflict or a deadlock. Please retry your transaction.',
    { code: 'P2034', clientVersion: '5.22.0' },
  );
}

/** A DIFFERENT `PrismaClientKnownRequestError` code — must never be retried. */
function p2002Error(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`email`)',
    {
      code: 'P2002',
      clientVersion: '5.22.0',
    },
  );
}

beforeEach(() => {
  process.env['DEMO_SEED_CONFIRM'] = REQUIRED_CONFIRMATION;
});

afterEach(() => {
  delete process.env['DEMO_SEED_CONFIRM'];
  vi.restoreAllMocks();
});

describe('db:seed:demo — Serializable isolation configuration', () => {
  it('every $transaction attempt requests Prisma.TransactionIsolationLevel.Serializable', async () => {
    const { prisma } = createMockDemoPrisma();

    await runSeedDemo(prisma);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const transactionMock = vi.mocked(prisma.$transaction);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    const [, options] = transactionMock.mock.calls[0] as [unknown, { isolationLevel?: string }];
    expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  });
});

describe('db:seed:demo — bounded retry on P2034 transaction conflict', () => {
  it('retries once and succeeds when the first attempt hits a P2034 conflict, rerunning the whole sequence', async () => {
    const { prisma, operationLog } = createMockDemoPrisma();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const transactionMock = vi.mocked(prisma.$transaction);
    transactionMock.mockImplementationOnce(() => Promise.reject(p2034Error()));
    // Second call falls through to the base implementation (`cb(tx)` → success).

    await runSeedDemo(prisma);

    expect(transactionMock).toHaveBeenCalledTimes(2);
    // Both calls requested Serializable isolation — the retry is not a
    // downgrade to a weaker (and unsafe) isolation level.
    for (const call of transactionMock.mock.calls) {
      const [, options] = call as [unknown, { isolationLevel?: string }];
      expect(options).toEqual({ isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    }
    // The successful (2nd) attempt reran the FULL marker-first sequence —
    // same ordering proof as the plain FIRST_RUN case in
    // seed-demo.atomicity.test.ts, not weakened here.
    expect(operationLog[0]).toBe('tx:demoSeedMarker.count');
    expect(operationLog).toContain('tx:demoSeedMarker.create');
    expect(operationLog).toContain('tx:user.upsert');
    expect(operationLog.every((op) => op.startsWith('tx:'))).toBe(true);
  });

  it('exhausts the bound on persistent P2034 conflicts and propagates the ORIGINAL error unchanged', async () => {
    const { prisma } = createMockDemoPrisma();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const transactionMock = vi.mocked(prisma.$transaction);
    const persistentConflict = p2034Error();
    transactionMock.mockImplementation(() => Promise.reject(persistentConflict));

    await expect(runSeedDemo(prisma)).rejects.toBe(persistentConflict);

    // Deterministic small bound: 3 total attempts (1 initial + 2 retries),
    // not unbounded retry/backoff.
    expect(transactionMock).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a non-retryable PrismaClientKnownRequestError (e.g. P2002) — propagates immediately', async () => {
    const { prisma } = createMockDemoPrisma();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const transactionMock = vi.mocked(prisma.$transaction);
    const uniqueViolation = p2002Error();
    transactionMock.mockImplementationOnce(() => Promise.reject(uniqueViolation));

    await expect(runSeedDemo(prisma)).rejects.toBe(uniqueViolation);

    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a non-Prisma error — propagates immediately', async () => {
    const { prisma } = createMockDemoPrisma();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const transactionMock = vi.mocked(prisma.$transaction);
    const genericFailure = new Error('unexpected connection drop');
    transactionMock.mockImplementationOnce(() => Promise.reject(genericFailure));

    await expect(runSeedDemo(prisma)).rejects.toBe(genericFailure);

    expect(transactionMock).toHaveBeenCalledTimes(1);
  });
});
