# Users Specification

## Purpose

Adopt shared `EntityStatus` semantics on User: replace the `active` filter/write path with `status`, expose the `?status=` filter, and keep the last-ACTIVE-ADMIN invariant using `status` instead of `active`.

## Error Catalog

| Code | HTTP | Trigger |
|---|---|---|
| `ENTITY_NOT_ACTIVE` | 409 | Target user has status `DISABLED` on operations requiring ACTIVE. |
| `NOT_FOUND` | 404 | User is null or has status `DELETED`. |

## Requirements

### Requirement: Status filter

`GET /api/users` MUST accept `?status=active|disabled|deleted|all`. Default (no param) MUST return `ACTIVE + DISABLED`. `all` returns every status.

#### Scenario: Default hides DELETED

- WHEN `GET /api/users` is called without `status`
- THEN response includes ACTIVE and DISABLED users; excludes DELETED

### Requirement: Response exposes status, not active

User response DTOs MUST expose `status: 'ACTIVE' | 'DISABLED' | 'DELETED'`. The `active: boolean` field MUST NOT appear in API responses after Slice B commit 2 (even though the column persists in the DB).

#### Scenario: Response shape

- WHEN `GET /api/users/:id`
- THEN response body includes `status` and does NOT include `active`

### Requirement: Soft delete sets DELETED

`DELETE /api/users/:id` MUST set `status = 'DELETED'`. It MUST reject when the target is the last user with `role = 'ADMIN' AND status = 'ACTIVE'`.

#### Scenario: Soft delete transitions ACTIVE → DELETED

- GIVEN an ACTIVE non-admin user
- WHEN `DELETE /api/users/:id` succeeds
- THEN the row persists with `status = 'DELETED'`

#### Scenario: Last ACTIVE ADMIN protected

- GIVEN the DB has exactly one user with `role = 'ADMIN' AND status = 'ACTIVE'`
- WHEN `DELETE /api/users/:id` targets that user
- THEN the operation is rejected; the user remains ACTIVE

### Requirement: Disable via update

Updates that transition an ACTIVE user to DISABLED MUST be allowed for ADMIN callers and MUST reject a self-disable attempt. Transitioning from DISABLED back to ACTIVE MUST be allowed for ADMIN.

#### Scenario: Self-disable rejected

- GIVEN caller is user X
- WHEN `PATCH /api/users/:X` sets `status = 'DISABLED'`
- THEN 409 or 403 is returned; user X remains ACTIVE
