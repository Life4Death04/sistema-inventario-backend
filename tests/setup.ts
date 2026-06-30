/**
 * Global Vitest setup file shared by unit and integration test projects.
 *
 * Responsibilities:
 * - Ensures NODE_ENV is set to 'test' (loads .env.test when present).
 * - Disconnects PrismaClient after all tests to prevent open handles.
 *
 * Prisma guard is lazy: if @prisma/client is not yet generated (e.g. before
 * the first migration) the import fails silently — this file still loads.
 */
import { afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// --- Env guard ---------------------------------------------------------
// Load .env.test when present so vitest picks up the test DATABASE_URL etc.
const envTestPath = resolve(process.cwd(), '.env.test');
if (existsSync(envTestPath)) {
  const { config } = await import('dotenv');
  config({ path: envTestPath, override: true });
}

// After dotenv override, NODE_ENV must be 'test'.
if (process.env['NODE_ENV'] !== 'test') {
  process.env['NODE_ENV'] = 'test';
}

// --- PrismaClient teardown (lazy guard) --------------------------------
// The module path is resolved at runtime so TypeScript does not fail when
// the prisma singleton does not yet exist (Slice 2 not implemented yet).
afterAll(async () => {
  try {
    // Dynamic string-based import: TypeScript does not type-check the path.
    const modulePath = '../src/shared/utils/prisma.js';
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any
    const mod: any = await import(/* @vite-ignore */ modulePath).catch(() => null);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (mod !== null && typeof mod.prisma?.$disconnect === 'function') {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
      await mod.prisma.$disconnect();
    }
  } catch {
    // Prisma client not generated yet — safe to ignore during scaffold phase.
  }
});
