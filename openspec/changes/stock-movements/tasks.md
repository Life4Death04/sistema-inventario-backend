# Tasks: Inventory Movements

## Apply Phase Skill Load

- `/home/life4death/.config/opencode/skills/sdd-apply/SKILL.md`
- `/home/life4death/.config/opencode/skills/work-unit-commits/SKILL.md`
- `/home/life4death/.config/opencode/skills/_shared/SKILL.md`

## Phase 1: Foundation

- [x] 1.1 Update `src/shared/errors/errorCodes.ts` with `INSUFFICIENT_STOCK`, `STOCK_CONCURRENCY_CONFLICT`, `FORBIDDEN_MOVEMENT_TYPE`, `METHOD_NOT_ALLOWED`; remove `INVALID_ADJUSTMENT_QUANTITY` from this change scope.
- [x] 1.2 Create `src/modules/inventory-movements/inventory-movements.schema.ts` body schemas for IN/OUT/ADJUSTMENT, using signed non-zero ADJUSTMENT input and required trimmed `reason`.
- [x] 1.3 Add `id` and `productId` params schemas in `inventory-movements.schema.ts`, confirming both `Product.id` and `InventoryMovement.id` remain `cuid()` in `prisma/schema.prisma`.
- [x] 1.4 Add list query schemas in `inventory-movements.schema.ts`: global extends `paginationQuerySchema` with `productId?`, `type?`, `from?`, `to?`; product-scoped omits `productId`; export DTO/response types with shared `PaginatedResponse`.

## Phase 2: Data + Business Logic

- [x] 2.1 Create `src/modules/inventory-movements/inventory-movements.repository.ts` with `findProductActive()` and guarded `attemptStockUpdate(tx, productId, observedStock, nextStock)` using `updateMany`.
- [x] 2.2 Add repository reads in `inventory-movements.repository.ts`: `insertMovement()`, `findMovementById()`, `listMovements()`, and `listMovementsByProduct()` with parallel `findMany + count`.
- [x] 2.3 Create `src/modules/inventory-movements/inventory-movements.service.ts` role/type guard, ADJUSTMENT translator, and `createMovement()` retry loop (2 attempts) with 404 not-found and 409 stock/concurrency handling.
- [x] 2.4 Add `getMovement()`, `listMovements()`, and `listMovementsByProduct()` in `inventory-movements.service.ts`, including pre-check that product-scoped reads return 404 for missing/inactive products.

## Phase 3: HTTP Surface

- [ ] 3.1 Create `src/modules/inventory-movements/inventory-movements.controller.ts`; parse params/query/body with the module schemas and map service results to 201/200 JSON responses.
- [ ] 3.2 Create `src/modules/inventory-movements/inventory-movements.routes.ts` for `POST /`, `GET /`, `GET /:id`, and explicit `router.all('/:id', methodNotAllowed)` returning 405 with `Allow: GET`.
- [ ] 3.3 Update `src/modules/products/products.routes.ts` to mount `GET /:productId/inventory-movements` with auth, read roles, params/query validation, and the movements controller.
- [ ] 3.4 Update `src/app.ts` to register `/api/inventory-movements` beside the existing module routers.

## Phase 4: Smoke Coverage

- [ ] 4.1 Create `tests/smoke/inventory-movements.test.ts` seed/setup mirroring `tests/smoke/products.test.ts`, including ADMIN/MANAGER/OPERATOR tokens and products with active/inactive stock baselines.
- [ ] 4.2 Add one `it` per create/get/list/product-scope scenario from `openspec/changes/stock-movements/specs/inventory-movements/spec.md`, covering all 34 locked scenarios and the `meta.limit` pagination envelope.
- [ ] 4.3 Add rollback/concurrency smoke cases in `tests/smoke/inventory-movements.test.ts`: insufficient stock atomicity, insert failure rollback, and one forced `updateMany.count === 0` retry-loss path.

## Phase 5: Verification Handoff

- [ ] 5.1 Record verify commands for `sdd-verify`: `npm run typecheck`, `npm run lint`, and `npm test -- inventory-movements`.

## Review Workload Forecast

- Estimated changed lines: 720 (production) + 860 (tests) = 1580
- 400-line budget risk: High
- 800-line budget risk (session budget): High
- Chained PRs recommended: Yes
- Suggested split (if chained): PR 1 foundation (`errorCodes.ts`, schema, repository, service); PR 2 HTTP surface (`controller`, `routes`, `products.routes.ts`, `app.ts`) + smoke scaffold; PR 3 scenario-heavy smoke coverage + verify handoff
- Decision needed before apply: Resolved
- Chain strategy: feature-branch-chain (tracker: feat/stock-movements; PR 1 → feat/stock-movements; PR 2 → PR 1 branch; PR 3 → PR 2 branch)
- Rationale: This change spans nine touched files, cross-router wiring, shared error catalog edits, optimistic concurrency logic, and a large smoke suite roughly comparable to the products reference. The production slice alone is review-heavy, and the 34-scenario test file can exceed the session budget by itself.

Decision needed before apply: Resolved
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High
