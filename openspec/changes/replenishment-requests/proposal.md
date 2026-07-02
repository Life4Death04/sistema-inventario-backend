# Proposal: Replenishment Requests Module

## Intent

Enable managers to raise purchase orders to suppliers, notify them via WhatsApp (Twilio), track lifecycle (PENDING → SENT → RECEIVED/CANCELLED), and post RECEIVED stock atomically as `IN` inventory movements. Closes the procurement gap in HighMeds pharmacy workflow.

## Scope

### In Scope
- `src/modules/replenishment-requests/` (5-file layered module).
- Prisma additions: 4 fields on `ReplenishmentRequest`, 1 on `ReplenishmentRequestItem`.
- `src/shared/notifications/` Twilio wrapper (WhatsApp send).
- WhatsApp fire-and-forget notifications on SENT and cancel-after-SENT.
- Atomic RECEIVED → `IN` `InventoryMovement` per item inside one `$transaction` (repository-direct).
- Error catalog additions, `.env.example` Twilio vars, `twilio` dependency.
- Smoke tests mirroring `tests/smoke/inventory-movements.test.ts`.

### Out of Scope
- Notification retries and `notificationStatus` persistence.
- WhatsApp Business template pre-approval.
- Delivery/read webhooks.
- Supplier portal for digital accept/reject.
- Multi-currency pricing.
- Item-level cancellation (only whole-request cancel).

## Capabilities

### New Capabilities
- `replenishment-requests`: create/list/get purchase orders with items and drive the 4-state lifecycle including WhatsApp notification and auto stock intake on receipt.

### Modified Capabilities
- None. `inventory-movements` and `suppliers` behavior is unchanged; the module consumes them internally.

## Approach

Layered module (`schema → repository → service → controller → routes`). State transitions use `updateMany({ where: { id, status: expected } })` as a status-CAS (409 on `count === 0`). SENT and cancel-after-SENT commit the DB status first, then fire Twilio best-effort (Pino-logged on failure, no rollback). RECEIVED opens one `$transaction` that updates status and calls `inventoryMovementsRepository.insertMovement(tx, …)` + stock CAS directly (bypasses `inventoryMovementsService` to keep everything transactional). `unitPrice` defaults from `ProductSupplier.referencePrice(supplierId, productId)` when omitted; manual value wins; missing both → 400 `UNIT_PRICE_REQUIRED`. Partial receipt via optional `receivedQuantity` per item (defaults to `requestedQuantity`, must be `0 ≤ received ≤ requestedQuantity`).

## Roles

| Op | ADMIN | MANAGER | OPERATOR |
|---|---|---|---|
| Create / Send / Receive / Cancel | ✅ | ✅ | ❌ |
| List / Get one | ✅ | ✅ | ✅ |

## State Machine

Valid: `— → PENDING`, `PENDING → SENT` (notify), `PENDING → CANCELLED`, `SENT → RECEIVED` (auto-IN), `SENT → CANCELLED` (notify). Invalid → 409 `INVALID_STATE_TRANSITION`. RECEIVED and CANCELLED are terminal.

## Data Model Diff

```prisma
model ReplenishmentRequest {
  // …existing fields…
  receivedAt         DateTime?
  cancelledAt        DateTime?
  receivedByUserId   String?
  cancelledByUserId  String?

  receivedBy         User?     @relation("ReplenishmentReceiver",  fields: [receivedByUserId],  references: [id], onDelete: Restrict)
  cancelledBy        User?     @relation("ReplenishmentCanceller", fields: [cancelledByUserId], references: [id], onDelete: Restrict)

  @@index([supplierId, status])
  @@index([receivedByUserId])
  @@index([cancelledByUserId])
}

model ReplenishmentRequestItem {
  // …existing fields…
  receivedQuantity Int?
}

model User {
  // …existing relations…
  replenishmentReceived  ReplenishmentRequest[] @relation("ReplenishmentReceiver")
  replenishmentCancelled ReplenishmentRequest[] @relation("ReplenishmentCanceller")
}
```

Base models already exist (`ReplenishmentRequest`, `ReplenishmentRequestItem`, `ReplenishmentStatus` enum, `Supplier.whatsapp`). No new enums.

## API Surface

Base: `/api/replenishment-requests`.

- `POST /` — create PENDING with items (unitPrice optional per item; defaults from ProductSupplier).
- `GET /` — paginated list; filters: `status`, `supplierId`, `dateFrom`, `dateTo`.
- `GET /:id` — detail with items embedded.
- `POST /:id/send` — PENDING → SENT; fires WhatsApp.
- `POST /:id/receive` — SENT → RECEIVED; body `{ items?: [{ id, receivedQuantity }] }`; creates `IN` movements atomically.
- `POST /:id/cancel` — PENDING|SENT → CANCELLED; fires WhatsApp on SENT branch only.
- `GET /api/suppliers/:supplierId/replenishment-requests` — supplier-scoped list (mirrors products/inventory-movements pattern).

Items are embedded in `GET /:id`; no separate `/items` endpoint.

## Notifications

`src/shared/notifications/` exposes `sendWhatsAppMessage(to, body)`. Two templates: SENT (order details, items, total) and CANCELLED (order id, cancellation notice). Supplier `whatsapp` is normalized to E.164 (`+CCNNNNNNNNN`) before send; missing/invalid → 422 `SUPPLIER_HAS_NO_WHATSAPP` guarded pre-transition on SENT only. Fire-and-forget: Twilio failures are Pino-logged at `error`, DB state stays `SENT`/`CANCELLED`. **Accepted risk**: supplier may never receive the message; only server logs will show it. Follow-up change can add persistence + retry.

## Concurrency & Integrity

- Status-CAS via `updateMany` prevents double-send/receive/cancel.
- RECEIVED status update + all `IN` movements + stock CAS run in a single `$transaction` (repository-direct).
- Unique per-request-per-product on items: `@@unique([replenishmentRequestId, productId])` on `ReplenishmentRequestItem`.
- No duplicate-active-request guard (allowed; manager visibility via list filters).

## Test Strategy

Smoke tests at `tests/smoke/replenishment-requests.test.ts`. Mocks: `vi.mock('../../src/shared/utils/prisma.js')` + `vi.mock('../../src/shared/notifications/index.js')`. Scenarios per endpoint:

- **Create**: happy path; empty items (400); missing unitPrice with no ProductSupplier (400 `UNIT_PRICE_REQUIRED`); unitPrice defaulted from ProductSupplier; inactive supplier (404); inactive product (404); OPERATOR forbidden (403).
- **Send**: PENDING→SENT + notification fired; supplier no whatsapp (422); already SENT (409); notification failure keeps DB SENT and logs error.
- **Receive**: SENT→RECEIVED creates one `IN` movement per item using `receivedQuantity`; missing `receivedQuantity` defaults to `requestedQuantity`; `receivedQuantity > requestedQuantity` (400 `PARTIAL_RECEIPT_INVALID`); PENDING→RECEIVED (409).
- **Cancel**: PENDING→CANCELLED (no notify); SENT→CANCELLED (notify); RECEIVED→CANCELLED (409).
- **List/Get**: filters, pagination, embedded items.

## Error Catalog

Add to `src/shared/errors/errorCodes.ts`: `REPLENISHMENT_REQUEST_NOT_FOUND` (404), `INVALID_STATE_TRANSITION` (409), `UNIT_PRICE_REQUIRED` (400), `PARTIAL_RECEIPT_INVALID` (400), `SUPPLIER_HAS_NO_WHATSAPP` (422), `REPLENISHMENT_ITEMS_REQUIRED` (400), `REPLENISHMENT_ITEM_NOT_FOUND` (400).

## Environment & Dependencies

- `package.json`: add `twilio`.
- `.env.example`: add `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`.
- Thesis demo uses **Twilio Sandbox** (free-form messages, pre-verified recipient numbers). Production requires Twilio WhatsApp Business template approval — out of scope; document in `.env.example` comment.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `prisma/schema.prisma` | Modified | 4 fields on `ReplenishmentRequest`, 1 on `ReplenishmentRequestItem`, 2 User relations, composite index |
| `src/modules/replenishment-requests/` | New | 5-file module (schema, repository, service, controller, routes) |
| `src/shared/notifications/` | New | Twilio WhatsApp wrapper + E.164 normalizer |
| `src/shared/errors/errorCodes.ts` | Modified | 7 new codes |
| `src/app.ts` | Modified | Register `/api/replenishment-requests` router; nested supplier route |
| `src/modules/suppliers/routes.ts` | Modified | Add `GET /:supplierId/replenishment-requests` |
| `.env.example` | Modified | Twilio vars |
| `package.json` | Modified | Add `twilio` |
| `tests/smoke/replenishment-requests.test.ts` | New | Smoke coverage |
| New Prisma migration | New | Add 5 fields + relations + index |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Twilio silent failure (fire-and-forget) | Med | Pino `error` log; accepted for thesis; documented; future change adds `notificationStatus` |
| Supplier `whatsapp` not E.164 | Med | Normalizer + pre-transition guard (422) |
| Repo-direct RECEIVED bypass breaks inventory invariants | Low | Reuse `insertMovement` + stock CAS from `inventoryMovementsRepository`; smoke test asserts stock delta |
| Server crash between DB commit and Twilio call | Low | Accepted (no queue); documented |
| Twilio Sandbox recipient allowlist | Med | Documented in `.env.example`; thesis demo uses pre-verified numbers |
| Migration on production data | Low | New fields are nullable; new item unique constraint may conflict with existing dup rows — pre-check in migration script |

## Rollback Plan

1. Remove `/api/replenishment-requests` and supplier sub-route registrations in `src/app.ts` (feature invisible).
2. Delete `src/modules/replenishment-requests/` and `src/shared/notifications/`.
3. Revert `errorCodes.ts`, `.env.example`, `package.json` (uninstall `twilio`).
4. Prisma: `prisma migrate resolve` marking the migration reverted, then create a down-migration dropping the 5 new fields, 2 relations, composite index, and item unique constraint. Existing data untouched (fields are nullable; unique constraint drop is non-destructive).

## Dependencies

- `twilio` npm package.
- Twilio account + WhatsApp-enabled sender (Sandbox for dev).
- `inventoryMovementsRepository` (existing) reused directly inside RECEIVED transaction.

## Success Criteria

- [ ] `POST /api/replenishment-requests` creates PENDING with items; defaulted `unitPrice` from `ProductSupplier` when omitted.
- [ ] Missing `unitPrice` with no `ProductSupplier` link returns 400 `UNIT_PRICE_REQUIRED`.
- [ ] `POST /:id/send` transitions PENDING→SENT, sets `sentAt`, and fires WhatsApp; Twilio failure keeps status SENT and logs at `error`.
- [ ] SENT without supplier `whatsapp` returns 422 `SUPPLIER_HAS_NO_WHATSAPP` and does not transition.
- [ ] `POST /:id/receive` transitions SENT→RECEIVED atomically, sets `receivedAt` + `receivedByUserId`, and creates one `IN` `InventoryMovement` per item using `receivedQuantity` (default `requestedQuantity`).
- [ ] `receivedQuantity` outside `[0, requestedQuantity]` returns 400 `PARTIAL_RECEIPT_INVALID`; no partial state persists.
- [ ] `POST /:id/cancel` from PENDING transitions silently; from SENT sets `cancelledAt` + `cancelledByUserId` and fires cancellation WhatsApp.
- [ ] Invalid transitions return 409 `INVALID_STATE_TRANSITION`; concurrent duplicate transitions never double-fire (status-CAS proven by test).
- [ ] OPERATOR is 403 on create/send/receive/cancel; ADMIN/MANAGER succeed.
- [ ] `GET /` supports pagination + `status`, `supplierId`, `dateFrom`, `dateTo`; `GET /:id` embeds items; `GET /api/suppliers/:id/replenishment-requests` returns supplier-scoped list.
- [ ] Smoke suite passes with Prisma + Twilio mocked; scenarios listed above are all green.
- [ ] `.env.example` documents Twilio vars and Sandbox note; `twilio` present in `package.json`.

## Forecast

- **Production code**: ~900 lines (module ~700, notifications ~80, error codes ~20, migration ~50, wiring ~50).
- **Test code**: ~700 lines.
- **File count**: ~9 new, ~5 modified.
- **PR shape**: exceeds 800-line review budget → chained PRs. Recommended split: (1) schema + migration + error codes + notifications shared + module skeleton (schema/repository/service scaffolding + create/list/get); (2) transitions (send/receive/cancel) + Twilio wiring + full smoke suite. Confirm with orchestrator (`chained_pr_strategy = ask-on-risk`).
