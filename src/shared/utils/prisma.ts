/**
 * PrismaClient singleton.
 *
 * A single PrismaClient instance is reused across the application to avoid
 * exhausting the database connection pool. In test environments each test file
 * imports this module — Vitest's module cache ensures the same instance is
 * returned; afterAll in tests/setup.ts calls prisma.$disconnect() to release
 * the connection after the full test suite.
 *
 * Connection logging is enabled in development so slow queries are visible.
 */
import { PrismaClient, type Prisma } from '@prisma/client';
import { env } from '../../config/env.js';

const devLog: Prisma.LogLevel[] = ['query', 'warn', 'error'];
const prodLog: Prisma.LogLevel[] = ['warn', 'error'];

export const prisma = new PrismaClient({
  log: env.NODE_ENV === 'development' ? devLog : prodLog,
});
