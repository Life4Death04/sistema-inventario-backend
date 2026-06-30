# Especificación: database-schema

## Purpose

Definir el modelo de datos persistente del sistema de inventario en Prisma + PostgreSQL: 9 entidades, sus relaciones, los enums del dominio, la estrategia de IDs y migraciones, y el seed inicial del usuario administrador. Este schema es la base sobre la cual se construyen todos los módulos funcionales.

## Status

> **CERRADO** — los campos adicionales de `Product` quedaron resueltos por decisión del usuario (Engram #281, topic `sdd/backend-foundations/product-fields-decision`). Se añaden exactamente tres campos: `unit` (enum `ProductUnit`), `unitContent` (Decimal), `brand` (String opcional). No se crean tablas adicionales (`Departamento`, `UnidadMedida`, `Brand`). El slice de Prisma ya NO está bloqueado.

## Requirements

### Requirement: Estrategia de IDs y timestamps

Todas las entidades **MUST** usar IDs `String` con `@default(cuid())` (motivo: cortos, URL-safe, ordenables por inserción, sin filtrar conteo).

Todas las entidades con histórico relevante **MUST** incluir `createdAt DateTime @default(now())` y `updatedAt DateTime @updatedAt`, **excepto** entidades inmutables tipo log (`InventoryMovement`) que solo requieren `createdAt`.

#### Scenario: Cuid generado al insertar

- GIVEN un modelo Prisma con `id String @id @default(cuid())`
- WHEN se crea un registro sin pasar `id`
- THEN Prisma genera un cuid válido (25 chars, prefijo `c`) y lo guarda

### Requirement: Enums del dominio

El schema **MUST** declarar exactamente estos enums (valores exactos, sensibles a mayúsculas):

| Enum | Valores |
|------|---------|
| `UserRole` | `ADMIN`, `MANAGER`, `OPERATOR` |
| `MovementType` | `IN`, `OUT`, `ADJUSTMENT` |
| `AdjustmentDirection` | `INCREASE`, `DECREASE` |
| `AlertType` | `LOW_STOCK`, `OUT_OF_STOCK` |
| `ReplenishmentStatus` | `PENDING`, `SENT`, `RECEIVED`, `CANCELLED` |
| `ProductUnit` | `MG`, `G`, `KG`, `ML`, `L`, `UNIT` |

`AdjustmentDirection` solo aplica a movimientos con `type = ADJUSTMENT` (regla de dominio, no constraint a nivel DB en foundations).

`ProductUnit` representa la **unidad de medida del contenido** de un producto (no la presentación/empaque). El empaque externo (BOLSA, CAJA, BLISTER) sigue viviendo en el campo libre `presentation`. Ejemplos: jarabe `100 ML`, polvo `500 G`, comprimidos `30 UNIT`.

#### Scenario: Valor inválido rechazado por Prisma

- GIVEN un cliente intenta crear un `User` con `role = 'SUPERADMIN'`
- WHEN Prisma valida el payload
- THEN lanza un error de validación antes de tocar la DB

### Requirement: Entidad User

```prisma
model User {
  id        String   @id @default(cuid())
  fullName  String
  email     String   @unique
  password  String   // bcrypt hash, nunca en respuestas API
  role      UserRole @default(OPERATOR)
  active    Boolean  @default(true)
  phone     String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  movements             InventoryMovement[]
  replenishmentRequests ReplenishmentRequest[]
  resolvedAlerts        Alert[]                @relation("AlertResolver")

  @@index([email])
  @@index([active])
}
```

#### Scenario: Email único

- GIVEN un `User` con `email = 'admin@highmeds.local'`
- WHEN se intenta crear otro `User` con el mismo email
- THEN Prisma lanza `P2002` (unique constraint violation)

### Requirement: Entidad Category

```prisma
model Category {
  id          String    @id @default(cuid())
  name        String    @unique
  description String?
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  products    Product[]
}
```

#### Scenario: Eliminar categoría con productos

- GIVEN una categoría con al menos un producto asociado
- WHEN se intenta `DELETE`
- THEN Prisma respeta `onDelete: Restrict` (default en este caso) y rechaza la operación

### Requirement: Entidad Product

```prisma
model Product {
  id               String      @id @default(cuid())
  code             String      @unique
  name             String
  activeIngredient String?
  description      String?
  presentation     String?     // empaque (BOLSA, CAJA, BLISTER) — texto libre
  brand            String?     @db.VarChar(120)
  unit             ProductUnit
  unitContent      Decimal     @db.Decimal(10, 3)
  categoryId       String
  category         Category    @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  stock            Int         @default(0)
  minStock         Int         @default(0)
  price            Decimal     @db.Decimal(12, 2)
  active           Boolean     @default(true)
  createdAt        DateTime    @default(now())
  updatedAt        DateTime    @updatedAt

  suppliers        ProductSupplier[]
  movements        InventoryMovement[]
  alerts           Alert[]
  replenishmentItems ReplenishmentRequestItem[]

  @@index([code])
  @@index([categoryId])
  @@index([active])
  @@index([brand])
}
```

**Decimal** para `price` y `unitContent` (nunca `Float`). Soft-delete vía `active = false`.

Campos cerrados por decisión (Engram #281):
- `unit` (`ProductUnit`, requerido) — unidad de medida del contenido.
- `unitContent` (`Decimal(10,3)`, requerido) — magnitud del contenido en esa unidad (ej: `100.000` con `unit = ML`).
- `brand` (`VarChar(120)`, opcional) — marca comercial. Permanece como columna `String?` hasta que adquiera atributos propios (RIF, dirección, contacto); promoverla a tabla ahora sería prematuro.
- `presentation` se conserva como `String?` para el empaque externo; **no** se reutiliza para la unidad.

#### Scenario: Soft-delete no rompe histórico

- GIVEN un `Product` con `active = true` y movimientos históricos
- WHEN se actualiza a `active = false`
- THEN los registros de `InventoryMovement` siguen accesibles vía la relación `product`

#### Scenario: Crear producto con unidad y contenido válidos

- GIVEN un payload `{ code: "JAR-001", name: "Jarabe Genfar", unit: "ML", unitContent: 100, brand: "GENFAR", categoryId: <existing>, price: 3.50 }`
- WHEN se ejecuta `prisma.product.create({ data })`
- THEN el producto se persiste con `unit = ML`, `unitContent = 100.000`, `brand = "GENFAR"` y `presentation = null`

#### Scenario: Valor inválido en `unit` rechazado

- GIVEN un payload con `unit: "LITROS"` (valor fuera del enum `ProductUnit`)
- WHEN Prisma valida el input antes de la DB
- THEN lanza un error de validación de enum y la inserción no llega a Postgres

#### Scenario: `brand` opcional

- GIVEN un payload sin `brand`
- WHEN se crea el producto
- THEN `brand` queda en `null` y el resto de campos requeridos (`unit`, `unitContent`) deben estar presentes; si falta `unit` o `unitContent` Prisma rechaza la operación

### Requirement: Entidad Supplier

```prisma
model Supplier {
  id        String   @id @default(cuid())
  name      String
  rif       String?  @unique
  whatsapp  String?
  address   String?
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  products              ProductSupplier[]
  replenishmentRequests ReplenishmentRequest[]

  @@index([active])
}
```

#### Scenario: RIF nullable pero único cuando se provee

- GIVEN dos suppliers ambos con `rif = null`
- WHEN se persisten ambos
- THEN no hay conflicto (Postgres permite múltiples `NULL` en columnas `UNIQUE`)

### Requirement: Entidad ProductSupplier (M:N explícita)

```prisma
model ProductSupplier {
  id             String   @id @default(cuid())
  productId      String
  supplierId     String
  referencePrice Decimal  @db.Decimal(12, 2)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  product        Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  supplier       Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)

  @@unique([productId, supplierId])
  @@index([productId])
  @@index([supplierId])
}
```

Se elige join explícito (no implícito) porque la relación lleva `referencePrice`.

#### Scenario: Par único product+supplier

- GIVEN un `ProductSupplier` para `(productId, supplierId)`
- WHEN se intenta crear otro par idéntico
- THEN Prisma lanza `P2002` por la `@@unique`

### Requirement: Entidad InventoryMovement

```prisma
model InventoryMovement {
  id                  String               @id @default(cuid())
  productId           String
  userId              String
  type                MovementType
  adjustmentDirection AdjustmentDirection?  // requerido cuando type = ADJUSTMENT
  reason              String
  quantity            Int                   // SIEMPRE > 0
  resultingStock      Int                   // snapshot post-operación
  createdAt           DateTime              @default(now())

  product             Product               @relation(fields: [productId], references: [id], onDelete: Restrict)
  user                User                  @relation(fields: [userId], references: [id], onDelete: Restrict)

  @@index([productId, createdAt])
  @@index([userId])
  @@index([type])
}
```

`quantity` **MUST** ser positiva siempre. La dirección la determina `type` (`IN` suma, `OUT` resta) y para `ADJUSTMENT` la determina `adjustmentDirection`. La validación se aplica en la capa de servicio (no constraint DB en foundations).

#### Scenario: Movimiento inmutable

- GIVEN un `InventoryMovement` creado
- WHEN se intenta actualizar `quantity`
- THEN la capa de servicio rechaza la operación (regla de dominio, no constraint en foundations)

### Requirement: Entidad Alert

```prisma
model Alert {
  id               String    @id @default(cuid())
  productId        String
  type             AlertType
  message          String
  resolved         Boolean   @default(false)
  resolvedAt       DateTime?
  resolvedByUserId String?
  createdAt        DateTime  @default(now())

  product          Product   @relation(fields: [productId], references: [id], onDelete: Cascade)
  resolvedBy       User?     @relation("AlertResolver", fields: [resolvedByUserId], references: [id], onDelete: SetNull)

  @@index([productId, resolved])
  @@index([resolved, createdAt])
}
```

#### Scenario: Alerta sin resolver

- GIVEN un `Alert` recién creado
- WHEN se consulta `resolved`
- THEN es `false`, `resolvedAt` es `null`, `resolvedByUserId` es `null`

### Requirement: Entidad ReplenishmentRequest

```prisma
model ReplenishmentRequest {
  id                  String               @id @default(cuid())
  supplierId          String
  requestedByUserId   String
  status              ReplenishmentStatus  @default(PENDING)
  requestedAt         DateTime             @default(now())
  sentAt              DateTime?
  notes               String?
  createdAt           DateTime             @default(now())
  updatedAt           DateTime             @updatedAt

  supplier            Supplier             @relation(fields: [supplierId], references: [id], onDelete: Restrict)
  requestedBy         User                 @relation(fields: [requestedByUserId], references: [id], onDelete: Restrict)
  items               ReplenishmentRequestItem[]

  @@index([supplierId])
  @@index([status])
}
```

#### Scenario: Transición de estado PENDING → SENT

- GIVEN una `ReplenishmentRequest` con `status = PENDING` y `sentAt = null`
- WHEN se actualiza a `status = SENT`
- THEN la capa de servicio setea `sentAt = now()` (regla de módulo `replenishment`)

### Requirement: Entidad ReplenishmentRequestItem

```prisma
model ReplenishmentRequestItem {
  id                     String   @id @default(cuid())
  replenishmentRequestId String
  productId              String
  requestedQuantity      Int
  unitPrice              Decimal  @db.Decimal(12, 2)
  createdAt              DateTime @default(now())

  request                ReplenishmentRequest @relation(fields: [replenishmentRequestId], references: [id], onDelete: Cascade)
  product                Product              @relation(fields: [productId], references: [id], onDelete: Restrict)

  @@index([replenishmentRequestId])
  @@index([productId])
}
```

#### Scenario: Borrar request borra items en cascada

- GIVEN una `ReplenishmentRequest` con 3 items
- WHEN se ejecuta `DELETE` sobre la request
- THEN los 3 items se borran automáticamente (`onDelete: Cascade`)

### Requirement: Primera migración

El repo **MUST** incluir una primera migración generada con `prisma migrate dev --name init` que cree las 9 tablas y los 6 enums. La migración **MUST** quedar versionada en `prisma/migrations/`.

#### Scenario: Migrate desde DB vacía

- GIVEN una Postgres recién creada (sin tablas)
- WHEN se ejecuta `npx prisma migrate deploy`
- THEN se crean las 9 tablas, los 6 enums, y todos los índices declarados

### Requirement: Seed de usuario administrador

El archivo `prisma/seed.ts` **MUST** crear (o actualizar idempotentemente vía `upsert`) un usuario `ADMIN` usando las variables de entorno `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_FULLNAME`. La contraseña **MUST** guardarse hasheada con bcrypt (cost = 10).

#### Scenario: Seed idempotente

- GIVEN un seed ya ejecutado una vez
- WHEN se ejecuta `npm run db:seed` por segunda vez
- THEN el upsert no crea un duplicado; el usuario admin existe una sola vez

#### Scenario: Seed sin variables

- GIVEN un `.env` sin `SEED_ADMIN_PASSWORD`
- WHEN se ejecuta `npm run db:seed`
- THEN el script aborta con error legible indicando la variable faltante

## Acceptance

- [ ] `prisma/schema.prisma` declara los 9 modelos y los 6 enums exactos (incluye `ProductUnit`).
- [ ] El modelo `Product` incluye `unit ProductUnit` (requerido), `unitContent Decimal @db.Decimal(10,3)` (requerido) y `brand String? @db.VarChar(120)` (opcional).
- [ ] `npx prisma format` no reporta errores.
- [ ] `npx prisma validate` pasa en limpio.
- [ ] `npx prisma migrate dev --name init` genera la primera migración.
- [ ] `npm run db:seed` crea el usuario admin con password hasheada (bcrypt cost 10).
- [ ] Re-ejecutar el seed no duplica datos.
- [ ] Todos los FKs tienen `onDelete` explícito (no se usa el default del driver).
