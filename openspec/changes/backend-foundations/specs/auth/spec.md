# Especificación: auth

## Purpose

Definir los 4 endpoints de autenticación (login, refresh, logout, me), la estrategia dual de JWT (access token corto en header + refresh token largo en cookie httpOnly), y los middlewares transversales `authenticate` y `requireRole(...roles)` que protegerán los endpoints de todos los módulos. Esta capability es la única que escribe en User en foundations (vía el seed) y la única que emite tokens.

## Requirements

### Requirement: Hashing de contraseñas con bcrypt

Las contraseñas **MUST** almacenarse hasheadas con **bcrypt cost factor 10**. La contraseña en texto plano **MUST NOT** persistirse nunca, ni loggearse, ni aparecer en ningún response.

#### Scenario: Comparación en login

- GIVEN un `User` con `password` = bcrypt-hash de `"ChangeMe123!"`
- WHEN el endpoint de login recibe `password: "ChangeMe123!"`
- THEN `bcrypt.compare()` retorna `true` y el login procede

#### Scenario: Password jamás en respuesta

- GIVEN un endpoint que retorna un `User`
- WHEN serializa el objeto
- THEN el campo `password` está ausente del JSON (sanitización en la capa de service/controller)

### Requirement: Access token (JWT corto)

El access token **MUST** ser un JWT firmado con **HS256** usando `env.JWT_ACCESS_SECRET`. TTL: **15 minutos** (configurable vía `env.JWT_ACCESS_TTL`, default `15m`).

Payload exacto:

```json
{
  "sub": "cuid-del-user",
  "role": "ADMIN | MANAGER | OPERATOR",
  "iat": 1700000000,
  "exp": 1700000900
}
```

Se envía en el header `Authorization: Bearer <token>`.

#### Scenario: Token expira a los 15 minutos

- GIVEN un access token emitido con `exp = iat + 900`
- WHEN se intenta usar 16 minutos después
- THEN `authenticate` responde `401` con `error: 'TOKEN_EXPIRED'`

#### Scenario: Token con secret inválido

- GIVEN un token firmado con otro secret
- WHEN llega a `authenticate`
- THEN responde `401` con `error: 'INVALID_TOKEN'`

### Requirement: Refresh token (cookie httpOnly)

El refresh token **MUST** ser un JWT firmado con **HS256** usando `env.JWT_REFRESH_SECRET` (distinto del access). TTL: **7 días** (configurable vía `env.JWT_REFRESH_TTL`, default `7d`).

Se entrega y recibe en una cookie con todos estos atributos:

```
Set-Cookie: refresh_token=<jwt>;
  HttpOnly;
  Secure;
  SameSite=Strict;
  Path=/api/auth;
  Max-Age=604800
```

En `NODE_ENV=development` el flag `Secure` **MAY** omitirse para permitir testing local sobre HTTP, pero esto **MUST** documentarse en el README.

Payload:

```json
{ "sub": "cuid-del-user", "iat": ..., "exp": ... }
```

(no incluye `role` — la fuente de verdad del rol está en la DB y se relee en refresh).

#### Scenario: Cookie no accesible vía JavaScript

- GIVEN un refresh token guardado como cookie httpOnly
- WHEN el navegador carga la página
- THEN `document.cookie` no muestra `refresh_token` (httpOnly)

### Requirement: POST /api/auth/login

**Body** (validado por Zod):

```json
{ "email": "admin@highmeds.local", "password": "ChangeMe123!" }
```

**Validación**:
- `email`: string, email válido, requerido.
- `password`: string, min 1 char (no se exigen reglas de complejidad aquí; eso es responsabilidad del módulo de usuarios cuando se gestione cambio de password).

**Response 200**:

```json
{
  "user": {
    "id": "cko1...",
    "fullName": "Administrador",
    "email": "admin@highmeds.local",
    "role": "ADMIN",
    "active": true,
    "phone": null,
    "createdAt": "2026-06-29T10:00:00.000Z"
  },
  "token": "eyJhbGciOiJIUzI1NiIs..."
}
```

**Headers de response**:
```
Set-Cookie: refresh_token=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=604800
```

**Errores**:

- `400 VALIDATION_ERROR` — body inválido.
- `401 INVALID_CREDENTIALS` — email no existe O password no coincide. El servidor **MUST** retornar el mismo error para ambos casos (no filtrar existencia de usuarios).
- `403 USER_INACTIVE` — usuario existe con password correcto pero `active = false`.

```json
{ "error": "INVALID_CREDENTIALS", "message": "Email or password is incorrect.", "statusCode": 401 }
```

#### Scenario: Login exitoso

- GIVEN un user `ADMIN` activo con email y password correctos
- WHEN `POST /api/auth/login` con credenciales válidas
- THEN responde `200` con `{ user, token }` y setea cookie `refresh_token`
- AND `user.password` **NO** está en el payload

#### Scenario: Password incorrecta

- GIVEN un user existente con password distinta a la enviada
- WHEN `POST /api/auth/login`
- THEN responde `401 INVALID_CREDENTIALS`

#### Scenario: Email no registrado

- GIVEN un email que no existe en DB
- WHEN `POST /api/auth/login`
- THEN responde `401 INVALID_CREDENTIALS` (mismo mensaje que password incorrecta)

#### Scenario: Usuario inactivo

- GIVEN un user con `active = false` y password correcta
- WHEN `POST /api/auth/login`
- THEN responde `403 USER_INACTIVE`

### Requirement: POST /api/auth/refresh

Lee la cookie `refresh_token`. Si es válida y no expiró, **MUST** emitir un nuevo access token y **MUST rotar el refresh token** (emitir uno nuevo, setear cookie).

**Body**: vacío.

**Response 200**:

```json
{ "token": "eyJhbGciOiJIUzI1NiIs..." }
```

**Headers**: nueva cookie `refresh_token` (rotada).

**Errores**:

- `401 MISSING_REFRESH_TOKEN` — cookie ausente.
- `401 INVALID_REFRESH_TOKEN` — cookie presente pero firma inválida o expirada.
- `401 USER_INACTIVE_OR_DELETED` — `sub` ya no resuelve a un user activo en DB.

#### Scenario: Refresh exitoso rota cookie

- GIVEN una cookie `refresh_token` válida
- WHEN `POST /api/auth/refresh`
- THEN responde `200` con nuevo access token
- AND el response setea una nueva cookie `refresh_token` (valor distinto al recibido)

#### Scenario: Sin cookie

- GIVEN un request sin cookie `refresh_token`
- WHEN `POST /api/auth/refresh`
- THEN responde `401 MISSING_REFRESH_TOKEN`

#### Scenario: Cookie expirada

- GIVEN una cookie cuyo `exp` ya pasó
- WHEN `POST /api/auth/refresh`
- THEN responde `401 INVALID_REFRESH_TOKEN`

### Requirement: POST /api/auth/logout

Limpia la cookie `refresh_token` enviando un `Set-Cookie` que la expire inmediatamente.

**Body**: vacío. **Auth**: no requerida (logout debe funcionar incluso con access token expirado).

**Response**: `204 No Content`. Sin body.

**Headers**:
```
Set-Cookie: refresh_token=; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0
```

#### Scenario: Logout sin sesión previa

- GIVEN un cliente sin cookie
- WHEN `POST /api/auth/logout`
- THEN responde `204` igualmente (idempotente)

#### Scenario: Logout invalida la cookie en el cliente

- GIVEN una cookie `refresh_token` válida
- WHEN `POST /api/auth/logout`
- THEN responde `204` con cookie de expiración inmediata
- AND el siguiente `POST /api/auth/refresh` responde `401 MISSING_REFRESH_TOKEN`

### Requirement: GET /api/auth/me

Devuelve el user autenticado. **Auth**: requerida (`authenticate`).

**Response 200**:

```json
{
  "user": {
    "id": "cko1...",
    "fullName": "Administrador",
    "email": "admin@highmeds.local",
    "role": "ADMIN",
    "active": true,
    "phone": null,
    "createdAt": "2026-06-29T10:00:00.000Z"
  }
}
```

**Errores**:
- `401 MISSING_TOKEN` — header `Authorization` ausente.
- `401 INVALID_TOKEN` — firma inválida.
- `401 TOKEN_EXPIRED` — `exp` ya pasó.

#### Scenario: Me con Bearer válido

- GIVEN un access token válido
- WHEN `GET /api/auth/me` con header `Authorization: Bearer <token>`
- THEN responde `200` con `{ user: { ... } }` sin `password`

#### Scenario: Me sin header

- GIVEN ningún header `Authorization`
- WHEN `GET /api/auth/me`
- THEN responde `401 MISSING_TOKEN`

### Requirement: Middleware `authenticate`

Función `authenticate: RequestHandler` que:

1. Lee header `Authorization`. Si ausente o no empieza con `Bearer `, responde `401 MISSING_TOKEN`.
2. Verifica el JWT con `JWT_ACCESS_SECRET`. Si firma inválida → `401 INVALID_TOKEN`. Si expirado → `401 TOKEN_EXPIRED`.
3. Pone `req.user = { id, role }` (decodificado del payload) para que los siguientes middlewares y controllers lo usen.
4. **No** consulta la DB en cada request (eso lo hacen los handlers cuando necesitan datos frescos).

#### Scenario: Token válido pasa al siguiente handler

- GIVEN un token válido y no expirado
- WHEN `authenticate` lo procesa
- THEN llama a `next()` con `req.user = { id, role }` correctamente poblado

### Requirement: Middleware `requireRole(...roles)`

Función `requireRole(...allowed: UserRole[]): RequestHandler` que **MUST** ejecutarse **después** de `authenticate`. Si `req.user.role` no está en `allowed`, responde `403 FORBIDDEN`.

```json
{ "error": "FORBIDDEN", "message": "You do not have permission to perform this action.", "statusCode": 403 }
```

#### Scenario: Rol permitido

- GIVEN un user con `role = ADMIN`
- WHEN llega a una ruta protegida con `requireRole('ADMIN', 'MANAGER')`
- THEN el middleware llama `next()` y el controller corre

#### Scenario: Rol denegado

- GIVEN un user con `role = OPERATOR`
- WHEN llega a una ruta protegida con `requireRole('ADMIN')`
- THEN responde `403 FORBIDDEN` sin invocar el controller

#### Scenario: requireRole sin authenticate previo

- GIVEN una ruta mal configurada que usa `requireRole` sin `authenticate` antes
- WHEN llega un request
- THEN el middleware responde `500 INTERNAL_ERROR` (defensa en profundidad: si `req.user` no existe, hay un bug de configuración)

## API contracts (resumen)

| Método | Path | Auth | Body | Response 200/204 | Errores |
|--------|------|------|------|------------------|---------|
| POST | `/api/auth/login` | No | `{ email, password }` | `{ user, token }` + Set-Cookie | 400, 401, 403 |
| POST | `/api/auth/refresh` | Cookie | — | `{ token }` + Set-Cookie (rotada) | 401 |
| POST | `/api/auth/logout` | No | — | `204` + Set-Cookie expirada | — |
| GET | `/api/auth/me` | Bearer | — | `{ user }` | 401 |

## Acceptance

- [ ] `bcrypt` con cost 10 utilizado en hashing y compare.
- [ ] Access token firma HS256, 15 min, payload `{ sub, role, iat, exp }`.
- [ ] Refresh token firma HS256, 7 días, cookie `refresh_token` con `HttpOnly; Secure; SameSite=Strict; Path=/api/auth`.
- [ ] `POST /api/auth/login` retorna shape exacto `{ user: { id, fullName, email, role, active, phone, createdAt }, token }`.
- [ ] `POST /api/auth/login` retorna `401 INVALID_CREDENTIALS` para email inexistente **y** para password incorrecta (mensaje idéntico).
- [ ] `POST /api/auth/refresh` rota la cookie en cada llamada exitosa.
- [ ] `POST /api/auth/logout` retorna `204` y limpia la cookie.
- [ ] `GET /api/auth/me` requiere Bearer y retorna user sin `password`.
- [ ] `authenticate` setea `req.user = { id, role }`.
- [ ] `requireRole(...)` bloquea con `403` si el rol no coincide.
- [ ] Smoke tests cubren: login OK, login KO (3 casos), refresh OK, refresh KO, logout, me OK, me KO, requireRole permitido, requireRole denegado.
