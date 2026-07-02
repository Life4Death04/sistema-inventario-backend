# Change: stock-movements

**Track**: Feature module (SDD full: propose → spec → design → tasks → apply → verify → archive)
**Status**: Proposed — 2026-07-01
**Mode**: Hybrid (Engram + OpenSpec)
**Branch**: `feat/stock-movements`

## Why

`Product.stock` today is a single mutable integer with no history. `products-crud` deliberately rejects `stock` on PATCH and points consumers at a future inventory-movements endpoint (see `products/products.service.ts` PATCH guard). That endpoint does not exist yet, which means:

- No auditable trail of how stock reached its current value (who / when / why).
- No safe way to correct mistakes — direct DB writes would silently drift `Product.stock` from reality.
- Frontend cannot render a history view (mock still fills the gap).

The `InventoryMovement` model, `MovementType` enum, and `AdjustmentDirection` enum already exist in `prisma/schema.prisma` (committed by `backend-foundations`). This change delivers the API surface that turns those tables into the single write path for stock.

## What Changes

### API path: `/api/inventory-movements`

Naming honors the existing schema and the message already surfaced by `products-crud`
(`"stock is only modifiable via /api/inventory-movements"`). The orchestrator briefing
used `/api/stock-movements`; we DELIBERATELY align to the schema/product-message to
avoid a second rename downstream.

### Endpoints

| Method | Path                                          | Roles                    |
|--------|-----------------------------------------------|--------------------------|
| POST   | `/api/inventory-movements`                    | ADMIN, MANAGER, OPERATOR* |
| GET    | `/api/inventory-movements`                    | ADMIN, MANAGER, OPERATOR |
| GET    | `/api/inventory-movements/:id`                | ADMIN, MANAGER, OPERATOR |
| GET    | `/api/products/:id/inventory-movements`       | ADMIN, MANAGER, OPERATOR |

`*` OPERATOR on POST is restricted at the service layer to `type = OUT` only. Any
`IN` or `ADJUSTMENT` attempt returns `403 FORBIDDEN_MOVEMENT_TYPE`. ADMIN and
MANAGER can post all three types. Reads are shared per canon
(memory #317: role-authorization-model).

### Stock update semantics (source of truth)

Every successful POST runs inside a single `prisma.$transaction([...])`:

1. Read current `Product.stock` (with `product.active = true` guard).
2. Compute `resultingStock`:
   - `IN`  → `stock + quantity`
   - `OUT` → `stock - quantity`
   - `ADJUSTMENT` + `INCREASE` → `stock + quantity`
   - `ADJUSTMENT` + `DECREASE` → `stock - quantity`
3. If `resultingStock < 0` → abort transaction, return `409 INSUFFICIENT_STOCK`
   with `{ productId, currentStock, attemptedDelta }`.
4. Concurrency guard: `prisma.product.updateMany({ where: { id, stock: currentStock }, data: { stock: resultingStock } })` — if `count = 0`, the stock changed under us; return `409 STOCK_CONFLICT` (client re-reads and retries).
5. Insert `InventoryMovement` with `quantity` (always positive), `type`, `adjustmentDirection` (only for ADJUSTMENT), `reason`, `resultingStock`, `productId`, `userId = req.user.id`.

Result: `Product.stock` is a cached projection of the sum of movements. Movements are the source of truth. No drift.

### API request contract

- Common fields: `productId` (required), `reason` (required — schema-level, applies to ALL types).
- `IN` body: `{ type: "IN", productId, quantity, reason }`. `quantity` MUST be a positive integer.
- `OUT` body: `{ type: "OUT", productId, quantity, reason }`. `quantity` MUST be a positive integer.
- `ADJUSTMENT` body: `{ type: "ADJUSTMENT", productId, quantity, reason }` where `quantity` is a SIGNED integer (positive or negative, never zero). Service translates: `abs(quantity) → InventoryMovement.quantity`, `sign → adjustmentDirection`.

Rejected at Zod layer:
- `quantity = 0` (any type).
- `quantity < 0` for `IN` / `OUT`.
- `type = ADJUSTMENT` with `quantity = 0`.
- Missing `reason` (empty string / whitespace-only).

### Hard business rules

- **No negative stock**: any operation that would leave `Product.stock < 0` is rejected with `409 INSUFFICIENT_STOCK`.
- **Immutable**: no PATCH / PUT endpoint. Corrections are posted as compensating movements (usually an `ADJUSTMENT`).
- **Non-deletable**: no DELETE endpoint (neither soft nor hard). Historical integrity is absolute.
- **Product must be active**: posting a movement against a soft-deleted product returns `404 PRODUCT_NOT_FOUND` (mirrors products-crud DELETE idempotency guard).
- **`resultingStock` is written by the server** — clients never send it.

### List filters (`GET /api/inventory-movements`)

- `productId` (optional, cuid).
- `type` (optional, enum: `IN | OUT | ADJUSTMENT`).
- `from` (optional, ISO date, inclusive — filters `createdAt >= from`).
- `to` (optional, ISO date, inclusive — filters `createdAt <= to`).
- `userId` (optional, cuid — who created the movement).
- `page` (default 1, min 1), `pageSize` (default 20, min 1, max 100).
- Default sort: `createdAt desc` (newest first). Includes `product` (id, code, name) and `user` (id, fullName) in projection.

`GET /api/products/:id/inventory-movements` is the same shape minus `productId` (path takes precedence). Returns `404 PRODUCT_NOT_FOUND` if the product does not exist.

## Non-Goals

- Transfers between warehouses (no multi-warehouse concept yet).
- Purchase-order integration (future `replenishment-orders` module).
- Low-stock / out-of-stock alerts (schema has `Alert` model reserved; separate change).
- Aggregated reports / dashboards (sums, averages, valuation).
- Financial reporting (no `unitCost` field on the schema; not adding one in this slice).
- One-click reversal endpoint (documented workaround: post a compensating movement).
- PATCH / PUT / DELETE endpoints (see immutability rule).
- Bulk operations (POST array).

## Impact

### Files added

- `src/modules/inventory-movements/inventory-movements.schema.ts` — Zod contracts (body discriminated union on `type`, query filter schema).
- `src/modules/inventory-movements/inventory-movements.repository.ts` — Prisma queries (list with filters, findById, create-transaction wrapper).
- `src/modules/inventory-movements/inventory-movements.service.ts` — transactional stock update, role guard on POST (`OUT` for OPERATOR), concurrency guard, error codes.
- `src/modules/inventory-movements/inventory-movements.controller.ts` — request/response mapping.
- `src/modules/inventory-movements/inventory-movements.routes.ts` — 3 route registrations.
- `tests/smoke/inventory-movements.test.ts` — smoke tests following `tests/smoke/products.test.ts` shape.

### Files modified

- `src/app.ts` — register `/api/inventory-movements` router; register `/api/products/:id/inventory-movements` sub-resource (either as a second mount of the same router or a small delegation in products routes — decided in design).
- `src/modules/products/products.routes.ts` — mount the product-scoped movement history under `:id/inventory-movements`.
- `openspec/config.yaml` (if `testing_capabilities` needs a bump; likely no change).

### Files NOT touched

- `prisma/schema.prisma` — the `InventoryMovement` model, `MovementType`, and `AdjustmentDirection` enums are ALREADY committed by `backend-foundations`. No migration in this change.
- `.atl/.skill-registry.cache.json`, `.atl/skill-registry.md`, `package-lock.json` — known dirty, excluded.

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Race condition on concurrent stock writes (two OUT requests read same stock, both succeed, one leaves negative). | Medium | `prisma.product.updateMany({ where: { id, stock: currentStock } })` inside the transaction; `count = 0` → `409 STOCK_CONFLICT`. Client re-reads and retries. Documented as expected behavior in specs. |
| Integer overflow on `quantity` (Postgres `INT` is 32-bit signed). | Low | Zod bounds `quantity` to `[1, 1_000_000]` for IN/OUT and `[-1_000_000, 1_000_000] \ {0}` for ADJUSTMENT. Business context (pharmacy line items) never approaches this. |
| Products created before this module exist with non-zero `stock` and NO history rows. Historical reconstruction will not tie out to zero. | Medium (data-only) | Documented as a known baseline: `resultingStock` on the FIRST movement of each pre-existing product will reflect current stock + delta, but no synthetic backfill. Called out in verify phase; frontend history view treats "before first movement" as opaque. |
| `reason` is required by the schema but is UX friction for high-volume IN/OUT. | Low | Kept required — audit trail wins. Frontend can pre-fill (e.g., `"Restock"`, `"Sale"`) but backend does not default it. |
| `type = ADJUSTMENT` with signed quantity in the API vs positive-only in the DB. | Low | Explicit translation in the service layer; unit-testable. Zod schema for ADJUSTMENT explicitly allows negatives and forbids zero. |
| OPERATOR role guard sits at the service, not the router. | Low | All three POST branches go through one route; role is checked after the discriminated union parses `type`. Smoke tests explicitly cover OPERATOR × {IN, OUT, ADJUSTMENT}. |

## Rollback Plan

- Revert the feature branch (`feat/stock-movements`) — no schema migration in this change, so revert is code-only.
- If already merged: `git revert` the merge commit. `Product.stock` values remain valid because we never wrote a schema-breaking column. Any movements already inserted stay in `InventoryMovement` and can be replayed against a future re-introduction of the endpoints.
- Frontend continues to show mock history until the endpoints are restored.

## Dependencies

- `backend-foundations` (archived 2026-06-30) — provides `InventoryMovement` model + enums.
- `products-crud` (branch `feat/products-crud`, LGTM) — provides `Product` CRUD and the PATCH-stock rejection message this module honors.
- `users-crud` — JWT middleware sets `req.user.id`, consumed for `InventoryMovement.userId`.
- Role middleware `requireRole` — used with `('ADMIN', 'MANAGER', 'OPERATOR')` on POST; service-level guard restricts OPERATOR to `type = OUT`.

## First slice (this change)

| Method | Path                                          | Roles                        |
|--------|-----------------------------------------------|------------------------------|
| POST   | `/api/inventory-movements`                    | ADMIN, MANAGER (all types); OPERATOR (OUT only) |
| GET    | `/api/inventory-movements`                    | ADMIN, MANAGER, OPERATOR     |
| GET    | `/api/inventory-movements/:id`                | ADMIN, MANAGER, OPERATOR     |
| GET    | `/api/products/:id/inventory-movements`       | ADMIN, MANAGER, OPERATOR     |

## Success Criteria

- [ ] POST creates the movement AND updates `Product.stock` in the same transaction (verified by a smoke test that reads both back).
- [ ] Concurrent POSTs on the same product cannot produce negative stock (verified by a race-condition smoke test).
- [ ] All immutability guarantees hold: no PATCH, PUT, DELETE routes registered.
- [ ] OPERATOR can POST `OUT` but is rejected on `IN` and `ADJUSTMENT` with `403 FORBIDDEN_MOVEMENT_TYPE`.
- [ ] `INSUFFICIENT_STOCK` returns 409 with `{ productId, currentStock, attemptedDelta }`.
- [ ] `npm run typecheck`, `npm run lint`, `npm test` all green.

## Open questions

**None** — all product decisions locked by orchestrator briefing plus schema reconciliation captured in Engram #337.

Deviations from the orchestrator briefing (locked here, not reopened):

1. **URL path**: `/api/inventory-movements` (not `/api/stock-movements`) — honors existing schema names and the message emitted by `products-crud`.
2. **`ADJUSTMENT` model shape**: schema uses positive `quantity` + `adjustmentDirection` enum; API accepts signed delta and service translates.
3. **`reason` required for all types**: schema-level `String` (non-null) — not relaxed to optional for IN/OUT.
4. **No `unitCost`**: schema does not have the field; not added in this slice.
5. **`resultingStock` snapshot**: written by the server on every movement (schema requires it); this is a design win, not a briefing item.
