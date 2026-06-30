import { defineConfig } from 'vitest/config';

/**
 * Vitest configuration — two logical test projects:
 *   - unit:        src/**\/*.test.ts  (fast, no real DB)
 *   - integration: tests/**\/*.test.ts (slower, may need DB)
 *
 * Both share the same global setup file (tests/setup.ts).
 * Run all: `npm test`  (vitest run)
 * Watch:   `npm run test:watch`
 */
export default defineConfig({
  test: {
    // Collect tests from both locations
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Global setup runs before every test file in every project
    setupFiles: ['./tests/setup.ts'],
    environment: 'node',
    // Integration tests hit real DB — give them more time
    testTimeout: 15_000,
    hookTimeout: 15_000,
    // Reporter
    reporters: ['verbose'],
  },
});
