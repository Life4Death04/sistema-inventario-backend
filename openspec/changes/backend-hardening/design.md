# Design: backend-hardening

## Technical Approach

Two additive slices delivered as a chained PR pair.

**Slice A (PR1)** applies the existing `stash@{0}` (replenishment enrichment) verbatim, then extends the same pattern — summary-select constants + service-level mappers — to `inventory-movements` and `suppliers`. Purely additive to response DTOs.

**Slice B (PR2)** replaces the boolean `active` field with a shared `EntityStatus { ACTIVE, DISABLED, DELETED }` enum on User, Product, Supplier, and Category via an additive-then-swap migration. `active` column stays alive until a follow-up PR. Delivered as two commits inside PR2: (1) Prisma migration + client regen; (2) application swap + tests. Locked by post-propose decisions (Engram #485).

## Architecture Decisions

### Decision: Summary DTOs — per-module colocation

**Choice**: Colocate `ProductSummary`, `UserSummary`, `SupplierSummary` in each consumer module's `*.schema.ts` (matches stash).
**Alternatives**: shared `src/shared/dto/summaries.ts`.
**Rationale**: The codebase has NO shared DTO barrel today; every module owns its schemas. The stash — reviewed and paused, not rejected — already uses per-module `ReplenishmentSupplierSummaryDto` etc. Introducing a shared barrel now is scope creep, forces cross-module rename, and inflates PR1 by ~80 lines. Duplication cost is 3 tiny type aliases; refactor can happen later without breaking callers.

### Decision: Summary DTO fields

**Choice**:
- `ProductSummary { id, name, code }`
- `UserSummary { id, fullName }`
- `SupplierSummary { id, name }`

**Alternatives**: include `email` in UserSummary, `rif` in SupplierSummary.
**Rationale**: Minimal viable identity + label. UI needs a display string; `code` on Product is already surfaced elsewhere and users scan by code. Adding `email`/`rif` broadens the response contract without a driving requirement and increases the enrichment surface each time the SELECT changes. Slice B/future work can widen if requested. Note: `fullName` (not `name`) because that is the actual Prisma field on `User`.

### Decision: Mapper strategy — service-level

**Choice**: Repository returns raw enriched rows via `select`; service `toDto` mappers normalize dates and `Decimal` to strings.
**Alternatives**: repository returns pre-mapped DTOs.
**Rationale**: Matches every existing module (`ProductsService.serializeDetail` lives in the repo but Decimal→string is the pattern; `ReplenishmentRequestsService.toDto` is the canonical mapper example). Consistency > novelty. Repositories stay Prisma-shaped; services own the DTO contract.

### Decision: Enum name and location — `EntityStatus` in `schema.prisma`

**Choice**: `enum EntityStatus { ACTIVE DISABLED DELETED }` declared once in `schema.prisma`, reused by 4 models via `status EntityStatus @default(ACTIVE)`.
**Alternatives**: `LifecycleStatus`; per-entity enums (`UserStatus`, `ProductStatus`, ...).
**Rationale**: `EntityStatus` reads as domain-agnostic soft-delete lifecycle; `LifecycleStatus` is a valid synonym but longer. Per-entity enums duplicate values and force fan-out on every guard. Prisma supports one enum shared by many models — validated pattern (see `UserRole` used only on `User` but the mechanism is identical). Postgres will store one `"EntityStatus"` type. Naming rationale documented for future contributors.

### Decision: Guard pattern — centralized helper (Option A)

**Choice**: `src/shared/guards/status.ts` exports `assertActive(entity, entityName)` and `assertNotDeleted(entity, entityName)`. Throws `AppError(ERROR_CODES.ENTITY_NOT_ACTIVE, 409, ...)` or `AppError(ERROR_CODES.NOT_FOUND, 404, ...)` respectively.
**Alternatives**: B inline per service; C hybrid.
**Rationale**: Guards fire in 8+ call sites (`softDelete`, `attachSupplier` × 2, `createMovement`, `attemptStockUpdate`, `update`, `receive`, ...). Centralization saves ~40–60 lines vs inline duplication — meaningful given PR2's 1,020-line forecast. `entityName` param keeps error messages contextual (`"Supplier is not active."` vs `"Product is not active."`). Two helpers instead of one because DELETED (404 hide) and DISABLED (409 block) have different HTTP semantics. Add two new error codes: `ENTITY_NOT_ACTIVE` and reuse existing `NOT_FOUND` for DELETED.

Signature (design-only, not implemented here):
```
assertActive(entity: { status: EntityStatus } | null, entityName: string): asserts entity is { status: 'ACTIVE' }
assertNotDeleted(entity: { status: EntityStatus } | null, entityName: string): asserts entity is NonNullable<...>
```

### Decision: List filter default and query param — `?status=all`

**Choice**: Default list behavior returns `ACTIVE + DISABLED` (hides `DELETED`). Override with `?status=all` (returns everything including DELETED). Also accept `?status=active | disabled | deleted` for exact filtering. Consistent across users, products, suppliers, categories.
**Alternatives**: `?includeDeleted=true` boolean.
**Rationale**: One knob (`status`) is more expressive than a boolean and mirrors the enum vocabulary. `all` is the escape hatch for admin/audit views. Boolean forces a second param to filter by DISABLED specifically. Query param replaces the current `active` boolean param across all 4 modules — this IS a breaking query-string change and must appear in spec.

### Decision: `PRODUCT_DETAIL_SELECT.supplier.active` → `.supplier.status` in Slice B commit 2

**Choice**: Swap the nested `supplier.active` field in `PRODUCT_DETAIL_SELECT` and `listSuppliers` to `supplier.status` in Slice B's application-swap commit.
**Alternatives**: include in Slice A.
**Rationale**: Slice A must stay purely additive (new fields, no removed/renamed fields) so it can ship independently and roll back cleanly. `supplier.active` is a RENAME, not an addition; touching it in A couples the two slices. Slice B commit 2 already renames `active`→`status` everywhere else in the same file — it is the natural home.

## Data Flow

Slice A — enrichment (movements example):

    Controller → Service.list
                    │
                    ▼
              Repository.list ── prisma.select (MOVEMENT_ENRICHED_SELECT with product+user)
                    │
                    ▼
              MovementRow[] ─── Service.toDto (embeds ProductSummary, UserSummary)
                    │
                    ▼
              MovementDto[] → JSON response

Slice B — status guard flow:

    Controller → Service.<op>
                    │
                    ▼
              Repository.findById (select includes status)
                    │
                    ▼
              assertActive(entity, "Supplier") ─── throws AppError if !ACTIVE
                    │
                    ▼
              Repository.write (data: { status: 'DELETED' } on softDelete)

## File Changes

### Slice A (PR1)

| File | Action | Description |
|------|--------|-------------|
| `src/modules/replenishment-requests/replenishment-requests.repository.ts` | Modify | Apply stash: add SUMMARY selects + REQUEST_LIST_SELECT |
| `src/modules/replenishment-requests/replenishment-requests.schema.ts` | Modify | Apply stash: summary DTOs + enriched RequestDto/ItemDto |
| `src/modules/replenishment-requests/replenishment-requests.service.ts` | Modify | Apply stash: toProductSummaryDto, calculateRequestMetrics, updated toDto |
| `openspec/specs/replenishment-requests/spec.md` | Modify | Apply stash: enrichment scenarios |
| `tests/smoke/replenishment-requests.test.ts` | Modify | Apply stash: enrichment assertions |
| `src/modules/inventory-movements/inventory-movements.repository.ts` | Modify | Add PRODUCT_SUMMARY_SELECT, USER_SUMMARY_SELECT, MOVEMENT_ENRICHED_SELECT; new MovementRow type |
| `src/modules/inventory-movements/inventory-movements.schema.ts` | Modify | Extend MovementDto with `product`, `user` summary fields |
| `src/modules/inventory-movements/inventory-movements.service.ts` | Modify | Add enriched mapper (Dates, Decimals, embedded summaries) |
| `src/modules/suppliers/suppliers.repository.ts` | Modify | Add SUPPLIER_WITH_PRODUCTS_SELECT; return `products[]` + `productsCount` |
| `src/modules/suppliers/suppliers.schema.ts` | Modify | Add `products: ProductSummary[]`, `productsCount: number` to SupplierResponseDto |
| `src/modules/suppliers/suppliers.service.ts` | Modify | Extend mapper for enriched shape |

### Slice B (PR2)

**Commit 1 — migration**

| File | Action | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modify | Add `enum EntityStatus`; add `status EntityStatus @default(ACTIVE)` on User, Product, Supplier, Category; add `@@index([status])`; keep `active` and `@@index([active])` intact |
| `prisma/migrations/<ts>_add_entity_status/migration.sql` | Create | See "Migration design" below |

**Commit 2 — application swap**

| File | Action | Description |
|------|--------|-------------|
| `src/shared/guards/status.ts` | Create | `assertActive`, `assertNotDeleted` helpers |
| `src/shared/errors/errorCodes.ts` | Modify | Add `ENTITY_NOT_ACTIVE` |
| `src/modules/users/users.{repository,service,schema}.ts` | Modify | Swap `active` → `status`; new list filter; guards |
| `src/modules/products/products.{repository,service,schema}.ts` | Modify | Swap `active` → `status`; low-stock raw SQL; PRODUCT_DETAIL_SELECT.supplier.status; guards |
| `src/modules/suppliers/suppliers.{repository,service,schema}.ts` | Modify | Swap `active` → `status`; guards |
| `src/modules/inventory-movements/inventory-movements.repository.ts` | Modify | `findProductActive` → `findProductStatus`; `attemptStockUpdate` CAS uses `status: 'ACTIVE'` |
| `src/modules/categories/categories.{repository,service,schema,routes,controller}.ts` | Modify | NEW soft-delete surface: `softDelete` sets `status: 'DELETED'`; list filter defaults hide DELETED; DELETE route becomes soft |
| `prisma/seed.ts` | Modify | ADMIN seed uses `status: 'ACTIVE'` (drop `active: true`) |
| `tests/smoke/*.test.ts` | Modify | Update fixtures + assertions for `status`; add DISABLED/DELETED transitions |

## Interfaces / Contracts

### Shared enum (Prisma)

```prisma
enum EntityStatus {
  ACTIVE
  DISABLED
  DELETED
}
```

### Summary DTOs (per-module, TypeScript)

```ts
type ProductSummary  = { id: string; name: string; code: string };
type UserSummary     = { id: string; fullName: string };
type SupplierSummary = { id: string; name: string };
```

### Guard helpers (`src/shared/guards/status.ts`)

```ts
import { AppError } from '../errors/AppError.js';
import { ERROR_CODES } from '../errors/errorCodes.js';

export function assertNotDeleted<T extends { status: string } | null>(
  entity: T, entityName: string,
): asserts entity is NonNullable<T> {
  if (!entity || entity.status === 'DELETED') {
    throw new AppError(ERROR_CODES.NOT_FOUND, 404, `${entityName} not found.`);
  }
}

export function assertActive<T extends { status: string } | null>(
  entity: T, entityName: string,
): asserts entity is NonNullable<T> {
  assertNotDeleted(entity, entityName);
  if ((entity as NonNullable<T>).status !== 'ACTIVE') {
    throw new AppError(ERROR_CODES.ENTITY_NOT_ACTIVE, 409, `${entityName} is not active.`);
  }
}
```

### Query param shape (schema.ts, all 4 modules)

```ts
status: z.enum(['active', 'disabled', 'deleted', 'all']).optional().default('active_or_disabled_alias')
```
Alias resolution: when omitted, repository filters `status IN [ACTIVE, DISABLED]`. When `all`, no filter. Otherwise exact match.

## Migration design (Commit 1 SQL)

Executed in this exact order per table (User, Product, Supplier):

```sql
-- 1. Create enum type (once)
CREATE TYPE "EntityStatus" AS ENUM ('ACTIVE', 'DISABLED', 'DELETED');

-- 2. Add nullable column temporarily to allow backfill
ALTER TABLE "User" ADD COLUMN "status" "EntityStatus";
UPDATE "User" SET "status" = CASE WHEN "active" = true THEN 'ACTIVE'::"EntityStatus" ELSE 'DELETED'::"EntityStatus" END;
ALTER TABLE "User" ALTER COLUMN "status" SET NOT NULL;
ALTER TABLE "User" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';

-- Repeat identical block for "Product" and "Supplier".

-- Category — no active column; column comes in with default:
ALTER TABLE "Category" ADD COLUMN "status" "EntityStatus" NOT NULL DEFAULT 'ACTIVE';

-- 3. Indexes — ADD status, KEEP active (drop deferred to follow-up PR)
CREATE INDEX "User_status_idx"     ON "User"("status");
CREATE INDEX "Product_status_idx"  ON "Product"("status");
CREATE INDEX "Supplier_status_idx" ON "Supplier"("status");
CREATE INDEX "Category_status_idx" ON "Category"("status");
```

Backfill semantics (locked, Engram #485): `active=true → ACTIVE`, `active=false → DELETED`, Category rows → ACTIVE.

## Raw SQL swap — `products.repository.ts` lowStock

Current:
```ts
SELECT id FROM "Product" WHERE stock <= "minStock" AND active = ${active}
```

Replacement:
```ts
// `statusFilter` is a TS-side computed literal from the resolved status query param
// (e.g. 'ACTIVE' when default, or ('ACTIVE','DISABLED') for the default-visible set).
SELECT id FROM "Product"
WHERE stock <= "minStock"
  AND status = ${statusFilter}::"EntityStatus"
```

For the default view (ACTIVE + DISABLED), use an `IN` clause with `Prisma.sql`:
```ts
prisma.$queryRaw<Array<{ id: string }>>`
  SELECT id FROM "Product"
  WHERE stock <= "minStock"
    AND status IN ('ACTIVE'::"EntityStatus", 'DISABLED'::"EntityStatus")
`;
```
The cast is required because Postgres treats bare string literals as `text`, not `EntityStatus`, and would raise a type mismatch on the enum column comparison.

## Alerts hook safety

`alertsRepository.reconcile(tx, productId, nextStock, minStock)` receives scalars precomputed by the service and does not read `product.active` or `product.status`. Confirmed in exploration (Engram #482). **No changes required to alerts.**

## Testing Strategy

| Layer | What to Test | Approach |
|-------|-------------|----------|
| Smoke (Slice A) | Enrichment shape on movements/suppliers/replenishments | Assert response contains `product.{id,name,code}`, `user.{id,fullName}`, `supplier.{id,name}`; assert no raw FK-only responses on enriched endpoints |
| Smoke (Slice B) | Status transitions | Create ACTIVE → PATCH to DISABLED → verify list default returns it → PATCH to DELETED → verify list default hides it, `?status=all` returns it |
| Smoke (Slice B) | Guards | Attempt movement/attach against DISABLED and DELETED targets → assert 409 `ENTITY_NOT_ACTIVE` and 404 `NOT_FOUND` respectively |
| Smoke (Slice B) | Low-stock raw SQL | Seed products in ACTIVE + DISABLED + DELETED states below minStock → assert default `lowStock` filter returns ACTIVE+DISABLED only |
| Migration | Backfill correctness | Apply migration on seeded DB where `active=false` rows exist → assert `status = DELETED` for those rows and `ACTIVE` for the rest |

## Migration / Rollout

- Migration 1 (this change) is additive: `active` column and `@@index([active])` remain. Rollback = revert code + `down` migration drops `status`, index, enum. No data loss.
- Migration 2 (follow-up PR, out of scope): drop `active` column and its index once frontend has fully migrated to `status` in production.
- Frontend must ship the `status` adoption in the same release window as PR2 merge. No API shim.

## Open Questions

- [ ] None blocking. All post-propose decisions are locked (Engram #483, #485).
- [ ] Sanity check for spec: `ENTITY_NOT_ACTIVE` (409) vs reusing `CONFLICT` — design picks the new specific code; spec should surface this to reviewers.
