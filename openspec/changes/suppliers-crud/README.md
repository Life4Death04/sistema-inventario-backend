# Change: suppliers-crud

**Track**: CRUD Template (no propose/spec/design/tasks phases)
**Status**: Applied — 2026-07-01
**Mode**: Hybrid (Engram + OpenSpec)

## Scope

Full CRUD for the `Supplier` model under `/api/suppliers`. All endpoints protected by `authenticate`. Mutations require `ADMIN | MANAGER`; reads allow `ADMIN | MANAGER | OPERATOR`. Soft-delete strategy (no hard delete — `ProductSupplier` and `ReplenishmentRequest` references must not lose historical data).

## Endpoints

| Method | Path                    | Body / Query                          | Response               | Roles               |
|--------|-------------------------|---------------------------------------|------------------------|---------------------|
| POST   | `/api/suppliers`        | `createSupplierSchema`                | 201 `{ supplier }`     | ADMIN, MANAGER      |
| GET    | `/api/suppliers`        | `listSuppliersQuerySchema` (pagination + active + search) | 200 `{ data, meta }` | ADMIN, MANAGER, OPERATOR |
| GET    | `/api/suppliers/:id`    | params: `supplierIdParamsSchema`      | 200 `{ supplier }`     | ADMIN, MANAGER, OPERATOR |
| PATCH  | `/api/suppliers/:id`    | `updateSupplierSchema` (partial)      | 200 `{ supplier }`     | ADMIN, MANAGER      |
| DELETE | `/api/suppliers/:id`    | params: `supplierIdParamsSchema`      | 204 No Content         | ADMIN, MANAGER      |

## Business Rules

- **Soft-delete strategy**: DELETE sets `active = false`. No hard delete. Rationale: `ProductSupplier` and `ReplenishmentRequest` reference `Supplier` — hard-deleting would corrupt historical records.
- **Delete idempotency**: DELETE on an already-inactive supplier returns 404 NOT_FOUND. Treat inactive as not-found for the delete guard.
- **GET /:id returns inactive**: The single-resource endpoint returns the supplier regardless of `active` flag (needed for historical detail views).
- **List filter**: GET `/` defaults to `?active=true`. Accepts `?active=false` to list inactive suppliers. `z.coerce.boolean()` was NOT used — `Boolean("false") === true` in JS. Used `z.enum(['true','false']).transform(v => v === 'true')` instead.
- **RIF uniqueness**: `rif` is optional. If provided and non-null, service checks for duplicates on create and update. Allows PATCH to keep the same RIF (no false-positive self-collision). `null` RIFs do NOT collide (Postgres UNIQUE allows multiple NULLs).
- **RIF normalization**: Empty string `""` is normalized to `null` at the Zod schema layer.
- **WhatsApp validation**: Optional. If provided, must match `/^\+?\d{8,15}$/` (after trimming and stripping spaces/dashes).
- **Address**: Optional; max 255 chars, trimmed.
- **PATCH nullable clearing**: PATCH with explicit `null` on `rif`, `whatsapp`, or `address` clears the field. PATCH with undefined/omitted leaves it unchanged. Uses `'field' in data` check in the repository — same pattern as `categories.repository.ts`.
- **Search**: GET list supports `?search=<term>` for case-insensitive substring match on `name` OR `rif`.

## Files Created / Modified

| File | Action |
|------|--------|
| `src/modules/suppliers/suppliers.schema.ts` | Created — Zod schemas + DTO types + constants |
| `src/modules/suppliers/suppliers.repository.ts` | Created — Prisma DAL, paginated list with active filter, soft-delete, RIF uniqueness helpers |
| `src/modules/suppliers/suppliers.service.ts` | Created — business logic, RIF uniqueness + soft-delete guards |
| `src/modules/suppliers/suppliers.controller.ts` | Created — HTTP handlers (5 endpoints) |
| `src/modules/suppliers/suppliers.routes.ts` | Created — router with per-endpoint role matrix |
| `src/app.ts` | Modified — added `suppliersRouter` at `/api/suppliers` |
| `tests/smoke/suppliers.test.ts` | Created — 38 smoke tests (Prisma mocked) |
| `openspec/changes/suppliers-crud/README.md` | Created — this file |

## Discoveries / Gotchas

- `z.coerce.boolean()` cannot safely parse the query string `"false"` — it coerces any non-empty string to `true`. Used explicit `z.enum(['true','false']).transform(...)` for the `?active` query param instead.

## Gate Results (2026-07-01)

```
npm run typecheck  → 0 errors
npm run lint       → 0 errors, 4 pre-existing warnings (seed scripts — not touched)
npm test           → 155/155 passed (38 new suppliers tests, all prior 117 still passing)
```
