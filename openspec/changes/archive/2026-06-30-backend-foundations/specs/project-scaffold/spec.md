# Especificación: project-scaffold

## Purpose

Definir la estructura base del repositorio backend, el tooling de calidad (lint, format, hooks), el entorno de desarrollo en Docker, los scripts de npm, la validación de variables de entorno al arranque, y el README. Sin este scaffold, ningún otro capability puede instalarse ni ejecutarse.

## Requirements

### Requirement: Runtime y TypeScript estricto

El proyecto **MUST** correr sobre **Node.js 20 LTS** y **TypeScript en modo strict**. El `tsconfig.json` **MUST** habilitar al menos: `"strict": true`, `"noUncheckedIndexedAccess": true`, `"target": "ES2022"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"outDir": "dist"`, `"rootDir": "src"`.

#### Scenario: Build limpio con TypeScript strict

- GIVEN un repo con scaffold instalado y dependencias resueltas
- WHEN se ejecuta `npm run typecheck`
- THEN el comando termina con código de salida `0` y sin errores de tipo

#### Scenario: Versión de Node bloqueada

- GIVEN un `package.json` con `"engines": { "node": ">=20 <21" }`
- WHEN un desarrollador con Node 18 corre `npm install`
- THEN npm muestra una advertencia (o error si `engine-strict=true`) indicando incompatibilidad

### Requirement: Estructura de carpetas modular

El repo **MUST** seguir esta estructura exacta:

```
src/
  app.ts              # construye la app Express (sin escuchar)
  server.ts           # arranca el listener HTTP
  config/
    env.ts            # parseo + validación Zod de process.env
  shared/
    errors/           # AppError + jerarquía
    middleware/       # errorHandler, notFound, authenticate, requireRole
    utils/            # helpers genéricos
    logger/           # instancia Pino
    validation/       # helper validate(schema, target)
    pagination/       # helper paginate() + tipos
  modules/
    auth/             # routes, controller, service, schema
    health/           # routes, controller
prisma/
  schema.prisma
  migrations/
  seed.ts
tests/
  setup.ts
  smoke/              # health.test.ts, auth.test.ts
```

#### Scenario: Boot separado de listener

- GIVEN `src/app.ts` exporta la app Express y `src/server.ts` la importa
- WHEN los tests de Supertest importan `app` directamente
- THEN no se abre ningún puerto y los tests corren contra el handler en memoria

### Requirement: Tooling de calidad y pre-commit

El repo **MUST** incluir ESLint (config TypeScript), Prettier, Husky y lint-staged. Un `git commit` **MUST** ejecutar pre-commit sobre archivos staged.

#### Scenario: Pre-commit bloquea código sucio

- GIVEN un archivo `.ts` con error de ESLint en staging
- WHEN el desarrollador ejecuta `git commit`
- THEN Husky corre `lint-staged` que aplica `eslint --fix` y `prettier --write`
- AND si quedan errores, el commit aborta con código distinto de `0`

#### Scenario: Pre-commit corre typecheck

- GIVEN un archivo `.ts` staged con error de tipos
- WHEN se ejecuta `git commit`
- THEN `lint-staged` invoca `tsc --noEmit` y el commit falla si hay errores de tipo

### Requirement: Scripts de npm completos

El `package.json` **MUST** declarar exactamente estos scripts (nombres exactos):

| Script | Comando esperado |
|--------|------------------|
| `dev` | `tsx watch src/server.ts` |
| `build` | `tsc -p tsconfig.build.json` |
| `start` | `node dist/server.js` |
| `lint` | `eslint . --ext .ts` |
| `lint:fix` | `eslint . --ext .ts --fix` |
| `typecheck` | `tsc --noEmit` |
| `test` | `vitest run` |
| `test:watch` | `vitest` |
| `db:migrate` | `prisma migrate dev` |
| `db:seed` | `prisma db seed` (configurado en `prisma.seed`) |
| `db:reset` | `prisma migrate reset` |
| `db:studio` | `prisma studio` |
| `prepare` | `husky` |

#### Scenario: Listado de scripts visible

- GIVEN scaffold instalado
- WHEN se ejecuta `npm run`
- THEN aparecen los 13 scripts listados con descripciones (o al menos los nombres)

### Requirement: Validación de variables de entorno al arranque

El módulo `src/config/env.ts` **MUST** validar `process.env` con un schema Zod al cargar. Si falla, el proceso **MUST** terminar con `exit code 1` y un mensaje legible indicando las variables ausentes o inválidas.

El `.env.example` **MUST** documentar como mínimo:

```
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/inventario_dev
JWT_ACCESS_SECRET=change-me-min-32-chars
JWT_REFRESH_SECRET=change-me-min-32-chars
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d
FRONTEND_URL=http://localhost:5173
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=900000
LOG_LEVEL=info
SEED_ADMIN_EMAIL=admin@highmeds.local
SEED_ADMIN_PASSWORD=ChangeMe123!
SEED_ADMIN_FULLNAME=Administrador
```

#### Scenario: Falta `DATABASE_URL`

- GIVEN un `.env` sin `DATABASE_URL`
- WHEN se ejecuta `npm run dev`
- THEN el proceso imprime un error indicando `DATABASE_URL is required` y termina con código `1`

#### Scenario: `JWT_ACCESS_SECRET` muy corto

- GIVEN un `.env` con `JWT_ACCESS_SECRET=short`
- WHEN se ejecuta `npm run dev`
- THEN el proceso falla indicando que debe tener al menos 32 caracteres y termina con código `1`

### Requirement: Entorno Docker para desarrollo

El repo **MUST** incluir un `docker-compose.dev.yml` con dos servicios: `app` (Node 20, monta el código local, ejecuta `npm run dev`) y `db` (postgres:15-alpine con volumen nombrado para persistir datos).

#### Scenario: Arranque con docker-compose

- GIVEN el repo recién clonado y un `.env` válido
- WHEN se ejecuta `docker-compose -f docker-compose.dev.yml up`
- THEN se levantan los servicios `db` y `app`, las migraciones corren automáticamente, y `GET http://localhost:3000/api/health` responde `200`

#### Scenario: Persistencia de datos entre reinicios

- GIVEN `docker-compose down` (sin `-v`) tras haber sembrado datos
- WHEN se ejecuta `docker-compose -f docker-compose.dev.yml up` nuevamente
- THEN los datos previos siguen presentes en Postgres (volumen nombrado preservado)

### Requirement: README operativo

El `README.md` **MUST** documentar:

1. **Setup**: requisitos (Node 20, Docker), pasos de instalación, copia de `.env.example`.
2. **Scripts**: tabla con los 13 scripts y su propósito.
3. **Folder structure**: árbol resumido de `src/`, `prisma/`, `tests/`.
4. **Env vars**: tabla con cada variable, tipo, default y descripción.
5. **Auth flow**: diagrama o resumen del flujo login → access token → refresh.
6. **Backup note (RNF9)**: nota explícita indicando que el backup de la base de datos es responsabilidad de infraestructura (vía `pg_dump` u otro) y **NO** del backend.

#### Scenario: Onboarding de nuevo desarrollador

- GIVEN un desarrollador nuevo lee solo el README
- WHEN sigue la sección "Setup" sin contexto previo
- THEN logra arrancar el backend localmente en menos de 10 minutos

## Acceptance

- [ ] `npm install` completa sin warnings críticos.
- [ ] `npm run typecheck` pasa en limpio.
- [ ] `npm run lint` pasa en limpio.
- [ ] `npm run dev` arranca en `:3000` con `.env` válido.
- [ ] `npm run dev` aborta con código `1` si falta cualquier variable obligatoria.
- [ ] `docker-compose -f docker-compose.dev.yml up` levanta app + db sin pasos manuales.
- [ ] `git commit` con un archivo TS sucio falla por pre-commit.
- [ ] README cubre los 6 puntos listados.
- [ ] Repo inicializado con git y primer commit creado.
