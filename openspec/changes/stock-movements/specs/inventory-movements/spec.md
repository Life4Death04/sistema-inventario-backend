# Inventory Movements Specification

## Purpose

Immutable audit log and single write path for `Product.stock`. Exposes four endpoints under `/api/inventory-movements` and a product-scoped history sub-resource. All stock mutations are transactional, non-negative, and role-gated.

## Requirements

### Requirement: Create Movement (POST /api/inventory-movements)

The system SHALL accept a movement create request, atomically update `Product.stock`, and persist an `InventoryMovement` row with a server-computed `resultingStock` snapshot.

Request body (discriminated on `type`):

| Field | Type | Rules |
|-------|------|-------|
| `productId` | cuid | required; product MUST exist and `active = true` |
| `type` | `IN` \| `OUT` \| `ADJUSTMENT` | required |
| `quantity` | integer | IN/OUT: `[1, 1_000_000]`; ADJUSTMENT: `[-1_000_000, 1_000_000] \ {0}` |
| `reason` | string | required, trimmed, non-empty, max 500 chars, for ALL types |

Server behavior: reads `Product.stock`, computes `resultingStock`, guards non-negative, updates stock via `updateMany({ where: { id, stock: observed } })`, inserts movement in same transaction. On `updateMany.count = 0` retries once; second miss returns `409 STOCK_CONCURRENCY_CONFLICT`.

Authorization:

| Role | IN | OUT | ADJUSTMENT |
|------|----|----|------------|
| ADMIN | ✅ | ✅ | ✅ |
| MANAGER | ✅ | ✅ | ✅ |
| OPERATOR | ❌ 403 | ✅ | ❌ 403 |

Rejections use `FORBIDDEN_MOVEMENT_TYPE` (403), `VALIDATION_ERROR` (400), `INVALID_ADJUSTMENT_QUANTITY` (400), `PRODUCT_NOT_FOUND` (404), `INSUFFICIENT_STOCK` (409 with `{ productId, currentStock, attemptedDelta }`), `STOCK_CONCURRENCY_CONFLICT` (409). Unauthenticated → 401.

#### Scenario: ADMIN creates IN increases stock

- GIVEN a product with `stock = 20` AND an ADMIN token
- WHEN POST `{ productId, type: "IN", quantity: 10, reason: "Restock" }`
- THEN response is 201 with movement having `resultingStock = 30` AND `Product.stock = 30`

#### Scenario: OPERATOR creates OUT with sufficient stock

- GIVEN a product with `stock = 8` AND an OPERATOR token
- WHEN POST `{ productId, type: "OUT", quantity: 5, reason: "Sale" }`
- THEN response is 201, movement `resultingStock = 3`, `Product.stock = 3`

#### Scenario: OUT with insufficient stock is rejected atomically

- GIVEN a product with `stock = 2`
- WHEN POST OUT `quantity = 5`
- THEN response is 409 `INSUFFICIENT_STOCK` AND no movement row is created AND `Product.stock` remains 2

#### Scenario: MANAGER posts positive ADJUSTMENT persists INCREASE

- GIVEN a product with `stock = 10` AND a MANAGER token
- WHEN POST `{ type: "ADJUSTMENT", quantity: 3, reason: "Recount surplus" }`
- THEN response is 201, persisted row has `quantity = 3` AND `adjustmentDirection = "INCREASE"` AND `Product.stock = 13`

#### Scenario: MANAGER posts negative ADJUSTMENT persists DECREASE

- GIVEN a product with `stock = 10` AND a MANAGER token
- WHEN POST `{ type: "ADJUSTMENT", quantity: -2, reason: "Recount shortage" }`
- THEN response is 201, persisted row has `quantity = 2` AND `adjustmentDirection = "DECREASE"` AND `Product.stock = 8`

#### Scenario: ADJUSTMENT with quantity zero is rejected

- WHEN POST ADJUSTMENT with `quantity = 0`
- THEN response is 400 `INVALID_ADJUSTMENT_QUANTITY` AND nothing is persisted

#### Scenario: ADJUSTMENT that would leave stock negative is rejected

- GIVEN a product with `stock = 4`
- WHEN POST ADJUSTMENT `quantity = -10`
- THEN response is 409 `INSUFFICIENT_STOCK` AND `Product.stock = 4`

#### Scenario: OPERATOR posting IN is forbidden

- GIVEN an OPERATOR token
- WHEN POST `type = "IN"`
- THEN response is 403 `FORBIDDEN_MOVEMENT_TYPE` AND nothing is persisted

#### Scenario: OPERATOR posting ADJUSTMENT is forbidden

- GIVEN an OPERATOR token
- WHEN POST `type = "ADJUSTMENT"`
- THEN response is 403 `FORBIDDEN_MOVEMENT_TYPE`

#### Scenario: Unauthenticated request is rejected

- WHEN POST without a valid JWT
- THEN response is 401

#### Scenario: Missing reason is rejected for every type

- WHEN POST with `reason` absent, empty, or whitespace-only for IN, OUT, or ADJUSTMENT
- THEN response is 400 `VALIDATION_ERROR` AND nothing is persisted

#### Scenario: Quantity out of bounds is rejected

- WHEN POST IN or OUT with `quantity <= 0` OR `quantity > 1_000_000`
- THEN response is 400 `VALIDATION_ERROR`

#### Scenario: Nonexistent product is rejected

- WHEN POST with a `productId` that does not exist
- THEN response is 404 `PRODUCT_NOT_FOUND`

#### Scenario: Inactive product is treated as not found

- GIVEN a product with `active = false`
- WHEN POST any movement for that product
- THEN response is 404 `PRODUCT_NOT_FOUND` (mirrors products-crud idempotency guard)

#### Scenario: Concurrency conflict after retry

- GIVEN two concurrent POSTs racing on the same product
- WHEN both read `stock = S` and the second `updateMany` returns `count = 0` on the retry
- THEN the losing request returns 409 `STOCK_CONCURRENCY_CONFLICT` AND its movement row is not inserted

### Requirement: List Movements (GET /api/inventory-movements)

The system SHALL return a paginated, filterable list of movements sorted by `createdAt DESC`, accessible to ADMIN, MANAGER, and OPERATOR.

Query params: `productId` (cuid), `type` (`IN`|`OUT`|`ADJUSTMENT`), `from` (ISO-8601), `to` (ISO-8601), `page` (int ≥ 1, default 1), `pageSize` (int in `[1, 100]`, default 20). Filters combine with AND. Response shape: `{ data: Movement[], pagination: { page, pageSize, total, totalPages } }`. Validation errors → 400 `INVALID_QUERY`.

#### Scenario: Default list returns newest first

- GIVEN 25 movements across products AND an authenticated caller
- WHEN GET `/api/inventory-movements`
- THEN response is 200 with `data.length = 20`, sorted `createdAt DESC`, `pagination = { page: 1, pageSize: 20, total: 25, totalPages: 2 }`

#### Scenario: Filter by productId

- WHEN GET `?productId=<id>`
- THEN response only includes movements whose `productId` equals the filter

#### Scenario: Filter by type

- WHEN GET `?type=OUT`
- THEN response only includes movements with `type = OUT`

#### Scenario: Inclusive date range filter

- WHEN GET `?from=2026-07-01&to=2026-07-02`
- THEN response only includes movements with `createdAt` on or between those dates

#### Scenario: Combined filters use AND

- WHEN GET `?productId=<id>&type=IN&from=2026-07-01`
- THEN response only includes IN movements for that product on/after the date

#### Scenario: Invalid pageSize is rejected

- WHEN GET with `pageSize=0`, `pageSize=101`, or a non-integer value
- THEN response is 400 `INVALID_QUERY`

#### Scenario: Invalid type value is rejected

- WHEN GET with `type=TRANSFER`
- THEN response is 400 `INVALID_QUERY`

#### Scenario: Invalid date format is rejected

- WHEN GET with `from=not-a-date`
- THEN response is 400 `INVALID_QUERY`

#### Scenario: Empty result is a valid 200

- WHEN the filters match no rows
- THEN response is 200 with `data = []` and `pagination.total = 0`

#### Scenario: Unauthenticated list is rejected

- WHEN GET without a valid JWT
- THEN response is 401

### Requirement: Get Movement by Id (GET /api/inventory-movements/:id)

The system SHALL return a single movement by id to any authenticated role. Movements are immutable — the endpoint MUST NOT accept PATCH, PUT, or DELETE.

#### Scenario: Existing movement is returned

- GIVEN an existing movement id
- WHEN GET `/api/inventory-movements/:id`
- THEN response is 200 with the full movement, including `resultingStock` and `adjustmentDirection` when the type is `ADJUSTMENT`

#### Scenario: Nonexistent movement returns 404

- WHEN GET with an id that does not exist
- THEN response is 404 `MOVEMENT_NOT_FOUND`

#### Scenario: Invalid id format is rejected

- WHEN GET with an id that is not a valid cuid
- THEN response is 400 `INVALID_ID`

#### Scenario: Unauthenticated get is rejected

- WHEN GET without a valid JWT
- THEN response is 401

### Requirement: List Product Movements (GET /api/products/:productId/inventory-movements)

The system SHALL return a paginated history scoped to one product, sorted `createdAt DESC`, using the same filter/pagination contract as the global list minus `productId`.

Query params accepted: `type`, `from`, `to`, `page`, `pageSize`. Same validation and 400 `INVALID_QUERY` semantics apply.

#### Scenario: Existing product with movements returns scoped page

- GIVEN a product with 3 movements AND an authenticated caller
- WHEN GET `/api/products/:productId/inventory-movements`
- THEN response is 200 with `data.length = 3` scoped to that product, sorted `createdAt DESC`

#### Scenario: Existing product with no movements returns empty list

- GIVEN a product that has never been posted against
- WHEN GET `/api/products/:productId/inventory-movements`
- THEN response is 200 with `data = []` AND `pagination.total = 0`

#### Scenario: Nonexistent product returns 404

- WHEN GET `/api/products/<unknown-id>/inventory-movements`
- THEN response is 404 `PRODUCT_NOT_FOUND`

#### Scenario: Invalid productId format is rejected

- WHEN GET with a `productId` that is not a valid cuid
- THEN response is 400 `INVALID_ID`

#### Scenario: Unauthenticated request is rejected

- WHEN GET without a valid JWT
- THEN response is 401

### Requirement: Movement Immutability and Atomicity Invariants

The system SHALL enforce these cross-cutting invariants for every write path:

1. `resultingStock` MUST equal `Product.stock` AFTER the movement, written by the server in the same transaction as both the stock update and the movement insert. Clients MUST NOT send it.
2. `Product.stock` update and `InventoryMovement` insert MUST be atomic; failure of either aborts both.
3. `Product.stock < 0` MUST be impossible; any operation that would violate this returns 409 `INSUFFICIENT_STOCK` and persists nothing.
4. The `/api/inventory-movements/:id` resource MUST NOT expose PATCH, PUT, or DELETE. Such requests MUST return 405.
5. Corrections MUST be modeled as new compensating `ADJUSTMENT` movements — never in-place edits.

#### Scenario: PATCH on a movement is rejected

- WHEN PATCH `/api/inventory-movements/:id`
- THEN response is 405

#### Scenario: PUT on a movement is rejected

- WHEN PUT `/api/inventory-movements/:id`
- THEN response is 405

#### Scenario: DELETE on a movement is rejected

- WHEN DELETE `/api/inventory-movements/:id`
- THEN response is 405

#### Scenario: Transaction failure rolls back stock and movement

- GIVEN a product with `stock = 10`
- WHEN the movement insert fails inside the transaction after the stock updateMany succeeds
- THEN both operations are rolled back AND `Product.stock` remains 10 AND no movement row exists
