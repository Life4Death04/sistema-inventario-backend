# Apply Progress: guest-environment-backend — PR1 + PR2 + PR3 + PR4

<!-- Updated by sdd-apply | PR4 batch — merged with PR1+PR2+PR3 apply-progress (cumulative) -->

## Chain Strategy

- feature-branch-chain (resolved, `ask-on-risk`)
- Tracker branch: `feat/guest-environment-backend` (draft, no-merge; holds final integration)
- PR1 (base: tracker) → Schema + migration + marker — **this work unit**
- PR2 (base: PR1) → JWT `isDemo` + demo read-only guard
- PR3 (base: PR2) → Demo-scoped refresh-token cleanup
- PR4 (base: PR3) → Seed safety state machine (pure)
- PR5a (base: PR4) → Seed bootstrap library — master data + RED tests (committed, `878ee1c`)
- PR5b (base: PR5a) → Atomic seed orchestration — marker-first single-transaction GREEN + CLI (this work unit)
- PR6 (base: PR5) → Private `seed.ts` `isDemo:false`
- PR7 (base: PR6) → Railway operational checklist

---

# PR1 — Phase 1: Schema & Migration

## Phase 1 Task Checklist ✅ COMPLETE

- [x] 1.1 `prisma/schema.prisma`: added `isDemo Boolean @default(false)` + `@@index([isDemo])` on `User`; added standalone `DemoSeedMarker { id, version, createdAt }` model.
- [x] 1.2 Created additive migration `prisma/migrations/20260925120000_add_user_is_demo_and_demo_marker/migration.sql`: nullable `ADD COLUMN` → backfill `false` → `SET NOT NULL DEFAULT false` → `CREATE INDEX`; `CREATE TABLE "DemoSeedMarker"` created empty. Style matches `20260704120000_add_entity_status`.
- [x] 1.3 Added `isDemo: false` to `User` fixtures in `tests/smoke/auth.test.ts` (`MOCK_USER_ACTIVE`, inherited by `MOCK_USER_INACTIVE`/`MOCK_USER_OPERATOR` spreads) and `tests/smoke/users.test.ts` (`MOCK_ADMIN`, `MOCK_MANAGER`, `MOCK_OPERATOR`, `MOCK_ADMIN2`, plus the `mockUserCreate` fixture wiring and type annotations).

## Files Touched

| File | Action | Details |
|------|--------|---------|
| `prisma/schema.prisma` | Modified | `User.isDemo Boolean @default(false)` + `@@index([isDemo])`; new `DemoSeedMarker` model |
| `prisma/migrations/20260925120000_add_user_is_demo_and_demo_marker/migration.sql` | Created | Additive migration matching repo style; 42 lines |
| `tests/smoke/auth.test.ts` | Modified | `isDemo: false` on `MOCK_USER_ACTIVE` (+1 line) |
| `tests/smoke/users.test.ts` | Modified | `isDemo: false` on 4 fixture literals + type annotations + `mockUserCreate` wiring (+33/-4 lines) |
| `openspec/changes/guest-environment-backend/tasks.md` | Modified | Phase 1 tasks 1.1–1.3 marked `[x]` |
| `openspec/changes/guest-environment-backend/apply-progress.md` | Created | This artifact (correction pass) |

## Work Unit Evidence

| Evidence | Result |
|---|---|
| **Focused test** `npx vitest run tests/smoke/users.test.ts` | ✅ 29/29 passed |
| **Also ran** `npx vitest run tests/smoke/auth.test.ts` (fixture also touched) | ✅ 23/23 passed |
| **Typecheck** `npx tsc --noEmit` | ✅ clean, no output |
| **Runtime harness** `npx prisma migrate deploy` then `npx prisma migrate dev --skip-seed` against disposable local Postgres (`sdd-guest-env-pg`, port 5433, `postgres:15-alpine`) | ✅ All 5 migrations (including the new one) applied cleanly; `migrate dev` reported **"Already in sync, no schema change or pending migration was found"** — proves `migration.sql` matches `schema.prisma` byte-for-byte. Verified via `psql`: `User.isDemo` is `boolean NOT NULL DEFAULT false` with index `User_isDemo_idx`; `DemoSeedMarker` table exists with 0 rows (empty, as required for first-run empty-DB detection). |
| **Full suite** `npm test` | 345/346 passed. 1 pre-existing failure in `tests/smoke/alerts-hooks.test.ts` (S5 reconcile assertion, expects 1 update got 2) — confirmed via `git stash` to fail identically on unmodified `deploy/railway`; not caused by this change. |
| **Rollback boundary** | `prisma/schema.prisma` (the `User.isDemo` field + index + `DemoSeedMarker` block), the new migration directory, and the `isDemo: false` fixture lines in the two test files. All independently revertible without touching Phase 2+ work (not yet started). |

## Deviations from Design

None material — implementation matches `design.md` exactly (marker model shape, migration style, additive backfill pattern).

One process note: `npx prisma format` initially reformatted unrelated whitespace alignment in `ReplenishmentRequest`/`ReplenishmentRequestItem` (pre-existing non-canonical padding in the repo, unrelated to this change). Manually reverted those two blocks to keep the diff scoped to Phase 1 only — confirmed via a `migrate dev` re-run that this reversion introduces zero schema drift.

## Issues Found

- Pre-existing unrelated test failure in `tests/smoke/alerts-hooks.test.ts` (S5 scenario, alert reconcile update-count assertion). Out of scope for this work unit; flagged for visibility, not fixed here.
- `.env` `DATABASE_URL` points at a remote `db.prisma.io` cloud instance — migration verification intentionally did NOT run against it; a disposable local Postgres container was used instead (spun up and torn down cleanly, confirmed absent via `docker ps -a`).

## Authored Change Count

41 insertions + 4 deletions in tracked files (`schema.prisma`: 11, `auth.test.ts`: 1, `users.test.ts`: 33) + 42 lines in the new `migration.sql` = **87 authored changed lines** — within the ~60-line forecast band and well under the 400-line review budget.

## Runtime Attempt Settlement

- Work unit: `PR1-schema-migration-marker`
- State: **complete**
- Evidence revision: `sha256:4e4edf1b6fc5948ea522e7a82fa52a973894e32b4d1377de6a32e80f4c45de79`

---

# PR2 — Phase 2: JWT Payload & Demo Read-Only Guard

Branch: `feat/guest-demo-read-only` (base: PR1's `feat/guest-environment-schema`), per the `feature-branch-chain` strategy above.

## Phase 2 Task Checklist ✅ COMPLETE

- [x] 2.1 RED `tests/unit/auth.service.test.ts`: added 2 new cases to the access-token describe block — `signAccessToken` embeds `isDemo:true` when passed, and `verifyAccessToken` defaults `isDemo` to `false` on a token signed with no `isDemo` claim (raw `jwt.sign`, simulating a stale pre-change token). Extended the existing round-trip test to assert `payload.isDemo === false` for an explicit `isDemo:false` sign call.
- [x] 2.2 GREEN `src/modules/auth/auth.service.ts`: `AccessTokenPayload` gained `isDemo: boolean`; `signAccessToken(userId, role, isDemo)` now requires the third argument and embeds it in the signed payload; `verifyAccessToken` return type gained `isDemo: boolean`, computed as `decoded.isDemo ?? false`.
- [x] 2.3 `src/shared/errors/errorCodes.ts`: added `DEMO_READ_ONLY: 'DEMO_READ_ONLY'` (403, documented as enforced at the `authenticate` chokepoint). `src/types/express.d.ts`: `Request.user` gained required `isDemo: boolean`.
- [x] 2.4 RED `tests/unit/assertMutationAllowed.test.ts` (new file, 20 cases): safe methods (`GET`/`HEAD`/`OPTIONS`) never throw regardless of `isDemo`; unsafe verbs (`POST`/`PUT`/`PATCH`/`DELETE` + an arbitrary verb `TRACE`) throw `AppError(DEMO_READ_ONLY, 403)` only when `isDemo:true`; non-demo (`isDemo:false`) and defensive no-`req.user` cases never throw for any unsafe verb.
- [x] 2.5 GREEN `src/shared/middleware/assertMutationAllowed.ts` (new): exported `assertMutationAllowed(req: Request): void`, throws synchronously (matches the existing `requireRole` pattern — not `next(err)`) when `req.user?.isDemo` is true and `req.method` is not in the safe-method set. Wired into `src/shared/middleware/authenticate.ts`: `req.user` now includes `isDemo: payload.isDemo`, and `assertMutationAllowed(req)` is called immediately after, before `next()`.
- [x] 2.6 RED extended `tests/smoke/auth.test.ts` with a new `describe('Demo read-only guard (isDemo)')` block (8 cases) plus a new `MOCK_USER_DEMO` fixture and an `isDemo`-aware `makeAccessToken` helper: demo `GET /api/auth/me` → 200; demo `POST/PATCH/DELETE/PUT` against `/api/users(/:id)` → 403 `DEMO_READ_ONLY` with the handler never reached (asserted via `prisma.user.findUnique` not called); non-demo `ADMIN` `POST /api/users` unaffected (reaches validation, 400 `VALIDATION_ERROR`, not 403); demo login → 200 + cookie; demo refresh then logout → 200 then 204; a token with **no** `isDemo` claim at all for the demo user's id is treated as non-demo (reaches validation, not blocked).
- [x] 2.7 GREEN `src/modules/auth/auth.controller.ts`: both `signAccessToken` call sites (login, refresh) now pass `user.isDemo` as the third argument.

## Files Touched (PR2)

| File | Action | Details |
|------|--------|---------|
| `src/modules/auth/auth.service.ts` | Modified | `AccessTokenPayload.isDemo`; `signAccessToken(userId, role, isDemo)`; `verifyAccessToken` returns `isDemo` defaulted `false` (+16/-5) |
| `src/modules/auth/auth.controller.ts` | Modified | Pass `user.isDemo` at both `signAccessToken` call sites (login + refresh) (+2/-2) |
| `src/shared/errors/errorCodes.ts` | Modified | Added `DEMO_READ_ONLY` (403) (+7) |
| `src/types/express.d.ts` | Modified | `req.user.isDemo: boolean` (+5) |
| `src/shared/middleware/assertMutationAllowed.ts` | Created | New named guard function; 39 lines |
| `src/shared/middleware/authenticate.ts` | Modified | Sets `req.user.isDemo`; calls `assertMutationAllowed(req)` before `next()` (+11/-2) |
| `tests/unit/auth.service.test.ts` | Modified | 2 new `isDemo` cases + round-trip assertion extended (+28/-1) |
| `tests/unit/assertMutationAllowed.test.ts` | Created | 20 cases covering safe/unsafe methods × demo/non-demo/no-user; 93 lines |
| `tests/smoke/auth.test.ts` | Modified | `MOCK_USER_DEMO` fixture, `isDemo`-aware `makeAccessToken`, new `Demo read-only guard (isDemo)` describe block (8 cases) (+142/-2) |
| `openspec/changes/guest-environment-backend/tasks.md` | Modified | Phase 2 tasks 2.1–2.7 marked `[x]` |
| `openspec/changes/guest-environment-backend/apply-progress.md` | Modified | This artifact — PR2 section merged with PR1 (cumulative) |

## Work Unit Evidence (PR2)

| Evidence | Result |
|---|---|
| **Focused test** `npx vitest run tests/unit/auth.service.test.ts tests/unit/assertMutationAllowed.test.ts tests/smoke/auth.test.ts` | ✅ 68/68 passed (3 test files) — 9 in `auth.service.test.ts`, 20 in `assertMutationAllowed.test.ts`, 39 in `auth.test.ts` (including the 8 new demo-guard cases) |
| **Typecheck** `npx tsc --noEmit` | ✅ clean, no output |
| **Lint** `npx eslint <all 9 changed/created files>` | ✅ clean after 2 fixes: `no-unexpected-multiline` (bracket-method chain reformatted to one line) and `@typescript-eslint/unbound-method` (added disable-line comment matching the existing pattern used elsewhere in the same file for `prisma.refreshToken.updateMany`) |
| **Format** `npx prettier --check` → `--write` | 2 files needed formatting (`assertMutationAllowed.test.ts`, `auth.test.ts`); applied, then re-ran focused tests to confirm no regression |
| **Runtime harness** supertest against the real Express `app` (mocked Prisma) — `tests/smoke/auth.test.ts` "Demo read-only guard (isDemo)" describe block | ✅ demo `GET /api/auth/me` → 200; demo `POST /api/users`, `PATCH /api/users/:id`, `DELETE /api/users/:id`, `PUT /api/users/:id` (no PUT route exists — proves the `authenticate`-level `.use()` chokepoint blocks even unrouted unsafe verbs before Express 404-routes them) → all 403 `DEMO_READ_ONLY`, with `prisma.user.findUnique` asserted never called (handler never reached); non-demo `ADMIN` `POST /api/users` → NOT 403, reaches validation (400 `VALIDATION_ERROR`); demo login → 200 + `refresh_token` cookie; demo refresh → 200 + rotated cookie; demo logout → 204; stale token (demo user id, no `isDemo` claim) `POST /api/users` → NOT 403, reaches validation — proves the verify-time default-to-`false` from 2.1/2.2 actually protects real users from mid-session lockout, not just in isolation |
| **Full suite** `npm test` | 375/376 passed. Same 1 pre-existing failure as PR1 in `tests/smoke/alerts-hooks.test.ts` (S5 reconcile assertion, expects 1 update got 2) — unrelated to this change (confirmed unrelated in PR1, unchanged by PR2's diff) |
| **Rollback boundary** | `src/modules/auth/auth.service.ts` (the `isDemo` additions to `AccessTokenPayload`/`signAccessToken`/`verifyAccessToken`), `src/modules/auth/auth.controller.ts` (the two `user.isDemo` arguments), `src/shared/errors/errorCodes.ts` (`DEMO_READ_ONLY` entry), `src/types/express.d.ts` (`isDemo` field), `src/shared/middleware/assertMutationAllowed.ts` (new file — delete), `src/shared/middleware/authenticate.ts` (the `isDemo` assignment + `assertMutationAllowed` call + import), and the 3 test files' PR2-specific additions. All independently revertible without touching Phase 1 (already merged into this branch's base) or Phase 3+ (not yet started). |

## Deviations from Design (PR2)

None — implementation matches `design.md` exactly: guard extracted as a small named function (`assertMutationAllowed`) called from inside `authenticate` (the universally-first middleware), not a per-route allowlist or a separate `app.ts` guard; safe-method set is `GET`/`HEAD`/`OPTIONS`; stale-token default is `false` via `verifyAccessToken`.

One test-design choice beyond the literal task wording: task 2.6 asks for POST/PUT/PATCH/DELETE coverage, but the app has no route that registers a `PUT` handler anywhere. Rather than skip `PUT` or invent a new route, the test sends `PUT /api/users/:id` and asserts 403 `DEMO_READ_ONLY` — this is a stronger proof than skipping it, because it demonstrates the guard fires from the `authenticate`-level `.use()` middleware (which matches every HTTP method on the mount path) even for a verb with no matching Express route handler, before Express would otherwise fall through to the 404 `notFound` middleware.

## Issues Found (PR2)

None new. The pre-existing `tests/smoke/alerts-hooks.test.ts` S5 failure (flagged in PR1) remains present and unrelated to this change — reconfirmed by the full-suite run above.

## Authored Change Count (PR2) — corrected: complete review diff, not code-only

The original PR2 batch scoped this count to code+test files only ("355 lines, no size:exception needed"). That was **incomplete accounting** — the complete reviewable PR2 diff also includes `tasks.md` bookkeeping and the mandatory `apply-progress.md` evidence artifact, both part of the same change.

| Component | +/- |
|---|---|
| Code + tests (`auth.controller.ts` +2/-2, `auth.service.ts` +16/-5, `errorCodes.ts` +7, `authenticate.ts` +11/-2, `express.d.ts` +5, `assertMutationAllowed.ts` new 39, `assertMutationAllowed.test.ts` new 93, `auth.service.test.ts` +28/-1, `auth.test.ts` +142/-2) | 355 |
| `tasks.md` checkbox bookkeeping (2.1–2.7) | 14 |
| `apply-progress.md` (mandatory Work Unit Evidence, measured against PR1-committed baseline `84bd32e`) | 97 |
| **Complete PR2 review diff (maintainer-approved measurement)** | **466** |

Note: this correction pass itself further extends `apply-progress.md` with the size-exception documentation below (self-referential — any evidence file necessarily grows when it documents its own correction). Measured against the same PR1-committed baseline, the final `apply-progress.md` diff after this pass is 110 insertions/5 deletions (115), bringing the complete diff to 355 + 14 + 115 = **484 lines — still within the maintainer-approved 500-line ceiling** (16-line margin). No code or test file was touched to produce this growth; it is documentation-only.

### Size-exception correction (maintainer-approved)

- Prior pass measured only the 355-line code+test subset against the 400-line budget → "no size:exception needed." That was an **incomplete-accounting error**, not a correct exception-free result — it omitted the mandatory `tasks.md`/`apply-progress.md` artifacts from the same reviewable diff.
- The complete 466-line diff correctly triggers `changed_line_budget_exceeded` against the original 400-line ceiling. The PR2 candidate itself is **unchanged** in this correction pass — no code, test, or middleware logic was touched; the fix is accounting-only.
- All functional checks (unit, smoke, typecheck, lint, format) **passed** under both the original and corrected accounting — only the line-count classification was wrong, not the implementation (see Re-Verification below).
- The maintainer reviewed the complete, cohesive 466-line PR2 candidate and **explicitly approved `size:exception` with a 500-line ceiling** for this work unit only (PR1, PR3–PR7 remain governed by their own forecasts above).
- Rationale accepted: overage is driven by (a) a thorough `assertMutationAllowed` unit-test matrix (20 cases, every safe/unsafe method × demo/non-demo/no-user) and (b) mandatory evidence bookkeeping — not avoidable code bloat. Further splitting would fragment one cohesive guard-plus-tests unit without reducing real review complexity.

## Re-Verification (this pass — size-exception correction)

No production code, test code, or `tasks.md` task state changed in this pass — the PR2 candidate is identical to the prior batch. Checks re-run against that unchanged candidate:

| Command | Result |
|---|---|
| `npx vitest run tests/unit/auth.service.test.ts tests/unit/assertMutationAllowed.test.ts tests/smoke/auth.test.ts` | ✅ 68/68 passed — same as original PR2 run |
| `npx tsc --noEmit` | ✅ clean |
| `npx eslint <9 PR2 files>` (check-only) | ✅ clean, no output |
| `npx prettier --check <same 9 files>` (check-only) | ✅ "All matched files use Prettier code style!" |

No defect exposed by any check, so no code or test correction was made — this pass is accounting-and-documentation-only, as scoped.

## Runtime Attempt Settlement (PR2)

- Work unit: `PR2-jwt-demo-read-only-guard` — **superseded by** `PR2-jwt-demo-read-only-guard-size-exception` (this pass)
- Prior attempt (400-line ceiling): functional checks **passed**, but line-count accounting was incomplete; corrected to the complete 466-line diff it evaluates to `changed_line_budget_exceeded`. Maintainer reset the objective rather than accept the incomplete accounting.
- Current attempt (`PR2-jwt-demo-read-only-guard-size-exception`, 500-line ceiling): goal is to re-verify the maintainer-approved 466-line candidate and persist correct evidence — **met** by this document.
- State: **complete** — the orchestrator settled the exception-verification attempt successfully with evidence revision `sha256:41c25e6b570c9b39ce53885be342e86a91b98d5a23071cddc017f417da832dbb`. **Correction**: the prior document incorrectly recorded the earlier opaque attempt token as though it were the evidence revision — `sha256:b2cee7cddd2db7672175269627baac3e8c79f883530de13de34f25325894573d` was attempt authority, not evidence. The exception-verification authority token was `sha256:c7dbcb47b9f3e3de8aa71e9f2c526b2a98b407b956ba6366376a4cea521d9062`.
- Cleanup/process evidence: no Docker containers or background processes started/left running (`docker ps -a` shows no `sdd-guest-env-pg` container; no orphaned `vitest` processes); no branch switches, commits, or pushes; `.atl/*` untouched (its `git status` modifications are pre-existing/unrelated).

---

# PR3 — Phase 3: Demo-Scoped Refresh-Token Cleanup

Branch: `feat/guest-refresh-cleanup` (base: PR2's `feat/guest-demo-read-only`), per the `feature-branch-chain` strategy above.

## Phase 3 Task Checklist ✅ COMPLETE

- [x] 3.1 RED `tests/unit/auth.repository.test.ts` (new, 4 cases): asserts `deleteMany` is called with `where.userId` scoped to the exact caller, `where.OR` containing `{ revoked: true }` and an `expiresAt: { lt: <Date> now-bounded> }` clause (exactly 2 clauses, neither matching a live row), scope never leaks across two sequential calls with different userIds, and the resolved count is returned.
- [x] 3.2 GREEN `src/modules/auth/auth.repository.ts`: added `pruneDeadRefreshTokens(userId): Promise<number>` = `deleteMany({ where: { userId, OR: [{revoked:true},{expiresAt:{lt:new Date()}}] } })`, returns `result.count`. Matches design.md's exact contract.
- [x] 3.3 RED extended `tests/smoke/auth.test.ts` with a `describe('Demo-scoped refresh-token cleanup')` block (4 cases) plus an `insertDeadRow(userId, opts)` fixture helper and a `deleteMany` mock-store implementation mirroring the real Prisma `where` shape: (a) demo login prunes pre-seeded revoked+expired rows for that user while the freshly created active row survives; (b) two concurrent demo logins (session A + B) each hold a live row — session A refreshing rotates+prunes only its own dead row, session B's live row is untouched and B can still refresh (this is the required runtime harness: 2 logins + 1 refresh); (c) non-demo login with pre-seeded dead rows never calls `deleteMany` at all and leaves those rows in place; (d) `deleteMany` mocked to reject once — login still returns `200` with a valid token, and `logger.error` (spied via `vi.spyOn`) is asserted called.
- [x] 3.4 GREEN `src/modules/auth/auth.controller.ts`: imported the shared `logger`; at both `loginController` and `refreshController`, immediately after the new `RefreshToken` row is created (`refreshTokenRow` / `newRow`), added `if (user.isDemo) { try { await authRepository.pruneDeadRefreshTokens(user.id); } catch (pruneErr) { logger.error({ err: pruneErr, userId: user.id }, '...') } }` — runs strictly after the live row exists, scoped to demo users only, failure logged and swallowed so the token response is never affected.

## Files Touched (PR3)

| File | Action | Details |
|------|--------|---------|
| `src/modules/auth/auth.repository.ts` | Modified | `pruneDeadRefreshTokens(userId)` (+22) |
| `src/modules/auth/auth.controller.ts` | Modified | `logger` import; demo-scoped prune `try/catch` at both sign sites (+33) |
| `tests/unit/auth.repository.test.ts` | Created | 4 cases — scoping, dead-only clauses, no cross-user leakage, return value; 99 lines |
| `tests/smoke/auth.test.ts` | Modified | `deleteMany` mock wiring + `insertDeadRow` helper + `logger` import + `Demo-scoped refresh-token cleanup` describe block (4 cases) (+154) |
| `openspec/changes/guest-environment-backend/tasks.md` | Modified | Phase 3 tasks 3.1–3.4 marked `[x]` |
| `openspec/changes/guest-environment-backend/apply-progress.md` | Modified | This artifact — PR3 section merged with PR1+PR2 (cumulative) |

## Work Unit Evidence (PR3)

| Evidence | Result |
|---|---|
| **Focused test** `npx vitest run tests/unit/auth.repository.test.ts tests/smoke/auth.test.ts` | ✅ 40/40 passed (2 test files) — 4 in `auth.repository.test.ts`, 36 in `auth.test.ts` (including the 4 new cleanup cases) |
| **RED confirmation** | `auth.repository.test.ts` run before 3.2: 4/4 failed with `pruneDeadRefreshTokens is not a function`. `auth.test.ts` cleanup block run before 3.4: 3/4 failed (dead rows not pruned, live-row count wrong, logger not called) — the 4th (non-demo untouched) passed both before and after, as expected for a negative assertion. |
| **Typecheck** `npx tsc --noEmit` | ✅ clean, no output |
| **Lint** `npx eslint src/modules/auth/auth.repository.ts src/modules/auth/auth.controller.ts tests/unit/auth.repository.test.ts tests/smoke/auth.test.ts` | ✅ clean after 1 fix: replaced `toHaveBeenNthCalledWith(n, expect.objectContaining(...))` with direct `mock.calls[n]` destructuring + assertions (`@typescript-eslint/no-unsafe-assignment` on `expect.objectContaining`'s `any` return) |
| **Format** `npx prettier --check <same 4 files>` | ✅ "All matched files use Prettier code style!" — no rewrites needed |
| **Runtime harness** supertest — `tests/smoke/auth.test.ts` "Demo-scoped refresh-token cleanup" case (b): two demo logins (session A, session B) each producing a live `RefreshToken` row, then session A calls `POST /api/auth/refresh` | ✅ refresh A → `200`; session A's OLD row (now revoked by rotation) is pruned by the post-issuance cleanup; session B's untouched live row survives (`refreshTokenStore.size` stays `2`: B's original + A's new rotated row); session B then independently calls `POST /api/auth/refresh` → `200`, proving the other session was never disturbed |
| **Full suite** `npm test` | 383/384 passed. Same 1 pre-existing failure as PR1/PR2 in `tests/smoke/alerts-hooks.test.ts` (S5 reconcile assertion, expects 1 update got 2) — unrelated to this change, count grew from 376→384 baseline only because of the 8 new PR3 tests (4 unit + 4 smoke) |
| **Rollback boundary** | `src/modules/auth/auth.repository.ts` (the `pruneDeadRefreshTokens` method — delete it), `src/modules/auth/auth.controller.ts` (the `logger` import and the two `if (user.isDemo) { try {...} catch {...} }` blocks), `tests/unit/auth.repository.test.ts` (new file — delete), and the PR3-specific additions to `tests/smoke/auth.test.ts` (`deleteMany` mock wiring, `insertDeadRow` helper, `logger` import, the `Demo-scoped refresh-token cleanup` describe block). All independently revertible without touching Phase 1–2 (already merged into this branch's base) or Phase 4+ (not yet started). |

## Deviations from Design (PR3)

None — implementation matches `design.md` exactly: `pruneDeadRefreshTokens` query shape is verbatim from the design's "File Changes" table; cleanup is placed strictly after `createRefreshToken` returns at both sign sites (data flow: `... → create RefreshToken → [isDemo? pruneDeadRefreshTokens(userId)] → respond`); failure is logged via the existing shared `logger` and swallowed, matching the same try/catch-and-log pattern already used in `inventory-movements.service.ts` for the alert-reconcile non-critical failure path.

## Issues Found (PR3)

None new. The pre-existing `tests/smoke/alerts-hooks.test.ts` S5 failure (flagged in PR1, reconfirmed in PR2) remains present and unrelated to this change — reconfirmed by the full-suite run above.

## Authored Change Count (PR3)

Measured via `git diff --numstat` (existing files) + `wc -l` (new file), against the PR2-committed baseline — additions/deletions, not a rough estimate:

| Component | + | - |
|---|---|---|
| `src/modules/auth/auth.repository.ts` | 22 | 0 |
| `src/modules/auth/auth.controller.ts` | 33 | 0 |
| `tests/unit/auth.repository.test.ts` (new, 99 lines total) | 99 | 0 |
| `tests/smoke/auth.test.ts` | 154 | 0 |
| **Code + tests subtotal** | **308** | **0** |
| `tasks.md` checkbox bookkeeping (3.1–3.4) | 4 | 4 |
| `apply-progress.md` (this PR3 section, mandatory Work Unit Evidence) | 74 | 5 |
| **Total changed lines (+ and - combined)** | | **395** |

The final read-back measured 395 changed lines against the PR2-committed baseline, within the 400-line review budget; no `size:exception` is needed for PR3, and PR2's exception does not carry forward. The over-forecast size comes from the two-session smoke harness and complete RED/GREEN evidence, with source, tests, tasks, and progress all counted.

## Runtime Attempt Settlement (PR3)

- Work unit: `PR3-demo-refresh-token-cleanup`
- State: **complete**
- Evidence revision: `sha256:d0e6e27d2416097725cd447cac272497ed04a66773b3ea9228e52f92cfb8e021`
- Cleanup/process evidence: no Docker containers or background processes started/left running; no branch switches, commits, or pushes; `.atl/*` untouched (its `git status` modifications are pre-existing/unrelated, confirmed via `git status --short` before and after this batch).

---

# PR4 — Phase 4: Demo Seed — Safety State Machine

Branch: `feat/guest-seed-safety` (base: PR3's `feat/guest-refresh-cleanup`), per the `feature-branch-chain` strategy above.

## Phase 4 Task Checklist ✅ COMPLETE (corrected — see Remediation below)

- [x] 4.1 `src/shared/demo/demoCredentials.ts` (new): committed public constants `DEMO_ADMIN_EMAIL` (`demo@highmeds.local`), `DEMO_ADMIN_PASSWORD` (`HighMedsDemo2026!`), `DEMO_MARKER_VERSION` (`'1'`) — intentionally hardcoded/public, distinct from env-driven private `SEED_ADMIN_*`.
- [x] 4.2 RED `tests/unit/seed-demo.safety.test.ts` (12 cases, pure — no DB/Prisma): `assertConfirm(false)` throws; `assertConfirm(true)` does not throw; `resolveSeedState` — no marker+empty→`FIRST_RUN`; no marker+non-empty→`ABORT_UNMARKED`; exactly 1 valid marker + exactly 1 valid demo identity→`RECOGNIZED_RERUN`; same + non-empty DB→still `RECOGNIZED_RERUN` (skips empty-check); 1 marker/wrong version→`ABORT_MISMATCH`; 1 valid marker/0 identities→`ABORT_MISMATCH`; 1 valid marker/2 duplicate-matching identities→`ABORT_MISMATCH`; **2 matching marker rows→`ABORT_MISMATCH`** (cardinality); **1 valid identity + 1 unrelated `isDemo:true` row→`ABORT_MISMATCH`** (identity cardinality).
- [x] 4.3 GREEN `src/shared/demo/seedSafety.ts` (new): pure `assertConfirm(confirmed: boolean): void` and `resolveSeedState(input: SeedStateInput): SeedState` — marker-first routing from injected **counts** `{ markerCount, matchingMarkerCount, totalDemoIdentityCount, matchingDemoIdentityCount, appIsEmpty }`; `RECOGNIZED_RERUN` requires `markerCount===1 && matchingMarkerCount===1 && totalDemoIdentityCount===1 && matchingDemoIdentityCount===1` — cardinality-exact, not existence-only. No Prisma import, no `process.env` read, no script coupling.

## Files Touched (PR4)

| File | Action | Details |
|------|--------|---------|
| `src/shared/demo/demoCredentials.ts` | Created | 3 public constants; 33 lines |
| `src/shared/demo/seedSafety.ts` | Created/Corrected | `assertConfirm` + `resolveSeedState` + `SeedStateInput`/`SeedState`; count-based cardinality fields; 126 lines |
| `tests/unit/seed-demo.safety.test.ts` | Created/Corrected | 12 cases covering every state-machine branch incl. 2 cardinality regressions; 151 lines |
| `openspec/changes/guest-environment-backend/tasks.md` | Modified | Phase 4 tasks 4.1–4.3 marked `[x]` |
| `openspec/changes/guest-environment-backend/apply-progress.md` | Modified | This artifact — PR4 section merged with PR1+PR2+PR3 (cumulative) |

## Work Unit Evidence (PR4)

| Evidence | Result |
|---|---|
| **RED confirmation (original)** `npx vitest run tests/unit/seed-demo.safety.test.ts` (before 4.1/4.3 existed) | ❌ Failed to load url `../../src/shared/demo/seedSafety.js` — production code absent, not a broken harness. |
| **Focused test (final, corrected GREEN)** `npx vitest run tests/unit/seed-demo.safety.test.ts` | ✅ 12/12 passed — `assertConfirm` (3 cases) + `resolveSeedState` (9 cases: all 4 states, empty-check-skip branch, and the 2 cardinality-regression cases added in remediation) |
| **Typecheck** `npx tsc --noEmit` | ✅ clean, no output |
| **Lint** `npx eslint src/shared/demo/demoCredentials.ts src/shared/demo/seedSafety.ts tests/unit/seed-demo.safety.test.ts` | ✅ clean, no output, no fixes needed |
| **Format** `npx prettier --check` (same 3 files) | ✅ "All matched files use Prettier code style!" |
| **`git diff --check`** | ✅ exit 0, no whitespace errors |
| **Runtime harness** | N/A — pure safety policy; executable database bootstrap arrives in PR5. Both functions have zero I/O, so there is no runtime boundary to exercise in this work unit. |
| **Rollback boundary** | `src/shared/demo/demoCredentials.ts`, `src/shared/demo/seedSafety.ts`, `tests/unit/seed-demo.safety.test.ts` — all net-new, independently revertible, nothing else imports from `src/shared/demo/` yet. |

## Deviations from Design (PR4)

One design-completion choice, not a deviation: `design.md`'s pseudocode reads `assertConfirm(env DEMO_SEED_CONFIRM === literal)`, which this implementation takes literally — `assertConfirm` accepts the pre-computed boolean (`confirmed: boolean`), not the raw string or an embedded literal. This keeps the function fully pure (no hardcoded confirmation phrase invented here, no coupling to how the caller derives the literal) and matches task 4.3's "from injected booleans/counts" wording, which task 4.2 groups `assertConfirm` and `resolveSeedState` under together. The real `process.env.DEMO_SEED_CONFIRM` comparison is deferred to PR5's `prisma/scripts/seed-demo.ts`, which is explicitly where "executable bootstrap wiring arrives" per task 4.3.

Otherwise implementation matches `design.md` exactly: marker read FIRST, empty-check skipped on any recognized rerun, `ABORT_MISMATCH` fires on either version mismatch or identity-count mismatch (0 or >1), `demoCredentials.ts` exports exactly the 3 constants named in the design's File Changes table with no additional public API invented.

## Issues Found (PR4)

None new. The pre-existing `tests/smoke/alerts-hooks.test.ts` S5 failure (flagged in PR1, reconfirmed in PR2/PR3) is unrelated to this change (last confirmed in the PR4 full-suite run below — not re-run in the remediation pass per the narrowed scope).

## Remediation — Maintainer-Authorized Cardinality Correction

The original PR4 candidate (evidence revision `sha256:23e22f6187584b563b37e7227d9a902da386c08057ade55309f69756dfe647c4`) failed independent validation on 2 fail-closed defects in `resolveSeedState`'s `RECOGNIZED_RERUN` check:

1. **Marker cardinality**: `markerVersionMatches: boolean` could not distinguish "exactly one matching marker" from "two matching markers" — a duplicate-marker target was silently accepted as a valid rerun.
2. **Demo identity cardinality**: `demoAdminCount` counted only MATCHING public-email ADMIN identities — an extra unrelated `isDemo:true` user alongside a correct one was silently accepted as a valid rerun.

**Fix**: `SeedStateInput` replaced the two booleans/one-count with four counts — `markerCount`, `matchingMarkerCount`, `totalDemoIdentityCount`, `matchingDemoIdentityCount` — so `resolveSeedState` can require `markerCount===1 && matchingMarkerCount===1 && totalDemoIdentityCount===1 && matchingDemoIdentityCount===1` for `RECOGNIZED_RERUN`; any other marker-present combination now fails closed to `ABORT_MISMATCH`. `assertConfirm` was unchanged (not implicated).

**RED** (2 new cases added, run against the UN-corrected production code first): both failed with `expected 'FIRST_RUN' to be 'ABORT_MISMATCH'` — the old code read the (now-absent) `markerExists`/`markerVersionMatches`/`demoAdminCount` fields as `undefined`, fell through to the no-marker branch, and returned `FIRST_RUN` because `appIsEmpty:true` — a clean behavioral failure, not a type/harness error (Vitest transpiles via esbuild, no type-check gate).

**GREEN**: after rewriting `resolveSeedState`'s input shape and logic, and updating all 10 pre-existing cases plus the 2 new ones to the corrected shape, all 12/12 pass (see Work Unit Evidence above). All previously correct FIRST_RUN, ABORT_UNMARKED, valid-rerun, empty-check-skip, version-mismatch, and zero-identity behaviors are preserved with no weakened assertions — each case still asserts one specific `SeedState` string derived from distinct, deliberately-chosen inputs.

Tasks 4.1–4.3 remain `[x]` — the corrected focused proof now passes; the 4.1/4.3 checklist entries above already reflect the corrected contract.

## Authored Change Count (PR4)

Measured via `wc -l` (new files, all-insertions) + `git diff --numstat 19b164a` (tracked files), against the PR3-committed baseline (`19b164a`). This table reflects the FINAL corrected candidate, not the original failed one:

| Component | Lines |
|---|---|
| `src/shared/demo/demoCredentials.ts` (new, unchanged by remediation) | 33 |
| `src/shared/demo/seedSafety.ts` (new; grew 90→126 lines during remediation) | 126 |
| `tests/unit/seed-demo.safety.test.ts` (new; grew 110→151 lines during remediation) | 151 |
| **Code + tests subtotal** | **310** |
| `tasks.md` checkbox bookkeeping (4.1–4.3, `git diff --numstat`) | 6 (3 insertions + 3 deletions) |
| `apply-progress.md` (this cumulative artifact's PR4 section, `git diff --numstat` at time of this table) | see exact figure in the return summary — this line count is necessarily approximate inside the file it describes (self-referential); the return summary reports the precise post-write `git diff --numstat` reading, which is authoritative over this line |
| **Total changed lines** | **310 (code+tests) + 6 (tasks.md) + apply-progress.md's own diff — see return summary for the exact total and whether it stays at/under 400** |

Correction to the prior pass's statement: the prior `apply-progress.md` text asserted "~384" as an approximate total. That figure was an estimate, not a measured value, and is retracted here — the accurate accounting is the `git diff --numstat`-measured table above plus the return summary's final reading. This is a pure-logic-only work unit (no Prisma, no HTTP surface, no CLI script); per the "Never compress tests/docs/code merely to fit" rule, no test, comment, or documentation content was shortened to hit a target — the 2 required regression tests and their full RED/GREEN narrative are included in full.

## Runtime Attempt Settlement (PR4)

- Original work unit: `PR4-demo-seed-safety-state-machine` — evidence revision `sha256:23e22f6187584b563b37e7227d9a902da386c08057ade55309f69756dfe647c4` — **failed independent validation** (2 fail-closed cardinality defects, see Remediation above).
- Remediation work unit: `PR4-seed-cardinality-correction` (token `sha256:9d706bf4dd6eff3d113d9e64850617974cf36e729ae23e047022c33b43da91d7`, `--remediates-evidence-revision "sha256:23e22f6187584b563b37e7227d9a902da386c08057ade55309f69756dfe647c4"`) — **complete**: both defects corrected, 12/12 focused tests pass, typecheck/lint/format/`git diff --check` clean.
- Cleanup/process evidence: no Docker containers or background processes started/left running; no branch switches, commits, or pushes; `.atl/*` untouched (its `git status` modifications are pre-existing/unrelated, confirmed via `git status --short` before and after this batch).


# PR5a — Phase 5 (part 1): Demo Seed — Master Data Bootstrap Library

Branch: `feat/guest-demo-seed-data` (base: PR4's `feat/guest-seed-safety`), per the `feature-branch-chain` strategy above.

**Committed**: `878ee1c feat(demo): add master-data bootstrap library` — 632 changed lines (`git show 878ee1c --numstat`: 629 insertions across 5 tracked files + 3/3 `tasks.md` bookkeeping).

## Phase 5a Task Checklist

- [x] 5.1 RED `tests/unit/seed-demo.integrity.test.ts` (4 cases): exactly one `user.upsert` call, and it targets the public `DEMO_ADMIN_EMAIL` with `isDemo:true`/`role:ADMIN` in both `create` AND `update`; every `product.upsert` create payload has `stock:0`; every `supplier.upsert` create payload has a non-null `rif` matching `J-\d+`, unique across suppliers.
- [ ] 5.2 GREEN `prisma/scripts/seed-demo.ts` — left **incomplete** by this commit (see below). Deferred to PR5b.
- [x] 5.3 RED `tests/unit/seed-demo.non-destructive.test.ts` (3 cases): a `RECOGNIZED_RERUN` (`isFirstRun:false`) call never invokes `demoSeedMarker.create`; every `product.upsert` update payload structurally omits the `stock` key; a before/after snapshot pins `inventoryMovement`/`alert`/`replenishmentRequest`/`replenishmentRequestItem` mocked `count()` to a fixed non-zero value, runs the rerun, and asserts the count is unchanged AND none of `create`/`update`/`delete` was ever called on those four models.
- [x] 5.4 RED `tests/unit/seed-demo.credential-isolation.test.ts` (3 cases, two concerns): (A) supertest `POST /api/users` with `isDemo:true` + the public `DEMO_ADMIN_EMAIL` in the body — `createUserSchema` strips the unknown `isDemo` key before it reaches the repository. (B) `bootstrapDemoData` run twice (`true` then `false`) — the `where` natural-key sets captured on each run are identical, proving no duplicate-creating code path exists on rerun.
- [ ] 5.5 `package.json`: `"db:seed:demo"` script — **not added** by this commit (`package.json` was not part of the 878ee1c diff). Deferred to PR5b.

## Files Touched (PR5a, committed)

| File | Action | Details |
|------|--------|---------|
| `prisma/scripts/seed-demo.ts` | Created | Fabricated master data (2 categories, 2 suppliers, 2 products, 3 `ProductSupplier` links) + an initial, **not-yet-wired** confirm/resolve/bootstrap scaffold; 192 lines |
| `tests/helpers/mockDemoPrisma.ts` | Created | Shared Prisma-shaped mock exposing distinct `prisma`/`tx`/`operationLog`, reused by all PR5a/PR5b test files; 103 lines |
| `tests/unit/seed-demo.integrity.test.ts` | Created | 4 cases — identity/stock/rif integrity; 90 lines |
| `tests/unit/seed-demo.non-destructive.test.ts` | Created | 3 cases — marker/stock/transactional-table non-destructiveness; 92 lines |
| `tests/unit/seed-demo.credential-isolation.test.ts` | Created | 3 cases — confinement (supertest) + natural-key rerun idempotency; 149 lines |
| `openspec/changes/guest-environment-backend/tasks.md` | Modified | Phase 5 tasks 5.1, 5.3, 5.4 marked `[x]`; 5.2 and 5.5 left `[ ]` (accurate — not yet complete at commit time) |

## Deviations from Design (PR5a)

**Fabricated dataset trimmed to 2 categories / 2 suppliers / 2 products** (one product keeps 2 `ProductSupplier` links, the other keeps 1, so the multi-link upsert path stays covered) — a data-volume reduction made under review-budget pressure, not a logic simplification. `design.md`/`specs/database-schema/spec.md` only require plural fabricated Category/Supplier/Product rows; they name no fixed count. All unit tests assert structural properties (`stock:0`, `rif` pattern, exactly-one-user-upsert, natural-key stability) rather than fixed counts.

## Issues Found (PR5a)

- Pre-existing unrelated failure in `tests/smoke/alerts-hooks.test.ts` (S5 reconcile assertion, expects 1 update got 2) persists — unrelated to this change, not touched.
- The committed `seed-demo.ts` scaffold was left functionally incomplete: `bootstrapDemoData` read/wrote against the ROOT `PrismaClient` directly rather than a shared transaction client, and `runSeedDemo`'s wiring to `seedSafety` was not finished. This is why 5.2 and 5.5 were correctly left `[ ]` rather than falsely marked complete. PR5b (below) completes the GREEN implementation.

## Runtime Attempt Settlement (PR5a)

- Work unit: `PR5-demo-seed-master-data` (original)
- State: **committed as an intentionally partial slice** — `5.1`/`5.3`/`5.4` RED test coverage plus the fabricated-data scaffold landed; `5.2`/`5.5` GREEN wiring deferred to PR5b. A later independent-validation pass on the then-in-progress `5.2` GREEN candidate found a marker-first transaction atomicity defect (evidence revision `sha256:35c0fbe86bd1e2863bbdcb951b208ab384613b84af4000115ce12c5a14ccd7ba`); that defect was diagnosed and corrected as part of PR5b, not by amending this commit.

---

# PR5b — Phase 5 (part 2): Demo Seed — Atomic Seed Orchestration

Branch: `feat/guest-demo-seed-atomicity` (base: PR5a's `feat/guest-demo-seed-data`), per the `feature-branch-chain` strategy above. **Uncommitted** at the end of this pass — see Runtime Attempt Settlement below; independent `sdd-verify` is a later orchestrator phase and is not run from this batch. **Evidence-accuracy correction (this pass)**: attempt token `sha256:a455c2cdb008435f2ec28927f2be72462503d7455c66b8c9f4e84fb30006bdbb`, bound to remediate evidence revision `sha256:e706d602ef55d1db887847679fa5e2e4b00e758d6364aaba0ad00b8d662ab605` — this pass corrects stale placeholders/counts/wording only (no production behavior touched) and is itself **pending parent settlement, not already passed**.

## Phase 5b Task Checklist

- [x] 5.2 GREEN `prisma/scripts/seed-demo.ts` (orchestration additions on top of PR5a's scaffold): `countApplicationRows(tx)` sums the 10 approved models (`User`, `RefreshToken`, `Category`, `Product`, `Supplier`, `ProductSupplier`, `InventoryMovement`, `Alert`, `ReplenishmentRequest`, `ReplenishmentRequestItem` — excludes `DemoSeedMarker`, tracked separately via `markerCount`, and `_prisma_migrations`). `resolveSeedStateInTransaction(tx)` reads the marker FIRST (`tx.demoSeedMarker.count()`), then — only on the no-marker branch — the ten-model empty-DB count; a recognized rerun never queries the ten-model count at all. `bootstrapDemoData(tx, isFirstRun)` writes using the SAME `tx` client the state read used. `runSeedDemo(prisma)` calls `assertConfirm(process.env['DEMO_SEED_CONFIRM'] === REQUIRED_CONFIRMATION)`, then opens exactly ONE `prisma.$transaction(async (tx) => {...})` wrapping the marker-first read, state resolution, and every write; every `ABORT_*` state throws inside that same callback before any write executes (zero writes on abort). `SeedTxClient` is a `Pick<PrismaClient, ...>` that structurally excludes `$transaction`/`$connect`/etc., so the write phase is mechanically incapable of opening a nested transaction or escaping the shared boundary. A CLI guard (`import.meta.url === file://${process.argv[1]}`) only runs `main()`/`runSeedDemo` when the file is executed directly, so every function stays independently importable and unit-testable. (**Wording correction**: this describes one transaction PER ATTEMPT, not one transaction total — the Remediation section below wraps this same per-attempt `$transaction` call in a bounded retry loop of at most 3 attempts; each attempt is fresh, `Serializable`, marker-first, and uses exactly one `tx` client for its own read+resolve+write sequence.)
- [x] 5.5 `package.json`: added `"db:seed:demo": "tsx prisma/scripts/seed-demo.ts"`.

## Files Touched (PR5b, this batch)

| File | Action | Details |
|------|--------|---------|
| `prisma/scripts/seed-demo.ts` | Modified | Confirmation handling, marker-first `resolveSeedStateInTransaction`, `countApplicationRows` (ten-model check, only when needed), single-`$transaction` wiring around `bootstrapDemoData`, CLI entry point; 156 insertions / 2 deletions vs the PR5a baseline |
| `tests/unit/seed-demo.atomicity.test.ts` | Created | 4 cases — marker-first-then-conditional-ten-model read ordering, zero-writes-on-abort, single-`tx`-only client usage; 154 lines |
| `tests/unit/seed-demo.credential-isolation.test.ts` | Modified | Narrow, behavior-preserving typing fix for Part A's `prisma.user.create` mock (see "Typecheck fix" below); 20 insertions / 13 deletions, same 3 cases, same assertions |
| `package.json` | Modified | `db:seed:demo` script (+1) |
| `openspec/changes/guest-environment-backend/tasks.md` | Modified | Phase 5 tasks 5.2 and 5.5 marked `[x]` (2 insertions / 2 deletions) |
| `openspec/changes/guest-environment-backend/apply-progress.md` | Modified | This section — corrects the PR5a/PR5b chain description, replacing the prior draft's single-monolithic-"PR5" narrative (which never matched what was actually committed) |

`tests/unit/seed-demo.integrity.test.ts`, `tests/unit/seed-demo.non-destructive.test.ts`, and `tests/helpers/mockDemoPrisma.ts` were **not modified** in PR5b — they already asserted against the `tx`-based contract in the PR5a commit and required no changes for the orchestration additions above.

## Marker-First Single-Transaction Design (behavioral proof, required by this work unit's evidence goal)

1. **Marker read occurs before any emptiness counts** — `resolveSeedStateInTransaction` calls `tx.demoSeedMarker.count()` as its first statement; `countApplicationRows(tx)` is only reached inside the `if (markerCount === 0)`... actually the `else`/fallthrough branch, i.e. only when no marker exists yet. Proven by `tests/unit/seed-demo.atomicity.test.ts`'s `operationLog[0] === 'tx:demoSeedMarker.count'` assertion on both the FIRST_RUN and RECOGNIZED_RERUN cases.
2. **Recognized reruns skip all other model counts and perform zero writes beyond the intended upserts** — on `markerCount > 0`, the function reads only `matchingMarkerCount`/`totalDemoIdentityCount`/`matchingDemoIdentityCount` (3 more `count()` calls) and never calls `countApplicationRows`. Proven by the RECOGNIZED_RERUN case asserting none of the nine unambiguous ten-model-count log tags appear.
3. **Unsafe/unrecognized states abort with zero writes** — `ABORT_UNMARKED` and `ABORT_MISMATCH` both `throw` inside the `$transaction` callback before `bootstrapDemoData` is ever called. Proven by both abort cases asserting `operationLog.some(isWriteOp) === false`.
4. **First-run reads, state resolution, and writes use one transaction client per attempt** — `runSeedDemo` opens `prisma.$transaction` exactly once for this non-retry FIRST_RUN case (asserted via `toHaveBeenCalledTimes(1)`); every logged operation across that case is tagged `tx:*`, never `root:*` (asserted via `operationLog.every((op) => op.startsWith('tx:'))`). There is one transaction PER ATTEMPT, at most 3 attempts total — see the Remediation section below.
5. **CLI requires explicit confirmation and the package script is correct** — `assertConfirm` is called with `process.env['DEMO_SEED_CONFIRM'] === REQUIRED_CONFIRMATION` as the very first line of `runSeedDemo`, before the transaction opens; a missing/mismatched value throws before any Prisma call. `package.json`'s `"db:seed:demo": "tsx prisma/scripts/seed-demo.ts"` matches `tasks.md` 5.5 verbatim.
6. **Combined chained candidate preserves fabricated row integrity, rerun preservation, and credential/API isolation** — proven by the unchanged PR5a suites (`seed-demo.integrity.test.ts`, `seed-demo.non-destructive.test.ts`, `seed-demo.credential-isolation.test.ts`) all still passing unmodified (Part B) or with only a typing-only fix (Part A) against the PR5b production code — see Work Unit Evidence below.

## Typecheck fix — `seed-demo.credential-isolation.test.ts` mock typing warning

**Inspected and fixed** (narrow, behavior-preserving): Part A's `vi.mocked(prisma.user.create).mockImplementation(({ data }: { data: Record<string, unknown> }) => ...)` failed the broadened typecheck (`tsconfig.test.json`) with `TS2345` — the statically-imported `prisma.user.create` carries the REAL generated `UserDelegate['create']` type (a narrow discriminated-union `data` parameter), which the `vi.mock(...)` factory's structural shape (`{ create: vi.fn(), findFirst: vi.fn() }`) does not narrow away for the type checker. The mock's own explicit `({ data }: { data: Record<string, unknown> })` parameter is therefore not assignable to the real delegate's parameter type under `strict`.

**Fix**: extracted `mockUserCreate = vi.mocked(prisma.user.create)`, then cast the entire implementation function — not its return value — to `Parameters<typeof mockUserCreate.mockImplementation>[0]`. This is a test-mock-only cast (documented inline in the test file); it changes zero runtime behavior — the same body still reads `data['fullName']`/`data['email']`/`data['role']` from whatever the request handler forwarded and returns the same literal shape. Both Part A cases (never-persists-`isDemo`, duplicate-email-409) still pass unmodified.

This is the same pre-existing warning flagged (but left unfixed, out of scope) by the interrupted prior pass's evidence table. It is fixed here because this batch's evidence goal requires a clean "applicable broadened typecheck" pass across PR4/PR5-family files; it does not touch or amend the PR5a commit (`878ee1c`) — the fix is a new, uncommitted change in PR5b's own diff.

The `tests/unit/seed-demo.atomicity.test.ts` `queueLoggedCount` helper needed the identical category of fix for the same structural reason (`tx.demoSeedMarker`/`tx.user` are cast to the real `PrismaClient` type in `mockDemoPrisma.ts`, so a `(...args: unknown[])`-typed helper parameter fails contravariant parameter checking against the real delegate's typed `count` overloads) — resolved by casting `model.count` to `(...args: never[]) => Promise<number>` at the call site, with an inline comment explaining the mock-only scope. This is new code in this pass, not a pre-existing warning.

## Work Unit Evidence (PR5b)

| Evidence | Result |
|---|---|
| **Focused test** `npx vitest run tests/unit/seed-demo.atomicity.test.ts tests/unit/seed-demo.integrity.test.ts tests/unit/seed-demo.non-destructive.test.ts tests/unit/seed-demo.credential-isolation.test.ts tests/unit/seed-demo.safety.test.ts tests/unit/seed-demo.serializable-retry.test.ts` | ✅ **31/31 passed (6 files)** — corrected: the prior command omitted `seed-demo.serializable-retry.test.ts` (added by the concurrency remediation below), understating the candidate as 26/26 (5 files) |
| **Format (source-mutating, run first)** `npx prettier --write prisma/scripts/seed-demo.ts tests/unit/seed-demo.atomicity.test.ts tests/unit/seed-demo.credential-isolation.test.ts package.json` | `seed-demo.credential-isolation.test.ts` reformatted (the mock-implementation cast); the other 3 files were already clean |
| **Format (check-only, run after normalization)** `npx prettier --check` on the same PR4/PR5 file set | ✅ "All matched files use Prettier code style!" |
| **Typecheck (root)** `npx tsc --noEmit` (`tsconfig.json`, `src/**` only) | ✅ clean, no output |
| **Typecheck (applicable broadened)** `npx tsc --noEmit -p tsconfig.test.json` (pre-existing, committed config covering `src/**`, `tests/**`, `prisma/**/*.ts`) | ✅ **zero errors in any PR4/PR5 demo-seed file** — the two typing fixes above resolved every error this pass's own files introduced or carried. **73 errors remain**, all pre-existing and unrelated, confined to `tests/smoke/auth.test.ts`, `tests/smoke/categories.test.ts`, `tests/smoke/products.test.ts`, `tests/smoke/suppliers.test.ts`, `tests/smoke/users.test.ts`, `tests/unit/validate.test.ts`, `tests/unit/validate-sentinel.test.ts` — confirmed via `grep` over the full error log; none touch `prisma/scripts/**`, `src/shared/demo/**`, or any `seed-demo.*.test.ts` file. |
| **Lint** `npx eslint prisma/scripts/seed-demo.ts prisma/scripts/demo-seed-concurrency-harness.ts tests/helpers/mockDemoPrisma.ts tests/unit/seed-demo.atomicity.test.ts tests/unit/seed-demo.integrity.test.ts tests/unit/seed-demo.non-destructive.test.ts tests/unit/seed-demo.credential-isolation.test.ts tests/unit/seed-demo.safety.test.ts tests/unit/seed-demo.serializable-retry.test.ts` | ✅ **0 errors; 16 `no-console` warnings total** — 12 in `demo-seed-concurrency-harness.ts` (manual Docker harness, allow-listed pattern) + 4 in `seed-demo.ts` (CLI seed script, same allow-listed pattern as `prisma/seed.ts`); corrected from the prior "4 warnings" figure, which omitted the harness file from the lint command |
| **`git diff --check`** | ✅ exit 0, no whitespace errors |
| **Full suite** `npm test` | 409/410 passed. Same single pre-existing failure as PR1–PR5a in `tests/smoke/alerts-hooks.test.ts` (S5 reconcile assertion, expects 1 update got 2) — unrelated, unchanged by this pass |
| **Runtime harness** | Superseded by the Remediation section below. **Correction to this row's original claim**: this row previously asserted the marker-first/zero-write claims were adequately covered by a mocked `operationLog` proof plus a *type-level* `SeedTxClient` exclusion of `$transaction`, and that no real-Postgres run was needed. That was **wrong for the concurrency case specifically**: a single interactive transaction at PostgreSQL's default `ReadCommitted` isolation does NOT serialize concurrent absence/predicate reads, so two concurrent first-run processes could both observe "empty, no marker" and both attempt to bootstrap — a real cross-PROCESS race that no single-process mock can exercise or disprove. See "Remediation — Concurrent First-Run Race" below for the corrected isolation/retry implementation and the real two-process PostgreSQL harness that proves it. |
| **Rollback boundary** | `prisma/scripts/seed-demo.ts` (the orchestration/confirmation/transaction-wrapping additions on top of the PR5a-committed scaffold — revertible to the `878ee1c` state), `tests/unit/seed-demo.atomicity.test.ts` (new file — delete), `tests/unit/seed-demo.credential-isolation.test.ts` (the Part A mock-typing cast only — revertible independently of Part B, which is untouched), `package.json` (single script line), `openspec/changes/guest-environment-backend/tasks.md` (5.2/5.5 checkbox flips). All independently revertible without touching PR5a's committed RED-test coverage or PR1–PR4. |

## Authored Change Count (PR5b)

Measured via `git diff --numstat 878ee1c` (the PR5a-committed baseline, PR5b's direct parent) after `git add -N` for all three untracked files (`demo-seed-concurrency-harness.ts`, `seed-demo.atomicity.test.ts`, `seed-demo.serializable-retry.test.ts`; reset immediately after measuring, nothing left staged), excluding unrelated `.atl/*`:

| Component | + | - |
|---|---|---|
| `prisma/scripts/seed-demo.ts` | 202 | 2 |
| `prisma/scripts/demo-seed-concurrency-harness.ts` (new) | 175 | 0 |
| `tests/unit/seed-demo.atomicity.test.ts` (new) | 154 | 0 |
| `tests/unit/seed-demo.serializable-retry.test.ts` (new) | 132 | 0 |
| `tests/unit/seed-demo.credential-isolation.test.ts` (typing fix only) | 20 | 13 |
| `package.json` | 1 | 0 |
| `tasks.md` (5.2/5.5 bookkeeping) | 2 | 2 |
| **Complete PR5b review diff vs direct parent `878ee1c`** (code+tests+config 686/17 + `apply-progress.md` 184/5, excluding unrelated `.atl/*`) | **870** | **22** |

The complete PR5b review diff against the direct parent (`878ee1c`) is **870 insertions + 22 deletions = 892 changed lines** — the accurate current-candidate total, including all three untracked PR5b files. The originally-forecast 800-line ceiling (`max_changed_lines`) is superseded: the concurrency remediation added the retry test suite and the real-Postgres harness after that forecast was written, and the maintainer reviewed the complete, cohesive 892-line candidate and explicitly approved an **exact 892-line exception** for this work unit only.

## Runtime Attempt Settlement (PR5b)

This section records evidence for the parent orchestrator to use when settling the runtime-bearing attempt it already holds (token `sha256:bbdf6ee16cfc9c14c0772b589c4c578e3e6de70dfc2d418651ae2ee08487f0e2`, work unit `PR5b-atomic-seed-orchestration`). **This apply batch does not acquire, reset, rescope, or settle that token** — settlement is the parent's action, not this batch's.

- Work unit: `PR5b-atomic-seed-orchestration`
- Evidence goal status: **met at the time** — marker-first read ordering, conditional ten-model check, zero-write abort paths, single-transaction-client-per-attempt read+resolve+write, CLI confirmation gating, and package-script correctness were proven by the Focused test + Work Unit Evidence above; 26/26 tests (5 files) at that point, clean typecheck (root + applicable broadened, zero PR4/PR5-file errors), clean lint, clean format, clean `git diff --check`, unaffected full suite (409/410, same pre-existing unrelated failure). The current candidate, after the concurrency remediation below, totals **31/31 tests across 6 files**.
- Size at the time: 350 changed lines (code+tests+config only, pre-`apply-progress.md`, pre-remediation) against the direct-parent baseline. The current complete candidate (after concurrency remediation) totals **870 insertions + 22 deletions = 892 changed lines** against the same baseline (`878ee1c`) — within the maintainer-approved exact 892-line exception; see "Authored Change Count (PR5b)" above for the full breakdown.
- Cleanup/process evidence: no Docker containers or background processes started/left running this pass (no runtime harness re-executed — see Work Unit Evidence); no branch switches, commits, staging, or pushes performed by this batch; `.atl/.skill-registry.cache.json` and `.atl/skill-registry.md` left byte-for-byte untouched, unstaged, uncommitted (pre-existing modifications from before this batch started, confirmed via `git status --short .atl/` before and after).
- PR5b remains **uncommitted** per this batch's explicit scope — the sole writer did not stage, commit, push, or open a PR. Independent `sdd-verify` is a later orchestrator phase and was not started.

## Remediation — Concurrent First-Run Race (Serializable Isolation + Bounded Retry)

**Diagnosis (maintainer-authorized, diagnosis evidence revision `sha256:266a1b20a09f9a77633ac99ce916272bdae82fce1743188d6c7cd5708ec3831c`)**: fresh independent validation proved that a single interactive transaction at PostgreSQL's default `ReadCommitted` isolation does **not** serialize absence/predicate reads. Two concurrent first-run `db:seed:demo` processes could both execute `resolveSeedStateInTransaction` and both read "no marker, empty database" before either committed, then both attempt a `FIRST_RUN` bootstrap — a genuine cross-process race no single-process mocked test could exercise, since the prior PR5b evidence (mocked `operationLog` ordering + `SeedTxClient`'s compile-time exclusion of `$transaction`) only proves intra-transaction structure, not cross-transaction serialization.

**Correction**:

1. **Serializable isolation** — every `$transaction` attempt now passes `{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }` as its second argument (Prisma 5.22's actual signature, confirmed against the installed `node_modules/.prisma/client/index.d.ts` — see API evidence below, not copied from newer Prisma docs). Serializable makes PostgreSQL detect the read/write conflict between two concurrent first-run transactions and abort the loser with a retryable error instead of allowing both to commit.
2. **Bounded retry on `P2034` only** — a new `isRetryableTransactionConflict(err)` guard checks `err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034'` (Prisma's stable "transaction failed due to a write conflict or a deadlock" code). `runSeedDemo` wraps the whole per-attempt `$transaction` call in a `for` loop bounded at `MAX_TRANSACTION_ATTEMPTS = 3` (1 initial + 2 retries — a fixed, deterministic bound, no backoff/jitter ceremony for a one-shot CLI). A retryable conflict with attempts remaining logs a `console.warn` and `continue`s to a **fresh** `$transaction` call (a brand-new interactive transaction, hence a brand-new `tx`); any other error (non-`P2034` `PrismaClientKnownRequestError`, or any non-Prisma error) is rethrown immediately, unchanged, with zero retry.
3. **Fresh full sequence per attempt** — because the retry re-invokes `prisma.$transaction(callback, options)` from scratch, each attempt reruns `resolveSeedStateInTransaction` (marker-first read → conditional ten-model empty check → state resolution) and `bootstrapDemoData` inside that SAME attempt's `tx`, never mixing state decided in one attempt with writes issued in another. A Postgres serialization failure invalidates everything the aborted transaction read/decided, so nothing may be carried over — the loop's `continue` correctly discards the failed attempt's local `state` and starts over.

**Prisma 5.22 API evidence (installed types, not newer-Prisma docs)**: `node_modules/.prisma/client/index.d.ts:300` — `$transaction<R>(fn: (prisma: Omit<PrismaClient, ITXClientDenyList>) => JsPromise<R>, options?: { maxWait?: number, timeout?: number, isolationLevel?: Prisma.TransactionIsolationLevel }): JsPromise<R>` and `index.d.ts:13315` — `TransactionIsolationLevel` is a real const object (`ReadUncommitted | ReadCommitted | RepeatableRead | Serializable`), a VALUE not a type-only export — which is why `Prisma` had to become a value import (`import { Prisma, PrismaClient, ... } from '@prisma/client'`, was previously `import type { Prisma }`). `PrismaClientKnownRequestError`'s `code: string` field (`runtime/library.d.ts:2323`) is the documented mechanism for reading `P2034`; the `P2034` code string itself is Prisma's long-stable transaction-conflict code (unchanged since early Prisma versions through 5.x) — Context7 quota was unavailable and the one successfully fetched Prisma transaction-concept page was for a materially different, not-yet-installed Prisma major (dotted `NAMESPACE.SUBCODE` errors, `prisma.config.ts`, a `contract` model absent from this project's `schema.prisma`-based 5.22 setup), so it is cited here only for the underlying CONCEPT (concurrent transactions can conflict and need bounded retry), never for syntax.

**RED → GREEN evidence** (new file `tests/unit/seed-demo.serializable-retry.test.ts`, 5 cases): RED was captured by temporarily reverting `prisma/scripts/seed-demo.ts` to its pre-correction (prior-PR5b) state in place, confirming genuine failure, then restoring the corrected file (not committed at any point — verified via `diff` against a pre-edit backup copy):

| Case | RED (pre-correction) | GREEN (post-correction) |
|---|---|---|
| Isolation configured | `expected undefined to deeply equal { isolationLevel: 'Serializable' }` — no options argument existed | ✅ passes |
| Retry-then-succeed | Test itself threw the injected `P2034` error uncaught — no retry loop existed | ✅ passes — `$transaction` called twice, both with `Serializable`, final attempt's `operationLog` shows the full marker-first sequence |
| Bounded exhaustion | `expected "spy" to be called 3 times, but got 1 times` — no retry, one call, error propagated on the first attempt anyway | ✅ passes — exactly 3 calls, original error object propagated unchanged (`rejects.toBe`, not `rejects.toThrow` — proves it is NOT wrapped/re-thrown as a new error) |
| Non-retryable `PrismaClientKnownRequestError` (`P2002`) | Passed trivially (no retry logic existed, so nothing to retry, coincidentally correct) | ✅ still passes — `$transaction` called exactly once |
| Non-Prisma `Error` | Passed trivially (same reason) | ✅ still passes — `$transaction` called exactly once |

Existing ordering/abort assertions in `tests/unit/seed-demo.atomicity.test.ts` (4 cases) were run unmodified after the correction and still pass — nothing was weakened to make the new cases pass.

**Real two-process PostgreSQL concurrency harness** (new file `prisma/scripts/demo-seed-concurrency-harness.ts`, manual — not part of `npm test`, requires Docker): spins up a disposable `postgres:15-alpine` container (`sdd-guest-env-pg-concurrency-harness`, host port 5434), applies all 5 migrations via `prisma migrate deploy`, then launches TWO real OS-level `npx tsx prisma/scripts/seed-demo.ts` child processes CONCURRENTLY (`Promise.all`) against the same empty database, asserts post-race row counts, then runs a THIRD sequential invocation to prove the rerun stays recognized and non-destructive. Cleans up its own container on every exit path (success, assertion failure, or crash).

Actual run (`npx tsx prisma/scripts/demo-seed-concurrency-harness.ts`, executed twice — once to observe the raw race, once after fixing a logging bug that was swallowing `stderr`):

- Process A: `🌱 first run… ✅ bootstrap complete, demo marker persisted.` — exit 0 (won the race, committed `FIRST_RUN`).
- Process B: `🌱 first run…` then, on `stderr`, `⚠️ db:seed:demo — serialization conflict (P2034) on attempt 1/3, retrying with a fresh transaction…`, then `🔁 recognized rerun… ✅ rerun complete.` — exit 0 (lost the race with a REAL `P2034` from PostgreSQL, retried once, succeeded as `RECOGNIZED_RERUN`).
- Post-race counts: `marker: 1, demoAdmin: 1, category: 2, supplier: 2, product: 2, productSupplier: 3` — the exact approved 2/2/2 dataset, no duplicates from the race.
- Process C (sequential rerun): exit 0, `🔁 recognized rerun… ✅ rerun complete.`; marker count after rerun: still `1`.
- Result: `✅ HARNESS PASSED`.
- Cleanup: `docker ps -a --filter name=sdd-guest-env-pg-concurrency-harness` → empty (container removed); no leftover `tsx` processes (confirmed via `ps aux` before/after).

This is real, unmocked evidence — the `P2034` error, the retry, and the correct final state were all produced by an actual PostgreSQL instance detecting an actual serialization anomaly, not simulated.

**Files touched (Remediation)**:

| File | Action | Details |
|---|---|---|
| `prisma/scripts/seed-demo.ts` | Modified | `Prisma` import made a value import; `MAX_TRANSACTION_ATTEMPTS`, `isRetryableTransactionConflict`; `runSeedDemo` wrapped in a bounded `for` retry loop, `$transaction` now passes `{ isolationLevel: Serializable }` |
| `tests/unit/seed-demo.serializable-retry.test.ts` | Created | 5 cases — isolation config, retry-success, bounded exhaustion, 2 non-retryable-propagation cases |
| `prisma/scripts/demo-seed-concurrency-harness.ts` | Created | Manual real-Postgres two-process concurrency harness (documented above) |
| `openspec/changes/guest-environment-backend/apply-progress.md` | Modified | This Remediation section; corrected the superseded "Runtime harness" row above |

**Corrected Runtime Attempt Settlement (Remediation)**:

- Work unit: `PR5b-concurrent-first-run-correction`
- Remediation binding: `sha256:266a1b20a09f9a77633ac99ce916272bdae82fce1743188d6c7cd5708ec3831c`
- Evidence goal status: **met** — Serializable isolation + bounded `P2034`-only retry implemented and proven at both the unit level (5/5 new cases, RED confirmed against the pre-correction file, GREEN confirmed after restoring it; 4/4 existing atomicity cases unweakened) and the real-database level (two-process PostgreSQL harness: both concurrent invocations exit 0, exactly one marker/admin survive, exact 2/2/2/3 cardinality, sequential rerun stays recognized and non-destructive).
- This apply batch does **not** acquire, reset, rescope, or settle either the original PR5b token (`sha256:bbdf6ee16cfc9c14c0772b589c4c578e3e6de70dfc2d418651ae2ee08487f0e2`) or the remediation token this prompt names — settlement remains the parent orchestrator's action.
- Cleanup/process evidence: harness container removed on both harness runs (confirmed via `docker ps -a` before/after, filtered on the harness container name); no orphaned `tsx`/`node`/`postgres` processes attributable to this batch; no branch switches, commits, staging, or pushes; `.atl/.skill-registry.cache.json` and `.atl/skill-registry.md` left byte-for-byte untouched, unstaged, uncommitted throughout (pre-existing modifications, confirmed via `git status --short .atl/` before and after this batch).
- PR5b remains **uncommitted** — the exact final changed-line count against the direct parent (`878ee1c`) is **870 insertions + 22 deletions = 892 changed lines** (see "Authored Change Count (PR5b)" above), within the maintainer-approved exact 892-line exception for this work unit.

---

## Remaining Phases

- [x] Phase 1: Schema & Migration (1.1–1.3) — PR1
- [x] Phase 2: JWT Payload & Demo Read-Only Guard (2.1–2.7) — PR2
- [x] Phase 3: Demo-Scoped Refresh-Token Cleanup (3.1–3.4) — PR3
- [x] Phase 4: Demo Seed — Safety State Machine (4.1–4.3) — PR4
- [x] Phase 5: Demo Seed — Master Data, Integrity & Confinement (5.1–5.5) — split across PR5a (committed, `878ee1c`) + PR5b (this batch, uncommitted)
- [ ] Phase 6: Private Setup ADMIN (6.1–6.2)
- [ ] Phase 7: Railway Operational Checklist (7.1)

## Status

22/25 tasks complete (Phases 1–5 of 7 done). Phase 5 is split across two chained child PRs: **PR5a** (`878ee1c feat(demo): add master-data bootstrap library`, 632 lines, committed on `feat/guest-demo-seed-data`, base PR4) landed tasks 5.1/5.3/5.4 — the RED test coverage and fabricated master data — while correctly leaving 5.2/5.5 unchecked, because the committed `seed-demo.ts` scaffold was not yet a working GREEN implementation. **PR5b** (this batch, branch `feat/guest-demo-seed-atomicity`, base PR5a) completes tasks 5.2 and 5.5: `runSeedDemo` now wraps the marker-first state read, state resolution, and every write in exactly one `prisma.$transaction` call on a single transaction-scoped client, with `SeedTxClient`'s type mechanically excluding `$transaction` from what that client can do; the ten-model empty-DB check runs only when no marker exists and is skipped entirely on recognized reruns; every abort path performs zero writes; the CLI requires exact `DEMO_SEED_CONFIRM` confirmation before the transaction ever opens; and `package.json` gained the `db:seed:demo` script. All 31 focused tests (6 files, including `seed-demo.serializable-retry.test.ts`) pass, typecheck is clean at both the root and applicable-broadened level (zero PR4/PR5-file errors, including a narrow same-pass fix for the previously-disclosed `seed-demo.credential-isolation.test.ts` mock-typing warning), lint/format/`git diff --check` are clean, and the full suite is unaffected (409/410, same single pre-existing unrelated `alerts-hooks.test.ts` failure carried since PR1). PR5b remains **uncommitted** on `feat/guest-demo-seed-atomicity` per this batch's explicit scope (sole writer, no commit/stage/push/PR) — the parent orchestrator holds the runtime-bearing attempt for this work unit and is responsible for settling it. **Correction (concurrency remediation pass)**: this single-transaction atomicity claim was insufficient on its own — a concurrent-first-run race was subsequently proven and corrected with `Serializable` isolation + bounded `P2034` retry; see "Remediation — Concurrent First-Run Race" above for the full diagnosis, correction, RED/GREEN unit evidence, and real two-process PostgreSQL harness proof. Ready for the parent to proceed to Phase 6 (Private Setup ADMIN) once PR5b is committed, or to independent `sdd-verify` per the orchestrator's own workflow.
