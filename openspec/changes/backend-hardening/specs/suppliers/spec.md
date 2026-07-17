# Suppliers Specification

## Purpose

Expose supplier list and detail responses with embedded products, adopt shared `EntityStatus` semantics, and support the `?status=` query filter used across master data.

## Error Catalog

| Code | HTTP | Trigger |
|---|---|---|
| `ENTITY_NOT_ACTIVE` | 409 | Target supplier has status `DISABLED` on operations requiring ACTIVE. |
| `NOT_FOUND` | 404 | Supplier is null or has status `DELETED`. |

## Requirements

### Requirement: Enriched response shape

List and detail endpoints MUST embed `products: ProductSummary[]` and `productsCount: number` on every supplier row. `productsCount` MUST equal the number of `ProductSupplier` rows linked to the supplier. Existing scalar fields (including the transitional `active` and the new `status`) MUST be preserved.

#### Scenario: List embeds products and count

- WHEN `GET /api/suppliers?page=1&limit=20`
- THEN 200; each row contains `products[]` (each `{id,name,code}`) and `productsCount` matching the link count

#### Scenario: Detail embeds products and count

- WHEN `GET /api/suppliers/:id`
- THEN 200; response contains `products[]` and `productsCount`

### Requirement: Status filter

`GET /api/suppliers` MUST accept `?status=active|disabled|deleted|all`. The default (no `status` param) MUST return `ACTIVE + DISABLED` (DELETED hidden). `all` MUST return every status. `active`, `disabled`, `deleted` MUST return only that status.

#### Scenario: Default hides DELETED

- GIVEN suppliers across all three statuses
- WHEN `GET /api/suppliers` is called without `status`
- THEN response includes ACTIVE and DISABLED rows; excludes DELETED

#### Scenario: `?status=all` returns everything

- WHEN `GET /api/suppliers?status=all`
- THEN response includes ACTIVE, DISABLED, and DELETED rows

### Requirement: Write guards on attach

`POST /api/suppliers/:id/products/:productId` MUST reject when supplier or product status is not `ACTIVE`. DISABLED → 409 `ENTITY_NOT_ACTIVE`. DELETED/null → 404 `NOT_FOUND`.

#### Scenario: Attach against DISABLED supplier

- GIVEN a supplier with `status = 'DISABLED'`
- WHEN attach is called
- THEN 409 `ENTITY_NOT_ACTIVE`; no `ProductSupplier` row created

### Requirement: Soft delete sets DELETED

`DELETE /api/suppliers/:id` MUST set `status = 'DELETED'` (soft delete). Subsequent default-filter GETs MUST NOT return the row.

#### Scenario: Soft delete hides row by default

- WHEN `DELETE /api/suppliers/:id` succeeds
- THEN the row persists with `status = 'DELETED'`; `GET /api/suppliers` excludes it; `GET /api/suppliers?status=all` includes it
