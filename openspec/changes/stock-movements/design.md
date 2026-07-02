# Design: Inventory Movements

## Technical Approach

Add a new `inventory-movements` module under `src/modules/` mirroring the layered pattern already used by `products` (schema → repository → service → controller → routes). All stock mutations run through a single service method (`create`) that wraps a `prisma.$transaction` with an optimistic-lock retry loop. Reads are read-only Prisma queries with the shared pagination helper. Movements are immutable — no PATCH/PUT/DELETE handlers are registered; a dedicated `router.all('/:id', methodNotAllowed)` returns 405 with `Allow: GET`. Auth reuses `authenticate` + `requireRole`; the OPERATOR type restriction is enforced in the service, not the router, because it depends on request payload.

Reference: proposal (Engram #338), reconciliation memo (#339), spec (#340, `openspec/changes/stock-movements/specs/inventory-movements/spec.md`).

## Architecture Decisions

### Decision: Error catalog placement

| Option | Tradeoff | Verdict |
|---|---|---|
| A. Extend `src/shared/errors/errorCodes.ts` with domain codes | Central catalog, single import site, matches existing pattern (all modules reuse `ERROR_CODES.*`) | Chosen |
| B. Local `stock-movements.errors.ts` | Encapsulates domain, but fragments the catalog and diverges from every existing module | Rejected |

**Rationale**: A canonical `ERROR_CODES` object already exists and `errorHandler.ts` reads codes off `AppError.code` directly — nothing forces codes to live in that file, but every module today imports from it. Fragmenting now would create two truths. We ADD `INSUFFICIENT_STOCK`, `STOCK_CONCURRENCY_CONFLICT`, `FORBIDDEN_MOVEMENT_TYPE`, `INVALID_ADJUSTMENT_QUANTITY` to `errorCodes.ts`. `INVALID_ID`, `INVALID_QUERY`, `PRODUCT_NOT_FOUND`, `MOVEMENT_NOT_FOUND` reuse existing `VALIDATION_ERROR` / `NOT_FOUND` with contextual messages (mirrors how `products` returns `NOT_FOUND` + `"Product not found."`).

### Decision: 405 vs 404 for disallowed methods on `/:id`

| Option | Tradeoff | Verdict |
|---|---|---|
| A. Explicit `router.all('/:id', methodNotAllowed)` returning 405 + `Allow: GET` | REST-correct, matches spec R5, one small helper | Chosen |
| B. Let global `notFound` return 404 | Zero new surface, but violates spec R5 and REST semantics | Rejected |

**Rationale**: The resource `/:id` exists (GET is defined) — semantically it is Method Not Allowed, not Not Found. The helper is 6 lines and lives inside the module router; no global change needed.

### Decision: Concurrency retry mechanic

**Choice**: Outer `for` loop (max 2 attempts) wraps `prisma.$transaction`. Inside the transaction: read stock, compute `nextStock`, reject if `< 0`, run `tx.product.updateMany({ where: { id, stock: observedStock, active: true }, data: { stock: nextStock } })`, then `tx.inventoryMovement.create({ ..., resultingStock: nextStock })`. If `updateMany.count === 0` we throw a sentinel `ConcurrencyRetryError` from inside the transaction (rolls back the movement insert too). The outer loop catches ONLY that sentinel and retries once with a fresh transaction. Second miss → `AppError(STOCK_CONCURRENCY_CONFLICT, 409)`.

**Alternatives**: (i) retry INSIDE transaction — impossible, Prisma aborts on first thrown error; (ii) pessimistic `SELECT … FOR UPDATE` via `$queryRaw` — heavier, dialect-specific, unnecessary given the guarded `updateMany`.

**Isolation**: Postgres default `READ COMMITTED` is sufficient. The `WHERE stock = observedStock` guard makes lost updates structurally impossible — an interleaved writer changes `stock`, our `updateMany` matches zero rows, and we retry with the fresh value.

### Decision: OPERATOR role guard at service layer

**Choice**: Route uses `requireRole('ADMIN', 'MANAGER', 'OPERATOR')` on POST — all three pass the middleware. The service’s `create` inspects `actor.role` and `dto.type`: if `role === 'OPERATOR' && type !== 'OUT'` → `throw AppError(FORBIDDEN_MOVEMENT_TYPE, 403)`.

**Rationale**: The rule depends on the request body (`type`), which route middleware cannot inspect without re-parsing. Business rules that mix identity + payload belong in the service (same layer that owns `ADJUSTMENT` sign translation and stock invariants). Keeps middleware chain declarative.

### Decision: Sub-resource mount

**Choice**: `GET /api/products/:productId/inventory-movements` is registered inside `productsRouter` (import the `listMovementsByProductController` from the movements module).

**Rationale**: Mirrors the existing `productsRouter.get('/:id/suppliers', …)` sub-resource. Keeps product-owned paths inside the product router; avoids double-mounting `inventoryMovementsRouter` at two prefixes.

## Data Flow

```
POST /api/inventory-movements
  ├─ authenticate → requireRole(ADMIN,MANAGER,OPERATOR)
  ├─ validate(createMovementSchema, 'body')
  └─ controller → service.create(actor, dto)
                    │
                    ├─ enforceRoleTypeMatrix(actor, dto.type)   → 403
                    ├─ translateAdjustment(dto)                  → {qty, direction}
                    └─ for attempt in 1..2:
                         prisma.$transaction(tx =>
                            product = tx.product.findUnique(...)  → 404 if missing/inactive
                            nextStock = compute(product.stock, qty, type, direction)
                            if nextStock < 0 → throw INSUFFICIENT_STOCK (409)
                            updated = tx.product.updateMany(
                              where: {id, stock: product.stock, active: true},
                              data:  {stock: nextStock}
                            )
                            if updated.count === 0 → throw ConcurrencyRetryError
                            movement = tx.inventoryMovement.create({..., resultingStock: nextStock})
                            return movement
                         )
                       catch ConcurrencyRetryError → continue
                    → 409 STOCK_CONCURRENCY_CONFLICT
```

### Scenario walkthroughs

1. **IN + sufficient stock (happy)**: attempt 1 succeeds → 201 with movement + `resultingStock`.
2. **OUT with insufficient stock**: `nextStock < 0` → 409 `INSUFFICIENT_STOCK` with `{ productId, currentStock, attemptedDelta: -quantity }`. No writes.
3. **ADJUSTMENT signed negative going under zero**: signed `-50` translated to `{quantity: 50, direction: DECREASE}`, `nextStock = current - 50 < 0` → 409 `INSUFFICIENT_STOCK`.
4. **Concurrency conflict resolves on retry**: attempt 1 sees `stock=10`, another writer commits `stock=8` first, `updateMany.count=0` → sentinel → attempt 2 reads `stock=8`, guard succeeds → 201.
5. **OPERATOR posts IN**: `enforceRoleTypeMatrix` throws → 403 `FORBIDDEN_MOVEMENT_TYPE`. No DB reads.
6. **GET list with filters**: validate query → `repository.list({productId, type, from, to, page, pageSize})` → `paginate()` → 200 with `{ data, meta }`.

## File Changes

| File | Action | Description |
|---|---|---|
| `src/modules/inventory-movements/inventory-movements.schema.ts` | Create | Zod discriminated union on `type` for body, list query schema, id/productId param schemas, DTO types. |
| `src/modules/inventory-movements/inventory-movements.repository.ts` | Create | `findProductForMovement`, `createMovementTx`, `updateProductStockGuarded`, `findMovementById`, `listMovements`, `countMovements`. All pure Prisma. |
| `src/modules/inventory-movements/inventory-movements.service.ts` | Create | `create(actor, dto)` transaction + retry, `getById`, `list`, `listByProduct`. Owns role/type matrix, ADJUSTMENT translation, `resultingStock` computation. |
| `src/modules/inventory-movements/inventory-movements.controller.ts` | Create | Thin Express handlers returning 201/200. Reads `req.user` (populated by `authenticate`). |
| `src/modules/inventory-movements/inventory-movements.routes.ts` | Create | Registers `POST /`, `GET /`, `GET /:id`, and `router.all('/:id', methodNotAllowed)` returning 405 + `Allow: GET`. |
| `src/modules/inventory-movements/inventory-movements.errors.ts` | Create | Internal-only `ConcurrencyRetryError` sentinel class (not an AppError; never leaves the service). |
| `src/shared/errors/errorCodes.ts` | Modify | Add `INSUFFICIENT_STOCK`, `STOCK_CONCURRENCY_CONFLICT`, `FORBIDDEN_MOVEMENT_TYPE`, `INVALID_ADJUSTMENT_QUANTITY`. |
| `src/app.ts` | Modify | Import + mount `inventoryMovementsRouter` at `/api/inventory-movements`. |
| `src/modules/products/products.routes.ts` | Modify | Mount `GET /:id/inventory-movements` → `listMovementsByProductController`. |
| `tests/smoke/inventory-movements.test.ts` | Create | Smoke tests covering every spec scenario (~40). |

No Prisma schema change. No migration.

## Interfaces / Contracts

Request body (discriminated on `type`):

```ts
// IN / OUT
{ type: 'IN' | 'OUT', productId: string /*cuid*/, quantity: number /*int [1,1_000_000]*/, reason: string /*1..500*/ }
// ADJUSTMENT
{ type: 'ADJUSTMENT', productId: string, quantity: number /*int [-1_000_000,1_000_000] \ {0}*/, reason: string }
```

Response DTO (create + getById + list items):

```ts
type MovementDto = {
  id: string;
  productId: string;
  userId: string;
  type: 'IN' | 'OUT' | 'ADJUSTMENT';
  adjustmentDirection: 'INCREASE' | 'DECREASE' | null;
  quantity: number;              // always positive
  resultingStock: number;
  reason: string;
  createdAt: string;             // ISO
};
```

List envelope reuses shared `PaginatedResponse<MovementDto>` → `{ data, meta: { page, limit, total, totalPages } }`. Note the spec used `pagination`; design aligns to the existing project envelope (`meta`) to preserve consistency with `products`. Spec is amended by this design decision — no user-visible break because this is a new endpoint.

List query: `productId?`, `type?`, `from?` (ISO), `to?` (ISO), `page` (default 1), `pageSize` (default 20, max 100). `from > to` → 400 `VALIDATION_ERROR`.

Path params: `{ id: cuid }` and `{ productId: cuid }`.

Service pseudo-code (create):

```ts
async create(actor: { id, role }, dto: CreateMovementDto): Promise<MovementDto> {
  if (actor.role === 'OPERATOR' && dto.type !== 'OUT')
    throw new AppError(FORBIDDEN_MOVEMENT_TYPE, 403, 'OPERATOR can only create OUT movements.');

  const { quantity, direction } = translateAdjustment(dto); // {qty>0, direction? }

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        const product = await tx.product.findFirst({
          where: { id: dto.productId, active: true },
          select: { id: true, stock: true },
        });
        if (!product) throw new AppError(NOT_FOUND, 404, 'Product not found.');

        const delta = dto.type === 'IN' ? quantity
                    : dto.type === 'OUT' ? -quantity
                    : direction === 'INCREASE' ? quantity : -quantity;
        const nextStock = product.stock + delta;
        if (nextStock < 0)
          throw new AppError(INSUFFICIENT_STOCK, 409, 'Insufficient stock.', {
            productId: product.id, currentStock: product.stock, attemptedDelta: delta,
          });

        const updated = await tx.product.updateMany({
          where: { id: product.id, stock: product.stock, active: true },
          data:  { stock: nextStock },
        });
        if (updated.count === 0) throw new ConcurrencyRetryError();

        return tx.inventoryMovement.create({
          data: {
            productId: product.id, userId: actor.id,
            type: dto.type, adjustmentDirection: direction ?? null,
            quantity, resultingStock: nextStock, reason: dto.reason.trim(),
          },
        });
      });
    } catch (e) {
      if (e instanceof ConcurrencyRetryError && attempt < 2) continue;
      if (e instanceof ConcurrencyRetryError)
        throw new AppError(STOCK_CONCURRENCY_CONFLICT, 409, 'Stock changed concurrently; retry.');
      throw e;
    }
  }
  // unreachable
}
```

## Error Catalog

| Code | Status | When | Message |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 | Zod body/query/params failure, empty `reason`, ADJUSTMENT quantity == 0, `from > to`, bad cuid on `:id` or `:productId` | Contextual (Zod / "reason is required." / "Adjustment quantity must be non-zero." / "Invalid id.") |
| `INVALID_ADJUSTMENT_QUANTITY` | 400 | Reserved for future non-Zod adjustment guard (currently VALIDATION_ERROR from Zod covers it — code exists for spec parity) | "Adjustment quantity must be a non-zero integer." |
| `MISSING_TOKEN` / `INVALID_TOKEN` / `TOKEN_EXPIRED` | 401 | Auth middleware | Standard |
| `FORBIDDEN` | 403 | Role not in {ADMIN,MANAGER,OPERATOR} on any endpoint | "You do not have permission…" |
| `FORBIDDEN_MOVEMENT_TYPE` | 403 | OPERATOR + type !== OUT | "OPERATOR can only create OUT movements." |
| `NOT_FOUND` | 404 | Product not found or inactive; movement not found; product not found on sub-resource | "Product not found." / "Movement not found." |
| `NOT_FOUND` | 405→ actually `METHOD_NOT_ALLOWED`? | See below | — |
| `INSUFFICIENT_STOCK` | 409 | `nextStock < 0` | "Insufficient stock." + `details: { productId, currentStock, attemptedDelta }` |
| `STOCK_CONCURRENCY_CONFLICT` | 409 | Retry exhausted | "Stock changed concurrently; please retry." |
| Method Not Allowed | 405 | PATCH/PUT/DELETE on `/:id` | Handler responds directly with `res.status(405).set('Allow','GET').json({ error: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.', statusCode: 405 })` — adds `METHOD_NOT_ALLOWED` to `ERROR_CODES` as well. |

Added to `ERROR_CODES`: `INSUFFICIENT_STOCK`, `STOCK_CONCURRENCY_CONFLICT`, `FORBIDDEN_MOVEMENT_TYPE`, `INVALID_ADJUSTMENT_QUANTITY`, `METHOD_NOT_ALLOWED`.

## Auth & Role Matrix

| Endpoint | Method | Middleware chain | Service check | Allowed roles |
|---|---|---|---|---|
| `/api/inventory-movements` | POST | `authenticate`, `requireRole(ADMIN,MANAGER,OPERATOR)`, `validate(body)` | `if OPERATOR && type !== OUT → 403` | ADMIN, MANAGER, OPERATOR (OPERATOR restricted to OUT) |
| `/api/inventory-movements` | GET | `authenticate`, `requireRole(ADMIN,MANAGER,OPERATOR)`, `validate(query)` | — | ADMIN, MANAGER, OPERATOR |
| `/api/inventory-movements/:id` | GET | `authenticate`, `requireRole(ADMIN,MANAGER,OPERATOR)`, `validate(params)` | — | ADMIN, MANAGER, OPERATOR |
| `/api/inventory-movements/:id` | PATCH/PUT/DELETE | `router.all('/:id', methodNotAllowed)` — no auth (405 responds directly) | — | none |
| `/api/products/:productId/inventory-movements` | GET | `authenticate`, `requireRole(ADMIN,MANAGER,OPERATOR)`, `validate(params)`, `validate(query)` | product existence check in service | ADMIN, MANAGER, OPERATOR |

## Validation Contracts

- `createMovementSchema` — Zod `z.discriminatedUnion('type', [...])`. IN/OUT branch: `quantity` int `[1, 1_000_000]`. ADJUSTMENT branch: `quantity` int `[-1_000_000, 1_000_000]` + `.refine(v => v !== 0, 'must be non-zero')`. All branches: `productId` cuid, `reason` trimmed `1..500`.
- `listMovementsQuerySchema` — `productId?` cuid, `type?` `nativeEnum(MovementType)`, `from?`/`to?` `z.coerce.date()` with `.superRefine` ensuring `from <= to`, `page`/`pageSize` numeric defaults as in products.
- `movementIdParamsSchema` — `{ id: cuid }`.
- `productIdParamsSchema` — reused from products module (import).

## Testing Strategy

| Layer | What to Test | Approach |
|---|---|---|
| Smoke (integration) | Every spec scenario (~40): happy paths per type/role, insufficient stock atomicity, ADJUSTMENT zero, forbidden roles, unauth, missing/empty reason, quantity bounds, nonexistent/inactive product, concurrency retry, list filters + pagination, 404 on unknown movement, 405 on PATCH/PUT/DELETE, product-scoped listing | Supertest against `app` from `src/app.ts`, single file `tests/smoke/inventory-movements.test.ts`. Concurrency scenario simulated by mocking `tx.product.updateMany` to return `count: 0` once. |
| Unit | ADJUSTMENT signed → `{quantity, direction}` translation | Only if translation grows beyond a 4-line switch. Deferred; smoke coverage suffices for the current shape. |
| E2E | — | None; the smoke layer is the integration boundary for this project. |

## Migration / Rollout

No migration required. `InventoryMovement`, `MovementType`, `AdjustmentDirection` already exist in `prisma/schema.prisma`. No feature flags. Rollout is code-only via `feat/stock-movements` merge. No backfill of historical movements for products with pre-existing `stock > 0` (per proposal §Non-Goals).

## Non-Goals

- Transfers, purchase-order integration, `unitCost`, aggregated reports, low-stock alerts triggered by movements, reversal endpoint, PATCH/PUT/DELETE, bulk operations, historical backfill.

## Open Questions

- [ ] Spec used `pagination` envelope name; design aligns to project standard `meta`. Confirm during `sdd-verify` that no external consumer already assumed `pagination`.
- [ ] `INVALID_ADJUSTMENT_QUANTITY` is defined but currently unreachable (Zod raises `VALIDATION_ERROR` first). Kept for spec parity; may be pruned in tasks phase.
