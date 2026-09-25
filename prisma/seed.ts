/**
 * Database seed script.
 *
 * Creates (or idempotently updates) the initial, PRIVATE setup ADMIN user
 * using environment variables. The seed is safe to re-run: prisma.user.upsert
 * guarantees no duplicate email rows.
 *
 * `isDemo` is explicitly set to `false` in BOTH `create` and `update` — not
 * left to the schema column default, which only applies on insert. This
 * guarantees a rerun always re-asserts this account as the private setup
 * ADMIN, independent of the public demo bootstrap (`db:seed:demo`), per
 * design.md's "Setup ADMIN isDemo" decision (guest-environment-backend).
 *
 * Required env vars (script exits with code 1 if any are missing):
 *   SEED_ADMIN_EMAIL       — email for the admin account
 *   SEED_ADMIN_PASSWORD    — plain-text password (will be bcrypt-hashed, cost 10)
 *   SEED_ADMIN_FULLNAME    — display name for the admin account
 *
 * Usage:
 *   npm run db:seed
 */
import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcrypt';
import 'dotenv/config';

const BCRYPT_COST = 10;

interface SeedAdminEnv {
  email: string;
  password: string;
  fullName: string;
}

/**
 * Reads and validates the required SEED_ADMIN_* env vars. Aborts the process
 * (exit code 1, readable stderr message naming every missing var) if any are
 * absent — never introduces a new env var (no SEED_ADMIN_PHONE).
 */
function readSeedAdminEnv(): SeedAdminEnv {
  const email = process.env['SEED_ADMIN_EMAIL'];
  const password = process.env['SEED_ADMIN_PASSWORD'];
  const fullName = process.env['SEED_ADMIN_FULLNAME'];

  const missing: string[] = [];
  if (!email) missing.push('SEED_ADMIN_EMAIL');
  if (!password) missing.push('SEED_ADMIN_PASSWORD');
  if (!fullName) missing.push('SEED_ADMIN_FULLNAME');

  if (missing.length > 0) {
    console.error(
      `❌  Seed aborted — missing required environment variable(s): ${missing.join(', ')}\n` +
        `    Copy .env.example to .env and fill in the SEED_ADMIN_* values.`,
    );
    process.exit(1);
  }

  // TypeScript narrowing — values are guaranteed non-null past this point.
  return { email: email as string, password: password as string, fullName: fullName as string };
}

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Upserts the private setup ADMIN on the given `prisma` client. Exported so
 * tests can invoke it directly against a mocked client without triggering
 * the CLI's own `PrismaClient` connection or `process.exit` side effects —
 * env validation only runs (and can only abort the process) when this
 * function is actually called, matching `prisma/scripts/seed-demo.ts`'s
 * exported-function + `isMainModule`-guard shape.
 */
export async function main(prisma: PrismaClient): Promise<void> {
  const {
    email: adminEmail,
    password: adminPassword,
    fullName: adminFullName,
  } = readSeedAdminEnv();

  console.log('🌱  Seeding database…');

  const hashedPassword = await bcrypt.hash(adminPassword, BCRYPT_COST);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      // Update fullName and password on re-run so seed stays in sync with env.
      // The role stays ADMIN; active stays true. isDemo is re-asserted false
      // on every rerun — this is the PRIVATE setup account, never the public
      // demo account, and the column default alone would not cover this
      // branch (defaults only apply on insert).
      fullName: adminFullName,
      password: hashedPassword,
      isDemo: false,
    },
    create: {
      email: adminEmail,
      fullName: adminFullName,
      password: hashedPassword,
      role: UserRole.ADMIN,
      active: true,
      isDemo: false,
    },
  });

  console.log(`✅  Admin user ready: ${admin.email} (id: ${admin.id})`);
}

// ---------------------------------------------------------------------------
// Entry point — only runs when this file is executed directly (`npm run
// db:seed` / `prisma db seed`), never on import (e.g. from tests).
// ---------------------------------------------------------------------------

const isMainModule = import.meta.url === `file://${process.argv[1] ?? ''}`;
if (isMainModule) {
  const prisma = new PrismaClient();
  main(prisma)
    .catch((err: unknown) => {
      console.error('❌  Seed failed:', err);
      process.exit(1);
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
