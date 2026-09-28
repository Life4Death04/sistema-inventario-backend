/**
 * Unit tests for `prisma/seed.ts` (private setup ADMIN, `db:seed`).
 *
 * Per tasks.md 6.1 + design.md ("Setup ADMIN `isDemo`" decision row):
 *   - The `user.upsert` call sets `isDemo:false` explicitly in BOTH `create`
 *     and `update` — not relying on the schema column default, which only
 *     applies on insert and would leave a rerun free to flip an
 *     accidentally-demo row back to non-demo without an explicit write.
 *   - Identity (`fullName`/`email`) is sourced from the EXISTING
 *     `SEED_ADMIN_FULLNAME`/`SEED_ADMIN_EMAIL` env vars — no new env var
 *     introduced for this change.
 *   - The password is bcrypt-hashed (cost 10) from `SEED_ADMIN_PASSWORD`.
 *   - `phone` stays unset/null — no `SEED_ADMIN_PHONE` env var exists or is
 *     read.
 *   - A missing `SEED_ADMIN_PASSWORD` aborts readably (console.error names
 *     the missing var) before any Prisma call.
 *
 * `prisma/seed.ts` exports `main(prisma)` and gates its own CLI auto-run
 * behind an `isMainModule` check (mirrors `prisma/scripts/seed-demo.ts`),
 * so importing it here for direct, targeted `main()` invocation never
 * touches a real database or calls `process.exit` outside the abort case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

function createMockPrisma(): { upsert: ReturnType<typeof vi.fn> } & Record<string, unknown> {
  const upsert = vi.fn(() =>
    Promise.resolve({ id: 'setup-admin-id', email: 'admin@example.test' }),
  );
  return { user: { upsert } } as unknown as { upsert: ReturnType<typeof vi.fn> } & Record<
    string,
    unknown
  >;
}

describe('prisma/seed.ts — main()', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('SEED_ADMIN_EMAIL', 'admin@example.test');
    vi.stubEnv('SEED_ADMIN_PASSWORD', 'SuperSecret1!');
    vi.stubEnv('SEED_ADMIN_FULLNAME', 'Setup Administrator');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('upserts the setup ADMIN with isDemo:false in BOTH create and update', async () => {
    const { user } = createMockPrisma() as unknown as {
      user: { upsert: ReturnType<typeof vi.fn> };
    };
    const mockPrisma = { user } as unknown as PrismaClient;

    const { main } = await import('../../prisma/seed.js');
    await main(mockPrisma);

    expect(user.upsert).toHaveBeenCalledTimes(1);
    const [call] = user.upsert.mock.calls[0] as [
      {
        where: { email: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      },
    ];

    expect(call.where.email).toBe('admin@example.test');
    expect(call.create['isDemo']).toBe(false);
    expect(call.update['isDemo']).toBe(false);
  });

  it('sources fullName/email from SEED_ADMIN_FULLNAME/SEED_ADMIN_EMAIL, not a new env var', async () => {
    const { user } = createMockPrisma() as unknown as {
      user: { upsert: ReturnType<typeof vi.fn> };
    };
    const mockPrisma = { user } as unknown as PrismaClient;

    const { main } = await import('../../prisma/seed.js');
    await main(mockPrisma);

    const [call] = user.upsert.mock.calls[0] as [
      {
        where: { email: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      },
    ];

    expect(call.create['email']).toBe('admin@example.test');
    expect(call.create['fullName']).toBe('Setup Administrator');
    expect(call.update['fullName']).toBe('Setup Administrator');
  });

  it('hashes SEED_ADMIN_PASSWORD with bcrypt (never stores the plaintext)', async () => {
    const { user } = createMockPrisma() as unknown as {
      user: { upsert: ReturnType<typeof vi.fn> };
    };
    const mockPrisma = { user } as unknown as PrismaClient;

    const { main } = await import('../../prisma/seed.js');
    await main(mockPrisma);

    const [call] = user.upsert.mock.calls[0] as [
      { create: Record<string, unknown>; update: Record<string, unknown> },
    ];

    expect(call.create['password']).not.toBe('SuperSecret1!');
    expect(typeof call.create['password']).toBe('string');
    expect((call.create['password'] as string).startsWith('$2')).toBe(true); // bcrypt hash prefix
    expect(typeof call.update['password']).toBe('string');
    expect(call.update['password']).not.toBe('SuperSecret1!');
  });

  it('leaves phone unset in both create and update (no SEED_ADMIN_PHONE env var read)', async () => {
    vi.stubEnv('SEED_ADMIN_PHONE', '+58-412-0000000'); // must be ignored even if present
    const { user } = createMockPrisma() as unknown as {
      user: { upsert: ReturnType<typeof vi.fn> };
    };
    const mockPrisma = { user } as unknown as PrismaClient;

    const { main } = await import('../../prisma/seed.js');
    await main(mockPrisma);

    const [call] = user.upsert.mock.calls[0] as [
      { create: Record<string, unknown>; update: Record<string, unknown> },
    ];

    expect('phone' in call.create).toBe(false);
    expect('phone' in call.update).toBe(false);
  });

  it('aborts readably when SEED_ADMIN_PASSWORD is missing, before any Prisma call', async () => {
    vi.stubEnv('SEED_ADMIN_PASSWORD', '');
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${String(code)})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { user } = createMockPrisma() as unknown as {
      user: { upsert: ReturnType<typeof vi.fn> };
    };
    const mockPrisma = { user } as unknown as PrismaClient;

    const { main } = await import('../../prisma/seed.js');

    await expect(main(mockPrisma)).rejects.toThrow('process.exit(1)');

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [message] = errorSpy.mock.calls[0] as [string];
    expect(message).toContain('SEED_ADMIN_PASSWORD');
    expect(user.upsert).not.toHaveBeenCalled();
  });
});
