# sistema-inventario-backend

Backend API for **HighMeds** pharmacy inventory system — thesis project (Farmacia HighMeds).  
Built with Node.js 20, Express 4, TypeScript (strict), Prisma 5, PostgreSQL 15, and Zod.

OpenSpec change: `openspec/changes/backend-foundations/`

---

## Setup

### Requirements

| Tool                       | Version                    |
| -------------------------- | -------------------------- |
| Node.js                    | **20 LTS** (`>=20 <21`)    |
| npm                        | 10+ (bundled with Node 20) |
| Docker + Docker Compose v2 | Latest stable              |
| Git                        | Any recent version         |

### Installation

```bash
# 1. Clone the repository
git clone <repo-url>
cd sistema-inventario-backend

# 2. Copy environment variables
cp .env.example .env
# Edit .env and fill in JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, DATABASE_URL
# Secrets must be ≥ 32 characters each

# 3. Install dependencies
npm install

# 4. Start the database (Docker)
docker-compose -f docker-compose.dev.yml up db -d

# 5. Run database migrations
npm run db:migrate

# 6. Seed initial admin user
npm run db:seed

# 7. Start the development server (hot reload)
npm run dev
```

The server starts at `http://localhost:3000`.

### Quick start with Docker (all services)

```bash
cp .env.example .env
# Edit .env with your secrets
docker-compose -f docker-compose.dev.yml up
```

This starts `db` (Postgres 15) and `api` (Node 20), runs migrations automatically,
and enables hot reload via `tsx watch`.

---

## Scripts

| Script         | Command                      | Purpose                                       |
| -------------- | ---------------------------- | --------------------------------------------- |
| `dev`          | `tsx watch src/server.ts`    | Start dev server with hot reload              |
| `build`        | `tsc -p tsconfig.build.json` | Compile TypeScript to `dist/`                 |
| `start`        | `node dist/server.js`        | Run compiled production build                 |
| `lint`         | `eslint . --ext .ts`         | Check code for lint errors                    |
| `lint:fix`     | `eslint . --ext .ts --fix`   | Auto-fix lint errors                          |
| `format`       | `prettier --write .`         | Format all files                              |
| `format:check` | `prettier --check .`         | Verify formatting (CI)                        |
| `typecheck`    | `tsc --noEmit`               | Type-check without emitting files             |
| `test`         | `vitest run`                 | Run all tests once                            |
| `test:watch`   | `vitest`                     | Run tests in watch mode                       |
| `db:migrate`   | `prisma migrate dev`         | Run pending Prisma migrations                 |
| `db:seed`      | `prisma db seed`             | Seed the database (admin user)                |
| `db:reset`     | `prisma migrate reset`       | Reset DB and re-run all migrations            |
| `db:studio`    | `prisma studio`              | Open Prisma Studio GUI                        |
| `prepare`      | `husky`                      | Install Husky git hooks (auto on npm install) |

---

## Folder Structure

```
sistema-inventario-backend/
├── .env.example          # Environment variable template
├── .husky/
│   └── pre-commit        # lint-staged + typecheck before every commit
├── Dockerfile            # Multi-stage production image (deps → build → runtime)
├── docker-compose.dev.yml# Local dev: Postgres 15 + Node 20 with hot reload
├── package.json
├── tsconfig.json         # TypeScript strict config (NodeNext, ES2022)
├── tsconfig.build.json   # Build-only config (excludes tests)
│
├── prisma/
│   ├── schema.prisma     # Database schema (9 models, 6 enums)
│   ├── migrations/       # Prisma migration files
│   └── seed.ts           # Creates initial admin user
│
├── src/
│   ├── index.ts          # Entry point → imports server.ts
│   ├── server.ts         # HTTP listener + graceful shutdown
│   ├── app.ts            # Express app factory (no listen — importable by tests)
│   │
│   ├── config/
│   │   └── env.ts        # Zod-validated env vars; exits with code 1 on failure
│   │
│   ├── shared/           # Cross-cutting infrastructure (never imports from modules/)
│   │   ├── errors/       # AppError class + errorCodes + global errorHandler
│   │   ├── middleware/   # authenticate, requireRole, notFound, rateLimit
│   │   ├── utils/        # asyncHandler, paginate, parseSort, jwt helpers
│   │   ├── logger/       # Pino instance + pino-http config
│   │   ├── validation/   # validate(schema, target) middleware factory
│   │   └── pagination/   # paginate() helper + PaginatedResponse type
│   │
│   └── modules/          # Domain modules (routes → controller → service → repository)
│       ├── auth/         # Login, refresh, logout, /me endpoints + JWT strategy
│       └── health/       # GET /api/health with Prisma ping
│
└── tests/
    ├── setup.ts           # Global test setup (DB teardown, env guard)
    └── smoke/             # End-to-end smoke tests (health, auth)
```

---

## Environment Variables

| Variable               | Required | Default                 | Description                                                                               |
| ---------------------- | -------- | ----------------------- | ----------------------------------------------------------------------------------------- |
| `NODE_ENV`             | no       | `development`           | Runtime environment (`development` \| `test` \| `production`)                             |
| `PORT`                 | no       | `3000`                  | HTTP port the server listens on                                                           |
| `DATABASE_URL`         | **yes**  | —                       | PostgreSQL connection string (`postgresql://user:pass@host:port/db`)                      |
| `JWT_ACCESS_SECRET`    | **yes**  | —                       | Secret for signing access tokens. Minimum 32 characters.                                  |
| `JWT_REFRESH_SECRET`   | **yes**  | —                       | Secret for signing refresh tokens. Minimum 32 characters. Must differ from access secret. |
| `JWT_ACCESS_TTL`       | no       | `15m`                   | Access token lifetime (ms-style, e.g. `15m`, `1h`)                                        |
| `JWT_REFRESH_TTL`      | no       | `7d`                    | Refresh token lifetime (e.g. `7d`, `30d`)                                                 |
| `BCRYPT_COST`          | no       | `10`                    | bcrypt work factor (8–14). 10 ≈ 100ms on dev hardware.                                    |
| `FRONTEND_URL`         | no       | `http://localhost:5173` | Allowed CORS origin for the frontend                                                      |
| `RATE_LIMIT_MAX`       | no       | `100`                   | Max requests per IP per window                                                            |
| `RATE_LIMIT_WINDOW_MS` | no       | `900000`                | Rate-limit window in milliseconds (default: 15 min)                                       |
| `LOG_LEVEL`            | no       | `info`                  | Pino log level (`fatal` \| `error` \| `warn` \| `info` \| `debug` \| `trace`)             |
| `SEED_ADMIN_EMAIL`     | no       | `admin@highmeds.local`  | Email for the seeded admin user                                                           |
| `SEED_ADMIN_PASSWORD`  | no       | `ChangeMe123!`          | Password for the seeded admin (bcrypt-hashed at seed time)                                |
| `SEED_ADMIN_FULLNAME`  | no       | `Administrador`         | Full name for the seeded admin user                                                       |

> The server exits with **code 1** and a readable error if any required variable is
> missing or invalid (checked by Zod in `src/config/env.ts` at startup).

---

## Auth Flow

```
POST /api/auth/login
  ← { email, password }
  → { user, token: accessJwt }  +  Set-Cookie: refresh_token=<jwt>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth

Every protected request:
  Authorization: Bearer <accessJwt>
  → authenticate middleware validates HS256 signature + expiry, sets req.user

POST /api/auth/refresh   (cookie refresh_token sent automatically)
  → verify JWT signature + lookup jti in RefreshToken table
  → revoke old jti, issue new access + refresh tokens (rotation)
  → Set-Cookie: refresh_token=<newJwt>

POST /api/auth/logout
  → revoke jti in DB, clear cookie
  → 204 No Content

GET /api/auth/me   (Bearer required)
  → fresh DB read of the authenticated user
  → { user } without password field
```

**Algorithm**: HS256 with two separate secrets (access ≠ refresh).  
**Access token TTL**: 15 minutes (configurable via `JWT_ACCESS_TTL`).  
**Refresh token**: 7 days, stored in httpOnly cookie; DB allowlist enables true logout and reuse detection.

---

## Backup Note (RNF9)

> **Database backups are the responsibility of the infrastructure layer, NOT this backend.**
>
> The backend does not implement automated backup, restore, or export endpoints.
> Backups should be scheduled externally using `pg_dump` (or a managed Postgres
> backup service) against the PostgreSQL instance. Example:
>
> ```bash
> pg_dump -U inventory -d inventory -F c -f backup_$(date +%Y%m%d).dump
> ```
>
> Restoring:
>
> ```bash
> pg_restore -U inventory -d inventory -c backup_20260101.dump
> ```
>
> Schedule and retention policy are infrastructure decisions outside the scope
> of this application. See OpenSpec design §14 (Riesgos abiertos) for context.

---

## Links

- OpenSpec proposal: `openspec/changes/backend-foundations/proposal.md`
- OpenSpec spec (scaffold): `openspec/changes/backend-foundations/specs/project-scaffold/spec.md`
- OpenSpec design: `openspec/changes/backend-foundations/design.md`
- OpenSpec tasks: `openspec/changes/backend-foundations/tasks.md`
- Frontend (sister repo): `../sistema-inventario-frontend`
