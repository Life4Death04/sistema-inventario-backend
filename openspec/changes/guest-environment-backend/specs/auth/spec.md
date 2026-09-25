# Delta for auth

## MODIFIED Requirements

### Requirement: Access token (JWT corto)

El access token **MUST** ser un JWT firmado con **HS256** usando `env.JWT_ACCESS_SECRET`. TTL: **15 minutos** (configurable vía `env.JWT_ACCESS_TTL`, default `15m`).

Payload exacto:

```json
{
  "sub": "cuid-del-user",
  "role": "ADMIN | MANAGER | OPERATOR",
  "isDemo": false,
  "iat": 1700000000,
  "exp": 1700000900
}
```

Se envía en el header `Authorization: Bearer <token>`.

The `isDemo` claim **MUST** be sourced from the current `User.isDemo` record at sign time (login and refresh). `isDemo` **MUST** be independent of `role`: a demo account keeps its assigned role (e.g. `ADMIN`). When verifying a token whose `isDemo` claim is absent (tokens issued before this change), verification **MUST** default it to `false` and treat the token as non-demo.

(Previously: payload contained only `{ sub, role, iat, exp }` and carried no demo marker.)

#### Scenario: Token expira a los 15 minutos

- GIVEN un access token emitido con `exp = iat + 900`
- WHEN se intenta usar 16 minutos después
- THEN `authenticate` responde `401` con `error: 'TOKEN_EXPIRED'`

#### Scenario: Token con secret inválido

- GIVEN un token firmado con otro secret
- WHEN llega a `authenticate`
- THEN responde `401` con `error: 'INVALID_TOKEN'`

#### Scenario: Demo claim carried from user record at login

- GIVEN a `User` with `isDemo = true` and `role = ADMIN`
- WHEN the login endpoint signs the access token
- THEN the payload contains `isDemo: true` AND `role: "ADMIN"`

#### Scenario: Demo claim refreshed from user record on refresh

- GIVEN a valid refresh session for a `User` with `isDemo = true`
- WHEN `POST /api/auth/refresh` signs a new access token
- THEN the new payload contains `isDemo: true` sourced from the current user record

#### Scenario: Stale token without isDemo behaves as non-demo

- GIVEN a valid, unexpired access token issued before this change (no `isDemo` claim)
- WHEN `authenticate` verifies it
- THEN verification succeeds AND `isDemo` defaults to `false` AND the request is treated as non-demo (role-based behavior unchanged)

### Requirement: Middleware `authenticate`

Función `authenticate: RequestHandler` que:

1. Lee header `Authorization`. Si ausente o no empieza con `Bearer `, responde `401 MISSING_TOKEN`.
2. Verifica el JWT con `JWT_ACCESS_SECRET`. Si firma inválida → `401 INVALID_TOKEN`. Si expirado → `401 TOKEN_EXPIRED`.
3. Pone `req.user = { id, role, isDemo }` (decodificado del payload, con `isDemo` default `false` cuando el claim está ausente) para que los siguientes middlewares y controllers lo usen.
4. **No** consulta la DB en cada request (eso lo hacen los handlers cuando necesitan datos frescos).
5. After populating `req.user`, `authenticate` **MUST** enforce a read-only policy for demo users before invoking the business handler: if `req.user.isDemo` is `true` and the request method is not a safe method (`GET`, `HEAD`, `OPTIONS`), it **MUST** respond `403` with stable error code `DEMO_READ_ONLY` and **MUST NOT** call `next()`, so no state is mutated. Safe methods **MUST** be allowed to proceed. Non-demo users **MUST** be unaffected by this policy (existing role-based behavior preserved).

(Previously: `authenticate` set `req.user = { id, role }` and enforced no method-based policy.)

#### Scenario: Token válido pasa al siguiente handler

- GIVEN un token válido y no expirado
- WHEN `authenticate` lo procesa
- THEN llama a `next()` con `req.user = { id, role, isDemo }` correctamente poblado

#### Scenario: Demo user allowed safe methods

- GIVEN an authenticated request with `req.user.isDemo = true`
- WHEN the method is `GET`, `HEAD`, or `OPTIONS`
- THEN `authenticate` calls `next()` and the request proceeds normally

#### Scenario: Demo user denied unsafe method before mutation

- GIVEN an authenticated request with `req.user.isDemo = true`
- WHEN the method is `POST`, `PUT`, `PATCH`, `DELETE`, or any other unsafe verb
- THEN `authenticate` responds `403` with `error: 'DEMO_READ_ONLY'`
- AND the business handler never runs and no state is mutated

#### Scenario: Non-demo user unaffected by read-only policy

- GIVEN an authenticated request with `req.user.isDemo = false` and a role permitting the action
- WHEN the method is `POST`, `PUT`, `PATCH`, or `DELETE`
- THEN the read-only policy does not apply and existing role-based authorization decides the outcome

## ADDED Requirements

### Requirement: Demo lifecycle endpoints remain usable

Login, refresh, and logout **MUST** remain fully usable by the demo account. These endpoints **MUST NOT** be blocked by the demo read-only policy, because logging in and rotating or clearing a session are not resource mutations subject to the demo write-denial.

#### Scenario: Demo account logs in

- GIVEN valid credentials for a `User` with `isDemo = true`
- WHEN `POST /api/auth/login`
- THEN responds `200` with `{ user, token }` and sets the `refresh_token` cookie

#### Scenario: Demo account refreshes and logs out

- GIVEN an active demo session with a valid `refresh_token` cookie
- WHEN `POST /api/auth/refresh` then `POST /api/auth/logout`
- THEN refresh responds `200` with a rotated cookie AND logout responds `204` clearing the cookie

### Requirement: Demo-scoped refresh-token cleanup

After fresh access/refresh token issuance or rotation for a demo user (`isDemo = true`), the system **MUST** prune only that demo user's `RefreshToken` rows that are already `revoked = true` or already past `expiresAt`. Cleanup **MUST** run only after the new active row has been created, so no live session is ever removed. Cleanup **MUST NOT** delete any live, unexpired row (including other concurrent sessions' rows), and **MUST NOT** apply this demo-specific pruning to non-demo users. Cleanup **MUST** be scoped to the acting demo user's `userId` only.

If cleanup fails after successful token issuance, the system **MUST** still return the successfully issued token to the caller (the login/refresh outcome **MUST NOT** be reported as failed), and the cleanup failure **MUST** be logged (observable) rather than silently swallowed. The contract **MUST NOT** leave an ambiguous half-success where the client cannot tell whether authentication succeeded.

#### Scenario: Cleanup runs after issuance and prunes only dead rows

- GIVEN a demo user with one revoked and one expired `RefreshToken` row plus a freshly created active row
- WHEN login or refresh completes issuance for that demo user
- THEN cleanup deletes the revoked and expired rows AND keeps the fresh active row

#### Scenario: Concurrent live sessions survive cleanup

- GIVEN two concurrent demo sessions each holding a distinct live, unexpired `RefreshToken` row
- WHEN one session refreshes and triggers cleanup
- THEN both sessions' live rows remain valid AND the other session can still refresh

#### Scenario: Non-demo user not subject to demo cleanup

- GIVEN a non-demo user (`isDemo = false`) logging in or refreshing
- WHEN issuance completes
- THEN the demo-specific pruning does not run and that user's revoked/expired rows are left untouched

#### Scenario: Cleanup failure does not fail authentication

- GIVEN a demo login/refresh where token issuance succeeds but the subsequent cleanup operation throws
- WHEN the request completes
- THEN the response returns the issued token (auth reported as success) AND the cleanup failure is logged for observability
