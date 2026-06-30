/**
 * Zod schemas and inferred types for the auth module.
 *
 * loginSchema validates the body of POST /api/auth/login.
 * All schemas are pure Zod — no Express dependency here.
 */
import { z } from 'zod';

/**
 * Schema for POST /api/auth/login body.
 * - email: valid email address (normalized to lowercase by Zod transform)
 * - password: any non-empty string (complexity rules are enforced elsewhere)
 */
export const loginSchema = z.object({
  email: z.string().email({ message: 'Must be a valid email address.' }),
  password: z.string().min(1, { message: 'Password is required.' }),
});

/** Inferred DTO type for the login endpoint body. */
export type LoginDto = z.infer<typeof loginSchema>;
