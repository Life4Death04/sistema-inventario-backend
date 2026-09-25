# Apply Progress: guest-environment-backend — PR1 (Phase 1: Schema & Migration)

<!-- Updated by sdd-apply | correction pass — PR1 apply-progress bookkeeping -->

## Chain Strategy

- feature-branch-chain (resolved, `ask-on-risk`)
- Tracker branch: `feat/guest-environment-backend` (draft, no-merge; holds final integration)
- PR1 (base: tracker) → Schema + migration + marker — **this work unit**
- PR2 (base: PR1) → JWT `isDemo` + demo read-only guard
- PR3 (base: PR2) → Demo-scoped refresh-token cleanup
- PR4 (base: PR3) → Seed safety state machine (pure)
- PR5 (base: PR4) → Seed bootstrap + master data + integrity + confinement
- PR6 (base: PR5) → Private `seed.ts` `isDemo:false`
- PR7 (base: PR6) → Railway operational checklist

## Phase 1 Task Checklist ✅ COMPLETE (this batch)

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

## Remaining Phases

- [ ] Phase 2: JWT Payload & Demo Read-Only Guard (2.1–2.7)
- [ ] Phase 3: Demo-Scoped Refresh-Token Cleanup (3.1–3.4)
- [ ] Phase 4: Demo Seed — Safety State Machine (4.1–4.3)
- [ ] Phase 5: Demo Seed — Master Data, Integrity & Confinement (5.1–5.5)
- [ ] Phase 6: Private Setup ADMIN (6.1–6.2)
- [ ] Phase 7: Railway Operational Checklist (7.1)

## Status

3/25 tasks complete (Phase 1 of 7 done). At apply completion, changes were left uncommitted. The version-control handoff places this work unit on `feat/guest-environment-schema`, based on tracker `feat/guest-environment-backend`; commit and delivery remain outside SDD apply. Ready for independent SDD verification or the next apply batch (Phase 2), pending orchestrator direction.
