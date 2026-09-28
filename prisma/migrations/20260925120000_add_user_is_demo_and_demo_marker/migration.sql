-- =============================================================================
-- Migration: add_user_is_demo_and_demo_marker
--
-- Additive — introduces `User.isDemo` (read-only demo account marker) and a
-- standalone `DemoSeedMarker` table (single-row sentinel for the `db:seed:demo`
-- safety state machine). Part of guest-environment-backend.
--
-- Backfill semantics:
--   Every pre-existing `User` row becomes isDemo = false (non-demo, unaffected).
--
-- `DemoSeedMarker` is created EMPTY (no row inserted here) so the first-run
-- `db:seed:demo` execution proves a truly empty application database before
-- `db:seed` adds the private setup ADMIN (demo-seed-first deploy order).
--
-- Rollback plan: drop the `isDemo` column + its index, and drop the
-- `DemoSeedMarker` table. Additive change — no data loss on rollback.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. User — add isDemo column, backfill, set NOT NULL + default
-- ---------------------------------------------------------------------------

ALTER TABLE "User" ADD COLUMN "isDemo" BOOLEAN;

UPDATE "User" SET "isDemo" = false;

ALTER TABLE "User" ALTER COLUMN "isDemo" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "isDemo" SET DEFAULT false;

CREATE INDEX "User_isDemo_idx" ON "User"("isDemo");

-- ---------------------------------------------------------------------------
-- 2. DemoSeedMarker — new standalone table, created empty
-- ---------------------------------------------------------------------------

CREATE TABLE "DemoSeedMarker" (
    "id" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DemoSeedMarker_pkey" PRIMARY KEY ("id")
);
