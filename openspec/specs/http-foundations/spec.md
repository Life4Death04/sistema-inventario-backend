# Especificación: http-foundations

## Purpose

Definir el bootstrap del servidor Express con sus middlewares transversales: seguridad (`helmet`, `cors`, rate limiting), logging estructurado (Pino), manejo global de errores con envelope JSON consistente, helper de validación con Zod, envelope universal de paginación + helper, y health check. Estas piezas son consumidas por TODOS los módulos posteriores.

## Requirements

### Requirement: Bootstrap Express y separación app/server

`src/app.ts` **MUST** exportar una función o instancia que construya la aplicación Express **sin** llamar a `listen()`. `src/server.ts` **MUST** importar `app`, validar `env`, y llamar a `app.listen(PORT)`. Esta separación permite Supertest sin abrir puertos.

#### Scenario: App utilizable por Supertest sin abrir puerto

- GIVEN un test importa `app` desde `src/app.ts`
- WHEN llama a `request(app).get('/api/health')`
- THEN obtiene una respuesta sin que se abra ningún socket TCP

### Requirement: Middlewares de seguridad por defecto

La aplicación **MUST** registrar, en este orden, antes de cualquier ruta:

1. `helmet()` con defaults seguros.
2. `cors({ origin: env.FRONTEND_URL, credentials: true })`.
3. `cookie-parser` (necesario para refresh token cookie).
4. `express.json({ limit: '1mb' })`.
5. `pino-http` logger.
6. `express-rate-limit` aplicado al prefijo `/api/*` con `max = env.RATE_LIMIT_MAX` (default 100) y `windowMs = env.RATE_LIMIT_WINDOW_MS` (default 900000 = 15 min). Configuración leída de env vars.

#### Scenario: CORS bloquea origen no autorizado

- GIVEN `env.FRONTEND_URL = 'http://localhost:5173'`
- WHEN llega un request con `Origin: https://evil.com`
- THEN CORS rechaza el preflight; el navegador bloquea la respuesta

#### Scenario: Rate limit dispara 429

- GIVEN un cliente envía 101 requests a `/api/*` en menos de 15 minutos desde la misma IP
- WHEN llega el request #101
- THEN el servidor responde `429 Too Many Requests` con el envelope de error estándar (`{ error: 'RATE_LIMIT_EXCEEDED', message, statusCode: 429 }`)

### Requirement: Envelope de error JSON consistente

Todo response de error **MUST** seguir esta forma exacta:

```json
{
  "error": "MACHINE_READABLE_CODE",
  "message": "Mensaje legible para humanos.",
  "statusCode": 400,
  "details": { "campo": "razón específica" }
}
```

- `error`: `string` en `SCREAMING_SNAKE_CASE`, código estable para clientes.
- `message`: `string`, texto orientado a humanos (puede traducirse).
- `statusCode`: `number`, mismo valor que el HTTP status.
- `details`: opcional, solo presente cuando aplica (ej: errores Zod).

#### Scenario: AppError personalizada propaga código

- GIVEN un controller lanza `throw new AppError('PRODUCT_NOT_FOUND', 'Producto no existe', 404)`
- WHEN el middleware de error captura la excepción
- THEN responde `404` con body `{ error: 'PRODUCT_NOT_FOUND', message: 'Producto no existe', statusCode: 404 }`

#### Scenario: Error no controlado en producción

- GIVEN `NODE_ENV=production` y un controller lanza un `TypeError` sin atrapar
- WHEN el middleware global lo recibe
- THEN logea el stack completo vía Pino y responde `500` con `{ error: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', statusCode: 500 }` (sin filtrar stack al cliente)

#### Scenario: Error no controlado en development

- GIVEN `NODE_ENV=development` y un controller lanza `Error('boom')`
- WHEN el middleware global lo recibe
- THEN responde `500` con `error`, `message`, `statusCode` **y** un campo `details.stack` con el stack para debug local

### Requirement: Ruta no encontrada (404 fallback)

La aplicación **MUST** registrar, después de todas las rutas, un middleware que capture peticiones a paths inexistentes y responda `404` con el envelope estándar.

#### Scenario: GET a ruta inexistente

- GIVEN no existe la ruta `/api/foo`
- WHEN un cliente hace `GET /api/foo`
- THEN responde `404` con `{ error: 'NOT_FOUND', message: 'Route GET /api/foo not found.', statusCode: 404 }`

### Requirement: Helper de validación Zod

El módulo `src/shared/validation` **MUST** exportar:

```ts
validate(schema: ZodSchema, target: 'body' | 'params' | 'query'): RequestHandler
```

En éxito, **MUST** reemplazar `req[target]` con el resultado parseado (datos tipados). En error, **MUST** responder `400` con `error: 'VALIDATION_ERROR'` y `details` mapeando `path → mensaje` de cada issue Zod.

Ejemplo de response de error de validación:

```json
{
  "error": "VALIDATION_ERROR",
  "message": "Invalid request body.",
  "statusCode": 400,
  "details": {
    "email": "Invalid email",
    "password": "String must contain at least 8 character(s)"
  }
}
```

#### Scenario: Body válido pasa al controller

- GIVEN una ruta usa `validate(loginSchema, 'body')`
- WHEN llega un POST con body válido
- THEN el handler siguiente recibe `req.body` ya parseado y tipado

#### Scenario: Body inválido produce 400 con detalles

- GIVEN una ruta usa `validate(loginSchema, 'body')` donde `password` requiere min 8 chars
- WHEN llega `{ email: 'a@b.com', password: 'x' }`
- THEN responde `400` con `details.password` describiendo la violación

### Requirement: Envelope y helper de paginación

Toda lista futura **MUST** responder con la forma:

```json
{
  "data": [ /* T[] */ ],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 137,
    "totalPages": 7
  }
}
```

Query params aceptados por todos los endpoints de listado:

| Param | Tipo | Default | Validación |
|-------|------|---------|------------|
| `page` | int | `1` | `min 1` |
| `limit` | int | `20` | `min 1`, `max 100` |
| `sort` | string | none | formato `field:asc` o `field:desc` |
| `search` | string | none | texto libre |
| `filter[<key>]` | string | none | object-style; el módulo decide los keys permitidos |

El módulo `src/shared/pagination` **MUST** exportar:

- Un Zod schema reusable `paginationQuerySchema` que parsee y normalice los query params.
- Una función `paginate<T>({ data, total, page, limit }): PaginatedResponse<T>` que arma el envelope.

#### Scenario: Defaults aplicados

- GIVEN una ruta de listado sin query params
- WHEN se invoca el helper
- THEN `page = 1`, `limit = 20`

#### Scenario: `limit` por encima del máximo

- GIVEN un request con `?limit=500`
- WHEN el helper valida
- THEN responde `400` con `details.limit` indicando `max 100`

#### Scenario: Sort mal formateado

- GIVEN un request con `?sort=name`  (sin `:direction`)
- WHEN el helper valida
- THEN responde `400` con `details.sort` indicando el formato esperado `field:asc|desc`

### Requirement: Logging estructurado con Pino

La aplicación **MUST** usar Pino como logger global. `pino-http` **MUST** loggear cada request con: método, path, status, latency, y un `requestId` (UUID v4 generado por middleware si no llega en header `X-Request-Id`). Nivel configurable vía `env.LOG_LEVEL`.

#### Scenario: Logs en JSON

- GIVEN un request a `GET /api/health`
- WHEN se procesa
- THEN aparece una línea de log en stdout en formato JSON con `req.method`, `req.url`, `res.statusCode`, `responseTime`, `requestId`

### Requirement: Health check

`GET /api/health` **MUST** responder siempre `200 OK` si el proceso está vivo. Body:

```json
{
  "status": "ok",
  "timestamp": "2026-06-29T18:30:00.000Z",
  "uptime": 1234.56,
  "db": "ok"
}
```

- `timestamp`: ISO 8601 UTC.
- `uptime`: segundos desde el arranque del proceso (`process.uptime()`).
- `db`: `'ok'` si `SELECT 1` contra Postgres tuvo éxito en menos de 2 segundos, `'down'` en caso contrario.

Si la DB está caída, el endpoint **MUST** seguir respondiendo `200` (el endpoint reporta salud, no falla por ella) pero con `db: 'down'`.

#### Scenario: DB disponible

- GIVEN Postgres está OK
- WHEN se hace `GET /api/health`
- THEN responde `200` con `db: 'ok'`

#### Scenario: DB caída

- GIVEN Postgres no acepta conexiones
- WHEN se hace `GET /api/health`
- THEN responde `200` con `db: 'down'` y los demás campos correctos

#### Scenario: Health no requiere autenticación

- GIVEN un request a `/api/health` sin `Authorization`
- WHEN llega al servidor
- THEN responde `200` (no se aplica `authenticate`)

## API contracts

### `GET /api/health`

**Request**: sin body, sin auth.

**Response 200**:
```json
{ "status": "ok", "timestamp": "2026-06-29T18:30:00.000Z", "uptime": 42.7, "db": "ok" }
```

### Error envelope (aplica a todos los endpoints)

```json
{ "error": "VALIDATION_ERROR", "message": "Invalid request body.", "statusCode": 400, "details": { "email": "Invalid email" } }
```

```json
{ "error": "NOT_FOUND", "message": "Route GET /api/foo not found.", "statusCode": 404 }
```

```json
{ "error": "RATE_LIMIT_EXCEEDED", "message": "Too many requests, please try again later.", "statusCode": 429 }
```

```json
{ "error": "INTERNAL_ERROR", "message": "An unexpected error occurred.", "statusCode": 500 }
```

## Acceptance

- [ ] `app.ts` no llama `listen()`; `server.ts` sí.
- [ ] `helmet`, `cors`, `cookie-parser`, `express.json`, `pino-http`, `express-rate-limit` registrados en orden.
- [ ] Rate limit configurable via env y aplicado a `/api/*`.
- [ ] Middleware global de error responde con el envelope exacto definido.
- [ ] 404 fallback registrado después de todas las rutas.
- [ ] `validate(schema, target)` exportado y funcional para body/params/query.
- [ ] `paginationQuerySchema` y `paginate()` exportados desde `src/shared/pagination`.
- [ ] `GET /api/health` retorna el shape exacto, incluido `db: 'ok'|'down'` vía `SELECT 1`.
- [ ] Logs estructurados en JSON con `requestId`.
- [ ] Smoke tests de health pasan (sin auth, con DB ok y simulando DB down).
