# Tasks: Guest (Demo) Environment — Backend

## Review Workload Forecast

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: feature-branch-chain
400-line budget risk: High

`ask-on-risk` resolved: tracker `feat/guest-environment-backend` (draft, no-merge) holds final integration; only it merges `main`. PR1 bases on tracker; each later PR bases on the immediate prior PR branch. Retarget/rebase any child whose diff shows prior-PR changes.

### Suggested Work Units

No transactional-table seeding → every slice <400 ln; combined ~950–1100 ln keeps the chain.

| PR (base) | Focus (~ln) | Focused test | Harness | Rollback |
|---|---|---|---|---|
| PR1 (tracker) | Schema+migration+marker (60) | `npx vitest run tests/smoke/users.test.ts` | `npx prisma migrate dev` | revert Phase 1 files |
| PR2 (PR1) | JWT `isDemo`+guard (220) | `npx vitest run tests/unit/auth.service.test.ts tests/unit/assertMutationAllowed.test.ts tests/smoke/auth.test.ts` | supertest demo GET/POST | revert Phase 2 files |
| PR3 (PR2) | Refresh cleanup (140) | `npx vitest run tests/unit/auth.repository.test.ts tests/smoke/auth.test.ts` | supertest 2 logins+1 refresh | revert Phase 3 files |
| PR4 (PR3) | Seed safety — pure state machine (140) | `npx vitest run tests/unit/seed-demo.safety.test.ts` | N/A — pure safety policy; executable database bootstrap arrives in PR5 | revert Phase 4 files |
| PR5 (PR4) | Seed bootstrap+data+integrity+confinement (330) | `npx vitest run tests/unit/seed-demo.integrity.test.ts tests/unit/seed-demo.non-destructive.test.ts tests/unit/seed-demo.credential-isolation.test.ts` | rerun `tsx prisma/scripts/seed-demo.ts` twice, diff snapshot | revert Phase 5 files |
| PR6 (PR5) | Private `seed.ts` isDemo=false (70) | `npx vitest run tests/unit/seed.setup-admin.test.ts` | `npm run db:seed` w/ `SEED_ADMIN_*`, inspect row | revert Phase 6 files |
| PR7 (PR6) | Railway checklist (90) | N/A (docs) | N/A — manual walkthrough | revert Phase 7 file |

## Phase 1: Schema & Migration

- [x] 1.1 `prisma/schema.prisma`: add `isDemo Boolean @default(false)` + `@@index([isDemo])` on `User`; add `DemoSeedMarker { id, version, createdAt }`.
- [x] 1.2 `prisma/migrations/<ts>_add_user_is_demo_and_demo_marker/migration.sql`: nullable ADD → backfill `false` → `SET NOT NULL DEFAULT false` → `CREATE INDEX`; `CREATE TABLE "DemoSeedMarker"` (match `20260704120000_add_entity_status` style).
- [x] 1.3 Set `isDemo:false` on `User` fixtures in `tests/smoke/auth.test.ts` and `tests/smoke/users.test.ts`.

## Phase 2: JWT Payload & Demo Read-Only Guard

- [ ] 2.1 RED `tests/unit/auth.service.test.ts`: sign embeds `isDemo`; verify defaults `false` when claim absent.
- [ ] 2.2 GREEN `auth.service.ts`: `AccessTokenPayload.isDemo`; `signAccessToken(userId, role, isDemo)`.
- [ ] 2.3 `errorCodes.ts`: add `DEMO_READ_ONLY` (403). `express.d.ts`: `req.user.isDemo: boolean`.
- [ ] 2.4 RED `tests/unit/assertMutationAllowed.test.ts`: GET/HEAD/OPTIONS no-op; unsafe verb+`isDemo`→throws `DEMO_READ_ONLY`; non-demo never throws.
- [ ] 2.5 GREEN `src/shared/middleware/assertMutationAllowed.ts` (new); wire into `authenticate.ts`: set `req.user.isDemo`, call guard before `next()`.
- [ ] 2.6 RED extend `tests/smoke/auth.test.ts`: demo GET passes; POST/PUT/PATCH/DELETE→403; non-demo unaffected; demo login/refresh/logout usable; stale token (no `isDemo`) treated non-demo.
- [ ] 2.7 GREEN `auth.controller.ts`: pass `user.isDemo` at both sign sites.

## Phase 3: Demo-Scoped Refresh-Token Cleanup

- [ ] 3.1 RED `tests/unit/auth.repository.test.ts`: `pruneDeadRefreshTokens(userId)` deletes only revoked/expired rows scoped to `userId`.
- [ ] 3.2 GREEN `auth.repository.ts`: add `pruneDeadRefreshTokens(userId)`.
- [ ] 3.3 RED extend `tests/smoke/auth.test.ts`: cleanup runs post-issuance; concurrent live rows survive; non-demo skipped; cleanup throw→token still returned+logged.
- [ ] 3.4 GREEN `auth.controller.ts`: `try/catch` prune call (existing logger) post row-creation, `isDemo`-only, both sign sites.

## Phase 4: Demo Seed — Safety State Machine

- [ ] 4.1 `src/shared/demo/demoCredentials.ts` (new): `DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD`, `DEMO_MARKER_VERSION` constants.
- [ ] 4.2 RED `tests/unit/seed-demo.safety.test.ts` (pure, no DB): mismatched/missing confirm→`assertConfirm` throws; no marker+empty→`FIRST_RUN`; no marker+non-empty→`ABORT_UNMARKED`; marker present→`RECOGNIZED_RERUN` (skips empty-check); marker/version or identity mismatch→`ABORT_MISMATCH`.
- [ ] 4.3 GREEN `src/shared/demo/seedSafety.ts` (new): pure `assertConfirm`+`resolveSeedState` — marker-first routing (`FIRST_RUN`/`RECOGNIZED_RERUN`/`ABORT_UNMARKED`/`ABORT_MISMATCH`) from injected booleans/counts, no Prisma/script coupling; executable bootstrap wiring arrives in PR5.

## Phase 5: Demo Seed — Master Data, Integrity & Confinement

- [ ] 5.1 RED `tests/unit/seed-demo.integrity.test.ts`: exactly one `isDemo:true` public ADMIN (`role:ADMIN`); every other user `isDemo:false`; new `Product` rows `stock:0`; `Supplier.rif` deterministic non-null (`J-<seq>`).
- [ ] 5.2 GREEN `prisma/scripts/seed-demo.ts` (new): wire `seedSafety.assertConfirm`/`resolveSeedState` with real marker read+empty-DB counts (10 models, excl. `_prisma_migrations`); on `FIRST_RUN`/`RECOGNIZED_RERUN` single `$transaction` — create `DemoSeedMarker` (first-run only), upsert `Category.name`/`Product.code`/`Supplier.rif`, bcrypt-hashed (cost 10) public ADMIN by `User.email`, `ProductSupplier` upsert by `@@unique([productId,supplierId])` with reference price, Product update omits `stock`; `ABORT_*`→zero writes.
- [ ] 5.3 RED `tests/unit/seed-demo.non-destructive.test.ts`: before/after snapshot proves rerun leaves `Product.stock` and row counts/contents of `InventoryMovement`, `Alert`, `ReplenishmentRequest`, `ReplenishmentRequestItem` unchanged.
- [ ] 5.4 RED `tests/unit/seed-demo.credential-isolation.test.ts`: `POST /api/users` (read-only) with `isDemo:true`/public email never persists `isDemo:true` (schema strips unknown field), duplicate email→`CONFLICT`; rerun matches entities by natural key — no duplicate Categories/Products/Suppliers, descriptive fields/`ProductSupplier` links may update.
- [ ] 5.5 `package.json`: add `"db:seed:demo": "tsx prisma/scripts/seed-demo.ts"`.

## Phase 6: Private Setup ADMIN (`db:seed`)

- [ ] 6.1 RED `tests/unit/seed.setup-admin.test.ts`: `seed.ts` upsert sets `isDemo:false` in BOTH `create` and `update`; fabricated `fullName`/`email` sourced from existing `SEED_ADMIN_FULLNAME`/`SEED_ADMIN_EMAIL` env vars; secret password from `SEED_ADMIN_PASSWORD`; `phone` stays `null`/unset (optional, no new env var); missing `SEED_ADMIN_PASSWORD`→readable abort.
- [ ] 6.2 GREEN `prisma/seed.ts`: add explicit `isDemo:false` in `create`/`update`; keep existing bcrypt(cost 10) `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`/`SEED_ADMIN_FULLNAME`-driven identity; leave `phone` unset; no public creds emitted; do not introduce `SEED_ADMIN_PHONE`.

## Phase 7: Railway Operational Checklist

- [ ] 7.1 Create `openspec/changes/guest-environment-backend/railway-demo-checklist.md`: isolated fabricated-only demo DB; order `migrate:deploy`→`db:seed:demo`→`db:seed`→manual txn setup via app→public verification; public/private creds split; confirmation/marker; `TWILIO_*` unset; `FRONTEND_URL`; rollback (drop `isDemo`+`DemoSeedMarker`, code revert).
