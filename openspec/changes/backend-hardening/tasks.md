# Tasks: backend-hardening

## Review Workload Forecast

| PR | Est. changed lines | Budget risk | Base | Notes |
|---|---:|---|---|---|
| PR1 | 680-760 | Medium | `feat/backend-hardening` | Slice A only; stash first |
| PR2 | 960-1080 | High | `feat/backend-hardening-enrichment` | Two internal commits; still over 800 |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units

| Unit | Goal | Likely PR | Notes |
|---|---|---|---|
| 1 | Response enrichment | PR1 | base=tracker; keep raw FK IDs; no status work |
| 2 | Status enum migration | PR2 | base=PR1 branch; Commit 1 only |
| 3 | App swap + soft delete | PR2 | base=PR1 branch; Commit 2 only |

## Slice A / PR1 — response enrichment

Locked: preserve raw FK IDs; per-module summary DTOs in `*.schema.ts`; service-level mappers; `itemsCount` = item-row count; `estimatedTotal` = `requestedQuantity * unitPrice`; no `PRODUCT_DETAIL_SELECT.supplier.status`; no status-enum work.

| ID | Title | Files touched | What to do | Tests | Deps | Commit |
|---|---|---|---|---|---|---|
| [x] A-1 | Audit stash boundary | `openspec/changes/backend-hardening/*` | Create PR1 branch from tracker, inspect `stash@{0}` scope against Slice A, record excluded files; do not apply yet. | None; checklist vs REQ-A2/A3 | none | PR1 commit 0 |
| [x] A-2 | Apply and verify replenishment stash | `src/modules/replenishment-requests/{replenishment-requests.repository,replenishment-requests.schema,replenishment-requests.service}.ts`, `tests/smoke/replenishment-requests.test.ts`, `openspec/specs/replenishment-requests/spec.md` | Apply stash, confirm summaries + metrics, preserve `supplierId`/`requestedByUserId`/`items[].productId`, clean leftovers. | REQ-A2/A4/A5, SA-3/4/7 | A-1 | PR1 commit 1 |
| [x] A-3 | Enrich inventory movements DTOs | `src/modules/inventory-movements/{inventory-movements.repository,inventory-movements.schema,inventory-movements.service}.ts`, `tests/smoke/inventory-movements.test.ts` | Add product/user selects and mapper; embed `product{id,name,code}` + `user{id,fullName}` while keeping `productId`/`userId`; keep `page`+`limit` only. | REQ-A1/A4/A7, SA-1/2/7 | A-2 pattern | PR1 commit 2 |
| [x] A-4 | Enrich suppliers DTOs | `src/modules/suppliers/{suppliers.repository,suppliers.schema,suppliers.service}.ts`, `tests/smoke/suppliers.test.ts` | Add `products[]` + `productsCount` on list/detail via repo select/count and service mapper; preserve current scalar fields. | REQ-A3/A6, SA-5/6 | A-2 pattern | PR1 commit 3 |
| [x] A-5 | Validate PR1 slice | `tests/smoke/{replenishment-requests,inventory-movements,suppliers}.test.ts` | Run `tsc --noEmit`, targeted smoke tests, then full suite; confirm PR1 excludes `supplier.status` and enum changes. | Regression for SA-1..7 | A-2..A-4 | PR1 final |

## Slice B / PR2 — soft-delete status enum

### Commit 1 — migration + Prisma client

| ID | Title | Files touched | What to do | Tests | Deps | Commit |
|---|---|---|---|---|---|---|
| B1-1 | Add shared status enum schema | `prisma/schema.prisma` | Add `EntityStatus { ACTIVE, DISABLED, DELETED }`, `status @default(ACTIVE)`, `@@index([status])` on User/Product/Supplier/Category; keep `active` and `@@index([active])`. | REQ-B1/B2/B10, SB-1 | PR1 merged/rebased | PR2 commit 1 |
| B1-2 | Write additive backfill migration | `prisma/migrations/*_add_entity_status/migration.sql` | Add enum, columns, indexes, backfill `active=true->ACTIVE`, `active=false->DELETED`, Category `ACTIVE`; do not drop `active`. | REQ-B3/B10, SB-1 | B1-1 | PR2 commit 1 |
| B1-3 | Regenerate client and align seed types | `prisma/seed.ts` | Run `prisma generate`; update seed only if schema types require `status`; validate `tsc --noEmit` if feasible. | Schema compile smoke | B1-2 | PR2 commit 1 |

### Commit 2 — app swap + tests

| ID | Title | Files touched | What to do | Tests | Deps | Commit |
|---|---|---|---|---|---|---|
| B2-1 | Add shared status guards | `src/shared/guards/status.ts`, `src/shared/errors/errorCodes.ts` | Add `assertNotDeleted()` -> 404 `NOT_FOUND` and `assertActive()` -> 409 `ENTITY_NOT_ACTIVE`. | REQ-B4, SB-6/7/8 | B1-3 | PR2 commit 2 |
| B2-2 | Swap users and categories to status | `src/modules/users/{users.repository,users.schema,users.service}.ts`, `src/modules/categories/{categories.repository,categories.schema,categories.service,categories.controller,categories.routes}.ts`, `tests/smoke/{users,categories}.test.ts` | Replace `active` reads/writes with `status`, add `?status=active|disabled|deleted|all`, protect last ACTIVE admin, make Category DELETE soft. | REQ-B5/B8, SB-2/9 | B2-1 | PR2 commit 2 |
| B2-3 | Swap products and movements to status | `src/modules/products/{products.repository,products.schema,products.service}.ts`, `src/modules/inventory-movements/inventory-movements.repository.ts`, `tests/smoke/{products,inventory-movements}.test.ts` | Update product DTOs/filters, low-stock SQL with enum casts, nested `supplier.status`, movement CAS/guards to ACTIVE-only; keep alerts hook unchanged. | REQ-B6/B7/B9/B11, SB-2/3/4/5/6/7/10/11/12 | B2-1 | PR2 commit 2 |
| B2-4 | Swap suppliers and replenishment guards | `src/modules/suppliers/{suppliers.repository,suppliers.schema,suppliers.service}.ts`, `src/modules/replenishment-requests/replenishment-requests.service.ts`, `tests/smoke/{suppliers,replenishment-requests}.test.ts` | Apply shared status filter/soft-delete semantics, block DISABLED writes, keep PR1 enrichment fields intact. | REQ-B5/B6, SB-8 + replenishment create guard | B2-1 | PR2 commit 2 |
| B2-5 | Validate PR2 slice | `tests/smoke/{users,products,suppliers,categories,inventory-movements,replenishment-requests,alerts-hooks}.test.ts` | Run targeted smoke/unit tests for status/filter/soft-delete/alerts, then full suite; verify PR2 review order and PR description notes `active -> status` break. | SB-1..12 | B2-2..B2-4 | PR2 final |

## Review Workload Forecast
- PR1 estimated_changed_lines: 680-760
- PR1 budget_risk: Medium
- PR2 estimated_changed_lines: 960-1080
- PR2 budget_risk: High
- chained_pr_recommended: Yes
- decision_needed_before_apply: Yes
- notes: feature-branch-chain is locked; PR2 keeps the required two-commit split but still exceeds the 800-line budget, so apply must stop for user approval or further slicing before implementation.
