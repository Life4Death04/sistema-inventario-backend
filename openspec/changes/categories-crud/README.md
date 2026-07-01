# Change: categories-crud

**Track**: CRUD Template (no propose/spec/design/tasks phases)
**Status**: Applied — 2026-07-01
**Mode**: Hybrid (Engram + OpenSpec)

## Scope

Full CRUD for the `Category` model under `/api/categories`. All endpoints protected by `authenticate`. Mutations require `ADMIN | MANAGER`; reads allow `ADMIN | MANAGER | OPERATOR`. Hard-delete (no `active` flag). Delete guard: reject if associated products exist.

## Endpoints

| Method | Path                    | Body / Query                          | Response             | Roles               |
|--------|-------------------------|---------------------------------------|----------------------|---------------------|
| POST   | `/api/categories`       | `createCategorySchema`                | 201 `{ category }`   | ADMIN, MANAGER      |
| GET    | `/api/categories`       | `listCategoriesQuerySchema` (pagination + search) | 200 `{ data, meta }` | ADMIN, MANAGER, OPERATOR |
| GET    | `/api/categories/:id`   | params: `categoryIdParamsSchema`      | 200 `{ category }`   | ADMIN, MANAGER, OPERATOR |
| PATCH  | `/api/categories/:id`   | `updateCategorySchema` (partial)      | 200 `{ category }`   | ADMIN, MANAGER      |
| DELETE | `/api/categories/:id`   | params: `categoryIdParamsSchema`      | 204 No Content       | ADMIN, MANAGER      |

## Business Rules

- **Duplicate name**: POST returns 409 if `name` already exists (`"Category name already exists."`). PATCH checks the same — but allows renaming to the row's own current name (no false positive).
- **Delete guard**: Before deletion, counts `Product` rows with `categoryId = :id`. If count > 0, rejects with 409 (`"Cannot delete category with associated products."`). Does NOT rely on Prisma's P2003 FK exception — explicit count for a clean, testable 409.
- **Hard delete**: No `active` flag on Category. DELETE physically removes the row.
- **description nullable**: PATCH accepts `description: null` to explicitly clear the field.
- **Search**: GET list supports `search` param for case-insensitive substring match on `name` OR `description`.

## Files Created / Modified

| File | Action |
|------|--------|
| `src/modules/categories/categories.schema.ts` | Created — Zod schemas + DTO types |
| `src/modules/categories/categories.repository.ts` | Created — Prisma DAL, paginated list, delete guard helper |
| `src/modules/categories/categories.service.ts` | Created — business logic, uniqueness + delete guards |
| `src/modules/categories/categories.controller.ts` | Created — HTTP handlers (5 endpoints) |
| `src/modules/categories/categories.routes.ts` | Created — router with per-endpoint role matrix |
| `src/app.ts` | Modified — added `categoriesRouter` at `/api/categories` |
| `tests/smoke/categories.test.ts` | Created — 28 smoke tests (Prisma mocked) |

## Gate Results (2026-07-01)

```
npm run typecheck  → 0 errors
npm run lint       → 0 errors, 4 pre-existing warnings (seed scripts)
npm test           → 117/117 passed (28 new categories tests)
```
