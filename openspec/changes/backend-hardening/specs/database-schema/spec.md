# Delta for database-schema

## ADDED Requirements

### Requirement: Enum EntityStatus

The schema MUST declare a shared enum `EntityStatus` with values `ACTIVE`, `DISABLED`, `DELETED`, reused across `User`, `Product`, `Supplier`, and `Category`. Per-entity duplicated enums MUST NOT be introduced.

#### Scenario: Enum reused by four models

- GIVEN `schema.prisma` with `enum EntityStatus { ACTIVE DISABLED DELETED }`
- WHEN a model declares `status EntityStatus @default(ACTIVE)`
- THEN `npx prisma validate` accepts the schema for User, Product, Supplier, and Category

### Requirement: Status column on master entities

`User`, `Product`, `Supplier`, and `Category` MUST each declare `status EntityStatus @default(ACTIVE)` and `@@index([status])`. Existing `active Boolean` columns and `@@index([active])` on `User`, `Product`, `Supplier` MUST be preserved during this change; dropping them is deferred to a follow-up PR.

#### Scenario: Column and index created on all four tables

- GIVEN a fresh Postgres DB
- WHEN the migration is applied
- THEN each of `User`, `Product`, `Supplier`, `Category` has a `status` NOT NULL column defaulting to `ACTIVE` and a `<Table>_status_idx` btree index

### Requirement: Backfill semantics

The migration MUST backfill `status` from `active` on `User`, `Product`, `Supplier` using: `active = true → 'ACTIVE'`, `active = false → 'DELETED'`. `Category` rows MUST default to `'ACTIVE'` (Category has no `active` column). No historical row is assigned `'DISABLED'`.

#### Scenario: Legacy soft-deleted rows map to DELETED

- GIVEN 3 users with `active = false` and 5 users with `active = true`
- WHEN the migration runs
- THEN exactly 3 users have `status = 'DELETED'` and 5 users have `status = 'ACTIVE'`; row counts pre/post match

#### Scenario: Category defaults to ACTIVE

- GIVEN 10 existing categories
- WHEN the migration runs
- THEN all 10 rows have `status = 'ACTIVE'`

### Requirement: `active` column preserved in this change

The migration MUST NOT drop `active` or `@@index([active])` on `User`, `Product`, `Supplier`. Reversibility relies on this column staying alive; dropping is a separate follow-up PR.

#### Scenario: `active` remains queryable post-migration

- GIVEN the migration has run
- WHEN `SELECT active FROM "User" LIMIT 1` executes
- THEN it returns without error
