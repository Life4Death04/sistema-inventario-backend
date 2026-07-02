-- =============================================================================
-- Migration: add_replenishment_audit_and_partial_receipt
--
-- Non-destructive: all new columns are nullable; indexes/unique are additive.
--
-- Pre-check (run before applying in production):
--   SELECT COUNT(*) FROM (
--     SELECT "replenishmentRequestId", "productId"
--     FROM "ReplenishmentRequestItem"
--     GROUP BY 1, 2
--     HAVING COUNT(*) > 1
--   ) dupes;
--   -- Must return 0 before the @@unique constraint is safe to add.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- ReplenishmentRequest: add audit and cancellation fields
-- ---------------------------------------------------------------------------

ALTER TABLE "ReplenishmentRequest"
  ADD COLUMN "receivedAt"        TIMESTAMP(3),
  ADD COLUMN "cancelledAt"       TIMESTAMP(3),
  ADD COLUMN "receivedByUserId"  TEXT,
  ADD COLUMN "cancelledByUserId" TEXT;

-- FK: receivedByUserId → User (ReplenishmentReceiver relation)
ALTER TABLE "ReplenishmentRequest"
  ADD CONSTRAINT "ReplenishmentRequest_receivedByUserId_fkey"
  FOREIGN KEY ("receivedByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- FK: cancelledByUserId → User (ReplenishmentCanceller relation)
ALTER TABLE "ReplenishmentRequest"
  ADD CONSTRAINT "ReplenishmentRequest_cancelledByUserId_fkey"
  FOREIGN KEY ("cancelledByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Composite index for common filter: status by supplier
CREATE INDEX "ReplenishmentRequest_supplierId_status_idx"
  ON "ReplenishmentRequest"("supplierId", "status");

-- Indexes for FK lookups on the new columns
CREATE INDEX "ReplenishmentRequest_receivedByUserId_idx"
  ON "ReplenishmentRequest"("receivedByUserId");

CREATE INDEX "ReplenishmentRequest_cancelledByUserId_idx"
  ON "ReplenishmentRequest"("cancelledByUserId");

-- ---------------------------------------------------------------------------
-- ReplenishmentRequestItem: add receivedQuantity + unique constraint
-- ---------------------------------------------------------------------------

ALTER TABLE "ReplenishmentRequestItem"
  ADD COLUMN "receivedQuantity" INTEGER;

-- Unique constraint: one item row per (request, product) pair.
-- Prevents ambiguous partial-receive scenarios.
CREATE UNIQUE INDEX "ReplenishmentRequestItem_replenishmentRequestId_productId_key"
  ON "ReplenishmentRequestItem"("replenishmentRequestId", "productId");
