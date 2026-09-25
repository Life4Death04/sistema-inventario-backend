# Proposal: Guest (Demo) Environment — Backend

## Intent

Enable a shared, publicly reachable **read-only demo account** so recruiters can explore the API without a signup or the risk of mutating data. The demo user keeps ADMIN role and can read every resource, but all unsafe HTTP methods are denied. Requires a physically isolated demo database seeded with fabricated data only.

## Scope

### In Scope
- `User.isDemo Boolean @default(false)` field + additive migration.
- Carry `isDemo` through access-token issuance/refresh, verification, Express typing, and `req.user`.
- Universal write-denial policy enforced at the `authenticate` chokepoint via a small named, unit-testable function (GET/HEAD/OPTIONS allowed; POST/PUT/PATCH/DELETE and other mutating verbs → 403 `DEMO_READ_ONLY`).
- Stale-token backward compatibility: missing `isDemo` claim defaults to `false`.
- Keep login/refresh/logout functional for demo users.
- Demo-only `RefreshToken` cleanup after fresh issuance/rotation (prune only that demo user's already-revoked/expired rows; preserve live sessions; no cron).
- Non-destructive `db:seed:demo` master/reference-data bootstrap: upsert exactly one public `isDemo=true` ADMIN (hardcoded public creds) plus fabricated Categories, Suppliers, Products (`stock=0`), and ProductSupplier links/reference prices. Idempotent rerun updates descriptive master fields/supplier links only.
- Fabricate the private setup ADMIN identity in env-driven `db:seed` (public demo can GET users; creds stay in Railway env).
- Railway operational checklist deliverable (deploy order + post-deploy manual transactional setup via the app).

### Out of Scope
- Frontend zero-typing demo login button (deferred).
- DEMO role (not added — demo stays ADMIN).
- Twilio application-code changes (env stays unset).
- Changes to general API rate limiting.
- Global (non-demo-scoped) refresh-token hygiene.
- Seeding transactional history (InventoryMovement, Alert, ReplenishmentRequest, ReplenishmentRequestItem). The owner creates these post-deploy via real application workflows as the private setup ADMIN — an operational step, not seed code.
- Periodic destructive reset/reseed (unneeded: public account is read-only).

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `auth`: add `isDemo` to access-token payload/verification, `req.user`, and enforce the read-only mutation guard inside `authenticate`; demo-scoped refresh-token cleanup on login/refresh.
- `database-schema`: add `User.isDemo` field/migration and the non-destructive fabricated master-data demo seed strategy.

## Approach

Adopt exploration Approach 1: embed the mutation guard inside `authenticate` (already the universally-first middleware on every protected route), extracting the check into a separate `assertMutationAllowed(req)`. Reject the pre-route `app.ts` guard (double-decode). Add one repository prune method called only for demo users after new-row creation. `db:seed:demo` upserts master/reference data only; it never creates, deletes, or resets transactional records or existing `Product.stock`. Railway order flows `migrate:deploy` → `db:seed:demo` → `db:seed`, then the owner builds transactional data through the app (see Success Criteria). Demo seed runs first so it inspects a truly empty application DB and atomically creates the persisted demo marker with public demo identity/master data; env-driven `db:seed` then adds the private writable setup ADMIN.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `prisma/schema.prisma` | Modified | Add `User.isDemo` (+ optional index) |
| `prisma/migrations/` | New | Additive migration |
| `src/modules/auth/auth.service.ts` | Modified | `isDemo` in sign/verify |
| `src/modules/auth/auth.controller.ts` | Modified | Pass `isDemo`; call prune |
| `src/shared/middleware/authenticate.ts` | Modified | Set `isDemo`; mutation guard |
| `src/types/express.d.ts` | Modified | `req.user.isDemo` |
| `src/shared/errors/errorCodes.ts` | Modified | `DEMO_READ_ONLY` |
| `src/modules/auth/auth.repository.ts` | Modified | Prune method |
| `prisma/scripts/seed-demo.ts` | New | Non-destructive master-data demo seed |
| `prisma/seed.ts` | Modified | Fabricate private setup ADMIN identity |
| tests | Modified/New | Guard, compat, cleanup, seed |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Real staff/supplier data exposed via demo GET | High | Physically isolated demo DB with fabricated data only (operational precondition) |
| Stale tokens lock out real users | Med | Default missing `isDemo` to `false`; explicit test |
| Concurrent demo sessions broken by cleanup | Med | Prune only revoked/expired rows; concurrency test |
| Re-seed resets stock or wipes transactional records | Med | Non-destructive rerun: upsert master fields only; never touch `Product.stock` or transactional tables; test |
| Combined diff exceeds review budget; final slicing undecided | High | Reforecast workload in tasks; slice/deliver decided there under `ask-on-risk` |

## Rollback Plan

Revert the additive migration (`isDemo` drop) and code changes; the seed script is standalone and touches only the isolated demo DB. Field is non-breaking, so partial rollback of the guard alone restores prior behavior.

## Dependencies

- Isolated Railway demo PostgreSQL instance (operational precondition).
- No new libraries.

## Success Criteria

- [ ] Demo user can GET all resources (incl. users) but every mutating verb returns 403 `DEMO_READ_ONLY`.
- [ ] Login/refresh/logout work for demo users; stale tokens behave as non-demo.
- [ ] Refresh cleanup prunes only dead demo rows; concurrent sessions survive.
- [ ] `db:seed:demo` creates one public ADMIN + fabricated Categories/Suppliers/Products (`stock=0`)/ProductSupplier; both seeded ADMIN identities are fabricated.
- [ ] Rerunning `db:seed:demo` is non-destructive: existing `Product.stock` and all transactional records (movements, alerts, replenishments) stay untouched; only descriptive master fields/supplier links update.
- [ ] Seed refuses unsafe/unrecognized targets and keeps public creds isolated to the single read-only demo identity.
- [ ] Railway checklist covers isolation, deploy order (`migrate:deploy` → `db:seed:demo` → `db:seed` → manual transactional setup → verify), `FRONTEND_URL`, Twilio unset, rollback.
