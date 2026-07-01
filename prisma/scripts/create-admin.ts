/**
 * One-shot script to create (or upsert) an additional ADMIN user.
 *
 * Unlike `prisma/seed.ts`, this script does NOT overwrite the primary seed
 * admin. It upserts a separate admin identified by ADMIN_EMAIL, so multiple
 * admin accounts can coexist in the same database — useful for manual API
 * testing (Postman, curl) without touching the seeded admin.
 *
 * Required env vars (script exits with code 1 if any are missing):
 *   ADMIN_EMAIL       — email for the admin account (must be a valid email)
 *   ADMIN_PASSWORD    — plain-text password (min 8 chars; will be bcrypt-hashed, cost 10)
 *   ADMIN_FULLNAME    — display name for the admin account
 *
 * Usage:
 *   ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_FULLNAME='...' npm run db:create-admin
 *
 * Idempotent: re-running with the same ADMIN_EMAIL updates fullName + password
 * and re-asserts role=ADMIN, active=true.
 */
import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcrypt';
import 'dotenv/config';

const BCRYPT_COST = 10;
const MIN_PASSWORD_LENGTH = 8;

// ---------------------------------------------------------------------------
// Guard — fail fast if required env vars are missing or invalid
// ---------------------------------------------------------------------------

const email = process.env['ADMIN_EMAIL'];
const password = process.env['ADMIN_PASSWORD'];
const fullName = process.env['ADMIN_FULLNAME'];

const missing: string[] = [];
if (!email) missing.push('ADMIN_EMAIL');
if (!password) missing.push('ADMIN_PASSWORD');
if (!fullName) missing.push('ADMIN_FULLNAME');

if (missing.length > 0) {
  console.error(
    `❌  create-admin aborted — missing required environment variable(s): ${missing.join(', ')}\n` +
      `    Usage: ADMIN_EMAIL=... ADMIN_PASSWORD=... ADMIN_FULLNAME='...' npm run db:create-admin`,
  );
  process.exit(1);
}

// TypeScript narrowing — values are guaranteed non-null past this point
const adminEmail = email as string;
const adminPassword = password as string;
const adminFullName = fullName as string;

// Basic email + password length checks (matches createUserSchema constraints).
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
if (!emailRegex.test(adminEmail)) {
  console.error(`❌  create-admin aborted — ADMIN_EMAIL is not a valid email: ${adminEmail}`);
  process.exit(1);
}
if (adminPassword.length < MIN_PASSWORD_LENGTH) {
  console.error(
    `❌  create-admin aborted — ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`,
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Upsert
// ---------------------------------------------------------------------------

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log(`👤  Upserting admin: ${adminEmail}`);

  const hashedPassword = await bcrypt.hash(adminPassword, BCRYPT_COST);

  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {
      fullName: adminFullName,
      password: hashedPassword,
      role: UserRole.ADMIN,
      active: true,
    },
    create: {
      email: adminEmail,
      fullName: adminFullName,
      password: hashedPassword,
      role: UserRole.ADMIN,
      active: true,
    },
  });

  console.log(`✅  Admin ready: ${admin.email} (id: ${admin.id}, role: ${admin.role})`);
}

main()
  .catch((err: unknown) => {
    console.error('❌  create-admin failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
