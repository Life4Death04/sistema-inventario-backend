# Products Specification

## Purpose

Adopt shared `EntityStatus` semantics on Product, keep the low-stock raw SQL correct after the swap, and expose the `?status=` filter contract on the product list. `PRODUCT_DETAIL_SELECT` MUST surface `supplier.status` (not `supplier.active`).

## Error Catalog

| Code | HTTP | Trigger |
|---|---|---|
| `ENTITY_NOT_ACTIVE` | 409 | Product is `DISABLED` on operations requiring ACTIVE. |
| `NOT_FOUND` | 404 | Product is null or `DELETED`. |

## Requirements

### Requirement: Status filter

`GET /api/products` MUST accept `?status=active|disabled|deleted|all`. Default (no param) MUST return `ACTIVE + DISABLED`. `all` returns every status. Named statuses return only that status.

#### Scenario: Default hides DELETED

- WHEN `GET /api/products` is called without `status`
- THEN response includes ACTIVE and DISABLED products; excludes DELETED

#### Scenario: `?status=deleted` returns only DELETED

- WHEN `GET /api/products?status=deleted`
- THEN response returns only rows with `status = 'DELETED'`

#### Scenario: `?status=disabled` returns only DISABLED

- WHEN `GET /api/products?status=disabled`
- THEN response returns only rows with `status = 'DISABLED'`

### Requirement: Low-stock raw SQL uses enum cast

The low-stock query MUST filter with `status IN ('ACTIVE'::"EntityStatus", 'DISABLED'::"EntityStatus")`. The explicit Postgres enum cast is required; bare string literals against an enum column MUST NOT be used.

#### Scenario: Low-stock returns ACTIVE and DISABLED

- GIVEN products in every status below their `minStock`
- WHEN the low-stock query runs
- THEN it returns only products with `status IN (ACTIVE, DISABLED)`; DELETED are excluded

### Requirement: PRODUCT_DETAIL_SELECT nested supplier field

The product detail select MUST surface `supplier.status` instead of `supplier.active`. This change lives in Slice B commit 2, alongside the other `active → status` renames.

#### Scenario: Detail exposes nested supplier.status

- WHEN `GET /api/products/:id`
- THEN the `suppliers[].supplier` object contains `status: 'ACTIVE' | 'DISABLED' | 'DELETED'` and NOT `active: boolean`

### Requirement: Soft delete sets DELETED

`DELETE /api/products/:id` MUST set `status = 'DELETED'`. Soft delete MUST reject when `target.status = 'DELETED'` already.

#### Scenario: Soft delete transitions ACTIVE → DELETED

- GIVEN an ACTIVE product
- WHEN `DELETE /api/products/:id` succeeds
- THEN the row persists with `status = 'DELETED'`

### Requirement: Alerts reconcile unchanged

The alerts reconcile hook MUST continue to fire on stock changes without reading `product.active` or `product.status`. This change MUST NOT modify `alertsRepository.reconcile`.

#### Scenario: Reconcile still triggers post-migration

- GIVEN a product whose stock crosses `minStock` after a movement
- WHEN the movement commits
- THEN reconcile fires exactly as it did before the migration (regression check)
