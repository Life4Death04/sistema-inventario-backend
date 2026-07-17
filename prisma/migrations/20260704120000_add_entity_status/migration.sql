-- =============================================================================
-- Migration: add_entity_status
--
-- Additive — introduces EntityStatus enum and a `status` column on four models.
-- The existing `active` column and its indexes are PRESERVED on all tables
-- (drop deferred to a follow-up PR after the app swap lands in Slice B commit 2).
--
-- Backfill semantics (locked — Engram #485):
--   active = true  → ACTIVE
--   active = false → DELETED
--   Category rows  → ACTIVE unconditionally (Category had no `active` column)
--
-- Rollback plan: revert the Commit 2 app-swap code, then run a down migration that
-- drops the status columns/indexes and the EntityStatus enum. No data loss.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Create the EntityStatus PostgreSQL enum
-- ---------------------------------------------------------------------------

CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'DISABLED', 'DELETED');

-- ---------------------------------------------------------------------------
-- 2. User — add status column, backfill, set NOT NULL + default
-- ---------------------------------------------------------------------------

ALTER TABLE "User" ADD COLUMN "status" "EntityStatus";

UPDATE "User"
  SET "status" = CASE
    WHEN "active" = true  THEN 'ACTIVE'::"EntityStatus"
    ELSE                       'DELETED'::"EntityStatus"
  END;

ALTER TABLE "User" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

CREATE INDEX "User_status_idx" ON "User"("status");

-- ---------------------------------------------------------------------------
-- 3. Product — add status column, backfill, set NOT NULL + default
-- ---------------------------------------------------------------------------

ALTER TABLE "Product" ADD COLUMN "status" "EntityStatus";

UPDATE "Product"
  SET "status" = CASE
    WHEN "active" = true  THEN 'ACTIVE'::"EntityStatus"
    ELSE                       'DELETED'::"EntityStatus"
  END;

ALTER TABLE "Product" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "Product" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

CREATE INDEX "Product_status_idx" ON "Product"("status");

-- ---------------------------------------------------------------------------
-- 4. Supplier — add status column, backfill, set NOT NULL + default
-- ---------------------------------------------------------------------------

ALTER TABLE "Supplier" ADD COLUMN "status" "EntityStatus";

UPDATE "Supplier"
  SET "status" = CASE
    WHEN "active" = true  THEN 'ACTIVE'::"EntityStatus"
    ELSE                       'DELETED'::"EntityStatus"
  END;

ALTER TABLE "Supplier" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "Supplier" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

CREATE INDEX "Supplier_status_idx" ON "Supplier"("status");

-- ---------------------------------------------------------------------------
-- 5. Category — add status column (NOT NULL with DEFAULT; no backfill condition)
--    Category had no `active` column — all rows are unconditionally ACTIVE.
-- ---------------------------------------------------------------------------

ALTER TABLE "Category"
  ADD COLUMN "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE';

CREATE INDEX "Category_status_idx" ON "Category"("status");

-- ---------------------------------------------------------------------------
-- NOTE: `active` columns and @@index([active]) indexes are intentionally kept.
-- They will be removed in the follow-up PR after commit 2 (app swap) ships.
-- ---------------------------------------------------------------------------
