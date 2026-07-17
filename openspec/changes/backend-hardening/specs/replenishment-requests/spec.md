# Delta for replenishment-requests

## MODIFIED Requirements

### Requirement: List and Retrieve

The system MUST expose paginated listing with filters, a detail endpoint embedding items, and a supplier-scoped list. List rows MUST embed `supplier: SupplierSummary`, `requestedByUser: UserSummary`, `itemsCount: number`, and `estimatedTotal: string` (Decimal serialized). Detail MUST additionally embed `items[].product: ProductSummary`. Raw FK IDs (`supplierId`, `requestedByUserId`, `items[].productId`) MUST be preserved.
(Previously: list/detail returned raw IDs only, no embedded supplier/user/product summaries and no computed `itemsCount`/`estimatedTotal`.)

#### Scenario: Paginated list embeds summaries and metrics

- GIVEN MANAGER and existing requests
- WHEN `GET /api/replenishment-requests?status=SENT&page=1&limit=20`
- THEN 200 with each row including `supplier{id,name}`, `requestedByUser{id,fullName}`, `itemsCount`, `estimatedTotal`, and the original `supplierId`/`requestedByUserId`

#### Scenario: Get by id embeds items with product

- WHEN `GET /api/replenishment-requests/:id`
- THEN 200 with `supplier`, `requestedByUser`, `itemsCount`, `estimatedTotal`, and `items[]` each embedding `product{id,name,code}` plus the original `productId`

#### Scenario: Get by id missing

- WHEN id does not exist
- THEN 404 `REPLENISHMENT_REQUEST_NOT_FOUND`

#### Scenario: Supplier-scoped list

- WHEN `GET /api/suppliers/:supplierId/replenishment-requests`
- THEN 200 with paginated requests for that supplier only, enriched identically

#### Scenario: Metrics calculation

- GIVEN a request with items `[{quantity:2, unitPrice:"10.00"},{quantity:3, unitPrice:"5.50"}]`
- THEN `itemsCount = 2` (distinct item rows) AND `estimatedTotal = "36.50"` (sum of `quantity * unitPrice`)

### Requirement: Create Request

The system MUST create `PENDING` requests with ≥1 item and MUST reject creation when `supplier.status !== 'ACTIVE'`, returning 409 `ENTITY_NOT_ACTIVE`. Item-level product validation continues via the product path.
(Previously: create checked `supplier.active === true` only; now aligns with the shared `EntityStatus` guard.)

#### Scenario: Create against DISABLED supplier

- GIVEN a supplier with `status = 'DISABLED'`
- WHEN MANAGER POSTs create
- THEN 409 `ENTITY_NOT_ACTIVE`; nothing persisted

#### Scenario: Create against DELETED supplier

- GIVEN a supplier with `status = 'DELETED'`
- WHEN MANAGER POSTs create
- THEN 404 `NOT_FOUND`; nothing persisted

#### Scenario: Create with ACTIVE supplier

- GIVEN ACTIVE supplier and items with valid prices
- WHEN MANAGER POSTs create
- THEN 201; `PENDING` request persisted; response is enriched per the List/Retrieve requirement
