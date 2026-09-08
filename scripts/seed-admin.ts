/**
 * One-shot script to insert a specific ADMIN user into the database.
 *
 * Unlike `prisma/seed.ts` and `prisma/scripts/create-admin.ts`, this script
 * does not read configuration from environment variables — it inserts a
 * single, hardcoded admin record:
 *
 *   fullName: "Santiago Rodriguez"
 *   email:    "santiagodrm@gmail.com"
 *   password: "password" (bcrypt-hashed before storage, matching AuthService)
 *   role:     "ADMIN"
 *
 * Usage:
 *   npm run seed:admin
 */
import { PrismaClient, UserRole } from '@prisma/client';
import bcrypt from 'bcrypt';
import 'dotenv/config';

const BCRYPT_COST = 10;

const ADMIN_FULL_NAME = 'Santiago Rodriguez';
const ADMIN_EMAIL = 'santiagodrm@gmail.com';
const ADMIN_PASSWORD = 'password';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  console.log(`👤  Creating admin user: ${ADMIN_EMAIL}`);

  const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_COST);

  const admin = await prisma.user.create({
    data: {
      fullName: ADMIN_FULL_NAME,
      email: ADMIN_EMAIL,
      password: hashedPassword,
      role: UserRole.ADMIN,
    },
  });

  console.log(`✅  Admin user created: ${admin.email} (id: ${admin.id}, role: ${admin.role})`);
}

main()
  .catch((err: unknown) => {
    console.error('❌  seed-admin failed:', err);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
