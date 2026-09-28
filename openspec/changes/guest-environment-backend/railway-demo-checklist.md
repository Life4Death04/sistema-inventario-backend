# Railway Operational Checklist — Guest (Demo) Environment

Backend-only, operational deployment checklist for the public, read-only demo
environment. No frontend work is introduced or required by this checklist.

## 1. Prerequisite: physically isolated demo database

- [ ] Provision a **dedicated** Railway PostgreSQL instance for the demo
      deployment — a separate Railway project/service from any environment
      holding real staff or supplier data. Never point the demo service's
      `DATABASE_URL` at a shared or production database.
- [ ] Confirm the demo database is **empty** before the first deploy (fresh
      Railway PostgreSQL plugin, no prior tables/data). `db:seed:demo`'s
      first-run safety check depends on this — a non-empty, unmarked target
      aborts with zero writes (see §5).
- [ ] Treat this database as **fabricated data only** for the deployment's
      lifetime — never restore a production backup into it.

## 2. Environment variables (Railway service → Variables)

| Variable | Value for demo | Notes |
|---|---|---|
| `DATABASE_URL` | the isolated demo PostgreSQL connection string | never the production URL |
| `NODE_ENV` | `production` | |
| `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` | distinct, ≥32-char secrets | independent of production secrets |
| `FRONTEND_URL` | the deployed demo frontend origin | drives CORS; must match the actual demo UI origin |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` / `SEED_ADMIN_FULLNAME` | **private** operator-chosen values | the private, writable setup ADMIN (§4) — never share publicly |
| `DEMO_SEED_CONFIRM` | `YES_SEED_THE_DEMO_DATABASE` | set only for the `db:seed:demo` run in §3 step 2 |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_WHATSAPP_FROM` | **unset** | intentional — WhatsApp sending is out of scope; app boots fine unset (optional at boot, required only to send) |

## 3. Deployment sequence

Run in this exact order — each step depends on the previous one succeeding.

1. **`npm run migrate:deploy`** (`prisma migrate deploy`) — applies pending
   migrations, including `User.isDemo` and an empty `DemoSeedMarker` table
   (no marker row yet). Railway's `preDeployCommand` already runs this
   automatically (`railway.json`); confirm it succeeded in the deploy logs.
2. **`DEMO_SEED_CONFIRM=YES_SEED_THE_DEMO_DATABASE npm run db:seed:demo`** —
   bootstraps the public demo ADMIN and fabricated master data (Categories,
   Suppliers, Products at `stock:0`, ProductSupplier links). Only reachable
   as `FIRST_RUN` because the application database is still empty at this
   point (see §5). Confirm the console shows `bootstrap complete, demo
   marker persisted`.
3. **`npm run db:seed`** — upserts the **private** setup ADMIN from
   `SEED_ADMIN_*` (§2), with `isDemo:false` asserted in both `create` and
   `update` — never the public demo identity, unaffected by the read-only
   guard.
4. **Manual transactional setup, via the running app, as the private setup
   ADMIN** — log in with the §2 credentials and create the demo's
   transactional history (stock via inventory movements, any alerts/
   replenishment requests) through real API workflows. No seed writes
   `InventoryMovement`/`Alert`/`ReplenishmentRequest`/
   `ReplenishmentRequestItem` — intentional, out of scope for seeding.
5. **Public-demo verification** — see §6.

## 4. Public demo credentials

- The public demo email/password are the **committed, intentionally public**
  constants in `src/shared/demo/demoCredentials.ts` — not env vars, not
  secrets, and specifically public so recruiters can log in without signup.
- Exactly **one** user row may hold `isDemo:true` (that identity,
  `role:ADMIN`) — `db:seed:demo`'s rerun check aborts with zero writes if
  this invariant is ever broken.
- The demo identity can `GET` every resource (incl. `/api/users`), but every
  unsafe verb returns `403 DEMO_READ_ONLY` before reaching a handler.
- `POST /api/users` cannot mint a second demo identity — `isDemo` is not in
  `createUserSchema` and is silently stripped from any request body.

## 5. Confirmation and marker safety

`db:seed:demo` writes only when BOTH gates pass: `DEMO_SEED_CONFIRM` matches
exactly, AND the marker-first state check resolves to `FIRST_RUN` or
`RECOGNIZED_RERUN`. Running it before `db:seed`/manual setup (§3) is what
makes `FIRST_RUN` reachable — `migrate:deploy` leaves the marker empty, so
the very first run observes a genuinely empty database. If the order is
skipped, the fail-closed `ABORT_UNMARKED` state performs zero writes rather
than seeding on top of unexpected data — do not bypass this by manually
inserting a `DemoSeedMarker` row. Later reruns (e.g. to refresh descriptive
fields) are safe: a `RECOGNIZED_RERUN` skips the empty-database check
entirely, tolerating the setup ADMIN and manual data already present, and
never touches `Product.stock` or any transactional table.

## 6. Public-demo verification (post-deploy)

- [ ] `GET /api/health` returns `200`.
- [ ] Log in with the public demo credentials (§4); refresh and logout work.
- [ ] `GET /api/products`, `/api/users`, `/api/categories` as the demo user
      return `200` with the §3-step-2 master data plus any manual history.
- [ ] A mutating call as the demo user (e.g. `POST /api/products`) returns
      `403 DEMO_READ_ONLY` and creates no row.
- [ ] The private setup ADMIN (§2/§3 step 3) can still log in and mutate
      normally — the guard must never affect non-demo accounts.

## 7. Rollback

- **Code**: revert the `guest-environment-backend` commits. The read-only
  guard is additive at the `authenticate` chokepoint — reverting it alone
  restores prior mutation behavior with no other side effects.
- **Schema**: the migration is purely additive. A follow-up migration can
  drop the `User.isDemo` column (+ index) and the `DemoSeedMarker` table
  without losing any other data.
- **Data**: the demo database is isolated and fabricated-only (§1) — the
  safest rollback is deleting/recreating the isolated Railway PostgreSQL
  instance, then re-running §3 from scratch.
