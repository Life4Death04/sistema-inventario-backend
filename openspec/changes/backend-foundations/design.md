# Design: Backend Foundations

> Proyecto: sistema-inventario-backend (Farmacia HighMeds) — Tesis de pasantía, un solo desarrollador.
> Inputs autoritativos: `proposal.md` (#261), design-decisions (#260), source-report-context (#259), pending-Producto (#262).
> Prosa en español; identificadores técnicos, env vars y código en inglés.

---

## 1. Arquitectura general

El informe declara un modelo **cliente-servidor de 3 niveles** (presentación, lógica, datos). El frontend (React + Vite) es la presentación; PostgreSQL es el dato; este backend es la **capa lógica** y se organiza internamente como **arquitectura por capas modular**:

```
HTTP request
   ↓
[express middleware chain]   ← cross-cutting
   ↓
routes (modules/<x>/<x>.routes.ts)
   ↓
controllers                  ← parse req, call service, format response
   ↓
services                     ← reglas de negocio, lanzan AppError
   ↓
repositories (Prisma)        ← acceso a datos, sin reglas de negocio
   ↓
PostgreSQL
```

### Por qué encaja

- **Coherente con el informe** (3 niveles + descomposición por módulos).
- **Cognitive load bajo para un solo developer**: cada feature vive en una carpeta auto-contenida; las dependencias cruzadas se hacen explícitas a nivel de servicio.
- **Testabilidad clara**: el repository se mockea fácilmente; los servicios se testean unitariamente sin Express; los routes/controllers se cubren con Supertest.
- **No requiere infraestructura adicional** (no hay message bus, ni workers, ni CQRS). Mantiene la complejidad accidental cerca de cero — apropiado para un MVP de tesis.

### Reglas de frontera entre módulos

1. Un servicio **NO** importa el `repository` de otro módulo. Si necesita datos de otro dominio, llama al **servicio** de ese dominio.
2. Los `controllers` solo conocen sus propios `services`.
3. `shared/` es de solo lectura para los módulos: middlewares, errores, utils, logger, config. Nunca importa desde `modules/`.
4. Eventos / pub-sub se **difieren** — innecesarios hasta que aparezca el módulo de alertas+cron.

---

## Stack y versiones (referencia transversal)

> Stack fijado por el informe Semana 5 + las decisiones del usuario. Versiones pineadas a **LTS estables a junio 2026**. Cada slice de `sdd-apply` debe respetar exactamente estas versiones salvo aprobación explícita.

| Capa            | Tecnología                  | Versión               | Por qué esta y no otra                                                                  |
|-----------------|-----------------------------|-----------------------|------------------------------------------------------------------------------------------|
| Runtime         | Node.js                     | **20 LTS**            | LTS hasta abr-2026 con soporte de mantenimiento extendido; `node:test` nativo; fetch GA |
| Lenguaje        | TypeScript                  | **5.4.x**             | `strict` estable; satisface tipos del frontend                                          |
| Framework HTTP  | Express                     | **4.19.x**            | Madurez + ecosistema; Express 5 aún no es default mainstream (ver decisión #3)          |
| ORM             | Prisma                      | **5.x**               | Type-safety end-to-end; migraciones reproducibles; mejor DX que Knex/TypeORM            |
| Base de datos   | PostgreSQL                  | **15-alpine**         | Versión soportada hasta 2027; suficiente para volumen de farmacia local                 |
| Validación      | Zod                         | **3.23.x**            | Mismo runtime de tipos en boundary HTTP + env; bundles bajo                             |
| Auth tokens     | jsonwebtoken                | **9.x**               | Default en industria; HS256 nativo                                                       |
| Hashing         | bcrypt                      | **5.x**               | Cost configurable; ver decisión #6                                                       |
| Seguridad HTTP  | helmet, cors, rate-limit    | helmet 7, cors 2, rate-limit 7 | Defaults seguros; ver sección "Security baseline"                                |
| Logging         | pino + pino-http            | pino 9, pino-http 10  | JSON-first, alto rendimiento; redacción nativa                                          |
| Testing         | Vitest + Supertest          | vitest 1.x, supertest 7 | Mismo motor que el frontend; ESM-native; rápido                                       |
| Dev runner      | tsx (`npm run dev`)         | **4.x**               | Reemplaza `ts-node-dev`; ESM-native; menos config                                       |
| Linter/Format   | ESLint + Prettier           | eslint 9, prettier 3  | Estándar del ecosistema; flat config con eslint 9                                       |
| Pre-commit      | Husky + lint-staged         | husky 9, lint-staged 15 | Pre-commit local barato; sin CI/CD obligatorio en foundations                          |
| Container       | docker + docker-compose     | compose v2            | Reproducibilidad dev; sin paridad prod en foundations                                   |
| Mensajería (deferida) | Twilio SDK            | —                     | Se introduce en change `replenishment`, no en foundations                                |
| Cron (deferido) | node-cron                   | —                     | Se introduce en change `stock-alerts`, no en foundations                                 |

**Alternativas descartadas (a nivel stack):**

| Capa     | Alternativa            | Por qué descartada                                                          |
|----------|------------------------|-----------------------------------------------------------------------------|
| Framework | Fastify, NestJS       | Informe declara Express; menor sorpresa, comunidad enorme, suficiente perf |
| ORM      | TypeORM, Knex, Drizzle | Prisma ya declarado por informe; mejor DX para schema-first                |
| Logger   | Winston, Bunyan        | Pino: más rápido y JSON puro por default                                    |
| Tests    | Jest                   | Vitest comparte motor con frontend (Vite); arranque y watch más rápidos    |

**Trade-off transversal**: pinear versiones reduce sorpresas pero exige bumps manuales. Aceptado: tesis de un solo desarrollador, sin Dependabot.

---

## 2. Estructura de carpetas

```
sistema-inventario-backend/
├── .env.example
├── .eslintrc.cjs
├── .prettierrc
├── .gitignore
├── .husky/
│   └── pre-commit               # lint-staged + typecheck
├── docker-compose.dev.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
│
├── prisma/
│   ├── schema.prisma
│   ├── migrations/
│   └── seed.ts                  # crea admin inicial
│
├── src/
│   ├── index.ts                 # entry point — arranca server.ts
│   ├── server.ts                # listen() + graceful shutdown
│   ├── app.ts                   # construye el Express app (sin listen)
│   │
│   ├── config/
│   │   └── env.ts               # carga .env + valida con Zod, fail-fast
│   │
│   ├── shared/
│   │   ├── errors/
│   │   │   ├── AppError.ts
│   │   │   ├── errorCodes.ts
│   │   │   └── errorHandler.ts  # middleware global
│   │   ├── middleware/
│   │   │   ├── authenticate.ts
│   │   │   ├── requireRole.ts
│   │   │   ├── validate.ts      # factory: validate(schema, 'body'|'query'|'params')
│   │   │   ├── rateLimit.ts
│   │   │   └── notFound.ts
│   │   ├── utils/
│   │   │   ├── asyncHandler.ts
│   │   │   ├── paginate.ts
│   │   │   ├── parseSort.ts
│   │   │   └── jwt.ts           # sign/verify access + refresh
│   │   ├── logger/
│   │   │   ├── logger.ts        # pino instance
│   │   │   └── httpLogger.ts    # pino-http config
│   │   └── db/
│   │       └── prisma.ts        # PrismaClient singleton
│   │
│   └── modules/
│       ├── auth/
│       │   ├── auth.routes.ts
│       │   ├── auth.controller.ts
│       │   ├── auth.service.ts
│       │   ├── auth.repository.ts   # RefreshToken queries
│       │   ├── auth.schema.ts       # Zod: loginSchema, refreshSchema
│       │   ├── auth.types.ts
│       │   └── auth.service.test.ts
│       └── health/
│           ├── health.routes.ts
│           ├── health.controller.ts
│           └── health.service.ts    # ping a Prisma
│
└── tests/
    ├── setup.ts                 # init test DB, before/after hooks
    ├── helpers/
    │   ├── testClient.ts        # Supertest agent
    │   └── factories.ts
    └── integration/
        ├── health.test.ts
        └── auth.test.ts
```

### Convenciones de nombres

| Tipo               | Sufijo                  | Ejemplo                       |
|--------------------|-------------------------|-------------------------------|
| Rutas Express      | `*.routes.ts`           | `auth.routes.ts`              |
| Controladores      | `*.controller.ts`       | `auth.controller.ts`          |
| Servicios          | `*.service.ts`          | `auth.service.ts`             |
| Repositorios       | `*.repository.ts`       | `auth.repository.ts`          |
| Schemas Zod        | `*.schema.ts`           | `auth.schema.ts`              |
| Tipos derivados    | `*.types.ts`            | `auth.types.ts`               |
| Tests unitarios    | `*.test.ts` (junto al código) | `auth.service.test.ts`  |
| Tests integración  | `tests/integration/*.test.ts` | `auth.test.ts`          |

---

## 3. Configuración y entorno

### `config/env.ts` — validación fail-fast

```ts
import { z } from 'zod';
import 'dotenv/config';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('7d'),
  BCRYPT_COST: z.coerce.number().int().min(8).max(14).default(10),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().default(100),
  LOG_LEVEL: z.enum(['fatal','error','warn','info','debug','trace']).default('info'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}
export const env = parsed.data;
```

### Catálogo de env vars

| Variable               | Requerido | Default                  | Notas                                |
|------------------------|-----------|--------------------------|--------------------------------------|
| `NODE_ENV`             | no        | `development`            | `production` cambia logger + cookies |
| `PORT`                 | no        | `3000`                   |                                      |
| `DATABASE_URL`         | **sí**    | —                        | `postgresql://user:pass@host:5432/db`|
| `JWT_ACCESS_SECRET`    | **sí**    | —                        | ≥ 32 chars                            |
| `JWT_REFRESH_SECRET`   | **sí**    | —                        | ≥ 32 chars, distinto al access        |
| `JWT_ACCESS_TTL`       | no        | `15m`                    | string `ms`-style                     |
| `JWT_REFRESH_TTL`      | no        | `7d`                     |                                      |
| `BCRYPT_COST`          | no        | `10`                     | 10 = balance seguridad/DX             |
| `FRONTEND_URL`         | no        | `http://localhost:5173`  | usado por CORS                        |
| `RATE_LIMIT_WINDOW_MS` | no        | `60000`                  |                                      |
| `RATE_LIMIT_MAX`       | no        | `100`                    |                                      |
| `LOG_LEVEL`            | no        | `info`                   | `debug` en dev                        |

### Secretos

- **`.env`** está en `.gitignore`. NUNCA se commitea.
- **`.env.example`** se versiona con valores vacíos o placeholders (`changeme-32-chars-minimum-secret`).
- En Docker dev, `docker-compose.dev.yml` lee `.env` via `env_file`.

---

## 4. Ciclo de vida de un request

### Orden de middlewares de Express (en `app.ts`)

```
helmet                  ← 1. cabeceras de seguridad primero
cors({ origin: FRONTEND_URL, credentials: true })
cookieParser            ← refresh token cookie
express.json({ limit: '1mb' })
express.urlencoded({ extended: false })
rateLimit (global, escapable por ruta)
pinoHttp                ← log de cada request con reqId
/api router             ← monta todos los routes
notFoundHandler         ← 404 catch-all
errorHandler            ← último; convierte cualquier error a envelope JSON
```

### Dentro de una ruta protegida típica

```
authenticate                ← valida Bearer, popula req.user
requireRole('ADMIN')        ← opcional, según endpoint
validate(loginSchema,'body')← reemplaza req.body por el parseado
controller.handler          ← extrae datos ya tipados, llama service
service.execute             ← reglas; lanza AppError si falla
repository.query            ← Prisma
res.status(200).json({...}) ← respuesta
```

### Manejo de errores async

**Decisión**: `express-async-errors` (paquete que parchea Express).

**Por qué**: requiere una sola línea `import 'express-async-errors';` al tope de `app.ts` y elimina la necesidad de envolver cada controlador con `asyncHandler`. Reduce ruido en controladores y elimina una fuente común de bugs (olvidar el wrapper). En 2026 el patch es estable y ampliamente usado. Express 5 lo hace nativo, pero al fecha mainstream sigue siendo 4.x.

> Trade-off: monkey-patching es "magia". Lo aceptamos por el ratio simplicidad/riesgo en un MVP de tesis. Si migramos a Express 5, eliminamos la dependencia sin más cambios.

---

## 5. Modelo de errores

### Clase `AppError`

```ts
export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
```

### Catálogo de códigos iniciales

| Code                 | HTTP | Cuándo                                                    |
|----------------------|------|-----------------------------------------------------------|
| `VALIDATION_FAILED`  | 400  | Zod falla en `validate` middleware                        |
| `INVALID_CREDENTIALS`| 401  | Login con email/password incorrectos                      |
| `TOKEN_EXPIRED`      | 401  | Access token expirado                                     |
| `TOKEN_INVALID`      | 401  | Firma inválida / malformado                               |
| `UNAUTHORIZED`       | 401  | Sin token en endpoint protegido                           |
| `FORBIDDEN`          | 403  | Token válido pero rol insuficiente                        |
| `NOT_FOUND`          | 404  | Recurso no existe                                         |
| `CONFLICT`           | 409  | Unique constraint, estado incoherente                     |
| `INTERNAL_ERROR`     | 500  | Catch-all desconocido (logueado con stack)                |

### Envelope de error

```json
{
  "error": "VALIDATION_FAILED",
  "message": "Body validation failed",
  "statusCode": 400,
  "details": { "fieldErrors": { "email": ["Invalid email"] } }
}
```

`details` opcional; se omite en `INTERNAL_ERROR` para no filtrar info.

### Reglas de propagación

- Services lanzan `AppError`. Nunca devuelven `null` con significado de error.
- Controllers **no** envuelven en try/catch operaciones rutinarias — `express-async-errors` propaga al `errorHandler`.
- `errorHandler` distingue: `AppError` → envelope con su `code/statusCode/details`; `ZodError` → 400 + `VALIDATION_FAILED`; `Prisma.PrismaClientKnownRequestError` con `P2002` → 409 `CONFLICT`; cualquier otro → 500 `INTERNAL_ERROR` + log con stack + `reqId`.

---

## 6. Autenticación y estrategia de refresh tokens (decisión central)

### Access token

- Algoritmo: **HS256** (suficiente para single-issuer, evita complejidad de keypairs).
- TTL: **15 min**.
- Transporte: header `Authorization: Bearer <jwt>`.
- Payload: `{ sub: userId, role: UserRole, iat, exp }`.

### Refresh token — Decisión: **JWT firmado + allowlist en DB (estrategia B)**

| Opción                              | Pros                                          | Contras                                            |
|------------------------------------|-----------------------------------------------|----------------------------------------------------|
| A. Stateless rotation              | Cero DB; simple                               | Imposible detectar reutilización; logout débil      |
| **B. JWT + DB allowlist (elegida)**| Detecta reuso; logout real; revocación atómica| 1 query extra por refresh; tabla extra              |

**Justificación**: el esfuerzo adicional es marginal (una tabla, dos queries) y demuestra consciencia de seguridad — valor agregado importante en un trabajo de tesis. Mantiene logout funcional aunque la cookie sobreviva.

### Modelo `RefreshToken`

```prisma
model RefreshToken {
  id        String   @id @default(cuid())   // == jti del JWT
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  revoked   Boolean  @default(false)
  revokedAt DateTime?
  createdAt DateTime @default(now())
  userAgent String?
  ip        String?

  @@index([userId])
  @@index([expiresAt])
}
```

### Flujo de rotación

```
login                    →  crea RefreshToken (jti=cuid), firma JWT con jti como sub-claim,
                            set cookie + responde access token.
refresh                  →  verifica JWT (firma + exp) → busca jti en DB →
                            si no existe OR revoked=true → revoca TODOS los del user (posible robo) + 401.
                            si OK → revoca el actual + crea uno nuevo + nueva cookie + nuevo access.
logout                   →  revoca el jti actual + clear cookie.
expira (cron, futuro)    →  delete WHERE expiresAt < now(). (No en foundations; manual por ahora.)
```

### Cookie del refresh token

```
name:      refresh_token
httpOnly:  true
secure:    NODE_ENV === 'production'
sameSite:  'strict'                ← mitiga CSRF
path:      '/api/auth'             ← solo enviada a endpoints de auth
maxAge:    7 días (en ms)
```

### bcrypt cost

- **10 rounds** — ~100ms en hardware dev típico. 12 sería ideal en producción pero 10 mantiene el login responsivo en desarrollo y es defendible frente a un ataque offline para una farmacia local.

---

## Security baseline (resumen consolidado)

> Tabla de defensa-en-profundidad. Cada ítem repite (o consolida) detalles ya distribuidos en §4, §5 y §6, para que la auditoría de seguridad no requiera reconstruir el diseño.

| Control                   | Configuración elegida                                            | Alternativa descartada                       | Trade-off / Razón                                                                                       |
|---------------------------|-------------------------------------------------------------------|----------------------------------------------|---------------------------------------------------------------------------------------------------------|
| `helmet`                  | Defaults (CSP off — API JSON, no HTML)                            | CSP custom                                   | No servimos HTML; CSP añade fricción sin valor; resto de headers (HSTS-ready, no-sniff, etc.) activos   |
| `cors`                    | `origin: env.FRONTEND_URL`, `credentials: true`                   | `origin: '*'`                                | Cookie de refresh requiere `credentials`; whitelist por env evita exposición                            |
| `express-rate-limit`      | Global: 100 req / 60s por IP. `/auth/login`: 5 req / 60s.         | Rate-limit por usuario                       | IP-based es suficiente para amenaza local; user-based requiere autenticación previa                     |
| Body size                 | `express.json({ limit: '1mb' })`                                  | Sin límite                                   | Mitiga DoS por payload; 1MB cubre todos los casos legítimos (sin uploads en foundations)                |
| JWT access                | HS256, 15min, header Bearer                                       | RS256, 1h                                    | HS256 simple para single-issuer; 15min minimiza ventana de un token robado                              |
| JWT refresh               | HS256 + allowlist DB + rotación + reuse detection                 | Stateless rotation                           | Detecta reuso → revoca toda la familia; ver decisión #1                                                 |
| Secretos JWT              | 2 secretos distintos (`JWT_ACCESS_SECRET` ≠ `JWT_REFRESH_SECRET`), ≥32 chars (validado por Zod) | Un solo secreto    | Compromiso de uno no expone al otro; Zod fail-fast al boot                                              |
| Cookie refresh            | `httpOnly + secure(prod) + sameSite=strict + path=/api/auth + maxAge=7d` | `sameSite=lax` o sin `path`            | `strict` + `path` minimizan superficie CSRF; ver decisión #8                                            |
| bcrypt cost               | 10 rounds                                                         | 12 rounds                                    | ~100ms dev; ver decisión #6                                                                              |
| Validación de entrada     | Zod en `body | query | params` con `validate()` middleware       | Validación ad-hoc en controllers             | Centraliza; tipo inferido al controller; rechazo temprano                                               |
| Manejo de errores         | `AppError` + `errorHandler` global; `INTERNAL_ERROR` sin stack en response | Stack al cliente                  | Evita leaks; stack sí va al log con `reqId`                                                              |
| Logging redacción         | `req.headers.authorization`, `req.body.password`, `req.cookies.refresh_token` redactados por Pino | Logear todo crudo | Cumple con principio de mínima exposición de secretos en logs                                            |
| HTTPS                     | Asumido en reverse proxy (Nginx/Caddy) en prod                    | TLS en Node                                  | Estándar producción; fuera del scope app                                                                 |
| Container                 | `USER node` (no root) en stage runtime                            | Root user                                    | Defensa-en-profundidad de contenedor                                                                     |
| Dependencias              | `npm audit` manual; sin Snyk/Dependabot en foundations            | CI con scanning                              | Aceptado: sin CI/CD hasta change posterior                                                               |

**Lo que NO está en foundations (riesgo aceptado, documentado en §14):**

- CSRF token explícito (mitigado por `sameSite=strict` + `path`).
- WAF / IDS — fuera del scope app.
- Auditoría/SIEM — Pino structured logs son la base; agregación se difiere.
- Secret rotation automatizada — manual hasta que existe orquestador.

---

## 7. Diseño de base de datos (Prisma sketch)

> ✅ **Schema de `Product` CERRADO** (decisión Engram #281, topic `sdd/backend-foundations/product-fields-decision`).
> Se añaden exactamente tres campos: `unit` (enum `ProductUnit`), `unitContent` (`Decimal(10,3)`), `brand` (`VarChar(120)` opcional). Se descartan tablas `Departamento`, `UnidadMedida` y `Brand`, y se descartan los campos `barcode`, `internalRef`, `model`, `weightKg`, `warrantyMonths`, `allowDecimalStock`, `contentUnit`, `currency` y campos de comisión/vendedor. Ver §13 decisión #11 para razonamiento.

### Esquema completo (sketch)

```prisma
generator client { provider = "prisma-client-js" }

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum UserRole {
  ADMIN
  MANAGER
  OPERATOR
}

enum MovementType {
  IN
  OUT
  ADJUSTMENT
}

enum AdjustmentDirection {
  INCREASE
  DECREASE
}

enum AlertType {
  LOW_STOCK
  OUT_OF_STOCK
}

enum ReplenishmentStatus {
  PENDING
  SENT
  RECEIVED
  CANCELLED
}

enum ProductUnit {
  MG
  G
  KG
  ML
  L
  UNIT
}

model User {
  id        String   @id @default(cuid())
  fullName  String
  email     String   @unique
  password  String                     // bcrypt hash
  role      UserRole @default(OPERATOR)
  phone     String?
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  movements         InventoryMovement[]
  resolvedAlerts    Alert[]              @relation("AlertResolver")
  requestedReplens  ReplenishmentRequest[]
  refreshTokens     RefreshToken[]

  @@index([role])
}

model RefreshToken {
  id        String    @id @default(cuid())
  userId    String
  user      User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  expiresAt DateTime
  revoked   Boolean   @default(false)
  revokedAt DateTime?
  createdAt DateTime  @default(now())
  userAgent String?
  ip        String?

  @@index([userId])
  @@index([expiresAt])
}

model Category {
  id          String    @id @default(cuid())
  name        String    @unique
  description String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
  products    Product[]
}

model Supplier {
  id        String    @id @default(cuid())
  name      String
  rif       String?   @unique
  whatsapp  String?
  address   String?
  active    Boolean   @default(true)
  createdAt DateTime  @default(now())
  updatedAt DateTime  @updatedAt

  products              ProductSupplier[]
  replenishmentRequests ReplenishmentRequest[]

  @@index([active])
}

// ✅ Schema CLOSED — decisión Engram #281 (ver §13 #11).
model Product {
  id              String      @id @default(cuid())
  code            String      @unique
  name            String
  activeIngredient String?
  description     String?
  presentation    String?     // empaque (BOLSA, CAJA, BLISTER) — NO usar para unidad
  brand           String?     @db.VarChar(120)
  unit            ProductUnit                     // unidad de medida del contenido
  unitContent     Decimal     @db.Decimal(10, 3)  // p.ej. 100.000 ML
  categoryId      String
  category        Category    @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  stock           Int         @default(0)
  minStock        Int         @default(0)
  price           Decimal     @db.Decimal(12, 2)
  active          Boolean     @default(true)
  createdAt       DateTime    @default(now())
  updatedAt       DateTime    @updatedAt

  suppliers ProductSupplier[]
  movements InventoryMovement[]
  alerts    Alert[]
  replenishmentItems ReplenishmentRequestItem[]

  @@index([categoryId])
  @@index([active])
  @@index([stock])              // soporte para "stock <= minStock"
  @@index([brand])              // búsqueda por marca
}

model ProductSupplier {
  id             String   @id @default(cuid())
  productId      String
  supplierId     String
  referencePrice Decimal? @db.Decimal(12, 2)
  createdAt      DateTime @default(now())

  product  Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  supplier Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)

  @@unique([productId, supplierId])
  @@index([productId])
  @@index([supplierId])
}

model InventoryMovement {
  id                  String              @id @default(cuid())
  productId           String
  userId              String
  type                MovementType
  reason              String
  quantity            Int                                          // SIEMPRE > 0 (decisión #2)
  adjustmentDirection AdjustmentDirection?                         // requerido si type = ADJUSTMENT
  resultingStock      Int                                          // snapshot post-operación
  createdAt           DateTime            @default(now())

  product Product @relation(fields: [productId], references: [id], onDelete: Restrict) // preserva historial
  user    User    @relation(fields: [userId],    references: [id], onDelete: Restrict)

  @@index([productId])
  @@index([userId])
  @@index([createdAt])          // historial cronológico
  @@index([productId, createdAt])
}

model Alert {
  id                String    @id @default(cuid())
  productId         String
  type              AlertType
  message           String
  resolved          Boolean   @default(false)
  resolvedAt        DateTime?
  resolvedByUserId  String?
  createdAt         DateTime  @default(now())

  product        Product @relation(fields: [productId], references: [id], onDelete: Cascade)
  resolvedByUser User?   @relation("AlertResolver", fields: [resolvedByUserId], references: [id], onDelete: SetNull)

  @@index([productId])
  @@index([resolved])                          // listar alertas abiertas
  @@index([productId, resolved])               // "hay alerta abierta para este producto?"
}

model ReplenishmentRequest {
  id                  String              @id @default(cuid())
  supplierId          String
  requestedByUserId   String
  status              ReplenishmentStatus @default(PENDING)
  requestedAt         DateTime            @default(now())
  sentAt              DateTime?
  notes               String?

  supplier        Supplier @relation(fields: [supplierId],        references: [id], onDelete: Restrict)
  requestedByUser User     @relation(fields: [requestedByUserId], references: [id], onDelete: Restrict)
  items           ReplenishmentRequestItem[]

  @@index([supplierId])
  @@index([status])
  @@index([requestedAt])
}

model ReplenishmentRequestItem {
  id                     String   @id @default(cuid())
  replenishmentRequestId String
  productId              String
  requestedQuantity      Int
  unitPrice              Decimal  @db.Decimal(12, 2)

  request ReplenishmentRequest @relation(fields: [replenishmentRequestId], references: [id], onDelete: Cascade)
  product Product              @relation(fields: [productId],              references: [id], onDelete: Restrict)

  @@index([replenishmentRequestId])
  @@index([productId])
}
```

### Reglas de cascada (resumen)

| Padre → Hijo                              | Acción       | Razón                                              |
|------------------------------------------|--------------|----------------------------------------------------|
| `User` → `RefreshToken`                  | Cascade      | Tokens muertos sin usuario                          |
| `Category` → `Product`                   | Restrict     | No borrar categoría con productos vivos             |
| `Product` → `ProductSupplier`            | Cascade      | Relación deja de existir                            |
| `Product` → `Alert`                      | Cascade      | Alertas pierden contexto                            |
| `Product` → `InventoryMovement`          | **Restrict** | Preservar historial (decisión #4 soft-delete)       |
| `Supplier` → `ProductSupplier`           | Cascade      |                                                    |
| `Supplier` → `ReplenishmentRequest`      | Restrict     | Preserva historial de pedidos                       |
| `User` → `InventoryMovement`             | Restrict     | Trazabilidad                                       |
| `User` → `Alert.resolvedByUser`          | SetNull      | Si se borra el usuario, la alerta queda histórica   |
| `ReplenishmentRequest` → `Items`         | Cascade      |                                                    |

### Estrategia de auditoría

- `createdAt` + `updatedAt` en todas las entidades de negocio.
- `InventoryMovement` actúa como **bitácora inmutable** del inventario (no se borra, no se edita).
- `RefreshToken.revoked + revokedAt` da trazabilidad de sesiones.
- Foundations **no** introduce una tabla genérica de audit log; se difiere a un change futuro si aparece el requisito.

### IDs: `cuid` vs `uuid`

**Decisión: `cuid()`** (Prisma `@default(cuid())`).

- URL-safe, más corto que UUID, ordenable temporalmente (k-sorted), suficientemente colisión-resistente para una farmacia.
- No filtra info como `autoincrement()`.
- Trade-off: no es un estándar IETF como UUID. Aceptable: no hay integraciones que exijan UUID.

---

## 8. Helper de paginación

### Signature

```ts
type PaginateArgs<TWhere, TOrderBy> = {
  model: { findMany: Function; count: Function };  // cualquier Prisma delegate
  where?: TWhere;
  orderBy?: TOrderBy;
  page: number;
  limit: number;
  select?: object;
  include?: object;
};

type PaginatedResult<T> = {
  data: T[];
  meta: { page: number; limit: number; total: number; totalPages: number };
};

export async function paginate<T>(args: PaginateArgs<any, any>): Promise<PaginatedResult<T>> {
  const { model, where, orderBy, page, limit, select, include } = args;
  const [data, total] = await Promise.all([
    model.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit, select, include }),
    model.count({ where }),
  ]);
  return { data, meta: { page, limit, total, totalPages: Math.ceil(total / limit) || 1 } };
}
```

### Parser de sort

`?sort=createdAt:desc` → `{ createdAt: 'desc' }`. Soporta múltiples: `?sort=createdAt:desc,name:asc` → `[{createdAt:'desc'},{name:'asc'}]`.

**Whitelist por recurso**: cada Zod schema de query declara `sort: z.string().regex(/^...$/).optional()` con regex que solo acepta los campos sortables permitidos por ese recurso (ej. `createdAt|name|stock` para productos). El controller pasa el string parseado a `parseSort()`.

### Parser de filtros

`?filter[active]=true&filter[categoryId]=abc` → `{ active: true, categoryId: 'abc' }`.

Cada recurso define en su `*.schema.ts` qué campos son filtrables y de qué tipo. Sin whitelist no se pasa al `where` — bloqueo de filtros arbitrarios.

`?search=texto` se traduce en cada repository a `OR: [{ field1: { contains: q, mode: 'insensitive' } }, ...]` con los campos textuales relevantes. Foundations no implementa search global, solo deja el patrón listo.

---

## 9. Helper de validación

```ts
import { ZodSchema } from 'zod';
import { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';

type Target = 'body' | 'query' | 'params';

export function validate(schema: ZodSchema, target: Target = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      return next(new AppError(
        'VALIDATION_FAILED',
        400,
        `${target} validation failed`,
        { fieldErrors: result.error.flatten().fieldErrors },
      ));
    }
    // Reemplaza el target por el resultado parseado → controllers consumen tipo inferido
    (req as any)[target] = result.data;
    next();
  };
}
```

**Ubicación de schemas**: `src/modules/<x>/<x>.schema.ts`. Cada schema exporta también su tipo inferido (`export type LoginInput = z.infer<typeof loginSchema>`). Los controllers tipan `req.body as LoginInput`.

---

## 10. Logging

### Pino base

```ts
// shared/logger/logger.ts
import pino from 'pino';
import { env } from '../../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.body.password', 'req.cookies.refresh_token'],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV === 'development' && {
    transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } },
  }),
});
```

### `pino-http`

- Inyecta `reqId` (uuid v4) en cada request.
- Loguea: `method`, `path`, `status`, `responseTime`, `userId` (de `req.user` si autenticado).
- En errores 5xx incluye stack trace; en 4xx solo el `code`.

### Redacción

- `req.headers.authorization`
- `req.body.password`
- `req.cookies.refresh_token`
- Cualquier campo que el equipo agregue debe documentarse aquí.

---

## 11. Estrategia de testing

### Stack

- **Vitest** (mismo motor que el frontend para coherencia mental; rápido; ESM-native).
- **Supertest** para integración HTTP sin escuchar puerto real.

### Configuración

- `vitest.config.ts` con dos proyectos: `unit` (default) y `integration` (más timeout, setup de DB).
- Naming: `*.test.ts`.

### Organización

| Tipo         | Ubicación                                 | Qué cubre                                    |
|--------------|-------------------------------------------|----------------------------------------------|
| Unit         | junto al código (`auth.service.test.ts`)  | Reglas de negocio puras; repositorio mockeado|
| Integration  | `tests/integration/*.test.ts`             | Endpoints reales sobre DB real de test       |

### Base de datos de test

- `.env.test` con `DATABASE_URL` apuntando a un schema separado (`inventory_test`) en la misma Postgres dev.
- Estrategia: `prisma migrate reset --force --skip-seed` **una sola vez** antes de la suite + **transaction rollback por test** usando `prisma.$transaction(async tx => {...})` y throw al final del test para revertir.

  > Trade-off frente a `reset` por test: muchísimo más rápido (~10× en suites medianas). Posible si los tests no llaman procedimientos que no respeten la transacción (Prisma sí).

### Cobertura mínima en foundations

- `auth.service.test.ts`: login OK, login bad password, login user inactivo, refresh válido, refresh con jti revocado (debe revocar todos los del user), logout.
- `tests/integration/auth.test.ts`: flujo end-to-end `/login → /me → /refresh → /me → /logout`.
- `tests/integration/health.test.ts`: 200 con `db: 'ok'`; status `degraded` si Prisma falla.
- `errorHandler`: ZodError → 400 con envelope; AppError custom; error desconocido → 500 sin filtrar stack.

---

## 12. Setup Docker para desarrollo

### `Dockerfile` (multi-stage, preparado para prod)

```dockerfile
# --- deps stage ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

# --- build stage ---
FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# --- runtime stage ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package*.json ./
EXPOSE 3000
USER node
CMD ["node", "dist/index.js"]
```

### `docker-compose.dev.yml`

```yaml
services:
  db:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: inventory
      POSTGRES_PASSWORD: inventory
      POSTGRES_DB: inventory
    ports: ["5432:5432"]
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U inventory -d inventory"]
      interval: 5s
      timeout: 3s
      retries: 10

  api:
    image: node:20-alpine
    working_dir: /app
    command: sh -c "npm install && npx prisma migrate deploy && npm run dev"
    env_file: .env
    environment:
      DATABASE_URL: postgresql://inventory:inventory@db:5432/inventory
    ports: ["3000:3000"]
    volumes:
      - .:/app
      - /app/node_modules
    depends_on:
      db:
        condition: service_healthy

volumes:
  pgdata:
```

- Bind mount + `npm run dev` (tsx watch) = hot reload.
- `node_modules` excluido del bind mount (volume anónimo) para evitar conflictos host/contenedor.
- Una sola red default de Compose; `api` resuelve `db` por nombre de servicio.

---

## 13. Decision Log

| # | Decisión                                | Elegido                                        | Alternativa descartada                          | Razón                                                                                          |
|---|-----------------------------------------|------------------------------------------------|-------------------------------------------------|------------------------------------------------------------------------------------------------|
| 1 | Estrategia de refresh token             | **B: JWT + DB allowlist con rotación**         | A: Stateless rotation                           | Detección de reuso, logout real; coste marginal; valor pedagógico para tesis                   |
| 2 | ID strategy                             | **`cuid()`**                                   | `uuid()`, `autoincrement()`                     | URL-safe, k-sorted, no filtra row count, sin integraciones que exijan UUID                     |
| 3 | Async error handling                    | **`express-async-errors`**                     | `asyncHandler` wrapper manual                   | Una línea vs ruido en cada controller; estable; trivial de migrar a Express 5                  |
| 4 | Ubicación de errores/middleware/utils   | **`src/shared/`**                              | Dentro de cada módulo                           | Foundations son transversales; evita ciclos de dependencia                                     |
| 5 | Cobertura de DB de test                 | **Transacción + rollback por test**            | `prisma migrate reset` por test                 | ~10× más rápido; Prisma `$transaction` soporta rollback total                                  |
| 6 | bcrypt cost                             | **10**                                         | 12                                              | ~100ms en dev hardware; aceptable para amenaza local                                           |
| 7 | Algoritmo JWT                           | **HS256** con dos secretos distintos           | RS256                                           | Single-issuer monolito; evita gestión de keypairs                                              |
| 8 | Cookie del refresh                      | `httpOnly + secure(prod) + sameSite=strict + path=/api/auth` | `sameSite=lax`                | `strict` mitiga CSRF; `path` limita exposición                                                 |
| 9 | Schema de Producto — campos extra       | **`unit` (enum `ProductUnit`) + `unitContent Decimal(10,3)` + `brand String?(120)`** | Nuevas tablas `Departamento` / `UnidadMedida` / `Brand`; campos `barcode`, `internalRef`, `model`, `weightKg`, `warrantyMonths`, `allowDecimalStock`, `contentUnit`, `currency`, comisión/vendedor | Cierre por decisión usuario (Engram #281). Ver #11.                                            |
| 10| FK indexing                             | Explícito `@@index` en todos los `*Id`         | Confiar en defaults                             | Postgres NO indexa FKs automáticamente; queries de join sufrirían                              |
| 11| Modelado de `unit` / `brand` / `presentation` | **`unit` enum + `unitContent Decimal` + `brand` String + `presentation` libre** | Tabla `UnidadMedida` (catálogo), tabla `Brand` (catálogo con RIF/dirección/contacto), reutilizar `presentation` para la unidad | (a) `unit` es dominio finito y estable → enum más simple que tabla; (b) `brand` sin atributos propios todavía → promoverla a tabla sería prematuro (YAGNI); cuando aparezca un atributo distinto al nombre, se migra a tabla en un change futuro; (c) `presentation` ya describe el empaque externo (BOLSA, CAJA, BLISTER) — mezclarlo con la unidad de contenido viola 1FN. Trade-off: agregar una marca nueva no requiere CRUD (se escribe libre), por lo que pueden quedar duplicados ortográficos ("GENFAR" vs "Genfar"); aceptable en MVP, mitigable con un `@@index([brand])` y normalización en seed. Validación 1FN/2FN/3FN OK: ningún campo nuevo es lista, todos dependen de la PK, y `brand` no depende de otra columna del producto. |
| 12| Estrategia de delivery                  | **Single PR con `size:exception` + commits granulares Conventional Commits** | Chained PRs (`stacked-to-main`), Feature Branch Chain, splits separados por slice | Tesis de un solo desarrollador con maintainer ya alineado a `size:exception`; consistente con el flujo del repo frontend; las 4 slices se conservan como **commit groups** para trazabilidad, no como PRs separadas. Trade-off: PR grande, rollback más caro, menos foco por commit; aceptado por el contexto (decisión Engram #280). |

---

## 14. Riesgos abiertos / unknowns

| Riesgo                                            | Impacto | Mitigación / Acción                                                                 |
|--------------------------------------------------|---------|-------------------------------------------------------------------------------------|
| Campos faltantes en `Product`                    | —       | **Resuelto** (Engram #281, ver §13 #11). Schema cerrado con `unit`, `unitContent`, `brand`. |
| Plataforma de despliegue indefinida              | Bajo    | Diseño asume Node single-process detrás de un reverse proxy (Nginx/Caddy)           |
| Sin métricas (Prometheus, OpenTelemetry)         | Bajo    | Solo Pino por ahora. Abrir change `observability` cuando sea necesario.             |
| Sin CSRF token explícito                         | Bajo    | `sameSite=strict` + `path=/api/auth` mitigan. Reevaluar al fijar dominio frontend.  |
| Sin job de limpieza de `RefreshToken` expirados  | Bajo    | Foundations no incluye cron. Manual hasta `node-cron` se introduzca con alertas.    |
| Sin CI/CD                                        | Medio   | Pre-commit (Husky + lint-staged) cubre mínimo local. Abrir change cuando se elija. |
| Tipos compartidos con frontend duplicados a mano | Medio   | Documentar contrato en specs. Considerar paquete compartido en change posterior.    |
| Express 4 vs 5                                    | Bajo    | Express 4 (estable). Migración a 5 elimina `express-async-errors` sin más impacto.  |
