# Delta for database-schema

## MODIFIED Requirements

### Requirement: Entidad User

```prisma
model User {
  id        String   @id @default(cuid())
  fullName  String
  email     String   @unique
  password  String   // bcrypt hash, nunca en respuestas API
  role      UserRole @default(OPERATOR)
  active    Boolean  @default(true)
  isDemo    Boolean  @default(false)
  phone     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  movements             InventoryMovement[]
  replenishmentRequests ReplenishmentRequest[]
  resolvedAlerts        Alert[]                @relation("AlertResolver")

  @@index([email])
  @@index([active])
  @@index([isDemo])
}
```

`isDemo` is additive with `@default(false)`. Adding it **MUST** be an additive change: existing `User` rows **MUST** migrate as non-demo (`isDemo = false`) with no data loss. `isDemo` **MUST** be independent of `role` — a demo user retains its assigned role.

(Previously: `User` had no `isDemo` field and no `@@index([isDemo])`.)

#### Scenario: Email único

- GIVEN un `User` con `email = 'admin@highmeds.local'`
- WHEN se intenta crear otro `User` con el mismo email
- THEN Prisma lanza `P2002` (unique constraint violation)

#### Scenario: Existing rows migrate as non-demo

- GIVEN existing `User` rows created before this change
- WHEN the additive migration adding `isDemo` is applied
- THEN every pre-existing row has `isDemo = false` AND no other column values change

### Requirement: Seed de usuario administrador

El archivo `prisma/seed.ts` (`db:seed`, env-driven) **MUST** crear o actualizar idempotentemente vía `upsert` un único `ADMIN` de **setup privado** con `isDemo = false`. Su identidad (`fullName`, `email`, `phone`) **MUST** ser fabricada, y sus credenciales secretas **MUST** provenir de variables de entorno (`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_FULLNAME`), con la contraseña hasheada con bcrypt (cost = 10). Este ADMIN **MUST** permanecer con permisos de escritura (`isDemo = false`) para que, tras el deploy, pueda crear movimientos, alertas y datos de reabastecimiento mediante los flujos reales de la aplicación. `db:seed` **MUST NOT** emitir credenciales públicas ni marcar identidad alguna como `isDemo = true`.

(Previously: creaba un `ADMIN` desde env sin fijar `isDemo`; no exigía identidad fabricada ni distinguía el ADMIN de setup privado del ADMIN público de demo.)

#### Scenario: Seed idempotente

- GIVEN un seed ya ejecutado una vez
- WHEN se ejecuta `npm run db:seed` por segunda vez
- THEN el upsert no crea un duplicado; el ADMIN de setup existe una sola vez

#### Scenario: Seed sin variables

- GIVEN un `.env` sin `SEED_ADMIN_PASSWORD`
- WHEN se ejecuta `npm run db:seed`
- THEN el script aborta con error legible indicando la variable faltante

#### Scenario: Private setup ADMIN is fabricated and non-demo

- GIVEN a database where `db:seed` has completed
- WHEN the setup ADMIN row is inspected
- THEN its identity fields are fabricated AND its credentials came from env AND `isDemo = false` (writable)

## ADDED Requirements

### Requirement: Non-destructive master-data demo bootstrap

A dedicated `db:seed:demo` script **MUST** bootstrap master/reference data only, non-destructively, into an isolated fabricated-data-only demo database. It **MUST** create or upsert: exactly one public `ADMIN` with `isDemo = true` and intentionally public hardcoded credentials; fabricated `Category` rows; fabricated `Supplier` rows; fabricated `Product` rows; and `ProductSupplier` relationships with reference prices. New `Product` rows **MUST** start with `stock = 0`. Public credentials **MUST** be confined to exactly this one demo identity; every other user **MUST** remain `isDemo = false`. The script **MUST NOT** seed transactional history.

Rerunning **MUST** be non-destructive and idempotent: it **MUST NOT** change any existing `Product.stock`, and **MUST NOT** create, delete, or update any `InventoryMovement`, `Alert`, `ReplenishmentRequest`, or `ReplenishmentRequestItem` row. Rerunning **MAY** update descriptive master fields and `ProductSupplier` links/reference prices idempotently, matching entities by natural key (`Category.name`, `Product.code`, `Supplier.rif`) so no duplicates are produced.

#### Scenario: Fresh master-data bootstrap marks the database

- GIVEN `migrate:deploy` has created the schema and an empty marker table, leaving an empty application database (no application/domain records) AND the exact required operator confirmation is supplied
- WHEN first-run `db:seed:demo` runs before `db:seed`
- THEN the demo bootstrap atomically initializes AND exactly one user has `isDemo = true` with `role = ADMIN` AND fabricated Categories, Suppliers, Products, and ProductSupplier reference prices exist AND the demo marker is persisted as part of the same successful bootstrap

#### Scenario: New products start at zero stock

- GIVEN `db:seed:demo` creating new `Product` rows
- WHEN the run completes
- THEN every newly created `Product` has `stock = 0`

#### Scenario: Rerun preserves manually established stock

- GIVEN a demo database where `Product.stock` was changed to non-zero after the first bootstrap
- WHEN `db:seed:demo` runs again
- THEN each affected `Product.stock` is left exactly as it was (unchanged)

#### Scenario: Rerun leaves transactional tables unchanged

- GIVEN a demo database holding `InventoryMovement`, `Alert`, `ReplenishmentRequest`, and `ReplenishmentRequestItem` rows
- WHEN `db:seed:demo` runs again
- THEN no row in any of those four tables is created, deleted, or updated

#### Scenario: Natural-key and link idempotency

- GIVEN a demo database already bootstrapped once
- WHEN `db:seed:demo` runs a second time
- THEN entities are matched by natural key and upserted (no duplicates) AND descriptive master fields and `ProductSupplier` links/reference prices may update in place

#### Scenario: Public credentials confined to one demo identity

- GIVEN a bootstrapped demo database
- WHEN all users are inspected
- THEN exactly one user carries the public hardcoded demo credentials with `isDemo = true` AND every other user has `isDemo = false`

### Requirement: Demo database isolation and seed-target safety

Demo database isolation and fabricated-data-only content are hard deployment preconditions. `db:seed:demo` behavior **MUST** be determined by two independent inputs: (a) the operator confirmation, which **MUST** match exactly; and (b) the persisted demo marker, checked independently of the confirmation. The marker **MUST NOT** be a substring of the database name; it **MUST** be persisted in the database and independently verifiable (exact mechanism left to design). The following state transitions are exhaustive and **MUST** hold:

1. **First-run initialization** — an empty application database (no application/domain records) plus the exact required operator confirmation **MAY** initialize the demo bootstrap, creating the public demo identity and master data and persisting the demo marker as part of the successful bootstrap.
2. **Unsafe non-empty unmarked target** — a database containing application/domain records but lacking the marker **MUST** abort with a clear, readable error and perform zero create, update, or delete writes.
3. **Recognized rerun** — a marked demo database plus the exact matching operator confirmation **MAY** perform the approved non-destructive master-data upserts.
4. **Confirmation failure** — missing or mismatched operator confirmation **MUST** abort before any write, regardless of database state.
5. **Marked target with unexpected data** — if the established recognition policy detects content inconsistent with the isolated fabricated-data-only precondition, `db:seed:demo` **MUST** fail closed; it **MUST NOT** attempt to destructively repair the target.

Silent deletion or overwrite of unrecognized data **MUST NOT** occur under any transition.

#### Scenario: Empty database plus confirmation succeeds and marks

- GIVEN an empty application database (no application/domain records) AND the exact required operator confirmation
- WHEN `db:seed:demo` is executed
- THEN it initializes the demo bootstrap without error AND persists the demo marker as part of that successful bootstrap

#### Scenario: Non-empty unmarked database refused with zero writes

- GIVEN a database containing application/domain records AND lacking the demo marker
- WHEN `db:seed:demo` is executed
- THEN it aborts with a readable error AND performs no create, update, or delete on any table

#### Scenario: Marked database plus confirmation reruns non-destructively

- GIVEN a database carrying the persisted demo marker AND the exact matching operator confirmation
- WHEN `db:seed:demo` is executed
- THEN it performs only the approved non-destructive master-data upserts AND preserves all `Product.stock` and transactional tables

#### Scenario: Missing or mismatched confirmation refused with zero writes

- GIVEN any database state
- WHEN `db:seed:demo` is executed with missing or mismatched operator confirmation
- THEN it aborts before any write AND performs no create, update, or delete on any table

#### Scenario: Marker independent of database name

- GIVEN a database whose name contains a demo-like substring but which has no persisted marker
- WHEN `db:seed:demo` inspects the target
- THEN recognition relies only on the persisted, independently checked marker AND the database name substring is not treated as the marker

### Requirement: Operational transactional-data setup

Transactional data (movements, alerts, and replenishment lifecycle records) **MUST NOT** be produced by any seed script. Instead, after deployment, the private setup ADMIN (`isDemo = false`) **MUST** create `InventoryMovement`, `Alert`, `ReplenishmentRequest`, and `ReplenishmentRequestItem` data through the real application workflows. This **MUST** be documented as an operational setup step, and the deployment sequence **MUST** be: `migrate:deploy` → `db:seed:demo` → `db:seed` → manual transactional setup via the app → public-demo verification. `migrate:deploy` **MUST** create the schema and an empty marker table; first-run `db:seed:demo` **MUST** run against the empty application database (proving no application/domain records) before `db:seed` adds the private setup ADMIN; running `db:seed` before `db:seed:demo` **MUST NOT** occur, because the private setup ADMIN would render the database non-empty and cause first-run `db:seed:demo` to abort.

#### Scenario: Operational sequence and manual workflow setup

- GIVEN the operational setup documentation
- WHEN a demo deploy is performed
- THEN the ordered steps are `migrate:deploy` → `db:seed:demo` → `db:seed` → manual transactional setup by the private setup ADMIN via the app → public-demo verification
- AND `db:seed:demo` runs against the empty application database created by `migrate:deploy`, then `db:seed` creates/updates the private non-demo setup ADMIN afterward
- AND transactional records are created only through real application workflows, not by any seed

### Requirement: Railway operational demo checklist

The change **MUST** deliver a documented, verifiable operational checklist for deploying the demo environment on Railway. The checklist **MUST** cover at minimum: use of a database instance physically isolated from any environment holding real staff/supplier data and containing fabricated data only; the deployment sequence (`migrate:deploy` → `db:seed:demo` → `db:seed` → manual transactional setup → public-demo verification); the intentional public demo credential set confined to the single demo identity; leaving `TWILIO_*` unset; `FRONTEND_URL` configuration; and the rollback path. The checklist **MUST NOT** introduce frontend work.

#### Scenario: Checklist covers isolation and deploy sequence

- GIVEN the demo deployment checklist artifact
- WHEN it is reviewed before a demo deploy
- THEN it explicitly requires an isolated fabricated-data-only demo database AND states the full deploy sequence AND lists the confined public demo credentials, unset `TWILIO_*`, `FRONTEND_URL`, and rollback steps

#### Scenario: Checklist stays backend/operational only

- GIVEN the demo deployment checklist artifact
- WHEN its scope is inspected
- THEN it contains only backend/operational steps and introduces no frontend deliverable
