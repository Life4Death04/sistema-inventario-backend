# Apply Progress: stock-movements — Phase 1 Foundation

<!-- Updated by sdd-apply | 2026-07-02 -->

## Phase 1 Task Checklist

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

## Files Touched

| File | Action | Details |
|------|--------|---------|
| `src/shared/errors/errorCodes.ts` | Modified | +4 error codes |
| `src/modules/inventory-movements/inventory-movements.schema.ts` | Created | ~155 lines |
| `openspec/changes/stock-movements/tasks.md` | Modified | Phase 1 [x]; chain strategy resolved |

## Commits (Phase 1)

| Hash | Message |
|------|---------|
| `2ea0b5c` | feat(inventory-movements): extend error catalog with stock movement codes |
| `bb77a05` | feat(inventory-movements): add schema module — body, params, and list queries |
| `d47a38d` | chore(sdd): mark Phase 1 tasks complete; resolve chain strategy in tasks.md |

## Typecheck + Lint

- `npm run typecheck`: ✅ PASS (0 errors)
- `npm run lint`: ✅ PASS (0 errors, 4 pre-existing seed warnings)

## Deviations from Design

- Spec draft used "pageSize"; project convention (shared paginationQuerySchema) uses "limit". Schema uses "limit" per project convention. Noted in schema file comment.

## Risks for Phase 2

- None. Prisma InventoryMovement schema confirmed — no modification needed.
- paginationQuerySchema uses `limit` (not `pageSize`) — repository and service must use `limit`.

## Remaining Phases

- [ ] Phase 2: repository + service (2.1–2.4)
- [ ] Phase 3: HTTP surface (3.1–3.4)
- [ ] Phase 4: smoke tests (4.1–4.3)
- [ ] Phase 5: verify handoff (5.1)
