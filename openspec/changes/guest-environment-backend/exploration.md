## Exploration: guest-environment-backend

### Current State

The backend is an Express 4 + Prisma 5 + PostgreSQL REST API with layered modules
(`router → controller → service → repository`). Relevant facts confirmed by reading
the actual code (not assumed):

**Auth flow** (`src/modules/auth/*`):
- `authService.signAccessToken(userId, role)` signs `{ sub, role, iat, exp }` (HS256,
  TTL `env.JWT_ACCESS_TTL`, default `15m`). Called from `loginController` and
  `refreshController` in `auth.controller.ts`.
- `authenticate` (`src/shared/middleware/authenticate.ts`) decodes the Bearer token via
  `authService.verifyAccessToken` and sets `req.user = { id: payload.sub, role: payload.role }`.
  **It does not hit the DB.** This is the single decode point for every protected request.
- `express.d.ts` declares `req.user?: { id: string; role: UserRole }`.
- `requireRole(...allowed)` runs strictly after `authenticate` and 500s if `req.user` is
  missing (misconfiguration guard).
- `POST /login`, `POST /refresh`, `POST /logout` do **not** call `authenticate` at all —
  they read credentials/cookie directly. `GET /me` is the only auth-router route that calls
  `authenticate`.
- `RefreshToken` is a DB allowlist keyed by its own `cuid` (`id` **is** the `jti`, no
  separate column). Rotation: `refreshController` revokes the presented row, creates a new
  one, and signs a new refresh JWT with the new row's `id`. Reuse of an already-rotated or
  revoked `jti` triggers `revokeAllUserRefreshTokens(userId)` (full-family revoke).
  `RefreshToken` has no cleanup job today — rows accumulate forever (revoked or not).

**Route wiring** (grepped all 9 routers in `src/modules/*/*.routes.ts`):
- Every module **except `users`** calls `authenticate` as the **first middleware on each
  individual route** (`router.post('/', authenticate, requireRole(...), validate(...), ctrl)`).
- `users.routes.ts` is the only router using a blanket `router.use(authenticate, requireRole('ADMIN'))`.
- In both patterns, `authenticate` is unconditionally the first middleware to run before any
  handler that needs `req.user`. There is **no router where a mutating handler is reachable
  without first passing through `authenticate`.**
- `app.ts` mounts `helmet → cors → cookieParser → json/urlencoded → pino-http → rate-limit`
  **before** any router. A hypothetical `app.use('/api', demoGuard)` inserted here would run
  **before** every router's own `authenticate` call and would see `req.user === undefined` —
  it would have to re-decode the JWT itself (double-decode) to know `isDemo`. This confirms
  the task instruction: a naive pre-auth global middleware cannot read `req.user`.
- `cors()` intercepts and short-circuits `OPTIONS` preflight before it reaches any router, so
  preflight requests never reach `authenticate` or a future demo guard.
- Method-not-allowed edge case: `inventory-movements.routes.ts` uses
  `router.all('/:id', methodNotAllowed)` for any verb other than `GET`, and this catch-all
  does **not** call `authenticate` — it 405s unconditionally, so it is already immutable and
  is not a demo-guard concern.

**Data model** (`prisma/schema.prisma`): `User { role UserRole, active Boolean, status
EntityStatus }`. No `isDemo` field yet. Domain has **no "customer" entity** — the only
person-shaped PII in the schema is `User.{fullName,email,phone}` (staff) and
`Supplier.{whatsapp,address}` (real supplier contacts). There is no per-row "seed/demo"
marker on any table besides the confirmed `User.isDemo` plan — `Category.name`,
`Product.code`, and `Supplier.rif` are the only `@unique` natural keys usable for
idempotent upsert-based seeding; `InventoryMovement`, `Alert`, `ReplenishmentRequest`,
`ReplenishmentRequestItem` have no natural key and must be reset by deleting rows scoped to
the known seeded parent IDs, in FK-safe order (items → requests, movements/alerts →
products, before deleting products/suppliers/categories themselves, matching the `onDelete:
Restrict` relations already declared).

**Twilio** (`src/shared/notifications/twilio-client.ts`): lazy singleton, throws only at
`getTwilioClient()` call time if `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` are unset. The only
caller path is inside mutation flows (e.g. `POST /:id/send` on replenishment requests),
which will already be blocked by the demo mutation guard before reaching the notification
service. No code change is needed; leaving `TWILIO_*` unset in the demo environment is
sufficient and already the documented optional-at-boot behavior in `env.ts`.

**Rate limiting** (`app.ts`): a single IP-keyed `express-rate-limit` instance applies to all
`/api/*` traffic (`env.RATE_LIMIT_MAX`, default 100 per `RATE_LIMIT_WINDOW_MS`, default 15
min). It is not user/account-aware. Login is already public and already rate-limited the
same way regardless of whether a demo account exists — publishing demo credentials does not
change the shape of this exposure. No evidence found that a demo-specific limiter is needed.

**Seeding** (`prisma/seed.ts`, `prisma/scripts/create-admin.ts`): both are `tsx` scripts run
via npm scripts (`db:seed`, `db:create-admin`), both env-var driven, both idempotent via
`prisma.user.upsert` on `email`. No existing script seeds fake business data (categories,
products, suppliers, movements, alerts, replenishment). A new dedicated script following
this exact pattern (env-var-gated where relevant, `tsx` script, idempotent) is the natural
fit for the demo seed.

### Affected Areas

- `prisma/schema.prisma` — add `User.isDemo Boolean @default(false)` (+ optional `@@index([isDemo])` for the cleanup/reset queries).
- `prisma/migrations/<timestamp>_add_user_is_demo/migration.sql` — new additive migration, same style as `20260704120000_add_entity_status`.
- `src/modules/auth/auth.service.ts` — `signAccessToken(userId, role, isDemo)`, `AccessTokenPayload` gains `isDemo`, `verifyAccessToken` returns `isDemo` defaulted to `false` when the claim is absent (stale pre-change token compatibility).
- `src/modules/auth/auth.controller.ts` — `loginController` and `refreshController` both already re-read the full `User` row before signing; pass `user.isDemo` through at both call sites (no new DB read).
- `src/shared/middleware/authenticate.ts` — set `req.user.isDemo`, and this is the recommended single chokepoint for the mutation guard (see Approaches).
- `src/types/express.d.ts` — `req.user` gains `isDemo: boolean`.
- `src/shared/errors/errorCodes.ts` — new code, e.g. `DEMO_READ_ONLY` (403).
- `src/modules/auth/auth.repository.ts` — new method for bounded `RefreshToken` cleanup (delete/revoke rows that are already `revoked=true` or past `expiresAt`, scoped to a `userId`).
- New demo seed script under `prisma/scripts/` (e.g. `prisma/scripts/seed-demo.ts`) + a new `npm run db:seed:demo` script in `package.json`.
- Tests: `tests/smoke/auth.test.ts`, `tests/unit/auth.service.test.ts`, and any other smoke test constructing a raw mock `User` object will need `isDemo: false` added to fixtures once the Prisma type gains the field (TypeScript will flag the omission after `prisma generate`). New tests needed for: demo mutation guard (GET allowed / POST-PUT-PATCH-DELETE blocked), stale-token backward compatibility, refresh-token cleanup bound, seed idempotency/integrity.
- Railway/env — **not application code**, but must be captured as an operational checklist artifact in design/tasks: a demo `SEED_ADMIN_*`-style credential set, `TWILIO_*` left unset, and (critical, see Risks) a **database fully isolated from production**.

### Approaches

1. **Embed the mutation guard inside `authenticate` (single-file chokepoint)** — after
   decoding the JWT and setting `req.user`, check `req.user.isDemo && !['GET','HEAD','OPTIONS'].includes(req.method)` and throw `AppError(DEMO_READ_ONLY, 403, ...)` before calling `next()`.
   - Pros: touches exactly one file; zero changes to any of the 9 route files; `authenticate` is *already* the universally-first middleware everywhere it's used (proven by reading all routers), so this is provably correct without inventing new wiring; no double-decode (same `verifyAccessToken` call already in progress); auth lifecycle routes (`login`/`refresh`/`logout`) are untouched because they never call `authenticate`; `GET /me` is unaffected because `GET` is a safe method.
   - Cons: blurs "authenticate = identity only" with an authorization concern; a future reviewer must read the function body (not just its name) to know it also enforces a write-block.
   - Effort: Low.

2. **New composable middleware inserted after every existing `authenticate` call** (mirrors how `requireRole` is already composed) — e.g. `denyDemoMutation` placed as `authenticate, denyDemoMutation, requireRole(...), validate(...), ctrl` in all ~34 route registrations across 9 files.
   - Pros: keeps single-responsibility separation consistent with the existing `authenticate` → `requireRole` composition pattern; the guard is visible in every route's middleware list.
   - Cons: ~34 mechanical insertions across 9 files (users, products, categories, suppliers, inventory-movements, replenishment-requests, alerts, auth `/me`); higher chance of a missed insertion on a future new route (silent security regression) since there is no structural guarantee every future route includes it, unlike Approach 1 where the guard is inseparable from `authenticate` itself.
   - Effort: Medium.

3. **New `app.use('/api', demoGuard)` mounted globally in `app.ts` before route mounts.**
   - Pros: single mount point, no per-route changes.
   - Cons: **provably wrong given actual code** — it runs before every router's own `authenticate` call, so `req.user` is `undefined` at that point; the guard would have to independently decode the JWT to learn `isDemo`, which is a double-decode of the same token `authenticate` will decode again a few milliseconds later. Explicitly what the task instructions warn against.
   - Effort: N/A — rejected on correctness grounds, not effort.

### Recommendation

**Approach 1** (embed in `authenticate`). It is the only option that is simultaneously
(a) provably correct given the actual, confirmed middleware order in every router, (b) a
single-file diff with no risk of a missed route, and (c) free of double-decoding. The
authorization-blur concern in Approach 1 is real but minor and can be mitigated at design
time by extracting the mutation-guard check into a small, separately-named, separately-unit-testable
function (e.g. `assertMutationAllowed(req)`) that `authenticate` calls internally — same
file, same single chokepoint, but the concern stays readable and independently testable.
Approach 2 remains a reasonable fallback if the design phase decides the blur in Approach 1
is unacceptable for this codebase's conventions, but it should be treated as strictly worse
on safety grounds (a new route that forgets the middleware is a silent security hole; a new
route that forgets `authenticate` already 401s loudly).

For **refresh-token cleanup**: add one repository method,
e.g. `authRepository.pruneDeadRefreshTokens(userId)` — `deleteMany({ where: { userId, OR: [{ revoked: true }, { expiresAt: { lt: new Date() } }] } })` — and call it from both `loginController` and `refreshController` for `isDemo` users only, immediately after the new row is created (so the fresh, active row is never at risk — only rows that are already dead weight are removed). This needs **no scheduled job, no cron, no extra table column**, and cannot invalidate the current session because it only ever deletes rows that are already unusable (`revoked=true` or past `exp`). Scoping it to `isDemo` users keeps the blast radius minimal and matches the stated problem (shared public demo account, repeated recruiter logins) without changing behavior for real users. A global (non-demo-scoped) version of the same hygiene fix is a reasonable low-risk follow-up but is out of scope here to keep this change's diff minimal.

### Risks

- **Highest risk — database isolation, not application logic.** Decision #4 states the demo
  ADMIN may read every resource including `GET /api/users`, which is only safe if the demo
  database contains **exclusively fabricated data**. This backend has no per-row "seed/demo"
  flag on `Product`, `Supplier`, `Category`, `InventoryMovement`, `Alert`, or
  `ReplenishmentRequest*` (only `User.isDemo` was decided) — there is no way to filter real
  data out of a GET response even if it existed. **This means the demo deployment MUST run
  against a database instance that is physically separate from any environment holding real
  staff or supplier data.** This is an operational/Railway decision, not something the
  application code can enforce, and must be called out explicitly and loudly in the design
  and in the Railway operational checklist — it is the one failure mode that defeats every
  other control in this plan.
- **Stale pre-change access tokens.** Tokens issued before this change carries no `isDemo`
  claim. `verifyAccessToken` must default missing `isDemo` to `false` so already-issued
  tokens keep working exactly as before (non-demo, unrestricted by role) rather than
  erroring or being silently treated as demo (which would incorrectly lock out real users
  mid-session on deploy). This must be an explicit test case.
  - Real users are minimally affected here since access tokens are short-lived (15 min
    default `JWT_ACCESS_TTL`); the compatibility window is small but must still be handled.
- **`requireRole('ADMIN')` still passes for the demo user** (it keeps role `ADMIN` by design
  decision #2), so `requireRole` alone cannot be the enforcement point — confirms the guard
  must be `isDemo`-driven, independent of role, exactly as scoped in Approach 1.
- **Concurrent recruiter sessions.** Multiple people can be logged into the same public demo
  account simultaneously, each holding a distinct `RefreshToken` row. The recommended cleanup
  policy (prune only `revoked=true` or expired rows) never touches another session's live,
  unexpired row, so concurrent sessions are safe by construction — but this must be an
  explicit test (two concurrent logins, one refresh/cleanup pass, both original access tokens
  and the *other* session's refresh row remain valid).
- **Seed re-run integrity.** Without natural keys on movement/alert/replenishment tables, a
  naive re-seed could duplicate rows on every run. The design must lock a concrete strategy
  (fixed/deterministic seed IDs, or upsert-by-natural-key for `Category`/`Product`/`Supplier`
  plus delete-and-recreate for dependent rows in FK-safe order) before implementation, per
  confirmed invariant #9.
- **Test fixture drift.** Several smoke test files construct raw mock `User`/`PublicUser`
  objects (`tests/smoke/auth.test.ts`, `tests/smoke/users.test.ts`, others). Once
  `isDemo` is added to the Prisma-generated `User` type, these fixtures should be updated
  (`isDemo: false`) even where TypeScript may not strictly enforce it through the loosely-typed
  `vi.fn()` mocks, to avoid false confidence in test coverage.
- **Review-budget risk (400-line budget, `ask-on-risk` strategy).** The combined scope
  (migration, JWT/request-state plumbing across 5+ files, mutation-guard tests, a genuinely
  new seed script with several fabricated entities, refresh-token cleanup, and an
  operational checklist) is very likely to exceed 400 authored lines in a single PR. The
  tasks phase should plan this as chained/stacked PR-sized work units (e.g.
  schema+migration → JWT/guard+tests → demo seed+integrity tests → refresh-token cleanup →
  Railway checklist) rather than one PR.

### Ready for Proposal

Yes. All confirmed decisions have a verified, code-backed enforcement path; the one
open risk that is NOT an application-code decision (database isolation) is flagged for the
proposal/design to state explicitly as a hard operational precondition rather than something
this change can silently assume. Recommend `sdd-propose` next, carrying forward: the
`authenticate`-embedded guard approach, the login/refresh-scoped `RefreshToken` pruning
policy, the natural-key-based idempotent seed strategy, and the explicit database-isolation
precondition for the Railway checklist.

### External Research Assessment

Not needed before proposal. Every open question in this exploration (enforcement
chokepoint, cleanup timing, seed idempotency) was resolved by reading this repository's
actual code, not by an external unknown (e.g., a third-party API contract or unfamiliar
library behavior). The design phase may want a short doc lookup for `express-rate-limit`
per-route override syntax if it later reconsiders decision #12, but that is optional and
not a blocker.
