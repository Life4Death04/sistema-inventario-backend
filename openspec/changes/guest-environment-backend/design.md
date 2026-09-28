# Design: Guest (Demo) Environment — Backend

## Technical Approach

Additive `User.isDemo` carried through the one-decode JWT; read-only demo enforced at the single `authenticate` chokepoint via extracted `assertMutationAllowed(req)`; one demo-scoped `RefreshToken` prune after issuance; a non-destructive, transactional, idempotent master-data bootstrap (`db:seed:demo`) gated by a two-input safety state machine. **Demo-seed-first** deploy order: `migrate:deploy → db:seed:demo → db:seed → manual transactional setup → public-demo verification`, so `db:seed:demo` proves a truly empty application DB on first run before `db:seed` adds the private setup ADMIN. The seed NEVER writes transactional tables (`InventoryMovement`, `Alert`, `ReplenishmentRequest`, `ReplenishmentRequestItem`) and NEVER touches existing `Product.stock`. Maps to proposal Approach 1 and both corrected delta specs.

## Architecture Decisions

| Decision | Choice | Alternatives | Rationale |
|---|---|---|---|
| Guard placement | Extract `assertMutationAllowed(req)`; call inside `authenticate` after `req.user` set | Per-route guard; global `app.ts` guard | `authenticate` is provably first middleware everywhere; single-file diff, no missed-route hole, no double-decode |
| Safe methods | Allow `GET`/`HEAD`/`OPTIONS`; else 403 `DEMO_READ_ONLY` | Per-route allowlist | Universal, stateless; `cors()` short-circuits `OPTIONS` preflight |
| Stale token | `verifyAccessToken` defaults missing `isDemo` to `false` | Reject / treat-as-demo | Prevents mid-session lockout; 15m TTL bounds window |
| Cleanup tx | Single `deleteMany` of dead rows AFTER new row committed | Wrap issuance+prune in `$transaction` | Prune removes only dead rows; must not roll back a successful login (failure logged, login still succeeds); concurrent live sessions survive |
| Seed writes | Master data only, upsert by natural key; no transactional writes, no stock writes | Delete/recreate | Corrected specs forbid touching stock and transactional tables |
| Persisted marker | Dedicated `DemoSeedMarker` model (single row) | Overload demo email; DB-name substring | Independently checkable sentinel, survives user edits, orthogonal to identity; substring matching banned by spec |
| Setup ADMIN `isDemo` | `seed.ts` upsert sets `isDemo:false` in BOTH `create` and `update` | Rely on column default | Default only applies on insert; explicit `update` write stops a rerun converting it to demo |

## Data Flow

    login/refresh → read User → sign(isDemo) → create RefreshToken → [isDemo? pruneDeadRefreshTokens(userId)] → respond

Canonical seed state machine (single `$transaction`, marker read FIRST):

    assertConfirm(env DEMO_SEED_CONFIRM === literal) ──mismatch/missing──▶ ABORT, zero writes
      │ ok
    readState: markerExists? then (only if NO marker) appEmpty?
      ├ no marker & empty     → FIRST RUN: atomically create DemoSeedMarker + public demo ADMIN + master data
      ├ marker present        → RERUN (recognized): SKIP empty-check; validate exactly one marker/version + one
      │                         isDemo=true public-email ADMIN; non-destructive master-data upsert only.
      │                         Tolerates private setup ADMIN (isDemo=false) + manual txn data (expected post-bootstrap)
      └ no marker & non-empty  → ABORT, zero writes (unsafe unmarked target)

`migrate:deploy` creates `User.isDemo` + EMPTY `DemoSeedMarker` table (no marker row), so first-run empty check passes before `db:seed`; later reruns are marker-recognized and skip it.

## File Changes

| File | Action | Description |
|---|---|---|
| `prisma/schema.prisma` | Modify | Add `isDemo Boolean @default(false)` + `@@index([isDemo])` on `User`; add `DemoSeedMarker` model |
| `prisma/migrations/<ts>_add_user_is_demo_and_demo_marker/migration.sql` | Create | `ADD COLUMN` NULL→backfill `false`→`SET NOT NULL DEFAULT false`; `CREATE INDEX`; `CREATE TABLE "DemoSeedMarker"` (style per `add_entity_status`) |
| `src/modules/auth/auth.service.ts` | Modify | `signAccessToken(userId, role, isDemo)`; `AccessTokenPayload.isDemo`; `verifyAccessToken` returns `isDemo` default `false` |
| `src/modules/auth/auth.controller.ts` | Modify | Pass `user.isDemo` at both sign sites; call prune for demo users after new row |
| `src/modules/auth/auth.repository.ts` | Modify | `pruneDeadRefreshTokens(userId)` = `deleteMany({ where:{ userId, OR:[{revoked:true},{expiresAt:{lt:new Date()}}] }})` |
| `src/shared/middleware/authenticate.ts` | Modify | Set `isDemo`; call `assertMutationAllowed(req)` |
| `src/shared/middleware/assertMutationAllowed.ts` | Create | Named policy fn (safe-method set + 403) |
| `src/types/express.d.ts` | Modify | `req.user.isDemo: boolean` |
| `src/shared/errors/errorCodes.ts` | Modify | Add `DEMO_READ_ONLY` (403) |
| `prisma/seed.ts` | Modify | Persist `isDemo:false` on setup ADMIN in both `create` and `update` |
| `prisma/scripts/seed-demo.ts` | Create | Non-destructive master-data bootstrap + marker state machine |
| `src/shared/demo/demoCredentials.ts` | Create | Committed public constants (`DEMO_ADMIN_EMAIL`, `DEMO_ADMIN_PASSWORD`, `DEMO_MARKER_VERSION`) |
| `package.json` | Modify | `db:seed:demo` tsx script |
| `openspec/changes/guest-environment-backend/railway-demo-checklist.md` | Create | Operational checklist |
| `tests/**` | Modify/Create | See Testing Strategy; add `isDemo:false` to `User` fixtures |

## Interfaces / Contracts

```ts
export interface AccessTokenPayload { sub: string; role: UserRole; isDemo: boolean; iat: number; exp: number }
export function assertMutationAllowed(req: Request): void // throws AppError(DEMO_READ_ONLY,403) when isDemo && !SAFE.has(method)
```

```prisma
model DemoSeedMarker {
  id        String   @id @default(cuid())
  version   String   // matches DEMO_MARKER_VERSION; mismatch fails closed
  createdAt DateTime @default(now())
}
```

- **Credentials/confinement**: committed public constants; seed bcrypt-hashes `DEMO_ADMIN_PASSWORD` (cost 10) at write time. Confinement is structural — `createUserSchema` (`z.object`) strips unknown keys, so no `POST /api/users` path sets `isDemo:true`; only `seed-demo.ts` writes that flag.
- **Upserts** by real unique keys: `Category.name`, `Product.code`, `Supplier.rif`, `ProductSupplier @@unique([productId, supplierId])`, public ADMIN by `User.email`. `Supplier.rif` is nullable+unique, so every fabricated supplier gets a deterministic non-null RIF (`J-<seq>`) for stable upsert. New products use `stock:0`; the **Product update payload OMITS `stock`** and writes no transactional tables, so reruns preserve manual stock/history.
- **Recognition (fail-closed)**: uses only the `DemoSeedMarker` row, evaluated FIRST. Rerun allowed iff confirmation matches AND exactly one marker with matching `version` AND exactly one `isDemo=true` public-email ADMIN. Recognized rerun does NOT re-run the empty-DB check — it tolerates the private setup ADMIN (`isDemo=false`) and manual movements/alerts/replenishment (expected post-bootstrap). Refuses (zero writes) on marker/version mismatch, missing/altered public identity, or multiple demo identities. No PII classification; assurance rests on physical DB isolation + checklist.
- **Empty application DB (FIRST-RUN ONLY)** = zero rows across every application model (`User`, `RefreshToken`, `Category`, `Product`, `Supplier`, `ProductSupplier`, `InventoryMovement`, `Alert`, `ReplenishmentRequest`, `ReplenishmentRequestItem`, `DemoSeedMarker`); `_prisma_migrations` excluded. Applied ONLY when no marker exists; NEVER on a recognized rerun. Empty check then all writes run inside one `$transaction` with explicit sequential `count` ordering for race-safety.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Unit | `assertMutationAllowed` safe vs unsafe; stale-token default | Vitest, mock `Request` |
| Unit | `sign`/`verifyAccessToken` carry `isDemo`; missing→false | Extend `auth.service.test.ts` |
| Integration | GET allowed; POST/PUT/PATCH/DELETE→403; non-demo unaffected; demo login/refresh/logout usable | supertest, mocked prisma |
| Integration | Prune deletes only dead rows; concurrent live sessions survive; non-demo skipped; cleanup-failure→success+log | mock `deleteMany` throw |
| Seed safety | First-run (no marker) empty+confirm→marker+public ADMIN+master data; non-empty unmarked→abort zero writes; recognized rerun (marker) SKIPS empty check and upserts even with setup ADMIN + manual txn rows; missing/mismatch confirm→abort zero writes; version/identity mismatch→fail closed | mocked prisma, assert no write calls |
| Seed non-destructive | Rerun: `Product.stock` snapshot unchanged; four transactional tables' counts+contents unchanged; update payload asserted to omit `stock` | before/after snapshots |
| Seed identity | Exactly one `isDemo=true` public ADMIN; every other user `isDemo=false`; new products `stock=0` | integrity test |
| Credential confinement | `POST /api/users` with `isDemo:true`/public email never persists `isDemo:true`; duplicate email→`CONFLICT` | supertest |
| Migration/Setup | Existing rows→`isDemo=false`; setup ADMIN rerun keeps `isDemo=false`; deploy order `db:seed:demo` before `db:seed` — recognized rerun tolerates setup ADMIN + manual txn data (no abort) | migration + seed test |

## Threat Matrix

CLI seed does DB writes only (no shell/subprocess/VCS/routing/file classification).

| Boundary | Applicability | Response | RED test |
|---|---|---|---|
| Documentation-like paths | N/A — no file classification/execution | — | — |
| Git repository selection | N/A — no VCS in seed | — | — |
| Commit/Push state | N/A — no VCS | — | — |
| PR commands | N/A — no PR automation | — | — |
| Unsafe seed target (added) | Applicable | Writes only when confirmation matches AND (first-run: no marker AND empty DB — demo-seed-first order guarantees this) OR (recognized rerun: valid `DemoSeedMarker`, empty check SKIPPED); unmarked non-empty or marker/identity mismatch aborts zero writes; never destructively repairs | Seed vs non-empty unmarked DB and vs version-mismatched marker both abort, mutate nothing; recognized rerun with setup ADMIN + manual txn rows still upserts without abort |

## Migration / Rollout

Sequence (maintainer-approved, demo-seed-first): `migrate:deploy` → `db:seed:demo` → `db:seed` → manual transactional setup (private setup ADMIN `isDemo=false`, then movements/alerts/replenishment) → public-demo verification. Safe because `migrate:deploy` leaves the marker table empty, so first-run empty check passes before `db:seed` adds the setup ADMIN; later reruns are marker-recognized, skip the empty check, tolerate setup ADMIN + manual data. **Rollback**: revert code (guard removal alone restores prior behavior); drop-column + drop `DemoSeedMarker` migration reverses schema (additive, no data loss). Combined diff >400 lines → tasks phase slices. Conceptual work units (tasks compute exact): (1) schema+migration+marker model, (2) JWT+guard+tests, (3) prune, (4) `db:seed:demo` safety state machine (first-run gate + fail-closed rerun recognition), (5) `db:seed:demo` master data + public identity + non-destructive/identity/credential confinement, (6) `db:seed` setup-ADMIN `isDemo=false` persistence, (7) checklist. Demo-seed-first order sequences (5) before (6) at deploy time; each unit stays independently testable with its own tests and revert.

## Open Questions

- [ ] None blocking. Marker is a dedicated `DemoSeedMarker` model (schema/migration impact accepted); recognition is orthogonal to identity and fails closed.
