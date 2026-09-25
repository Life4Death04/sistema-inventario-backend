/**
 * Unit tests for demo credential confinement and rerun natural-key
 * idempotency, per tasks.md 5.4 + specs/database-schema/spec.md
 * ("Non-destructive master-data demo bootstrap" — public credentials
 * confined; "Natural-key and link idempotency").
 *
 * Two independent concerns in one file, matching the task grouping:
 *
 *   A. `POST /api/users` structurally cannot persist a demo identity: the
 *      `isDemo` field is stripped by `createUserSchema` (unknown key) before
 *      it ever reaches the repository, and a duplicate email (the public
 *      demo email) still yields 409 CONFLICT like any other email collision.
 *
 *   B. `bootstrapDemoData` matches Category/Product/Supplier by natural key
 *      on rerun — the SAME `where` clause is used both runs, so no
 *      duplicate-creating code path exists; descriptive fields may update.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createMockDemoPrisma } from '../helpers/mockDemoPrisma.js';
import { bootstrapDemoData } from '../../prisma/scripts/seed-demo.js';
import { DEMO_ADMIN_EMAIL } from '../../src/shared/demo/demoCredentials.js';

// ── A. POST /api/users confinement ──────────────────────────────────────────

vi.mock('../../src/shared/utils/prisma.js', () => ({
  prisma: {
    user: { create: vi.fn(), findFirst: vi.fn() },
  },
}));

const ADMIN_ID = 'clh3xxk0h0000356c9a5oba7k';

function adminToken(): string {
  return jwt.sign(
    { sub: ADMIN_ID, role: 'ADMIN' },
    process.env['JWT_ACCESS_SECRET'] ?? 'dev-access-secret-minimum-32-chars-ok',
    { algorithm: 'HS256', expiresIn: '15m' },
  );
}

describe('POST /api/users — demo credential confinement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('never persists isDemo:true even when the body sends it (unknown field stripped)', async () => {
    const { prisma } = await import('../../src/shared/utils/prisma.js');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(prisma.user.create).mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'new-user-id',
          fullName: data['fullName'],
          email: data['email'],
          role: data['role'] ?? 'OPERATOR',
          active: true,
          phone: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }) as unknown as Promise<never>,
    );

    const { app } = await import('../../src/app.js');
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({
        fullName: 'Fake Demo Clone',
        email: DEMO_ADMIN_EMAIL,
        password: 'SecurePass1!',
        role: 'ADMIN',
        isDemo: true, // MUST be stripped — createUserSchema has no isDemo field
      });

    expect(res.status).toBe(201);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const [createCall] = vi.mocked(prisma.user.create).mock.calls[0] as unknown as [
      { data: Record<string, unknown> },
    ];
    expect('isDemo' in createCall.data).toBe(false);
    expect((res.body as { user: { isDemo?: boolean } }).user.isDemo).toBeUndefined();
  });

  it('duplicate public demo email still yields 409 CONFLICT (no special-case bypass)', async () => {
    const { prisma } = await import('../../src/shared/utils/prisma.js');
    // eslint-disable-next-line @typescript-eslint/unbound-method
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      id: 'existing-demo-id',
      email: DEMO_ADMIN_EMAIL,
    } as unknown as never);

    const { app } = await import('../../src/app.js');
    const res = await request(app)
      .post('/api/users')
      .set('Authorization', `Bearer ${adminToken()}`)
      .send({ fullName: 'Another Clone', email: DEMO_ADMIN_EMAIL, password: 'SecurePass1!' });

    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toBe('CONFLICT');
  });
});

// ── B. Rerun natural-key idempotency ────────────────────────────────────────

interface UpsertCall {
  where: Record<string, unknown>;
}

/** Extracts the `where[key]` values from every recorded upsert call, in order. */
function wheresFor(mockFn: { mock: { calls: unknown[][] } }, key: string): unknown[] {
  return mockFn.mock.calls.map((c) => (c[0] as UpsertCall).where[key]);
}

describe('db:seed:demo — rerun matches entities by natural key (no duplicates)', () => {
  it('Category/Supplier/Product upserts use the SAME natural-key where clause on both runs', async () => {
    const { tx } = createMockDemoPrisma();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const categoryUpsert = vi.mocked(tx.category.upsert);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const supplierUpsert = vi.mocked(tx.supplier.upsert);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const productUpsert = vi.mocked(tx.product.upsert);

    await bootstrapDemoData(tx, true); // first run
    const categoryWheresFirst = wheresFor(categoryUpsert, 'name');
    const supplierWheresFirst = wheresFor(supplierUpsert, 'rif');
    const productWheresFirst = wheresFor(productUpsert, 'code');

    vi.clearAllMocks();

    await bootstrapDemoData(tx, false); // recognized rerun
    const categoryWheresSecond = wheresFor(categoryUpsert, 'name');
    const supplierWheresSecond = wheresFor(supplierUpsert, 'rif');
    const productWheresSecond = wheresFor(productUpsert, 'code');

    // Same natural keys, same count → no new distinct entity was introduced
    // by the rerun, i.e. no duplicate-creating code path exists.
    expect(new Set(categoryWheresSecond)).toEqual(new Set(categoryWheresFirst));
    expect(new Set(supplierWheresSecond)).toEqual(new Set(supplierWheresFirst));
    expect(new Set(productWheresSecond)).toEqual(new Set(productWheresFirst));
    expect(categoryWheresSecond.length).toBe(categoryWheresFirst.length);
    expect(supplierWheresSecond.length).toBe(supplierWheresFirst.length);
    expect(productWheresSecond.length).toBe(productWheresFirst.length);
  });
});
