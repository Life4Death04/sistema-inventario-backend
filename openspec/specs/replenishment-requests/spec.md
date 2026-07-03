# Replenishment Requests Specification

## Purpose

ADMIN/MANAGER users raise supplier purchase orders, notify suppliers via WhatsApp (Twilio), track lifecycle `PENDING → SENT → RECEIVED | CANCELLED`, and post received stock atomically as IN `InventoryMovement`s. OPERATOR is read-only.

## Error Catalog

| Code | HTTP | Trigger |
|---|---|---|
| `REPLENISHMENT_REQUEST_NOT_FOUND` | 404 | Unknown request id. |
| `INVALID_STATE_TRANSITION` | 409 | Transition not allowed by state machine, or status-CAS matched 0 rows. |
| `UNIT_PRICE_REQUIRED` | 400 | Item omits `unitPrice` and no `ProductSupplier.referencePrice` exists. |
| `PARTIAL_RECEIPT_INVALID` | 400 | `receivedQuantity` negative or greater than item `quantity`. |
| `SUPPLIER_HAS_NO_WHATSAPP` | 422 | SEND called and supplier `whatsapp` null/blank. |
| `REPLENISHMENT_ITEMS_REQUIRED` | 400 | Create body with empty `items[]`. |
| `REPLENISHMENT_ITEM_NOT_FOUND` | 400 | Receive body references item id not on the request. |

## Requirements

### Requirement: Create Request

The system MUST create `PENDING` requests with ≥1 item, resolving each `unitPrice` from body, else `ProductSupplier.referencePrice(supplierId, productId)`, else 400.

#### Scenario: Explicit unit prices
- GIVEN MANAGER, active supplier, active products
- WHEN POST `/api/replenishment-requests` with `supplierId` and `items:[{productId,quantity,unitPrice}]`
- THEN 201, request in `PENDING`, `receivedAt`/`cancelledAt` null, items store provided `unitPrice`

#### Scenario: Default from referencePrice
- GIVEN item body without `unitPrice` and matching `ProductSupplier.referencePrice`
- WHEN create is called
- THEN stored `unitPrice` equals `ProductSupplier.referencePrice`

#### Scenario: No price fallback available
- GIVEN item without `unitPrice` and no `ProductSupplier` row for `(supplierId,productId)`
- THEN 400 `UNIT_PRICE_REQUIRED`; nothing persisted

#### Scenario: Empty items rejected
- WHEN create body has `items:[]`
- THEN 400 `REPLENISHMENT_ITEMS_REQUIRED`

#### Scenario: OPERATOR forbidden
- WHEN OPERATOR POSTs create
- THEN 403; nothing persisted

### Requirement: List and Retrieve

The system MUST expose paginated listing with filters, a detail endpoint embedding items, and a supplier-scoped list.

#### Scenario: Paginated list with filters
- WHEN MANAGER calls `GET /api/replenishment-requests?status=SENT&supplierId=…&dateFrom=…&dateTo=…&page=1&pageSize=20`
- THEN 200 with only matching requests plus pagination metadata

#### Scenario: Get by id embeds items
- WHEN `GET /api/replenishment-requests/:id` on existing request
- THEN 200 with request and `items[]` embedded

#### Scenario: Get by id missing
- WHEN id does not exist
- THEN 404 `REPLENISHMENT_REQUEST_NOT_FOUND`

#### Scenario: Supplier-scoped list
- WHEN `GET /api/suppliers/:supplierId/replenishment-requests`
- THEN 200 with paginated requests for that supplier only

### Requirement: Send (PENDING → SENT)

The system MUST transition PENDING to SENT via status-CAS, then fire fire-and-forget WhatsApp with the SENT template. Notification failure MUST NOT roll back the DB.

#### Scenario: Send succeeds and notifies
- GIVEN request `PENDING`, supplier has valid E.164 `whatsapp`
- WHEN MANAGER POSTs `/:id/send`
- THEN 200 with status `SENT` AND `sendWhatsAppMessage` called once with SENT body

#### Scenario: Supplier missing WhatsApp
- GIVEN supplier `whatsapp` null/blank
- THEN 422 `SUPPLIER_HAS_NO_WHATSAPP`; status stays `PENDING`

#### Scenario: Notification failure keeps SENT
- GIVEN status commits to SENT then Twilio rejects
- THEN 200 with `SENT`; error logged via Pino; no DB rollback

#### Scenario: Concurrent send
- GIVEN two concurrent send calls on the same PENDING request
- THEN exactly one returns 200 SENT; the other returns 409 `INVALID_STATE_TRANSITION`

#### Scenario: Send from non-PENDING
- GIVEN request already in SENT, RECEIVED, or CANCELLED
- THEN 409 `INVALID_STATE_TRANSITION`

### Requirement: Receive (SENT → RECEIVED)

The system MUST transition SENT to RECEIVED, stamp `receivedAt` and `receivedByUserId`, and post one IN `InventoryMovement` per item inside a single Prisma `$transaction`. Movement quantity MUST be `receivedQuantity` when provided, else item `quantity`.

#### Scenario: Receive with default quantities
- GIVEN SENT request with items `[{id:A,quantity:10},{id:B,quantity:5}]`
- WHEN MANAGER POSTs `/:id/receive` with empty body
- THEN 200 with `RECEIVED`, `receivedAt` set, `receivedByUserId` = caller
- AND two IN movements created in one transaction with quantities `10` and `5`
- AND product stocks increase by `10` and `5`

#### Scenario: Partial receipt
- GIVEN SENT request, item `quantity:10`
- WHEN receive body is `items:[{id,receivedQuantity:7}]`
- THEN stored `receivedQuantity` = 7 AND IN movement quantity = 7

#### Scenario: Partial receipt out of range
- WHEN any `receivedQuantity` is `<0` or `> quantity`
- THEN 400 `PARTIAL_RECEIPT_INVALID`; no movement created

#### Scenario: Unknown item id
- WHEN receive body includes `id` not belonging to the request
- THEN 400 `REPLENISHMENT_ITEM_NOT_FOUND`; transaction aborted

#### Scenario: Receive from non-SENT
- GIVEN request in PENDING, RECEIVED, or CANCELLED
- THEN 409 `INVALID_STATE_TRANSITION`; no movement created

#### Scenario: Concurrent receive is idempotent
- GIVEN two concurrent receive calls on the same SENT request
- THEN exactly one commits RECEIVED with movements; the other returns 409 with no extra movements

### Requirement: Cancel (PENDING | SENT → CANCELLED)

The system MUST cancel from PENDING or SENT, stamp `cancelledAt` and `cancelledByUserId`. It MUST fire the CANCELLED WhatsApp fire-and-forget only when prior status was SENT. Notification failure MUST NOT roll back the DB.

#### Scenario: Cancel from PENDING is silent
- GIVEN request `PENDING`
- WHEN MANAGER POSTs `/:id/cancel`
- THEN 200 with `CANCELLED`, `cancelledAt` set, `cancelledByUserId` = caller
- AND `sendWhatsAppMessage` is NOT called

#### Scenario: Cancel from SENT notifies
- GIVEN request `SENT`, supplier has valid `whatsapp`
- WHEN cancel is called
- THEN 200 with `CANCELLED` AND `sendWhatsAppMessage` called once with CANCELLED body

#### Scenario: Cancel notification failure keeps CANCELLED
- GIVEN CANCELLED commits then Twilio rejects
- THEN 200 with `CANCELLED`; error logged via Pino; no DB rollback

#### Scenario: Cancel from terminal state
- GIVEN request in RECEIVED or CANCELLED
- THEN 409 `INVALID_STATE_TRANSITION`

### Requirement: Role-Based Access

The system MUST allow ADMIN and MANAGER to create/send/receive/cancel, and MUST restrict OPERATOR to GET only.

#### Scenario: OPERATOR can read
- WHEN OPERATOR calls any GET endpoint (list, get by id, supplier-scoped list)
- THEN 200

#### Scenario: OPERATOR cannot mutate
- WHEN OPERATOR POSTs any endpoint (create, send, receive, cancel)
- THEN 403; no state change occurs
