# Tasks: backend-foundations

## Delivery Plan

> ✅ **Single PR with `size:exception`** — decisión Engram #280, topic `sdd/backend-foundations/delivery-decision`.
>
> El maintainer aceptó `size:exception` para `backend-foundations`. NO se usa chained PRs, NI stacked-to-main, NI feature-branch-chain. Las 4 slices descritas abajo (scaffold, prisma, express-base, auth) se conservan como **commit groups** (organización lógica + trazabilidad) dentro de un único PR. Cada tarea atómica produce un commit independiente con mensaje Conventional Commits (consistente con el flujo del repo frontend: `feat(scaffold): ...`, `feat(prisma): ...`, `chore(tooling): ...`).
>
> Slice 2 (prisma) ya NO está bloqueada: los campos de `Product` quedaron cerrados en Engram #281 (`unit`, `unitContent`, `brand`).

> 🟡 **NOTE — Deployment platform**
> `FRONTEND_URL` is read from env. No further action in tasks. CORS config is
> already parameterized. Resolve when platform is decided.

---

## Review Workload Forecast

| Field | Value |
|---|---|
| Total commit groups (slices) | 4 (scaffold, prisma, express-base, auth) |
| Total estimated lines | ~1,735 (accepted with `size:exception`) |
| Per-slice forecast (commit-group estimates) | scaffold ~430 · prisma ~410 · express-base ~405 · auth ~500 |
| 400-line budget risk | **High** (overridden by `size:exception`) |
| 800-line budget risk | **High** (overridden by `size:exception`) |
| Chained PRs recommended | **No** (overridden by `size:exception`) |
| Chain strategy | **N/A** (single PR) |
| Delivery strategy | `exception-ok` |
| Commit style | Conventional Commits, one commit per atomic task |

```
Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High
800-line budget risk: High
```

---

## Suggested Work Units

| Commit group | Slice | Order | Gate |
|--------------|-------|-------|------|
| Group 1 | scaffold | first | `typecheck` + `lint` + `docker-compose up` |
| Group 2 | prisma | after group 1 | `prisma validate` + `migrate deploy` + `db:seed` |
| Group 3 | express-base | parallel with group 2 (no DB dep) | health smoke test passes |
| Group 4 | auth | after groups 1-3 | full auth smoke suite passes |

> Todos los grupos viven dentro de **un solo PR**. Cada item bajo "Commit plan" en cada slice es un commit independiente.

---

## Slice 1 — scaffold

**Goal**: Establish the repo base — Node/TS tooling, quality hooks, Docker dev environment, Zod env validation, and README.

**Depends on**: nothing (first slice).

**Estimated lines**: ~430

### Commit plan (Conventional Commits, one per atomic task)

1. `chore(scaffold): initialize package.json, tsconfig, and folder tree` (tasks 1.1, 1.2, 1.3, 1.10)
2. `chore(tooling): add ESLint and Prettier flat config` (task 1.4)
3. `chore(tooling): add Husky + lint-staged pre-commit hook` (task 1.5)
4. `chore(tooling): add Vitest config with unit/integration projects` (tasks 1.6, 1.7)
5. `feat(env): add Zod env validation and .env.example` (tasks 1.8, 1.9)
6. `feat(logger): add Pino logger with redaction` (task 1.11)
7. `chore(docker): add Dockerfile (multi-stage) and docker-compose.dev.yml` (tasks 1.12, 1.13, 1.14)
8. `docs(backend): add README with setup, scripts, env vars, and auth summary` (task 1.15)

> Task 1.16 (`git init` + tag) only applies if the repo is fresh; otherwise omit.

### Tasks

- [x] 1.1 Initialize `package.json` with `engines: { node: ">=20 <21" }`, `type: "module"`, and all 13 exact scripts (`dev`, `build`, `start`, `lint`, `lint:fix`, `typecheck`, `test`, `test:watch`, `db:migrate`, `db:seed`, `db:reset`, `db:studio`, `prepare`). Files: `package.json`.
- [x] 1.2 Add all runtime and devDependencies declared in the design: express, prisma, zod, pino, pino-http, cookie-parser, helmet, cors, express-rate-limit, express-async-errors, jsonwebtoken, bcrypt, tsx, typescript, vitest, supertest, @types/*. Files: `package.json`.
- [x] 1.3 Create `tsconfig.json` with `strict: true`, `noUncheckedIndexedAccess: true`, `target: "ES2022"`, `module: "NodeNext"`, `moduleResolution: "NodeNext"`, `outDir: "dist"`, `rootDir: "src"`. Create `tsconfig.build.json` excluding tests. Files: `tsconfig.json`, `tsconfig.build.json`.
- [x] 1.4 Configure ESLint 9 with TypeScript plugin. Configure Prettier. Add `.eslintignore` and `.prettierignore`. Files: `.eslintrc.cjs`, `.prettierrc`, `.eslintignore`, `.prettierignore`.
- [x] 1.5 Install Husky and lint-staged. Create `.husky/pre-commit` that runs lint-staged (eslint --fix, prettier --write, tsc --noEmit on staged `.ts` files). Files: `.husky/pre-commit`, `package.json` (lint-staged config).
- [x] 1.6 Create `vitest.config.ts` with two projects (`unit` and `integration`) referencing `tests/setup.ts`. Files: `vitest.config.ts`.
- [x] 1.7 Create `tests/setup.ts` with global setup stubs (PrismaClient disconnect, env guard). Files: `tests/setup.ts`.
- [x] 1.8 Create `.env.example` documenting all 14 variables: `NODE_ENV`, `PORT`, `DATABASE_URL`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`, `FRONTEND_URL`, `RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`, `LOG_LEVEL`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_FULLNAME`. Files: `.env.example`.
- [x] 1.9 Create `src/config/env.ts` — Zod schema that parses `process.env`, enforces `JWT_ACCESS_SECRET` min 32 chars, exits with `code 1` and readable message on failure. Export typed `env` object. Files: `src/config/env.ts`.
- [x] 1.10 Create empty barrel stubs for folder tree: `src/app.ts` (exports `app`, no `listen()`), `src/server.ts` (imports `app`, calls `app.listen(env.PORT)`). Create empty index files for `src/shared/{errors,middleware,utils,logger,validation,pagination}/`. Create empty dirs `src/modules/{auth,health}/`. Files: directory tree.
- [x] 1.11 Create `src/shared/logger/index.ts` — Pino instance with `redact: ['req.headers.authorization', 'req.body.password', 'req.cookies.refresh_token']`, level from `env.LOG_LEVEL`, `pino-pretty` in dev. Files: `src/shared/logger/index.ts`.
- [x] 1.12 Create `Dockerfile` multi-stage: `deps` stage (install only prod deps), `build` stage (tsc), `runtime` stage (node:20-alpine, USER node, copy dist + node_modules). Files: `Dockerfile`.
- [x] 1.13 Create `docker-compose.dev.yml` with `app` service (node:20, bind mount, `npm run dev`, depends_on db) and `db` service (postgres:15-alpine, named volume, healthcheck `pg_isready`). Files: `docker-compose.dev.yml`.
- [x] 1.14 Create `.dockerignore`, `.gitignore`. Files: `.dockerignore`, `.gitignore` (pre-existing, verified adequate).
- [x] 1.15 Write `README.md` covering all 6 required sections: Setup, Scripts table (13 scripts), Folder structure, Env vars table, Auth flow summary, Backup note (RNF9 — pg_dump, not backend responsibility). Files: `README.md`.
- [x] 1.16 Run `git init`, create initial commit with all scaffold files. Tag as `scaffold-base` (N/A — repo was pre-initialized; 8 Slice 1 commits created instead; Slice 1 complete).

**Acceptance** (spec `project-scaffold`):
- `npm run typecheck` exits 0.
- `npm run lint` exits 0.
- `npm run dev` boots on `:3000` with valid `.env`.
- `npm run dev` exits 1 with readable message if `DATABASE_URL` or `JWT_ACCESS_SECRET` missing/invalid.
- `docker-compose -f docker-compose.dev.yml up` brings up `db` + `app`.
- `git commit` with dirty TS file is blocked by pre-commit.
- README covers 6 points.

**Test gate**: `npm run typecheck && npm run lint` (no runtime tests in this slice).

---

## Slice 2 — prisma

**Goal**: Define the full Prisma schema (9 models + 6 enums + RefreshToken), run the initial migration, and seed the admin user.

**Depends on**: Slice 1.

**Estimated lines**: ~410

### Commit plan (Conventional Commits, one per atomic task group)

1. `feat(prisma): add schema.prisma datasource, generator, and 6 enums` (tasks 2.1, 2.2)
2. `feat(prisma): add User, Category, and Supplier models` (tasks 2.3, 2.4, 2.6)
3. `feat(prisma): add Product model with unit, unitContent, brand` (task 2.5)
4. `feat(prisma): add ProductSupplier (M:N explicit)` (task 2.7)
5. `feat(prisma): add InventoryMovement, Alert, ReplenishmentRequest, ReplenishmentRequestItem` (tasks 2.8, 2.9, 2.10)
6. `feat(prisma): add RefreshToken for JWT DB allowlist` (task 2.11)
7. `chore(prisma): run prisma format/validate and add Prisma client singleton` (tasks 2.12, 2.13)
8. `feat(prisma): generate init migration` (task 2.14)
9. `feat(prisma): add bcrypt-hashed admin seed (idempotent upsert)` (tasks 2.15, 2.16)

### Tasks

- [ ] 2.1 Create `prisma/schema.prisma` with `datasource db` (postgresql) and `generator client` (prisma-client-js). Files: `prisma/schema.prisma`.
- [ ] 2.2 Add 6 enums to schema: `UserRole` (ADMIN, MANAGER, OPERATOR), `MovementType` (IN, OUT, ADJUSTMENT), `AdjustmentDirection` (INCREASE, DECREASE), `AlertType` (LOW_STOCK, OUT_OF_STOCK), `ReplenishmentStatus` (PENDING, SENT, RECEIVED, CANCELLED), `ProductUnit` (MG, G, KG, ML, L, UNIT). Files: `prisma/schema.prisma`.
- [ ] 2.3 Add `User` model with exact fields from spec: `id`, `fullName`, `email @unique`, `password`, `role UserRole @default(OPERATOR)`, `active`, `phone?`, timestamps, relations to `InventoryMovement[]`, `ReplenishmentRequest[]`, `Alert[] @relation("AlertResolver")`. Add `@@index([email])`, `@@index([active])`. Files: `prisma/schema.prisma`.
- [ ] 2.4 Add `Category` model: `id`, `name @unique`, `description?`, timestamps, `products Product[]`. Files: `prisma/schema.prisma`.
- [ ] 2.5 Add `Product` model (CLOSED — Engram #281): `id`, `code @unique`, `name`, `activeIngredient?`, `description?`, `presentation?`, `brand String? @db.VarChar(120)`, `unit ProductUnit` (required), `unitContent Decimal @db.Decimal(10, 3)` (required), `categoryId`, `category Category @relation(... onDelete: Restrict)`, `stock`, `minStock`, `price Decimal @db.Decimal(12, 2)`, `active`, timestamps, relations to `ProductSupplier[]`, `InventoryMovement[]`, `Alert[]`, `ReplenishmentRequestItem[]`. Indexes: `@@index([code])`, `@@index([categoryId])`, `@@index([active])`, `@@index([brand])`. Files: `prisma/schema.prisma`.
- [ ] 2.6 Add `Supplier` model: `id`, `name`, `rif? @unique`, `whatsapp?`, `address?`, `active`, timestamps, relations. `@@index([active])`. Files: `prisma/schema.prisma`.
- [ ] 2.7 Add `ProductSupplier` M:N explicit model: `id`, `productId`, `supplierId`, `referencePrice Decimal`, timestamps, `onDelete: Cascade` for both FKs, `@@unique([productId, supplierId])`, indexes. Files: `prisma/schema.prisma`.
- [ ] 2.8 Add `InventoryMovement` model: `id`, `productId`, `userId`, `type MovementType`, `adjustmentDirection AdjustmentDirection?`, `reason`, `quantity Int`, `resultingStock Int`, `createdAt` only (immutable log). `onDelete: Restrict` on both FKs. `@@index([productId, createdAt])`, `@@index([userId])`, `@@index([type])`. Files: `prisma/schema.prisma`.
- [ ] 2.9 Add `Alert` model: `id`, `productId`, `type AlertType`, `message`, `resolved Boolean @default(false)`, `resolvedAt?`, `resolvedByUserId?`, `createdAt`. `onDelete: Cascade` for product, `onDelete: SetNull` for resolver user with `@relation("AlertResolver")`. `@@index([productId, resolved])`, `@@index([resolved, createdAt])`. Files: `prisma/schema.prisma`.
- [ ] 2.10 Add `ReplenishmentRequest` model and `ReplenishmentRequestItem` model with all fields from spec. `onDelete: Restrict` for supplier and requestedBy FKs. `onDelete: Cascade` for items. All indexes from spec. Files: `prisma/schema.prisma`.
- [ ] 2.11 Add `RefreshToken` model for JWT DB allowlist (design §7): `id`, `jti String @unique` (cuid), `userId`, `user User @relation(...)`, `expiresAt DateTime`, `revokedAt DateTime?`, `createdAt`. `@@index([userId])`, `@@index([jti])`. Files: `prisma/schema.prisma`.
- [ ] 2.12 Run `npx prisma format` and `npx prisma validate` — fix any issues. Files: `prisma/schema.prisma`.
- [ ] 2.13 Create `src/shared/utils/prisma.ts` — singleton `PrismaClient` export with connection logging in dev. Files: `src/shared/utils/prisma.ts`.
- [ ] 2.14 Run `npm run db:migrate` (`prisma migrate dev --name init`) against a live Postgres to generate `prisma/migrations/[timestamp]_init/migration.sql`. Commit the migration file. Files: `prisma/migrations/`.
- [ ] 2.15 Create `prisma/seed.ts` — reads `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_FULLNAME` from env (exits 1 if missing), hashes password with bcrypt cost 10, upserts `User` by email. Files: `prisma/seed.ts`. Update `package.json` `prisma.seed` field.
- [ ] 2.16 Run `npm run db:seed` — verify admin created, re-run to verify idempotent (no duplicates).

**Acceptance** (spec `database-schema`):
- `npx prisma validate` passes.
- `npx prisma migrate deploy` creates all 9 tables + 6 enums + indexes from empty DB.
- `Product` row created with `unit=ML`, `unitContent=100`, `brand="GENFAR"` succeeds.
- `Product` row with `unit="LITROS"` rejected at the Prisma layer.
- `npm run db:seed` creates admin; re-run produces no duplicate.
- All FKs have explicit `onDelete`.

**Test gate**: `npx prisma validate && npx prisma migrate deploy && npm run db:seed`.

---

## Slice 3 — express-base

**Goal**: Wire the full Express middleware stack, AppError + error handler, validation and pagination helpers, and the health check endpoint with smoke tests.

**Depends on**: Slice 1 (can run without Slice 2 if DB is mocked in tests; production run requires Slice 2).

**Estimated lines**: ~405

### Commit plan (Conventional Commits, one per atomic task group)

1. `feat(errors): add AppError, errorCodes, and global error handler` (tasks 3.1, 3.2, 3.3)
2. `feat(middleware): add notFound handler` (task 3.4)
3. `feat(validation): add Zod validate() middleware factory` (task 3.5)
4. `feat(pagination): add pagination schema and paginate() helper` (task 3.6)
5. `feat(express): wire app.ts middleware chain (helmet, cors, rate-limit, pino-http)` (task 3.7)
6. `feat(health): add /api/health endpoint with Prisma ping` (tasks 3.8, 3.9, 3.10)
7. `feat(server): boot server with env validation and structured log` (task 3.11)
8. `test(health): add smoke tests for /api/health` (task 3.12)
9. `test(shared): add unit tests for validate() and paginate()` (tasks 3.13, 3.14)

### Tasks

- [ ] 3.1 Create `src/shared/errors/AppError.ts` — class `AppError extends Error` with `errorCode: string`, `statusCode: number`, `details?: Record<string,string>`. Export `isAppError(e)` type guard. Files: `src/shared/errors/AppError.ts`.
- [ ] 3.2 Create `src/shared/errors/errorCodes.ts` — const object with the 9 canonical codes: `VALIDATION_ERROR`, `INVALID_CREDENTIALS`, `TOKEN_EXPIRED`, `INVALID_TOKEN`, `MISSING_TOKEN`, `FORBIDDEN`, `NOT_FOUND`, `RATE_LIMIT_EXCEEDED`, `INTERNAL_ERROR`. Files: `src/shared/errors/errorCodes.ts`.
- [ ] 3.3 Create `src/shared/middleware/errorHandler.ts` — 4-arg Express error middleware: handles `AppError` (pass fields through), Zod errors (map to VALIDATION_ERROR 400), unknown errors (INTERNAL_ERROR 500; include `details.stack` in dev only). Uses envelope shape `{ error, message, statusCode, details? }`. Files: `src/shared/middleware/errorHandler.ts`.
- [ ] 3.4 Create `src/shared/middleware/notFound.ts` — handler registered after all routes; responds `404 NOT_FOUND` with `Route ${req.method} ${req.path} not found.` Files: `src/shared/middleware/notFound.ts`.
- [ ] 3.5 Create `src/shared/validation/validate.ts` — `validate(schema: ZodSchema, target: 'body'|'params'|'query'): RequestHandler`. Replaces `req[target]` with parsed output on success; on ZodError maps issues to `{[path]: message}` and throws `AppError('VALIDATION_ERROR', ..., 400, details)`. Files: `src/shared/validation/validate.ts`.
- [ ] 3.6 Create `src/shared/pagination/index.ts` — exports `paginationQuerySchema` (Zod: page≥1, limit 1–100, sort `field:asc|desc`, search string, filter object), and `paginate<T>({data, total, page, limit}): PaginatedResponse<T>` that assembles `{ data, meta: { page, limit, total, totalPages } }`. Export `PaginatedResponse<T>` type. Files: `src/shared/pagination/index.ts`.
- [ ] 3.7 Wire `src/app.ts` — register middlewares in spec-required order: `helmet()`, `cors({origin: env.FRONTEND_URL, credentials:true})`, `cookieParser()`, `express.json({limit:'1mb'})`, `pino-http(logger)`, `express-rate-limit` on `/api/*`. Import `express-async-errors` at top. Mount routes. Register `notFound`, then `errorHandler`. Files: `src/app.ts`.
- [ ] 3.8 Create `src/modules/health/health.controller.ts` — async handler: `SELECT 1` via Prisma with 2s timeout, responds `200` with `{ status:'ok', timestamp, uptime, db:'ok'|'down' }`. DB failure → `db:'down'` but still 200. Files: `src/modules/health/health.controller.ts`.
- [ ] 3.9 Create `src/modules/health/health.routes.ts` — `Router` mounting `GET /` → `healthController`. Export router. Files: `src/modules/health/health.routes.ts`.
- [ ] 3.10 Mount health router in `src/app.ts` at `/api/health` (no auth middleware). Files: `src/app.ts`.
- [ ] 3.11 Extend `src/server.ts` to import `env`, validate at startup, call `logger.info({port: env.PORT}, 'Server started')`. Files: `src/server.ts`.
- [ ] 3.12 Write `tests/smoke/health.test.ts` — Supertest against `app`: (a) GET /api/health with DB ok → 200 + correct shape; (b) GET /api/health with DB mocked down → 200 + `db:'down'`; (c) GET /api/health without Authorization → 200 (no auth). Files: `tests/smoke/health.test.ts`.
- [ ] 3.13 Write unit tests for `validate()` helper: valid body passes to next; invalid body returns 400 VALIDATION_ERROR with details. Files: `tests/unit/validate.test.ts`.
- [ ] 3.14 Write unit tests for `paginate()` and `paginationQuerySchema`: defaults apply, limit>100 → 400, sort without direction → 400. Files: `tests/unit/paginate.test.ts`.

**Acceptance** (spec `http-foundations`):
- `app.ts` does not call `listen()`.
- All 6 middlewares registered in order.
- Error envelope shape is exact.
- `GET /api/health` returns correct shape, `db:'ok'|'down'`.
- All smoke + unit tests pass: `npm test`.

**Test gate**: `npm test` (all Vitest tests pass, including health smoke).

---

## Slice 4 — auth

**Goal**: Implement bcrypt hashing, JWT access+refresh strategy with DB allowlist, the 4 auth endpoints, and `authenticate` + `requireRole` middlewares.

**Depends on**: Slices 1, 2, 3 (all groups complete in the same PR).

**Estimated lines**: ~500

### Commit plan (Conventional Commits, one per atomic task group)

1. `feat(auth): add Zod login schema` (task 4.1)
2. `feat(auth): add AuthService (bcrypt + JWT sign/verify)` (task 4.2)
3. `feat(auth): add auth repository (User + RefreshToken queries)` (task 4.3)
4. `feat(auth): implement POST /login` (task 4.4)
5. `feat(auth): implement POST /refresh with rotation and reuse detection` (task 4.5)
6. `feat(auth): implement POST /logout` (task 4.6)
7. `feat(auth): implement GET /me` (task 4.7)
8. `feat(middleware): add authenticate and requireRole guards` (tasks 4.8, 4.9, 4.10)
9. `feat(auth): mount auth router at /api/auth` (tasks 4.11, 4.12)
10. `test(auth): add smoke tests for full auth flow` (task 4.13)
11. `test(auth): add unit tests for AuthService` (task 4.14)

### Tasks

- [ ] 4.1 Create `src/modules/auth/auth.schema.ts` — Zod schemas: `loginSchema` (`email` string email, `password` string min 1). Export inferred types `LoginDto`. Files: `src/modules/auth/auth.schema.ts`.
- [ ] 4.2 Create `src/modules/auth/auth.service.ts` — `AuthService` class with:
  - `hashPassword(plain: string): Promise<string>` — bcrypt cost 10.
  - `comparePassword(plain: string, hash: string): Promise<boolean>`.
  - `signAccessToken(userId: string, role: UserRole): string` — HS256, TTL from `env.JWT_ACCESS_TTL`, payload `{sub, role}`.
  - `signRefreshToken(userId: string): { token: string; jti: string }` — HS256, TTL from `env.JWT_REFRESH_TTL`, cuid jti.
  - `verifyAccessToken(token: string): { sub: string; role: UserRole }` — throws `AppError(TOKEN_EXPIRED|INVALID_TOKEN)`.
  - `verifyRefreshToken(token: string): { sub: string; jti: string }` — throws `AppError(INVALID_REFRESH_TOKEN)`.
  Files: `src/modules/auth/auth.service.ts`.
- [ ] 4.3 Create `src/modules/auth/auth.repository.ts` — wraps Prisma for auth queries: `findUserByEmail`, `findUserById`, `createRefreshToken`, `findRefreshTokenByJti`, `revokeRefreshToken`, `revokeAllUserRefreshTokens`. Files: `src/modules/auth/auth.repository.ts`.
- [ ] 4.4 Implement `POST /api/auth/login` logic in `auth.service.ts` / controller: find user by email (same error for not-found and wrong-password), check `active`, sign both tokens, store `RefreshToken` in DB via repository, set cookie (`HttpOnly; Secure in prod; SameSite=Strict; Path=/api/auth; Max-Age=604800`), return `{ user: {id,fullName,email,role,active,phone,createdAt}, token }` (no `password` field). Files: `src/modules/auth/auth.service.ts`, `src/modules/auth/auth.controller.ts`.
- [ ] 4.5 Implement `POST /api/auth/refresh` logic: read `req.cookies.refresh_token`, verify JWT, lookup `RefreshToken` row by jti (missing/revoked → INVALID_REFRESH_TOKEN), check user still active, **revoke old jti**, issue new access + refresh tokens, store new RefreshToken row, set rotated cookie. Reuse detection: if jti not found (already rotated), revoke entire family (`revokeAllUserRefreshTokens`) and return 401. Files: `src/modules/auth/auth.service.ts`, `src/modules/auth/auth.controller.ts`.
- [ ] 4.6 Implement `POST /api/auth/logout`: clear cookie (`Set-Cookie: refresh_token=; Max-Age=0`), revoke jti in DB if cookie present. Return `204 No Content`. Idempotent (works even without cookie). Files: `src/modules/auth/auth.controller.ts`.
- [ ] 4.7 Implement `GET /api/auth/me`: protected by `authenticate`. Fetch user from DB by `req.user.id` (fresh read). Return `{ user: {...} }` without `password`. Files: `src/modules/auth/auth.controller.ts`.
- [ ] 4.8 Create `src/shared/middleware/authenticate.ts`: reads `Authorization` header, extracts Bearer token, calls `authService.verifyAccessToken`, sets `req.user = { id, role }`, calls `next()`. On error: throws appropriate AppError (MISSING_TOKEN, INVALID_TOKEN, TOKEN_EXPIRED). Import `express-async-errors` already registered in app. Files: `src/shared/middleware/authenticate.ts`.
- [ ] 4.9 Create `src/shared/middleware/requireRole.ts`: `requireRole(...allowed: UserRole[]): RequestHandler`. Checks `req.user` exists (INTERNAL_ERROR 500 if not — misconfiguration guard), checks `req.user.role` in `allowed` (FORBIDDEN 403 if not). Files: `src/shared/middleware/requireRole.ts`.
- [ ] 4.10 Extend Express `Request` type to include `user?: { id: string; role: UserRole }` via declaration merging. Files: `src/types/express.d.ts`.
- [ ] 4.11 Create `src/modules/auth/auth.routes.ts` — `Router`: `POST /login` → `validate(loginSchema,'body')`, `loginController`; `POST /refresh` → `refreshController`; `POST /logout` → `logoutController`; `GET /me` → `authenticate`, `meController`. Files: `src/modules/auth/auth.routes.ts`.
- [ ] 4.12 Mount auth router in `src/app.ts` at `/api/auth`. Files: `src/app.ts`.
- [ ] 4.13 Write `tests/smoke/auth.test.ts` — Supertest + real DB (test schema). Scenarios from spec: login OK, login wrong-password (401), login unknown-email (401, same message), login inactive user (403), refresh OK (rotated cookie), refresh no-cookie (401), refresh expired-cookie (401), logout + subsequent refresh (401), me with Bearer (200), me no header (401), requireRole allowed (200), requireRole denied (403). Files: `tests/smoke/auth.test.ts`.
- [ ] 4.14 Write unit tests for `AuthService`: `signAccessToken`/`verifyAccessToken` roundtrip, expired token → TOKEN_EXPIRED, wrong secret → INVALID_TOKEN, `hashPassword`/`comparePassword` correctness. Files: `tests/unit/auth.service.test.ts`.

**Acceptance** (spec `auth`):
- bcrypt cost 10 used throughout.
- Access token: HS256, 15 min, `{sub, role}` payload.
- Refresh token: HS256, 7 days, httpOnly cookie with all required flags.
- `POST /login` shape exact; `password` never in response.
- `POST /refresh` rotates cookie.
- `POST /logout` 204 + cookie cleared.
- `GET /me` requires Bearer.
- `authenticate` sets `req.user`.
- `requireRole` blocks 403.
- All smoke + unit tests pass.

**Test gate**: `npm test` (all Vitest tests pass including full auth suite).

---

## Implementation Order

```
Slice 1 (scaffold) ──┬──→ Slice 2 (prisma)        ─┐
                     │                              ├──→ Slice 4 (auth)
                     └──→ Slice 3 (express-base) ──┘
```

All four slices live in a **single PR** with `size:exception`. Recommended commit order:

1. **Slice 1 (scaffold)** — sin dependencias, primer commit group.
2. **Slice 2 (prisma)** — schema cerrado, sin bloqueo.
3. **Slice 3 (express-base)** — puede intercalarse con Slice 2 (no comparten archivos).
4. **Slice 4 (auth)** — requiere los tres anteriores (usa Prisma + middleware base).

Cada item del "Commit plan" de cada slice es un commit independiente con mensaje Conventional Commits; el resultado es un PR ordenado y revisable commit-por-commit aunque exceda el budget de 400 líneas.
