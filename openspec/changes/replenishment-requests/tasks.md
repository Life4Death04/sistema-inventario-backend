# Tasks: Replenishment Requests

## Apply Phase Skill Load
- `/home/life4death/.claude/skills/sdd-apply/SKILL.md`
- `/home/life4death/.config/opencode/skills/work-unit-commits/SKILL.md`
- `/home/life4death/.config/opencode/skills/chained-pr/SKILL.md`
- `/home/life4death/.config/opencode/skills/_shared/SKILL.md`

## Coordination Notes
- Frontend contract changes to `pageSize`; `../sistema-inventario-frontend` still mocks `page` + `limit`. Coordinate after PR 1.
- Set `TWILIO_*` vars locally before smoke runs that hit the notification hook.

## Review Workload Forecast
| Field | Value |
|---|---|
| Estimated changed lines | ~1,535 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (Phases 1-2) → PR 2 (Phase 3) |
| Delivery strategy | ask-on-risk |
| Chain strategy | feature-branch-chain |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

### Suggested Work Units
| Unit | Goal | Likely PR | Notes |
|---|---|---|---|
| 1 | Foundation + create/read side + tests | PR 1 | Base `main`; include schema, notifications wrapper, routes, smoke coverage. |
| 2 | Transitions + Twilio wiring + tests | PR 2 | Depends on PR 1; if chained, ask team for target strategy before apply. |

## Phase 1: Foundation
- [x] 1.1 Extend `prisma/schema.prisma` with audit fields, `receivedQuantity`, User inverse relations, `@@unique([replenishmentRequestId, productId])`, and indexes from design.
- [x] 1.2 Generate `prisma/migrations/*_add_replenishment_audit_and_partial_receipt/migration.sql` and verify the duplicate-item pre-check comment.
- [x] 1.3 Add the 7 replenishment codes to `src/shared/errors/errorCodes.ts`: `REPLENISHMENT_REQUEST_NOT_FOUND`, `INVALID_STATE_TRANSITION`, `UNIT_PRICE_REQUIRED`, `PARTIAL_RECEIPT_INVALID`, `SUPPLIER_HAS_NO_WHATSAPP`, `REPLENISHMENT_ITEMS_REQUIRED`, `REPLENISHMENT_ITEM_NOT_FOUND`.
- [x] 1.4 Update `.env.example` and `src/config/env.ts` for optional `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_WHATSAPP_FROM`.
- [x] 1.5 Install `twilio` (`package.json`/lockfile) and record the command `npm install twilio` in apply work notes.
- [x] 1.6 Create `src/shared/notifications/{notifications.service.ts,index.ts,twilio-client.ts}` with singleton DI override `__setNotificationService(fake)`.
- [x] 1.7 Create `src/shared/notifications/normalizeE164.ts` plus unit tests for valid, stripped, and invalid inputs.
- [x] 1.8 Create `src/shared/notifications/templates.ts` with `buildSentTemplate(request, supplier)` and `buildCancelledTemplate(request, supplier)`.
- [x] 1.9 Extend `src/shared/validation/validate.ts` to map the `REPLENISHMENT_ITEMS_REQUIRED` sentinel to `AppError`, scoped so other Zod messages stay generic.

## Phase 2: Module skeleton + read side
- [x] 2.1 Create `src/modules/replenishment-requests/replenishment-requests.schema.ts` with create/query/receive schemas, params, and DTO types using `page` + `pageSize`.
- [x] 2.2 Create `replenishment-requests.repository.ts` with `create`, `findById`, `findMany`, and `findManyBySupplier` read-side methods.
- [x] 2.3 Create `replenishment-requests.service.ts` for create/list/get/listBySupplier, including `ProductSupplier.referencePrice` fallback and 400 `UNIT_PRICE_REQUIRED`.
- [x] 2.4 Create `replenishment-requests.controller.ts` for POST create, GET list, GET by id, and supplier-scoped GET.
- [x] 2.5 Create `replenishment-requests.routes.ts` for the 4 module endpoints with `authenticate → requireRole → validate` chaining.
- [x] 2.6 Mount `replenishmentRequestsRouter` in `src/app.ts` after the existing module-router pattern.
- [x] 2.7 Mount `GET /api/suppliers/:supplierId/replenishment-requests` in `src/modules/suppliers/suppliers.routes.ts` using this module’s controller/schema.
- [x] 2.8 Add unit tests for schema sentinel handling so empty `items[]` returns `REPLENISHMENT_ITEMS_REQUIRED`, not `VALIDATION_ERROR`.
- [x] 2.9 Add smoke tests in `tests/smoke/replenishment-requests.test.ts` for create, filtered list, get-by-id 404, supplier list, and create role gating with fully mocked Prisma.

## Phase 3: State transitions + Twilio wiring
- [x] 3.1 Extend the repository with `transitionToSent`, `transitionToReceived`, `transitionToCancelled`, and `updateItemReceivedQuantity`; keep received stock posting in service transaction composition.
- [x] 3.2 Extend the service with `send`, `receive`, and `cancel`; run RECEIVE in `prisma.$transaction`, and fire WhatsApp after commit for SEND and SENT→CANCELLED.
- [x] 3.3 Extend the controller and routes with `POST /:id/send`, `POST /:id/receive`, and `POST /:id/cancel`.
- [x] 3.4 Add smoke tests for SEND: happy path, missing WhatsApp 422, non-PENDING 409, concurrent CAS (`count:1` then `count:0`), and Twilio failure keeping `SENT`.
- [x] 3.5 Add smoke tests for RECEIVE: default quantities with 2 IN movements + stock delta, partial receipt, `PARTIAL_RECEIPT_INVALID`, unknown item id, non-SENT 409, and concurrent idempotency.
- [x] 3.6 Add smoke tests for CANCEL: PENDING silent, SENT notifies, Twilio failure keeps `CANCELLED`, and terminal-state 409.
- [x] 3.7 Add unit tests for `NotificationService` using fake `twilio.messages.create` success and reject branches.

## Review Workload Forecast
| Phase | Prod LOC | Test LOC |
|---|---:|---:|
| 1 | ~205 | ~70 |
| 2 | ~360 | ~235 |
| 3 | ~270 | ~395 |
| Total | ~835 | ~700 |

Total forecast: ~1,535 lines.
Chained PRs recommended: Yes
400-line budget risk: High
Decision needed before apply: Yes
Proposed PR split: PR 1 = Phases 1-2 (~800 lines); PR 2 = Phase 3 (~735 lines).
