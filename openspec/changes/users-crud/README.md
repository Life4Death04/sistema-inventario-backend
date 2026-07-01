# Change: users-crud

**Track**: CRUD Template (no propose/spec/design/tasks phases)
**Status**: Applied — 2026-07-01
**Mode**: Hybrid (Engram + OpenSpec)

## Scope

Full CRUD for the `User` model under `/api/users`. All endpoints are protected by `authenticate` + `requireRole('ADMIN')`. Soft-delete only — no physical row removal.

## Endpoints

| Method | Path               | Body / Query                        | Response      | Role  |
|--------|--------------------|-------------------------------------|---------------|-------|
| POST   | `/api/users`       | `createUserSchema`                  | 201 `{ user }` | ADMIN |
| GET    | `/api/users`       | `listUsersQuerySchema` (pagination) | 200 `{ data, meta }` | ADMIN |
| GET    | `/api/users/:id`   | params: `userIdParamsSchema`        | 200 `{ user }` | ADMIN |
| PATCH  | `/api/users/:id`   | `updateUserSchema` (partial)        | 200 `{ user }` | ADMIN |
| DELETE | `/api/users/:id`   | params: `userIdParamsSchema`        | 204 No Content | ADMIN |

## Business Rules

- **Password hashing**: reuses `authService.hashPassword()` (same bcrypt cost as login).
- **Password in response**: structurally excluded via `select` in the repository — never in any response.
- **Duplicate email**: POST and PATCH return 409 CONFLICT if email is already in use.
- **Last-admin guard**: DELETE and PATCH (demote role / set `active=false`) on an ADMIN reject with 409 if it would leave zero active admins. Message: `"Cannot remove the last active administrator."`
- **Self-modification guard**: An ADMIN cannot deactivate themselves nor demote their own role. Returns 403 with `"You cannot deactivate or demote your own account."`
- **Soft delete**: DELETE sets `active = false` — no physical removal. Preserves FK references.

## Files Created / Modified

| File | Action |
|------|--------|
| `src/modules/users/users.repository.ts` | Created — Prisma data-access, paginated list, guard helpers |
| `src/modules/users/users.service.ts` | Created — business logic, guard orchestration |
| `src/modules/users/users.controller.ts` | Created — HTTP handlers (5 endpoints) |
| `src/modules/users/users.routes.ts` | Created — router with middleware chain |
| `src/modules/users/users.schema.ts` | Pre-existing (reused as-is) |
| `src/app.ts` | Modified — added `usersRouter` at `/api/users` |
| `tests/smoke/users.test.ts` | Created — 29 smoke tests (Prisma mocked) |

## Gate Results (2026-07-01)

```
npm run typecheck  → 0 errors
npm run lint       → 0 errors, 2 pre-existing warnings (seed.ts)
npm test           → 89/89 passed (29 new users tests)
```
