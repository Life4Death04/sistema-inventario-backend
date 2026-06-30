# Proposal: Backend Foundations

## Intent

Levantar el backend del sistema de inventario de Farmacia HighMeds desde cero con un esqueleto productivo y todas las piezas transversales (scaffold, tooling, Docker, Prisma, Express base, auth JWT, errores, validación, paginación, health check). Sin estas bases, ningún módulo funcional (Productos, Inventario, Alertas, Reposición, Proveedores, Usuarios) puede empezar. El frontend hermano ya está construido sobre mocks y necesita una API real bajo `/api` que respete los tipos en `common.types.ts`.

## Scope

### In Scope

- Scaffold TypeScript: `package.json`, `tsconfig.json` (strict), estructura `src/` por módulos.
- Linting/formato: ESLint + Prettier + Husky + lint-staged (pre-commit: `lint` + `typecheck`).
- Contenedores dev: `Dockerfile` + `docker-compose.dev.yml` (Node + PostgreSQL).
- Prisma: init + schema completo (9 tablas) + primera migración + seed de admin.
- Express base: `helmet`, `cors`, `express-rate-limit`, body parser, logger Pino.
- Errores globales: clase `AppError` + middleware → JSON `{ error, message, statusCode }`.
- Validación: helper `validate(schema, 'body'|'params'|'query')` con Zod.
- Paginación universal: helper + envelope `{ data, meta: { page, limit, total, totalPages } }`.
- Auth MVP: `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`; middleware `authenticate` y `requireRole(...roles)`. Access 15min (Bearer), refresh 7d (cookie httpOnly secure).
- Health: `GET /api/health` → `{ status, timestamp, uptime, db }`.
- `.env.example` + validación Zod al arranque.
- README con scripts (`dev`, `build`, `test`, `db:migrate`, `db:seed`).
- Commit inicial (proyecto sin git todavía).

### Out of Scope

- CRUDs por módulo (Productos, Categorías, Proveedores, Inventario, Movimientos, Usuarios) → un change por módulo después.
- Integración Twilio → change `replenishment`.
- node-cron + auto-resolución de alertas → change `stock-alerts`.
- Backup automatizado (RNF9) → responsabilidad de infra (decisión #9), solo se documenta en README.
- CI/CD pipeline → change posterior cuando se decida plataforma.

## Capabilities

> Contract con la fase `sdd-spec`. No existen specs previas en `openspec/specs/` (greenfield).

### New Capabilities

- `project-scaffold`: estructura del repo, tooling (ESLint/Prettier/Husky), Docker dev, scripts npm, validación de env vars, README.
- `database-schema`: modelo Prisma con las 9 entidades, enums (UserRole, MovementType, AlertType, ReplenishmentStatus), índices y FKs, primera migración, seed de admin.
- `http-foundations`: bootstrap Express con `helmet`/`cors`/`rate-limit`/Pino, `AppError` + error middleware, helper `validate(zodSchema, target)`, envelope de paginación + helper, health check.
- `auth`: login/refresh/logout/me con JWT (access 15min Bearer + refresh 7d cookie httpOnly), middlewares `authenticate` y `requireRole(...roles)`, hashing bcrypt.

### Modified Capabilities

- None (greenfield).

## Approach

Arquitectura por capas 3 niveles confirmada en el informe: `routes → controllers → services → repositories (Prisma)`. Stack confirmado: **Node.js + TypeScript + Express + Prisma + PostgreSQL + Zod + JWT + bcrypt + Pino + Vitest + Supertest** (alineado al informe; ver decisión #10 para tooling adicional). Estructura modular `src/modules/<dominio>/{routes,controller,service,repository,schema}` + `src/shared/{middleware,errors,utils,config}`.

### Decisiones autoritativas aplicadas (de `sdd/backend-foundations/design-decisions`)

| # | Decisión | Aplicación en foundations |
|---|----------|----------------------------|
| 1 | Roles `ADMIN \| MANAGER \| OPERATOR` | Enum Prisma + payload JWT + `requireRole` |
| 2 | `MovimientoInventario.quantity` siempre positiva + `adjustmentDirection` para ADJUSTMENT | Reflejado en schema Prisma (no se usa hasta el módulo, pero el modelo queda fijo) |
| 3 | Schema completo de `Alerta` (type LOW_STOCK/OUT_OF_STOCK, resolved, resolvedAt, resolvedByUserId) | Reflejado en schema Prisma |
| 4 | Soft-delete de productos (`active=false` no borra histórico) | Campo `active` boolean + reglas se aplican en módulos posteriores |
| 5 | JWT access 15min + refresh 7d cookie httpOnly | Implementado en módulo `auth` de este change |
| 6 | Paginación universal `{ data, meta }` | Helper `paginate()` + envelope en `http-foundations` |
| 7 | Estados WhatsApp `PENDING/SENT/RECEIVED/CANCELLED` | Enum Prisma listo (uso en change `replenishment`) |
| 8 | Despliegue local/dev + docker-compose | `docker-compose.dev.yml`, CORS leyendo `FRONTEND_URL` |
| 9 | Backup RNF9 fuera de la app | Solo nota en README |
| 10 | Docker + ESLint/Prettier + Husky/lint-staged en foundations | Incluido en este scope |

## Affected Areas

| Área | Impacto | Descripción |
|------|---------|-------------|
| `/` (raíz) | New | `package.json`, `tsconfig.json`, `.eslintrc`, `.prettierrc`, `.gitignore`, `.env.example`, `README.md`, `Dockerfile`, `docker-compose.dev.yml`, `.husky/` |
| `prisma/` | New | `schema.prisma` (9 modelos + enums), `migrations/`, `seed.ts` |
| `src/` | New | `index.ts`, `app.ts`, `server.ts`, `config/env.ts`, `shared/{errors,middleware,utils,logger}`, `modules/auth/`, `modules/health/` |
| `tests/` | New | Setup Vitest + Supertest, smoke tests de health y auth |
| `.git` | New | Repo inicializado con primer commit |

## Risks

| Riesgo | Probabilidad | Mitigación |
|--------|--------------|------------|
| Foundations PR demasiado grande (> 400 líneas budget) | Alta | `sdd-tasks` debe forzar chained PRs por capa: (1) scaffold+tooling+docker, (2) prisma+schema+seed, (3) express base + errores + validación + paginación + health, (4) auth + JWT + middlewares |
| Refresh-token rotation (reuse detection, allowlist/denylist) sin diseño aún | Media | Spec/design define estrategia (rotación + revocación en logout); MVP usa rotación simple en cada refresh |
| Plataforma de despliegue indefinida → CORS/env podrían cambiar | Media | `FRONTEND_URL` por env var; CORS configurable; documentar en README |
| Sin observabilidad/métricas (solo logging Pino) | Media | Aceptado para foundations; abrir change `observability` después si se requiere |
| Sin CI/CD configurado | Media | Pre-commit (lint+typecheck) cubre mínimo local; abrir change `ci-pipeline` cuando se elija plataforma |
| Falta de sincronización de tipos con frontend (duplicación manual) | Media | Documentar contrato en specs; considerar paquete compartido en change posterior |
| Decisión de Express vs alternativas podría revisitarse | Baja | Informe ya declara Express; se mantiene |

## Rollback Plan

Foundations es un único commit inicial sobre un repo vacío. Rollback = `rm -rf` del proyecto o `git reset --hard` previo al commit. Si una capa específica falla en chained PRs, revertir solo ese PR y mantener los anteriores (cada slice es autocontenido: scaffold sin DB funciona; DB sin auth funciona; etc.).

## Dependencies

- PostgreSQL 15+ disponible localmente (vía docker-compose).
- Node.js 20 LTS instalado en máquina del desarrollador.
- Acceso a registro npm público.
- Tipos del frontend en `../sistema-inventario-frontend/src/types/common.types.ts` (referencia, no import directo).

## Success Criteria

- [ ] `npm run dev` arranca el servidor en `:3000` con conexión a Postgres OK.
- [ ] `GET /api/health` responde `{ status: 'ok', db: 'ok', ... }`.
- [ ] `POST /api/auth/login` con seed admin retorna `{ user, token }` + cookie refresh.
- [ ] `POST /api/auth/refresh` rota access token usando cookie.
- [ ] `GET /api/auth/me` con Bearer válido retorna el usuario; sin token → 401.
- [ ] Endpoint protegido con `requireRole('ADMIN')` rechaza OPERATOR con 403.
- [ ] `npx prisma migrate dev` aplica la primera migración con las 9 tablas.
- [ ] `npx prisma db seed` crea usuario admin.
- [ ] `npm run lint` y `npm run typecheck` pasan en limpio.
- [ ] Pre-commit (Husky + lint-staged) bloquea commits con errores.
- [ ] Errores de validación Zod retornan `400` con shape `{ error, message, statusCode }`.
- [ ] `docker-compose -f docker-compose.dev.yml up` levanta API + DB sin pasos manuales adicionales.
- [ ] README documenta scripts, variables de entorno y nota de backup RNF9.
- [ ] Commit inicial creado.
