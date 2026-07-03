# Design: Replenishment Requests

## Technical Approach

New `src/modules/replenishment-requests/` follows the existing 5-file layered pattern (schema → repository → service → controller → routes) used by `inventory-movements`. Prisma schema amended in-place (all new fields nullable → non-destructive). Twilio wrapper in `src/shared/notifications/`. RECEIVED runs inside one `prisma.$transaction`; WhatsApp fires AFTER commit as fire-and-forget (spec §Send, §Cancel).

## Architecture Decisions

| Decision | Choice | Alternative | Rationale |
|---|---|---|---|
| Concurrency | `updateMany({where:{id, status:expected}})` status-CAS | `SELECT FOR UPDATE` | Mirrors `attemptStockUpdate`; natural idempotency (2nd caller → count=0 → 409). |
| RECEIVED tx | Service composes tx directly using `inventoryMovementsRepository.attemptStockUpdate`/`.insertMovement` inside one `$transaction` | Loop over `inventoryMovementsService.createMovement` | Nesting would re-run role guards + break atomicity. Repo-direct = 1 tx / N items. |
| Twilio timing | Fire-and-forget AFTER commit; `.catch(logger.error)` | Await in tx / queue | Spec §Send + locked decision #2: DB truth > delivery guarantee. |
| Twilio DI | Module singleton + exported `__setNotificationService(fake)` | Constructor injection | Matches existing singleton style; test override is one line. |
| Supplier list route | Mount inside `suppliers.routes.ts`, controller lives in this module | New sub-path here | Mirrors `products.routes.ts` mounting `listMovementsByProductController`. |
| Item unique | `@@unique([replenishmentRequestId, productId])` | Allow dupes | Prevents ambiguous partial-receive; project pre-launch → zero data risk. |
| Pagination | `page` + `pageSize` (spec-mandated) | `page`+`limit` | Spec §List and Retrieve explicitly requires `pageSize`. This module diverges from the project's `limit` convention because the spec is authoritative. |
| Empty items error | Zod `.min(1)` with custom message mapped to `REPLENISHMENT_ITEMS_REQUIRED` in the validation error mapper | Generic `VALIDATION_ERROR` fallthrough | Spec's error catalog REQUIRES the specific code (400). Mapping is centralized in `validate` middleware so the schema stays declarative. |

## Data Flow — RECEIVE

```
Controller → Service.receive(id, userId, body)
  └─ prisma.$transaction(async tx => {
       1. repo.transitionToReceived(tx,id,userId) → count===0 ? throw 409
       2. for each item on request:
            qty = body.items?.find(id)?.receivedQuantity ?? item.quantity
            0 ≤ qty ≤ item.quantity  else 400 PARTIAL_RECEIPT_INVALID
            repo.updateItemReceivedQuantity(tx,itemId,qty)
            inventoryMovementsRepository.attemptStockUpdate(tx,productId,obs,next)
            inventoryMovementsRepository.insertMovement(tx,{type:IN,...})
       3. return repo.findById(tx,id,{includeItems:true})
     })
  └─ return DTO   // no Twilio on RECEIVE
```

SEND / CANCEL-after-SENT: tx commits first → respond → `notificationService.sendWhatsAppMessage(...).catch(logger.error)` NOT awaited.

## File Changes

| File | Action | Description |
|---|---|---|
| `prisma/schema.prisma` | Modify | +4 fields on ReplenishmentRequest, +1 on Item, +2 User relations, +3 indexes, +1 unique. |
| `prisma/migrations/<ts>_add_replenishment_audit_and_partial_receipt/migration.sql` | Create | ALTER TABLE ADD COLUMN (nullable), CREATE (UNIQUE) INDEX. |
| `src/modules/replenishment-requests/*.ts` (5 files) | Create | schema, repository, service, controller, routes. |
| `src/shared/notifications/index.ts` | Create | Exports `notificationService`, `normalizeE164`, `__setNotificationService`. |
| `src/shared/notifications/twilio-client.ts` | Create | Twilio SDK impl reading env vars. |
| `src/shared/notifications/templates.ts` | Create | `buildSentTemplate`, `buildCancelledTemplate` (English). |
| `src/shared/errors/errorCodes.ts` | Modify | +7 codes. |
| `src/modules/suppliers/suppliers.routes.ts` | Modify | Mount supplier-scoped list. |
| `src/app.ts` | Modify | `app.use('/api/replenishment-requests', router)`. |
| `.env.example`, `src/config/env.ts` | Modify | Twilio vars (optional at boot, checked at send). |
| `package.json` | Modify | `+twilio`. |
| `tests/smoke/replenishment-requests.test.ts` | Create | Full smoke suite (mirrors mocked-Prisma pattern of `inventory-movements.test.ts`). |

## Interfaces / Contracts

**Prisma delta — Existing vs Required**

*ReplenishmentRequest* (existing has: id, supplierId, requestedByUserId, status, requestedAt, sentAt, notes, createdAt, updatedAt).

| Field | Existing | Required | Delta |
|---|---|---|---|
| receivedAt / cancelledAt | — | `DateTime?` | ADD |
| receivedByUserId / cancelledByUserId | — | `String?` + FK User onDelete:Restrict (rels `ReplenishmentReceiver`,`ReplenishmentCanceller`) | ADD |
| indexes | supplierId, status, requestedAt | +`[supplierId,status]`, +`[receivedByUserId]`, +`[cancelledByUserId]` | ADD |

*ReplenishmentRequestItem* (existing has: id, replenishmentRequestId, productId, requestedQuantity, unitPrice).

| Field | Existing | Required | Delta |
|---|---|---|---|
| receivedQuantity | — | `Int?` | ADD |
| unique | — | `@@unique([replenishmentRequestId, productId])` | ADD |

*User* — add inverse relations `receivedRequests`, `cancelledRequests`.

**Zod schemas**

- `createReplenishmentRequestSchema` — `{ supplierId: cuid, notes?, items: z.array(...).min(1, { message: "REPLENISHMENT_ITEMS_REQUIRED" }) }` where each item is `{productId:cuid, requestedQuantity:int≥1, unitPrice?:number>0}`. The message string is a sentinel: the `validate` middleware inspects `ZodError.issues[].message` and, when it equals `REPLENISHMENT_ITEMS_REQUIRED`, throws `new AppError("REPLENISHMENT_ITEMS_REQUIRED", 400)` instead of the generic `VALIDATION_ERROR` (400). All other Zod failures still map to `VALIDATION_ERROR`.
- `sendReplenishmentRequestSchema` / `cancelReplenishmentRequestSchema` — `{}`
- `receiveReplenishmentRequestSchema` — `{ items?: [{id:cuid, receivedQuantity?:int≥0}] }`
- `listReplenishmentRequestsQuerySchema` — `{ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20), status?, supplierId?, dateFrom?: z.coerce.date, dateTo? }`. Same `page`+`pageSize` shape reused by the supplier-scoped list.

**Response DTOs**

```ts
interface ReplenishmentRequestDto {
  id; supplierId; requestedByUserId; status;
  requestedAt: string; sentAt: string|null;
  receivedAt: string|null; receivedByUserId: string|null;
  cancelledAt: string|null; cancelledByUserId: string|null;
  notes: string|null;
}
interface ReplenishmentRequestItemDto {
  id; productId;
  requestedQuantity: number;
  receivedQuantity: number|null;
  unitPrice: number; // Decimal.toNumber()
}
interface ReplenishmentRequestWithItemsDto extends ReplenishmentRequestDto {
  items: ReplenishmentRequestItemDto[];
}
```

Mapper `toDto(row)` handles Decimal→number, Date→ISO. camelCase (existing convention).

**Repository methods**

```ts
create(dto, actorId, tx?): Promise<WithItems>
findById(id, { includeItems }): Promise<...|null>
findMany(filters, { page, pageSize }): Promise<[Row[], number]>
findManyBySupplier(supplierId, { page, pageSize }): Promise<[Row[], number]>
transitionToSent(tx, id, userId): Promise<number>       // updateMany count
transitionToReceived(tx, id, userId): Promise<number>
transitionToCancelled(tx, id, userId, priorStatus): Promise<number>
updateItemReceivedQuantity(tx, itemId, qty): Promise<void>
```

`postReceivedMovements` is NOT a repo method — inlined in `service.receive` because it composes two repositories.

**NotificationService**

```ts
interface NotificationService { sendWhatsAppMessage(to: string, body: string): Promise<void>; }
export const normalizeE164: (raw: string) => string | null;  // strip [\s()-], require ^\+\d{8,15}$
export let notificationService: NotificationService;
export function __setNotificationService(fake: NotificationService): void; // test-only
```

Templates hardcoded English (i18n out of scope; TODO comment in `templates.ts`):
- SENT: `New order #{id} from {company}. Items: {lines}. Total: ${total}. Please confirm.`
- CANCELLED: `Order #{id} from {company} has been cancelled.`

**Error codes** (all reuse `AppError` — no new subclasses; codes/HTTP mirror spec §Error Catalog verbatim)

| Code | HTTP | Thrown by |
|---|---|---|
| REPLENISHMENT_REQUEST_NOT_FOUND | 404 | service.get/send/receive/cancel |
| INVALID_STATE_TRANSITION | 409 | service (status-CAS count=0) |
| UNIT_PRICE_REQUIRED | 400 | service.create |
| PARTIAL_RECEIPT_INVALID | 400 | service.receive |
| SUPPLIER_HAS_NO_WHATSAPP | 422 | service.send (pre-check) |
| REPLENISHMENT_ITEMS_REQUIRED | 400 | Zod `.min(1)` sentinel → mapped to `AppError` in `validate` middleware (NOT generic VALIDATION_ERROR) |
| REPLENISHMENT_ITEM_NOT_FOUND | 400 | service.receive (unknown item id) |

**Routes** — mounted at `/api/replenishment-requests` in `src/app.ts` (after `inventoryMovementsRouter`); supplier-scoped list mounted inside `suppliers.routes.ts`. Chain: `authenticate → requireRole(...) → validate(...)`.

Explicit endpoint-to-spec mapping (spec §Requirements → controller):

| # | Spec requirement | Method + Path | Controller method | Auth |
|---|---|---|---|---|
| 1 | Create | POST /api/replenishment-requests | create | requireRole(ADMIN, MANAGER) |
| 2 | List | GET /api/replenishment-requests | list | authenticate |
| 3 | Get by id | GET /api/replenishment-requests/:id | getById | authenticate |
| 4 | Send | POST /api/replenishment-requests/:id/send | send | requireRole(ADMIN, MANAGER) |
| 5 | Receive | POST /api/replenishment-requests/:id/receive | receive | requireRole(ADMIN, MANAGER) |
| 6 | Cancel | POST /api/replenishment-requests/:id/cancel | cancel | requireRole(ADMIN, MANAGER) |
| 7 | Supplier-scoped list | GET /api/suppliers/:supplierId/replenishment-requests | listBySupplier | authenticate |
| 8 | Role-Based Access | — (cross-cutting) | — | Implicit: `requireRole(ADMIN,MANAGER)` on every mutation (#1,4,5,6); reads (#2,3,7) allow all authenticated roles including OPERATOR |

## Testing Strategy

Follows the mocked-Prisma convention established in `tests/smoke/inventory-movements.test.ts` — no real DB.

| Layer | What | How |
|---|---|---|
| Unit | Zod edge cases (empty items sentinel), `normalizeE164`, templates | Vitest, pure functions, no I/O |
| Smoke (HTTP) | All spec Gherkin scenarios (create, list w/ `page`+`pageSize`, get, send, receive, cancel, supplier-scoped list, role gating) | Vitest + supertest + `vi.mock('../../src/shared/utils/prisma.js')` — Prisma fully mocked with in-memory `Map` stores for requests, items, products; `$transaction` dual-mode (callback runs with `mockTx`, array uses `Promise.all`) |
| Concurrency (simulated) | Two "concurrent" send/receive calls → 1×200 + 1×409, no double stock post | Mock `tx.replenishmentRequest.updateMany` (status-CAS) to return `{count:1}` on the first call and `{count:0}` on the second via `.mockResolvedValueOnce({count:1}).mockResolvedValueOnce({count:0})`. Real DB races are out of scope — this proves the CAS branch. |
| Twilio | Success + failure keep DB state; failure logs Pino error; SUPPLIER_HAS_NO_WHATSAPP pre-check | `__setNotificationService({ sendWhatsAppMessage: vi.fn().mockResolvedValue(undefined) })` for success; `.mockRejectedValue(new Error(...))` for failure; spy on Pino logger |
| Role gating | OPERATOR mutation → 403; OPERATOR GET → 200 | Existing `makeAccessToken(userId, 'OPERATOR')` helper pattern |

Note: real-DB integration tests are out of scope for this change. If added later they are a separate concern with their own harness.

## Migration / Rollout

Non-destructive: all fields nullable, indexes/unique additive. Migration `add_replenishment_audit_and_partial_receipt`. Pre-check comment: `SELECT COUNT(*) FROM (SELECT replenishmentRequestId, productId FROM ReplenishmentRequestItem GROUP BY 1,2 HAVING COUNT(*)>1)` = 0 (project pre-launch). No feature flag. Twilio env vars optional at boot; send-time missing → 500 INTERNAL_ERROR.

## Forecast

Prod: schema+migration ~55 + module ~600 + notifications ~150 + wiring ~30 = **~835 lines**. Tests: ~700. Total ~1,535 → **exceeds 800-line budget → chained PRs required** (2-PR split anticipated in proposal).

## Open Questions

- [ ] English-only templates — confirm no i18n requirement for thesis defense (default English, TODO left in `templates.ts`).
