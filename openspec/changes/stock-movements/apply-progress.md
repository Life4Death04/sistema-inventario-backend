# Apply Progress: stock-movements — Phase 1 + Phase 2 + Phase 3

<!-- Updated by sdd-apply | 2026-07-02 — Phase 3: HTTP surface complete -->

## Phase 1 Task Checklist ✅ COMPLETE

- [x] 1.1 Updated `src/shared/errors/errorCodes.ts`
  - Added: INSUFFICIENT_STOCK, STOCK_CONCURRENCY_CONFLICT, FORBIDDEN_MOVEMENT_TYPE, METHOD_NOT_ALLOWED
  - INVALID_ADJUSTMENT_QUANTITY excluded (Zod covers it; out of scope per tasks.md)
- [x] 1.2 Created body schemas in `inventory-movements.schema.ts`
  - discriminatedUnion('type') → createInMovementSchema, createOutMovementSchema, createAdjustmentMovementSchema
  - ADJUSTMENT: signed non-zero quantity [-1_000_000, 1_000_000] \ {0} via .refine()
  - reason: required, trimmed, 1–500 chars on ALL types
- [x] 1.3 Added params schemas in `inventory-movements.schema.ts`
  - movementIdParamsSchema: id cuid (confirmed InventoryMovement.id @default(cuid()))
  - movementProductIdParamsSchema: productId cuid (confirmed Product.id @default(cuid()))
  - No prisma/schema.prisma modification needed
- [x] 1.4 Added list query schemas in `inventory-movements.schema.ts`
  - listMovementsQuerySchema: extends paginationQuerySchema + productId?, type?, from?, to?
  - listMovementsByProductQuerySchema: omits productId (from URL param)
  - MovementDto interface exported
  - PaginatedMovementsResponse type alias exported (PaginatedResponse<MovementDto>)

## Phase 2 Task Checklist ✅ COMPLETE

- [x] 2.1 Created `src/modules/inventory-movements/inventory-movements.repository.ts`
  - findProductActive(productId): returns { id, stock, active } | null
  - attemptStockUpdate(tx, productId, observedStock, nextStock): updateMany WHERE id + stock + active; returns count (0 or 1)
  - MOVEMENT_SELECT constant for consistent field projection
- [x] 2.2 Added read methods in `inventory-movements.repository.ts`
  - insertMovement(tx, data): creates InventoryMovement inside open transaction, returns MovementDto
  - findMovementById(id): point read, returns MovementDto | null
  - listMovements(query): parallel Promise.all([findMany, count]); createdAt DESC; AND-filters: productId?, type?, from?, to?
  - listMovementsByProduct(productId, query): same pattern, productId forced from URL param
- [x] 2.3 Created `src/modules/inventory-movements/inventory-movements.service.ts`
  - Role guard (D4): OPERATOR + non-OUT → AppError(FORBIDDEN_MOVEMENT_TYPE, 403)
  - ADJUSTMENT translator: translateAdjustment(signedQty) → { adjustmentDirection, quantity: abs }
  - ConcurrencyRetryError sentinel class for CAS miss signaling
  - createMovement(): for-loop max 2 attempts, wraps prisma.$transaction:
    * read product (active guard) → 404 on missing/inactive
    * compute nextStock = observedStock + delta
    * nextStock < 0 → AppError(INSUFFICIENT_STOCK, 409, details: { productId, currentStock, attemptedDelta })
    * attemptStockUpdate → count=0 → throw ConcurrencyRetryError (rolls back tx)
    * count=1 → insertMovement atomically
    * outer catch: re-throw non-sentinel; on last attempt → AppError(STOCK_CONCURRENCY_CONFLICT, 409)
- [x] 2.4 Added read methods in `inventory-movements.service.ts`
  - getMovement(id): 404 MOVEMENT_NOT_FOUND when movement doesn't exist
  - listMovements(query): delegates to repo, wraps in paginate()
  - listMovementsByProduct(productId, query): pre-checks product (missing or inactive → 404 PRODUCT_NOT_FOUND), then delegates + paginate()

## Phase 2 Hardening — W1 Adversarial Review Fix ✅

**Commit**: `dcb2f3d`
**Resolved**: W1 — service threw generic `NOT_FOUND` at all three 404 sites; spec R1/R3/R4 name specific codes.

### Changes
| File | What Changed |
|------|-------------|
| `src/shared/errors/errorCodes.ts` | Added `MOVEMENT_NOT_FOUND` + `PRODUCT_NOT_FOUND` next to `NOT_FOUND` |
| `src/modules/inventory-movements/inventory-movements.service.ts` | Replaced `NOT_FOUND` in 3 call sites + updated JSDoc |

### Deferred
- W2, W3, W4 — deferred to later phases per scope contract.

## Phase 3 Task Checklist ✅ COMPLETE

- [x] 3.1 Created `src/modules/inventory-movements/inventory-movements.controller.ts`
  - createMovementController: POST / → 201 { movement }; passes dto + req.user.id + req.user.role to service
  - listMovementsController: GET / → 200 PaginatedResponse; passes Zod-parsed query (NOT req.query) to service
  - getMovementController: GET /:id → 200 { movement }; propagates 404 AppError
  - listMovementsByProductController: GET /:productId/inventory-movements → 200 PaginatedResponse; passes Zod-parsed query to service
- [x] 3.2 Created `src/modules/inventory-movements/inventory-movements.routes.ts`
  - ALL_ROLES = ['ADMIN', 'MANAGER', 'OPERATOR']
  - POST / → authenticate → requireRole(ALL_ROLES) → validate(createMovementSchema, 'body') → createMovementController
  - GET / → authenticate → requireRole(ALL_ROLES) → validate(listMovementsQuerySchema, 'query') → listMovementsController
  - GET /:id → authenticate → requireRole(ALL_ROLES) → validate(movementIdParamsSchema, 'params') → getMovementController
  - router.all('/:id', methodNotAllowed) → 405 + Allow: GET header (registered AFTER GET /:id)
  - Local methodNotAllowed(): res.set('Allow','GET').status(405).json({ error: METHOD_NOT_ALLOWED, ... })
- [x] 3.3 Updated `src/modules/products/products.routes.ts`
  - Added import: listMovementsByProductController from inventory-movements.controller.ts
  - Added import: movementProductIdParamsSchema, listMovementsByProductQuerySchema from inventory-movements.schema.ts
  - Mounted GET /:productId/inventory-movements before /:id to ensure specificity
  - Middleware chain: authenticate → requireRole(READ_ROLES) → validate(params) → validate(query) → listMovementsByProductController
- [x] 3.4 Updated `src/app.ts`
  - Added import: inventoryMovementsRouter
  - Mounted: app.use('/api/inventory-movements', inventoryMovementsRouter) beside existing module routers

## Files Touched

| File | Action | Details |
|------|--------|---------|
| `src/shared/errors/errorCodes.ts` | Modified | +4 error codes (Phase 1) + MOVEMENT_NOT_FOUND + PRODUCT_NOT_FOUND (Phase 2 hardening) |
| `src/modules/inventory-movements/inventory-movements.schema.ts` | Created | ~194 lines; full schema module |
| `src/modules/inventory-movements/inventory-movements.repository.ts` | Created | ~245 lines; repository layer |
| `src/modules/inventory-movements/inventory-movements.service.ts` | Created | ~284 lines; service layer |
| `src/modules/inventory-movements/inventory-movements.controller.ts` | Created | ~88 lines; HTTP handlers |
| `src/modules/inventory-movements/inventory-movements.routes.ts` | Created | ~81 lines; router + 405 handler |
| `src/modules/products/products.routes.ts` | Modified | +sub-resource mount (16 lines) |
| `src/app.ts` | Modified | +import + route mount (2 lines) |
| `openspec/changes/stock-movements/tasks.md` | Modified | Phase 1+2+3 tasks marked [x] |

## Commits

### Phase 1
| Hash | Message |
|------|---------|
| `2ea0b5c` | feat(inventory-movements): extend error catalog with stock movement codes |
| `bb77a05` | feat(inventory-movements): add schema module — body, params, and list queries |
| `d47a38d` | chore(sdd): mark Phase 1 tasks complete; resolve chain strategy in tasks.md |

### Phase 2
| Hash | Message |
|------|---------|
| `9468421` | feat(inventory-movements): add repository — findProductActive, CAS stock update, movement reads |
| `cd8827d` | feat(inventory-movements): add service — role guard, ADJUSTMENT translator, createMovement retry loop, read methods |
| `24e46bc` | chore(sdd): mark Phase 2 tasks complete in tasks.md |

### Phase 2 Hardening
| Hash | Message |
|------|---------|
| `dcb2f3d` | fix(inventory-movements): use specific NOT_FOUND codes per spec |

### Phase 3
| Hash | Message |
|------|---------|
| `e3665b8` | feat(inventory-movements): add controller and routes for /api/inventory-movements |
| `308300f` | feat(inventory-movements): mount sub-resource in products.routes and register /api/inventory-movements in app |

## Typecheck + Lint

- `npm run typecheck`: ✅ PASS (0 errors) — all phases including Phase 3
- `npm run lint`: ✅ PASS (0 errors, 4 pre-existing seed warnings — unchanged)

## Chain Strategy

- feature-branch-chain (resolved)
- Tracker branch: `feat/stock-movements` (current branch)
- PR 1 (Phases 1–2: foundation) → targets `feat/stock-movements`
- PR 2 (Phase 3: HTTP surface) → targets PR 1 branch
- PR 3 (Phases 4–5: smoke + verify) → targets PR 2 branch

## Deviations from Design

- None material. Implementation strictly follows D1–D5 from design.md.
- `ConcurrencyRetryError` sentinel class is an implementation detail not named in D3 but matching its specification exactly.
- `resolveMovementFields()` extracted as module-level function (not class method) for readability.
- `methodNotAllowed` defined as a local function in inventory-movements.routes.ts (no shared helper existed in the project); returns 405 with Allow: GET header directly without throwing (matching D2 rationale).

## Risks / Notes for Phase 4

- `listMovementsController` and `listMovementsByProductController` cast `req.query as unknown as ListMovementsQuery / ListMovementsByProductQuery` — this is the same pattern used in products.controller.ts. The validate() middleware replaces the raw req.query with the Zod-parsed output before the handler runs, so the cast is safe.
- The sub-resource `GET /:productId/inventory-movements` in products.routes.ts is mounted BEFORE `GET /:id` to ensure Express specificity. If this order is ever reversed, the sub-resource will be shadowed.
- 405 handler for `router.all('/:id', ...)` in inventory-movements.routes.ts is mounted AFTER `GET /:id`. This order is critical — reversing it would shadow the GET handler.

## Remaining Phases

- [ ] Phase 4: smoke tests (4.1–4.3)
- [ ] Phase 5: verify handoff (5.1)
