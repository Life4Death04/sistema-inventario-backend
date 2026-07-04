# Proposal: backend-hardening

## Intent

The frontend receives raw foreign-key IDs (`productId`, `userId`, `supplierId`) from movements and suppliers endpoints and has to fan out extra calls to render names. Simultaneously, the master entities (User, Product, Supplier) only expose a boolean `active` flag, which cannot represent the two lifecycle states the UI actually needs: a **disabled** entity that must stay visible (with a badge, blocked for new operations) and a **deleted** entity that must disappear from listings. One grouped change closes both gaps for the MVP and unifies the soft-delete model across all master data, including Category.

## Scope

### In Scope

- **Slice A — Response enrichment** for three modules:
  - `inventory-movements`: embed `product { id, name, code }` and `user { id, name }`.
  - `replenishment-requests`: embed `supplier`, `requestedByUser`, `items[].product`, `itemsCount`, `estimatedTotal` (recover `stash@{0}` on `feat/replenishment-response-enrichment-backend`).
  - `suppliers`: embed `products: ProductSummary[]` and `productsCount: number`.
- **Slice B — Soft-delete two-stage** on **User, Product, Supplier, Category**:
  - Introduce enum `EntityStatus { ACTIVE, DISABLED, DELETED }` (final name TBD in spec).
  - Additive migration: add `status` + backfill from `active` (default `ACTIVE` for Category).
  - DISABLED = hard block for new operations (same as today's `active=false`).
  - DELETED = filtered out of every listing by default.
  - Frontend contract shifts from `active: boolean` to `status: 'ACTIVE'|'DISABLED'|'DELETED'`. No shim.

### Out of Scope

- Dropping the `active` column (deferred to a follow-up PR — Migration 2 in the additive-then-swap plan).
- Enrichment for any module other than the three named above.
- DISABLED "soft warning" semantics (DISABLED behaves exactly like today's inactive: hard block).
- Alerts reconcile changes (the hook does not read `active` — verified in exploration).
- Twilio/notifications and any frontend code changes.
- Cascading soft-delete: `ProductSupplier` rows survive when a Supplier is set to `DELETED` (no cascade — accepted debt).

## Capabilities

### New Capabilities
- None. All work extends existing spec surfaces.

### Modified Capabilities
- `replenishment-requests`: response DTO gains supplier/user/items.product/itemsCount/estimatedTotal.
- `inventory-movements`: response DTO gains product + user summaries; operational guards move from `active` to `status === 'ACTIVE'`.
- `suppliers`: response DTO gains products list + count; lifecycle moves from `active` to `status`.
- `products`: lifecycle moves from `active` to `status`; `lowStock` raw SQL updated; `attachSupplier` and `softDelete` guards updated.
- `users`: lifecycle moves from `active` to `status`; ADMIN self-guard and role checks updated.
- `database-schema`: adds `EntityStatus` enum + `status` column + index on User/Product/Supplier/Category; keeps `active` on the three legacy tables (dropped in follow-up PR).
- `categories` (new soft-delete surface): `softDelete` sets `DELETED`; list defaults exclude `DELETED`.

## Approach

**Slice A (PR1):** recover `stash@{0}` — it fully covers `replenishment-requests` (repository, schema, service, smoke tests). Then apply the same enrichment pattern to `inventory-movements` (new `PRODUCT_SUMMARY_SELECT` / `USER_SUMMARY_SELECT` / `MOVEMENT_ENRICHED_SELECT`, extended `MovementDto`, mapper update) and `suppliers` (new `SUPPLIER_WITH_PRODUCTS_SELECT`, extended `SupplierResponseDto`, mapper update). All three modules follow the same summary-select-plus-mapper shape already validated in replenishment.

**Slice B (PR2):** additive Prisma migration adds `EntityStatus` enum, adds `status EntityStatus @default(ACTIVE)` + `@@index([status])` to User/Product/Supplier/Category, and backfills `status` from `active` for the three legacy tables. Then swap every read/write of `active` to `status` across 5 repositories, 3 services, 2 schemas, the raw `lowStock` SQL, the seed, and add Category service/repository updates for the new soft-delete semantics. The `active` column stays alive to keep this migration reversible; it is dropped in a future PR.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `src/modules/inventory-movements/*` | Modified | Enrichment (Slice A) + status guards (Slice B) |
| `src/modules/replenishment-requests/*` | Modified | Enrichment from stash (Slice A) |
| `src/modules/suppliers/*` | Modified | Products embed (Slice A) + status lifecycle (Slice B) |
| `src/modules/products/*` | Modified | Status lifecycle + lowStock raw SQL (Slice B) |
| `src/modules/users/*` | Modified | Status lifecycle + ADMIN guards (Slice B) |
| `src/modules/categories/*` | Modified | New soft-delete via status (Slice B) |
| `prisma/schema.prisma` | Modified | Add enum + `status` + index on 4 models (Slice B) |
| `prisma/migrations/*` | New | Additive migration: enum, column, backfill, index (Slice B) |
| `prisma/seed.ts` | Modified | Set `status: 'ACTIVE'` on seeded rows (Slice B) |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Raw SQL `lowStock` silent runtime break (`active = ${bool}` → `status = 'ACTIVE'`) | Med | Explicit unit test on `lowStock` after swap; string literal typed via constant. |
| Breaking frontend contract (`active` → `status`) | High | Documented in PR description; frontend team notified; single-cut, no shim. |
| PR2 exceeds 800-line review budget (Category expands surface) | Med | See Review Workload Forecast — recommend internal split (migration commit + code commit). Escalate to `size:exception` if needed. |
| `active` column outlives PR2 → dangling column technical debt | High | Tracked as explicit follow-up PR (Migration 2). Documented in this proposal. |
| `ProductSupplier` rows survive `DELETED` supplier | Med | Accepted debt for MVP; noted in spec as non-goal; hidden by filtering supplier listings on `status !== DELETED`. |
| Missed `active` read/write in the swap → silent runtime bug | Med | Grep-audit checklist in `sdd-tasks`; every touched file listed in exploration must appear in a task. |

## Rollback Plan

- **Slice A (PR1)**: revert the PR. No schema change, no data migration. Frontend keeps consuming the old flat response — additive fields simply disappear.
- **Slice B (PR2)**: revert the code PR. The additive migration leaves `status` and the enum in place but harmless — all reads/writes fall back to `active`. If the migration itself must be reverted, run a down migration dropping `status`, `@@index([status])`, and the `EntityStatus` enum. Because `active` was never removed, no data loss occurs.
- **Tracker branch**: if both slices need rollback, revert the tracker merge to `main`.

## Dependencies

- Frontend team must adopt the new `status` field in the same release window as PR2. Backend does not ship a compatibility shim.
- Stash `stash@{0}` on `feat/replenishment-response-enrichment-backend` must be recoverable at the start of Slice A implementation.

## Success Criteria

- [ ] Movements, replenishment, and suppliers endpoints return embedded summaries (no raw IDs for the three enriched relations).
- [ ] User/Product/Supplier/Category expose `status` in responses; `DELETED` rows are filtered from default listings; `DISABLED` rows are returned but rejected for new operations.
- [ ] Prisma migration applies cleanly on a fresh DB and on a seeded DB (backfill preserves lifecycle).
- [ ] No endpoint returns both `active` and `status` inconsistently for the same row.
- [ ] All existing smoke tests pass; new smoke tests cover enrichment fields and status transitions.

## Delivery Plan (Chained PRs)

- **Tracker branch**: `feat/backend-hardening` from `main`.
- **PR1 (Slice A)**: `feat/backend-hardening-enrichment` → target `feat/backend-hardening`.
- **PR2 (Slice B)**: `feat/backend-hardening-soft-delete` → target `feat/backend-hardening-enrichment`.
- **Merge order**: PR1 merges into tracker → PR2 rebases on tracker, merges into tracker → tracker merges into `main`.
- **Chain strategy**: feature-branch-chain (only the tracker touches `main`).

## Review Workload Forecast

**Budget**: 800 lines per PR (`additions + deletions`). Delivery strategy: `force-chained`. Chain strategy: `feature-branch-chain`.

### Slice A — `feat/backend-hardening-enrichment`

| Component | Est. lines |
|-----------|-----------:|
| Replenishment enrichment (from stash — repo + schema + service + smoke) | ~380 |
| Movements enrichment (repo selects + schema DTO + service mapper + tests) | ~180 |
| Suppliers enrichment (repo select + schema DTO + service mapper + tests) | ~160 |
| **Total** | **~720** |

- `chained_pr_recommended`: **Yes** (already chosen).
- `budget_risk`: **Medium** — comfortably under 800 but tight. If tests grow, escalate.

### Slice B — `feat/backend-hardening-soft-delete`

| Component | Est. lines |
|-----------|-----------:|
| Prisma schema (enum + 4 columns + 4 indexes) | ~40 |
| Migration SQL (enum, columns, backfill, indexes) | ~90 |
| Users repo + service + schema swap | ~140 |
| Products repo + service + schema swap (incl. raw SQL) | ~180 |
| Suppliers repo + service + schema swap | ~120 |
| Movements guards swap (findProductActive, attemptStockUpdate) | ~60 |
| Category new soft-delete (repo + service + schema + endpoint) | ~180 |
| Seed update | ~10 |
| Smoke tests for status transitions across 4 entities | ~200 |
| **Total** | **~1,020** |

- `chained_pr_recommended`: **Yes** (already chosen).
- `budget_risk`: **High** — forecast **exceeds** the 800-line budget by ~220 lines, driven mainly by Category expansion and the 4-entity fan-out.
- **Recommendation**: split Slice B into two internal commits inside PR2 for reviewer sanity (`chore(db): additive status migration + schema` and `refactor: swap active → status across modules + Category soft-delete`). If reviewer prefers two PRs, escalate to a **third chained PR** (`feat/backend-hardening-soft-delete-category` targeting `feat/backend-hardening-soft-delete`) or invoke `size:exception` with the budget overrun documented.
