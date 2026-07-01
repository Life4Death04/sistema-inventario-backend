# Change: products-crud

**Track**: CRUD Template (SDD-lite: propose → apply → manual verify)
**Status**: Proposed — 2026-07-01
**Mode**: Hybrid (Engram + OpenSpec)

## Intent

Full CRUD for the `Product` model under `/api/products`, plus a dedicated sub-resource for product↔supplier link management (`/api/products/:id/suppliers`). Soft-delete strategy preserves audit trails referenced by `InventoryMovement`, `Alert`, and `ReplenishmentRequestItem`. Stock mutation is deliberately excluded from PATCH — all post-creation stock changes must flow through the future `inventory-movements` module.

## Endpoints

| Method | Path                                              | Roles                     |
|--------|---------------------------------------------------|---------------------------|
| POST   | `/api/products`                                   | ADMIN, MANAGER            |
| GET    | `/api/products`                                   | ADMIN, MANAGER, OPERATOR  |
| GET    | `/api/products/:id`                               | ADMIN, MANAGER, OPERATOR  |
| PATCH  | `/api/products/:id`                               | ADMIN, MANAGER            |
| DELETE | `/api/products/:id`                               | ADMIN, MANAGER (soft)     |
| GET    | `/api/products/:id/suppliers`                     | ADMIN, MANAGER, OPERATOR  |
| POST   | `/api/products/:id/suppliers`                     | ADMIN, MANAGER (attach)   |
| DELETE | `/api/products/:id/suppliers/:supplierId`         | ADMIN, MANAGER (detach)   |

Role matrix canon: ADMIN+MANAGER share business actions; OPERATOR gets business reads; only `/api/users` is ADMIN-only.

## Business Rules

1. **Stock lifecycle**:
   - POST accepts optional `stock` (default 0, integer >= 0) — initial stock at creation.
   - PATCH REJECTS `stock` with 400: `"stock is only modifiable via /api/inventory-movements"`. This preserves the audit trail.
   - `minStock` (threshold, not quantity) is editable via POST and PATCH freely.

2. **Soft-delete strategy**: DELETE sets `active = false`. No hard delete — `InventoryMovement`, `Alert`, `ReplenishmentRequestItem` reference `Product` and hard-deleting would corrupt history. DELETE on an already-inactive product returns 404 (idempotency guard, mirrors suppliers).

3. **List filters** — `GET /api/products` accepts:
   - `page` (default 1, min 1), `pageSize` (default 20, min 1, max 100)
   - `search` — case-insensitive substring match on `name` OR `code` OR `activeIngredient` OR `brand`
   - `categoryId` — filter by category
   - `active` (default `true`) — uses `z.enum(['true','false']).transform(v => v === 'true')`. DO NOT use `z.coerce.boolean()` (`Boolean("false") === true` — see suppliers discovery)
   - `lowStock` (boolean) — when `true`, filters `stock <= minStock`
   - `supplierId` — filter products linked to a supplier via `ProductSupplier`
   - `orderBy` (`name` | `stock` | `price` | `createdAt`; default `createdAt`), `order` (`asc` | `desc`; default `desc`)

4. **GET `/api/products/:id`**: returns product regardless of `active` flag; includes `category` and `suppliers[]` (with `referencePrice`).

5. **Validation guards**:
   - `code`: required, unique (case-sensitive as-is), trimmed, 1–60 chars.
   - `name`: required, trimmed, 2–200 chars.
   - `activeIngredient`, `presentation`, `brand`, `description`: optional, trimmed (200 / 100 / 120 / 2000 max).
   - `unit`: required, native enum `MG | G | KG | ML | L | UNIT`.
   - `unitContent`: required Decimal, > 0, up to 3 decimal places (string-or-number → Zod validated).
   - `categoryId`: required on POST; service pre-checks existence for clean 400 (Prisma FK Restrict is the DB-level guard).
   - `stock`: POST only, integer >= 0, default 0. PATCH rejects.
   - `minStock`: integer >= 0, default 0.
   - `price`: Decimal, >= 0, up to 2 decimal places.
   - PATCH nullable clearing: explicit `null` on `activeIngredient`, `description`, `presentation`, `brand` clears the field; `undefined` / omitted leaves unchanged (mirrors categories `description: null` pattern).

6. **product-suppliers sub-resource**:
   - `POST /:id/suppliers` body: `{ supplierId, referencePrice? }`. Guards: product must exist AND be active; supplier must exist AND be active; pair must NOT already exist (DB-level `@@unique([productId, supplierId])`).
   - `DELETE /:id/suppliers/:supplierId`: removes the link; 404 if link does not exist.
   - `GET /:id/suppliers`: returns `[{ supplier, referencePrice }]`.
   - `referencePrice`: Decimal(12,2), optional, >= 0. In-place update is OUT OF SCOPE — to change price, detach + reattach.

## Out of Scope

- `inventory-movements` endpoint (future change — receives all post-creation stock deltas).
- Bulk operations (POST array, bulk import).
- Product images / media attachments.
- Updating `referencePrice` in-place on an existing `ProductSupplier` link (detach + reattach only).

## Risks

- Query-filter surface is larger than previous CRUDs → ~40–50 smoke tests expected.
- Estimated implementation size ~800–1000 lines including tests. May approach or exceed the 800-line review budget → the orchestrator will make the chained-PR call at task-forecast time; NOT decided here.
- ProductSupplier attach guard must reject soft-deleted product OR supplier (`active = false`) — easy to miss when only checking existence.

## Estimated Size / Process

- **Track**: SDD-lite (propose done → apply → manual verify by user; no spec/design/tasks phases).
- **Files expected** (mirrors categories/suppliers module layout):
  - `src/modules/products/products.schema.ts`
  - `src/modules/products/products.repository.ts`
  - `src/modules/products/products.service.ts`
  - `src/modules/products/products.controller.ts`
  - `src/modules/products/products.routes.ts`
  - `src/app.ts` (register router)
  - `tests/smoke/products.test.ts`
- **Gate**: `npm run typecheck` + `npm run lint` + `npm test` all green before user verifies.

## Related Changes

- `users-crud` — auth + role-matrix pattern (`ADMIN`-only exception).
- `categories-crud` — `PATCH description: null` nullable clearing pattern; delete-guard style.
- `suppliers-crud` — soft-delete + idempotency (404 on already-inactive); `active` query param via `z.enum(['true','false']).transform(...)`; RIF-style optional-unique pattern to mirror for `code`.
