/**
 * Database seed script.
 *
 * Creates (or idempotently updates) the initial ADMIN user using environment
 * variables. The seed is safe to re-run: prisma.user.upsert guarantees no
 * duplicate email rows.
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

// ---------------------------------------------------------------------------
// Guard — fail fast if seed env vars are missing
// ---------------------------------------------------------------------------

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

// TypeScript narrowing — values are guaranteed non-null past this point
const adminEmail = email as string;
const adminPassword = password as string;
const adminFullName = fullName as string;

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log('🌱  Seeding database…');

  const hashedPassword = await bcrypt.hash(adminPassword, BCRYPT_COST);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      // Update fullName and password on re-run so seed stays in sync with env.
      // The role stays ADMIN; active stays true.
      fullName: adminFullName,
      password: hashedPassword,
    },
    create: {
      email: adminEmail,
      fullName: adminFullName,
      password: hashedPassword,
      role: UserRole.ADMIN,
      active: true,
    },
  });

  console.log(`✅  Admin user ready: ${admin.email} (id: ${admin.id})`);
}

main()
  .catch((err: unknown) => {
    console.error('❌  Seed failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
