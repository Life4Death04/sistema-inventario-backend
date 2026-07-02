# Apply Progress: stock-movements — Phase 1 + Phase 2

<!-- Updated by sdd-apply | 2026-07-02 -->

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
  - getMovement(id): 404 NOT_FOUND when movement doesn't exist
  - listMovements(query): delegates to repo, wraps in paginate()
  - listMovementsByProduct(productId, query): pre-checks product (missing or inactive → 404), then delegates + paginate()

## Files Touched

| File | Action | Details |
|------|--------|---------|
| `src/shared/errors/errorCodes.ts` | Modified | +4 error codes |
| `src/modules/inventory-movements/inventory-movements.schema.ts` | Created | ~194 lines; full schema module |
| `src/modules/inventory-movements/inventory-movements.repository.ts` | Created | ~245 lines; repository layer |
| `src/modules/inventory-movements/inventory-movements.service.ts` | Created | ~284 lines; service layer |
| `openspec/changes/stock-movements/tasks.md` | Modified | Phase 1+2 tasks marked [x] |

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

## Typecheck + Lint

- `npm run typecheck`: ✅ PASS (0 errors) — both phases
- `npm run lint`: ✅ PASS (0 errors, 4 pre-existing seed warnings)

## Chain Strategy

- feature-branch-chain (resolved)
- Tracker branch: `feat/stock-movements` (current branch)
- PR 1 (Phases 1–2: foundation) → targets `feat/stock-movements`
- PR 2 (Phase 3: HTTP surface) → targets PR 1 branch
- PR 3 (Phases 4–5: smoke + verify) → targets PR 2 branch

## Deviations from Design

- None material. Implementation follows D1–D5 strictly.
- `ConcurrencyRetryError` sentinel class is an implementation detail; not named in design D3 but matches its specification exactly.
- `resolveMovementFields()` extracted as module-level function (not class method) for readability — functionally equivalent.

## Risks / Notes for Phase 3

- `Prisma.TransactionClient` type import: available via `@prisma/client` — confirmed compiling.
- `adjustmentDirection: null` coercion: `data.adjustmentDirection ?? undefined` maps null → omission in Prisma create, stores NULL for IN/OUT. Matches schema optional field.
- Controller must pass the Zod-parsed query object directly to service methods — `limit` field is already coerced to number by paginationQuerySchema.

## Remaining Phases

- [ ] Phase 3: HTTP surface (3.1–3.4)
- [ ] Phase 4: smoke tests (4.1–4.3)
- [ ] Phase 5: verify handoff (5.1)
