/**
 * Environment variable validation — fail-fast at boot.
 *
 * Parses process.env with a Zod schema. If any required variable is missing
 * or invalid, prints a readable error and exits with code 1.
 *
 * Import this module BEFORE any other module that needs env values so the
 * process terminates immediately on misconfiguration.
 */
import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // Database — required (no default)
  DATABASE_URL: z.string().url({ message: 'DATABASE_URL must be a valid URL' }),

  // JWT — required, minimum 32 characters each
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),

  // Password hashing — spec requires minimum cost factor of 10.
  BCRYPT_COST: z.coerce.number().int().min(10).max(14).default(10),

  // CORS
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),

  // Rate limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),

  // Logging
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const fieldErrors = parsed.error.flatten().fieldErrors;
  console.error('❌  Invalid environment variables — server cannot start:\n');
  for (const [field, messages] of Object.entries(fieldErrors)) {
    const msg = messages?.join(', ') ?? 'invalid value';
    console.error(`  ${field}: ${msg}`);
  }
  console.error('\nCheck .env.example for the required format and values.');
  process.exit(1);
}

/** Validated, typed environment variables. Use this instead of process.env. */
export const env = parsed.data;
