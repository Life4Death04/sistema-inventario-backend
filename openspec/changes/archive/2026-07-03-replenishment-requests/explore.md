# Exploration: replenishment-requests

> **Generated**: 2026-07-02 | **Status**: Ready for Proposal
> **Project**: sistema-inventario-backend | **Store**: hybrid (Engram + openspec)

---

## Current State

The codebase has six fully implemented modules following a strict 5-file layered pattern:
`schema.ts → repository.ts → service.ts → controller.ts → routes.ts`

**Prisma schema** already defines both models:

- `ReplenishmentRequest` (id, supplierId, requestedByUserId, status `ReplenishmentStatus`, requestedAt, sentAt?, notes?, createdAt, updatedAt)
- `ReplenishmentRequestItem` (id, replenishmentRequestId, productId, requestedQuantity, unitPrice)
- Enum `ReplenishmentStatus` = PENDING | SENT | RECEIVED | CANCELLED

Both models are complete and **migration-ready** — no schema additions needed for the core data model.

**Critical gap**: No `Twilio` / `node-cron` packages are installed (not in `package.json`). Twilio must be added as a dependency. No Twilio env vars are scaffolded in `.env.example`.

**Supplier model** already has `whatsapp: String?` — the phone number is available for WhatsApp notification without schema changes.

**Frontend contract** (`common.types.ts`) defines:
```ts
ReplenishmentStatus = 'PENDING' | 'SENT' | 'RECEIVED' | 'CANCELLED'
ReplenishmentRequestItem = { id, productId, requestedQuantity, unitPrice: number }
ReplenishmentRequest     = { id, supplierId, requestedByUserId, status, requestedAt, sentAt?, notes, items[] }
```
Backend owns the final shape; the frontend reference is an INPUT signal only.

---

## Affected Areas

- `prisma/schema.prisma` — models already exist; **no changes needed** for core data model
- `.env.example` — needs Twilio env vars added (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_WHATSAPP_FROM)
- `package.json` — needs `twilio` package added
- `src/app.ts` — register `/api/replenishment-requests` router
- `src/shared/errors/errorCodes.ts` — add replenishment-specific error codes
- `src/modules/replenishment-requests/` — new module (5 files)
- `src/shared/notifications/` — new shared module for Twilio abstraction (recommended)
- `tests/smoke/replenishment-requests.test.ts` — smoke coverage (Prisma + Twilio mocked)

---

## Business Flow Analysis

### Who Creates Requests (Role Matrix)
| Operation           | ADMIN | MANAGER | OPERATOR |
|---------------------|-------|---------|----------|
| Create PENDING      | ✅    | ✅      | ❌       |
| Send (→ SENT)       | ✅    | ✅      | ❌       |
| Mark Received       | ✅    | ✅      | ❌       |
| Cancel              | ✅    | ✅      | ❌       |
| Read (list/get)     | ✅    | ✅      | ✅       |

**Rationale**: Creating and transitioning replenishment requests is a managerial procurement action. OPERATOR visibility is read-only, consistent with how inventory mutations work.

### State Machine

```
                  [create]
                     │
                     ▼
               ┌─ PENDING ─┐
               │            │
        [send] │            │ [cancel]
               │            │
               ▼            ▼
             SENT       CANCELLED
               │            (terminal)
     [receive] │
               │
               ▼
           RECEIVED
           (terminal)
```

**Valid transitions**:
| From       | To         | Trigger             | Side Effects                              |
|------------|------------|---------------------|-------------------------------------------|
| —          | PENDING    | POST /               | None                                      |
| PENDING    | SENT       | POST /:id/send       | WhatsApp notification to supplier         |
| PENDING    | CANCELLED  | POST /:id/cancel     | None                                      |
| SENT       | RECEIVED   | POST /:id/receive    | Auto-create IN InventoryMovement per item |
| SENT       | CANCELLED  | POST /:id/cancel     | None (notification already sent)          |

**Invalid transitions** (→ 409 INVALID_TRANSITION):
- PENDING → RECEIVED (must be SENT first)
- RECEIVED → anything (terminal)
- CANCELLED → anything (terminal)

### Transition Details

**→ SENT** (`POST /:id/send`):
1. Validate status is PENDING
2. Validate supplier has a `whatsapp` number (otherwise → 422 SUPPLIER_NO_WHATSAPP)
3. Set `status = SENT`, `sentAt = now()` in a DB transaction
4. **After** DB commit: fire Twilio notification (fire-and-forget or best-effort with logged failure)
5. If notification fails: log error, do NOT rollback DB — the request is still SENT

**→ RECEIVED** (`POST /:id/receive`):
1. Validate status is SENT
2. Open a DB transaction:
   a. Set `status = RECEIVED`
   b. For each item: call `inventoryMovementsService.createMovement()` with type=IN, quantity=requestedQuantity, reason="Replenishment received: {requestId}"
3. Commit atomically (if any movement fails → rollback all)

**→ CANCELLED** (`POST /:id/cancel`):
1. Validate status is PENDING or SENT
2. Set `status = CANCELLED` (no side effects)

---

## Data Model Assessment

### Models Already in Schema ✅

```prisma
model ReplenishmentRequest {
  id                String              @id @default(cuid())
  supplierId        String
  requestedByUserId String
  status            ReplenishmentStatus @default(PENDING)
  requestedAt       DateTime            @default(now())
  sentAt            DateTime?
  notes             String?
  createdAt         DateTime            @default(now())
  updatedAt         DateTime            @updatedAt

  supplier        Supplier                   @relation(...)
  requestedByUser User                       @relation(...)
  items           ReplenishmentRequestItem[]

  @@index([supplierId])
  @@index([status])
  @@index([requestedAt])
}

model ReplenishmentRequestItem {
  id                     String  @id @default(cuid())
  replenishmentRequestId String
  productId              String
  requestedQuantity      Int
  unitPrice              Decimal @db.Decimal(12, 2)

  request ReplenishmentRequest @relation(...onDelete: Cascade)
  product Product              @relation(...onDelete: Restrict)

  @@index([replenishmentRequestId])
  @@index([productId])
}
```

### Potential Schema Additions (open questions — see §8)

- `receivedAt: DateTime?` — timestamp when RECEIVED transition occurred (symmetric to `sentAt`)
- `cancelledAt: DateTime?` — timestamp for CANCELLED transition
- `cancelledByUserId: String?` — audit trail for who cancelled
- A composite index `@@index([supplierId, status])` for "pending requests per supplier" query
- `receivedByUserId: String?` — who received the order

These are **optional enhancements** that should be decided before spec writing, not blockers.

---

## API Surface (Proposed)

### Primary Resource

```
POST   /api/replenishment-requests              Create PENDING request (ADMIN, MANAGER)
GET    /api/replenishment-requests              List all with filters (ALL roles)
GET    /api/replenishment-requests/:id          Get detail with items (ALL roles)
```

### State Transition Endpoints (Action sub-resources)

```
POST   /api/replenishment-requests/:id/send     PENDING → SENT + WhatsApp notify
POST   /api/replenishment-requests/:id/receive  SENT → RECEIVED + auto-IN movements
POST   /api/replenishment-requests/:id/cancel   PENDING|SENT → CANCELLED
```

**REST style decision — Dedicated action endpoints vs PATCH with body**:

| Approach | Pros | Cons | Complexity |
|----------|------|------|------------|
| Dedicated POST /:id/send, /receive, /cancel | Clear intent, no ambiguous body parsing, easier to guard per transition, consistent with how industry models workflows | More endpoints | Low |
| PATCH /:id with `{ status: "SENT" }` | Fewer endpoints | Must validate which transitions are legal, body parsing is ambiguous, side effects (notifications) are less obvious from the URL | Medium |

**Recommendation**: Dedicated action endpoints. The side effects (Twilio, stock update) are significant enough that clarity wins. Pattern precedent: GitHub uses `/issues/:id/lock`, `/pulls/:id/merge`.

### Supplier Sub-resource (optional, lower priority)
```
GET    /api/suppliers/:id/replenishment-requests   Scoped list for a supplier
```
This is a convenience endpoint. Not required for Phase 1.

### Create Body Shape
```ts
{
  supplierId: string;       // cuid, must be active
  notes?: string;           // max 500 chars
  items: Array<{
    productId: string;      // cuid, must be active
    requestedQuantity: int; // >= 1
    unitPrice: Decimal;     // >= 0.00, max 2 decimal places
  }>;                       // min 1 item required
}
```

### Response DTO Shape
```ts
{
  id: string;
  supplierId: string;
  requestedByUserId: string;
  status: ReplenishmentStatus;
  requestedAt: string;      // ISO 8601
  sentAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  items: Array<{
    id: string;
    productId: string;
    requestedQuantity: number;
    unitPrice: string;      // Decimal serialized as string (consistent with Product.price)
  }>;
}
```

**Note on `unitPrice`**: Frontend type shows `number` but Prisma Decimal serializes as string. Backend MUST serialize as string to be safe. Frontend will need to handle the coercion (or we document the mismatch).

---

## Notification Integration

### Approach Options

| Approach | Pros | Cons | Complexity |
|----------|------|------|------------|
| A: Shared `src/shared/notifications/` module with `NotificationsService` | Testable in isolation, reusable for future SMS/email/push, clean dependency injection, single mock point in tests | Extra file | Low |
| B: Inline Twilio call in replenishment service | Fewer files | Tight coupling, hard to mock without touching the replenishment service test, not reusable | Medium |
| C: Event emitter / message queue | Decoupled, retry-friendly | Way over-engineered for a thesis, adds infra dependency | High |

**Recommendation**: **Approach A** — `src/shared/notifications/` with a `NotificationsService` class exposing `sendWhatsAppMessage(to: string, body: string): Promise<void>`. The replenishment service depends on it via constructor or singleton import. Tests mock `../../shared/notifications/index.js` independently.

### Notification Timing
- Fire **after the DB transaction commits** for the SENT transition
- Use try/catch around the notification call; on failure: log the error at `error` level (Pino), do NOT rollback the DB state (the request is now SENT regardless of whether WhatsApp delivered)
- Consider adding a `notificationStatus: 'SENT' | 'FAILED' | 'PENDING'` field to `ReplenishmentRequest` to track delivery — this is an open question for the user

### WhatsApp Message Template (proposed)
```
HighMeds Pharmacy - Purchase Order
Request ID: {id}
Date: {requestedAt}
Items:
- {product.name} x {requestedQuantity} units @ {unitPrice}
...
Total: {sum}
Please confirm receipt.
```

### Twilio Requirements
- Account SID + Auth Token (secrets)
- WhatsApp-enabled sender number (Twilio Sandbox in dev, Business API in prod)
- Supplier `whatsapp` field must be in E.164 format (`+58412XXXXXXX`)
- Guard: supplier must have `whatsapp != null` before attempting SENT transition

---

## Concurrency and Integrity

### Duplicate Requests
- Two simultaneous PENDING requests to the same supplier for the same product are **allowed** by the schema (no unique constraint at DB level)
- Business question (open): Should we warn/block if a PENDING or SENT request for the same supplier already exists?
- **Recommendation**: Allow duplicates but expose them through the list endpoint with filters. Let the manager decide.

### CAS Guard Needed?
- The SENT → RECEIVED transition triggers InventoryMovement creates. Since we call `inventoryMovementsService.createMovement()` which already uses CAS retry internally, the stock update is safe.
- The status transition itself (PENDING → SENT, etc.) uses a simple `update WHERE status = expectedStatus` pattern, which provides atomic guard against double-firing.
- Pattern: use `prisma.replenishmentRequest.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'SENT' } })` and check `count === 0` → 409 INVALID_TRANSITION. This provides a status-CAS without full optimistic locking.

### RECEIVED → Auto-IN Movements
- Each item generates one `InventoryMovement` of type IN
- These must be wrapped in the same transaction as the status update
- The `inventoryMovementsRepository.insertMovement(tx, ...)` can be called inside the replenishment service's transaction callback
- The stock update CAS from the movements module must also be inside this transaction — but since `createMovement` is a service method that opens its own transaction, we must call repository methods directly (not the service) inside the RECEIVED handler's transaction. This is an important design boundary: **repository bypass for transactional cohesion**.

---

## Test Strategy

### Mirror Pattern from smoke tests

All existing smoke tests (products, suppliers, inventory-movements) follow this pattern:
- `vi.mock('../../src/shared/utils/prisma.js')` — full Prisma mock via in-memory stores
- `vi.mock` for any external services (we'll add Twilio client mock)
- `beforeEach`: `seedStore()` + re-bind mocks
- `afterEach`: `vi.restoreAllMocks()`

### For replenishment-requests smoke:
```
vi.mock('../../src/shared/utils/prisma.js')
vi.mock('../../src/shared/notifications/index.js')  // mock Twilio notifications
```

### Smoke scenarios to cover:
| Scenario | Type |
|----------|------|
| Create PENDING with valid items | Happy path |
| Create with empty items array | Validation error (400) |
| Create with inactive supplier | 404 |
| Create with inactive product in items | 404 |
| OPERATOR cannot create | 403 |
| PENDING → SENT (supplier has whatsapp) | Happy path + notification fired |
| PENDING → SENT (supplier no whatsapp) | 422 |
| PENDING → RECEIVED (invalid) | 409 INVALID_TRANSITION |
| SENT → RECEIVED (auto creates IN movements) | Happy path |
| SENT → CANCELLED | Happy path |
| RECEIVED → CANCELLED (invalid) | 409 INVALID_TRANSITION |
| List with status filter | 200 paginated |
| Get by id includes items | 200 with items array |
| Notification failure → DB still SENT, error logged | Error path |

### Unit vs Integration
- All of the above: **smoke tests** (Prisma + Twilio mocked)
- Twilio delivery confirmation webhooks (if added): real integration test against sandbox

---

## Known Unknowns / Open Questions

These must be answered **before spec writing** (the orchestrator should surface these to the user):

1. **`receivedAt`, `cancelledAt` timestamps**: Should the schema track when each terminal transition happened? Adds 2 optional DateTime fields and changes the DTO.

2. **`receivedByUserId` / `cancelledByUserId`**: Full audit trail for who executed each transition? Each adds a FK to User.

3. **`notificationStatus` field**: Track whether the WhatsApp delivery succeeded? Options: ignore (fire-and-forget, log only), add `notificationStatus: 'PENDING' | 'SENT' | 'FAILED'` to schema. If added, enables "resend notification" use case later.

4. **Duplicate active request guard**: Block or warn if a PENDING or SENT request for the same supplier already exists? Or allow freely?

5. **`cancelledByUserId` for SENT cancellation**: If a SENT request is cancelled, should we send a WhatsApp cancellation notice to the supplier?

6. **RECEIVED → partial receipt**: Can the pharmacy receive only part of the ordered quantity? Or must 100% be received? (Affects whether `receivedQuantity` per item is needed.)

7. **`unitPrice` data source**: Is `unitPrice` per item manually entered by the manager at request creation time, or should it default from `ProductSupplier.referencePrice`? If defaulted, what if there's no reference price on file?

8. **WhatsApp template approval**: Twilio WhatsApp Business API requires pre-approved message templates for production. Does the thesis scope only use sandbox (free-form messages)? This affects whether we need a `templateId` field.

9. **Twilio Sandbox vs Production**: In sandbox mode, only pre-verified numbers can receive messages. Does the demo environment have test supplier WhatsApp numbers available?

10. **`notes` editability**: Can the notes field be updated after creation (PATCH /:id)? Or is the request immutable after creation (correction by cancel + re-create)?

---

## Risks

1. **Twilio package not installed**: `twilio` is not in `package.json`. Must be added with `npm install twilio`. Adds ~5 MB to bundle.

2. **WhatsApp Business API approval**: Twilio's WhatsApp integration requires a Facebook Business verification and template approval for production. Sandbox mode works but has restrictions (only pre-verified numbers). For a thesis demo, sandbox is sufficient — document the limitation.

3. **Supplier phone format**: The `whatsapp` field in `Supplier` schema is validated as `/^\+?\d{8,15}$/` (optional leading +). Twilio expects E.164 format (`+CCNNNNNNNNN`). If the stored number lacks the leading `+`, Twilio will reject. The notification service must normalize the number or the schema must enforce E.164 strictly.

4. **DB transaction + Twilio side-effect**: The SENT transition fires a network call after commit. If the server crashes between DB commit and Twilio call, the notification is lost and `notificationStatus` (if tracked) would be stale. Without a job queue (which is not in scope), this is an acceptable gap for a thesis — document it.

5. **RECEIVED auto-movements scope creep**: The CAS retry for stock updates in `inventory-movements.service.ts` is designed to run inside its own transaction. Reusing it inside the RECEIVED handler's transaction requires calling repository methods directly (bypassing the service retry loop). This is a design boundary that must be documented in the spec.

6. **Product missing fields (Engram #262)**: The Product model was closed in obs #281 — fields are now finalized. This risk is resolved.

7. **`unitPrice` as Decimal vs number in frontend**: Frontend type shows `unitPrice: number` for ReplenishmentRequestItem but `price: string` for Product (Decimal serialization). The backend must be consistent — serialize all Decimal values as strings. Frontend will need to parse `unitPrice` as a number client-side.

8. **Cost implications**: Twilio WhatsApp messages cost ~$0.005–$0.05 per message depending on country/tier. For a thesis with few demo transactions, negligible. But must be documented.

---

## Approaches Comparison

### Approach 1: Full module (all transitions + Twilio) in one change
- Pros: Complete feature in one PR, single deployment
- Cons: Large scope (~900+ lines), harder to review, harder to test transitions in isolation
- Effort: High

### Approach 2: Two-phase — Phase 1 (CRUD + state machine, no Twilio) / Phase 2 (Twilio notification)
- Pros: Working state machine without Twilio dependency first, easier to test and review, Twilio added incrementally
- Cons: Two separate PRs/changes, feature is incomplete without Phase 2
- Effort: Medium each

### Approach 3: Full module with Twilio notifications as a shared service (recommended)
- Pros: Ships the complete feature cleanly, notification abstraction is reusable, can mock Twilio in tests trivially, clear separation between DB logic and notification side-effects
- Cons: Slightly more files
- Effort: High but manageable (estimated ~850 production lines + ~700 test lines)

**Recommendation**: **Approach 3** — full module in one change with `src/shared/notifications/` abstraction. The Twilio wrapper is small (~40 lines), the service separation is clean, and mock injection in tests is straightforward. Use chained PRs to stay within the 800-line review budget.

---

## Recommendation

Proceed with the full replenishment-requests module in a single SDD change, using:
- Dedicated action endpoints for state transitions (`POST /:id/send`, `/:id/receive`, `/:id/cancel`)
- `src/shared/notifications/` shared module with a `NotificationsService` (Approach 3)
- Fire-and-forget notification after DB commit with error logging (no rollback on Twilio failure)
- Repository-layer bypass inside the RECEIVED transaction (direct `insertMovement` + `attemptStockUpdate`) to keep the stock update atomic with the status change
- Chained PRs: Phase 1 (schema errors + module skeleton + CRUD) → Phase 2 (transitions + Twilio)

**Before writing the spec, the orchestrator must ask the user to resolve open questions #1, #2, #3, #6, and #7 at minimum.** Questions #4, #5, #8, #9, #10 can be defaulted if the user doesn't have a strong opinion.

---

## Ready for Proposal

**Conditionally yes** — the core architecture is clear and the module can be specified. The orchestrator should run a short Q&A round (5–7 questions max) before spec writing to nail down the schema additions, audit trail, notification tracking, and partial receipt behavior. These decisions affect the Prisma schema and the DTO shape, which must be locked before spec writing.
