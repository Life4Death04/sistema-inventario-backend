/**
 * Committed public credentials for the shared demo account.
 *
 * Unlike `SEED_ADMIN_*` (prisma/seed.ts — private, env-driven, fabricated
 * identity used for real operational setup), these values are INTENTIONALLY
 * public and hardcoded. They identify the single `isDemo:true` ADMIN that
 * `db:seed:demo` (prisma/scripts/seed-demo.ts, PR5) creates or upserts, so
 * anyone can log in to the read-only public demo environment.
 *
 * design.md — File Changes: `src/shared/demo/demoCredentials.ts` (Create),
 * "Committed public constants (DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD,
 * DEMO_MARKER_VERSION)".
 * specs/database-schema/spec.md — "Non-destructive master-data demo
 * bootstrap": exactly one public ADMIN with `isDemo = true` and
 * intentionally public hardcoded credentials; public credentials MUST be
 * confined to exactly this one demo identity.
 *
 * Never wire these into `prisma/seed.ts` or any env-driven, private-admin
 * flow — public/private credential confinement is a hard requirement.
 */

/** Public login email for the shared demo ADMIN. Intentionally hardcoded. */
export const DEMO_ADMIN_EMAIL = 'demo@highmeds.local';

/** Public login password for the shared demo ADMIN. Intentionally hardcoded. */
export const DEMO_ADMIN_PASSWORD = 'HighMedsDemo2026!';

/**
 * Version stamp written into `DemoSeedMarker.version` on first-run
 * bootstrap. `seedSafety.resolveSeedState` fails closed (ABORT_MISMATCH)
 * when a persisted marker's version does not match this constant.
 */
export const DEMO_MARKER_VERSION = '1';
