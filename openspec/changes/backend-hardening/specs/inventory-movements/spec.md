# Inventory Movements Specification

## Purpose

Enrich movement responses with embedded product and user summaries so the frontend renders labels without fan-out calls, and align write-path guards with the shared `EntityStatus` model (DISABLED = 409 block; DELETED = 404 hide).

## Error Catalog

| Code | HTTP | Trigger |
|---|---|---|
| `ENTITY_NOT_ACTIVE` | 409 | Referenced product or user has status `DISABLED`. |
| `NOT_FOUND` | 404 | Referenced product or user is null or has status `DELETED`. |
| `VALIDATION_ERROR` | 400 | Body fails Zod validation. |

## Requirements

### Requirement: Enriched response shape

The list and detail endpoints MUST embed `product: ProductSummary { id, name, code }` and `user: UserSummary { id, fullName }` on every movement row. Raw FK IDs `productId` and `userId` MUST be preserved for backwards compatibility.

#### Scenario: List enriched

- WHEN `GET /api/inventory-movements?page=1&limit=20`
- THEN 200; each row contains `product{id,name,code}`, `user{id,fullName}`, `productId`, `userId`

#### Scenario: Detail enriched

- WHEN `GET /api/inventory-movements/:id`
- THEN 200; response contains the same enrichment as list rows

### Requirement: Write guards use status

Creation of an `InventoryMovement` MUST reject when either the referenced product or user has a status other than `ACTIVE`. DISABLED MUST return 409 `ENTITY_NOT_ACTIVE`. DELETED (or null) MUST return 404 `NOT_FOUND`.

#### Scenario: Movement against DISABLED product

- GIVEN a product with `status = 'DISABLED'`
- WHEN `POST /api/inventory-movements` referencing it
- THEN 409 `ENTITY_NOT_ACTIVE`; no movement created; stock unchanged

#### Scenario: Movement against DELETED product

- GIVEN a product with `status = 'DELETED'`
- WHEN `POST /api/inventory-movements` referencing it
- THEN 404 `NOT_FOUND`; no movement created

#### Scenario: Movement against ACTIVE product and user

- GIVEN ACTIVE product and ACTIVE user
- WHEN a valid `POST /api/inventory-movements` fires
- THEN 201; movement persisted; stock CAS uses `status = 'ACTIVE'`

### Requirement: Pagination convention

List endpoints MUST accept `page` (default `1`, min `1`) and `limit` (default `20`, max `100`). The legacy `pageSize` alias MUST NOT be introduced.

#### Scenario: Defaults applied

- WHEN `GET /api/inventory-movements` without query params
- THEN 200 with `page=1`, `limit=20`, and pagination metadata in the response envelope
