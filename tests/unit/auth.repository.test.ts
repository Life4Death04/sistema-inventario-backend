/**
 * Unit tests for AuthRepository.pruneDeadRefreshTokens().
 *
 * Tests per tasks.md 3.1 + specs/auth/spec.md
 * (Requirement: Demo-scoped refresh-token cleanup):
 *   - Deletes only rows scoped to the given userId (no cross-user leakage).
 *   - Deletes only rows that are revoked=true OR already past expiresAt.
 *   - The query never targets live/unexpired rows.
 *
 * Prisma is fully mocked — no real DB required. Asserts the exact `where`
 * clause passed to `deleteMany`, matching the direct-unit-assertion style
 * used by tests/unit/assertMutationAllowed.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/shared/utils/prisma.js', () => ({
  prisma: {
    refreshToken: {
      deleteMany: vi.fn(),
    },
  },
}));

import { prisma } from '../../src/shared/utils/prisma.js';
import { AuthRepository } from '../../src/modules/auth/auth.repository.js';

type DeleteManyWhere = {
  userId: string;
  OR: Array<{ revoked?: boolean; expiresAt?: { lt: Date } }>;
};

describe('AuthRepository.pruneDeadRefreshTokens()', () => {
  const repository = new AuthRepository();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('scopes the delete to the given userId and to dead rows only (revoked OR expired)', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockDeleteMany = vi.mocked(prisma.refreshToken.deleteMany);
    mockDeleteMany.mockResolvedValue({ count: 2 });

    const before = Date.now();
    await repository.pruneDeadRefreshTokens('cuid-user-demo-1');
    const after = Date.now();

    expect(mockDeleteMany).toHaveBeenCalledTimes(1);
    const [call] = mockDeleteMany.mock.calls[0] as unknown as [{ where: DeleteManyWhere }];

    expect(call.where.userId).toBe('cuid-user-demo-1');
    expect(call.where.OR).toContainEqual({ revoked: true });

    const expiredClause = call.where.OR.find((clause) => 'expiresAt' in clause);
    expect(expiredClause?.expiresAt?.lt).toBeInstanceOf(Date);
    const ltTime = expiredClause?.expiresAt?.lt.getTime() ?? 0;
    expect(ltTime).toBeGreaterThanOrEqual(before);
    expect(ltTime).toBeLessThanOrEqual(after);
  });

  it('never leaks scope across users — each call is bound to its own userId', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockDeleteMany = vi.mocked(prisma.refreshToken.deleteMany);
    mockDeleteMany.mockResolvedValue({ count: 0 });

    await repository.pruneDeadRefreshTokens('cuid-user-a');
    await repository.pruneDeadRefreshTokens('cuid-user-b');

    const [callA] = mockDeleteMany.mock.calls[0] as unknown as [{ where: DeleteManyWhere }];
    const [callB] = mockDeleteMany.mock.calls[1] as unknown as [{ where: DeleteManyWhere }];
    expect(callA.where.userId).toBe('cuid-user-a');
    expect(callB.where.userId).toBe('cuid-user-b');
  });

  it('the OR clause contains exactly revoked/expired — no clause matches a live row', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockDeleteMany = vi.mocked(prisma.refreshToken.deleteMany);
    mockDeleteMany.mockResolvedValue({ count: 0 });

    await repository.pruneDeadRefreshTokens('cuid-user-x');

    const [call] = mockDeleteMany.mock.calls[0] as unknown as [{ where: DeleteManyWhere }];
    expect(call.where.OR).toHaveLength(2);
    for (const clause of call.where.OR) {
      const isRevokedClause = clause.revoked === true;
      const isExpiredClause = clause.expiresAt !== undefined;
      expect(isRevokedClause || isExpiredClause).toBe(true);
    }
  });

  it('returns the deleted row count', async () => {
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockDeleteMany = vi.mocked(prisma.refreshToken.deleteMany);
    mockDeleteMany.mockResolvedValue({ count: 3 });

    const result = await repository.pruneDeadRefreshTokens('cuid-user-y');
    expect(result).toBe(3);
  });
});
