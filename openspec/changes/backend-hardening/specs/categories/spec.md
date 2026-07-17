# Categories Specification

## Purpose

Introduce soft-delete semantics on Category via the shared `EntityStatus` enum. `DELETE /api/categories/:id` transitions to `DELETED` instead of hard-deleting; list default hides DELETED; `?status=` filter follows the shared convention.

## Error Catalog

| Code | HTTP | Trigger |
|---|---|---|
| `NOT_FOUND` | 404 | Category is null or has status `DELETED`. |
| `VALIDATION_ERROR` | 400 | Body fails Zod validation. |

## Requirements

### Requirement: Status filter

`GET /api/categories` MUST accept `?status=active|disabled|deleted|all`. Default (no param) MUST return `ACTIVE + DISABLED`. `all` returns every status.

#### Scenario: Default hides DELETED

- GIVEN categories across all statuses
- WHEN `GET /api/categories` is called without `status`
- THEN response includes ACTIVE and DISABLED rows; excludes DELETED

#### Scenario: `?status=all` returns everything

- WHEN `GET /api/categories?status=all`
- THEN response includes all rows regardless of status

### Requirement: DELETE becomes soft delete

`DELETE /api/categories/:id` MUST set `status = 'DELETED'` (no row removal). The row MUST remain queryable via `?status=all` or `?status=deleted`.

#### Scenario: Soft delete hides row by default

- WHEN `DELETE /api/categories/:id` succeeds
- THEN the row persists with `status = 'DELETED'`
- AND subsequent `GET /api/categories/:id` returns 404 `NOT_FOUND`
- AND `GET /api/categories?status=all` includes the row

#### Scenario: Delete already-DELETED

- GIVEN a category with `status = 'DELETED'`
- WHEN `DELETE /api/categories/:id` is called
- THEN 404 `NOT_FOUND`; state unchanged

### Requirement: Response exposes status

Category response DTOs MUST expose `status: 'ACTIVE' | 'DISABLED' | 'DELETED'`. Category has no legacy `active` field to preserve.

#### Scenario: Response shape

- WHEN `GET /api/categories/:id`
- THEN response body includes `status`
