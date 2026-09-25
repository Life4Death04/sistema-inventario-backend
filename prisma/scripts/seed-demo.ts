/**
 * db:seed:demo — non-destructive master-data bootstrap for the public,
 * read-only demo environment.
 *
 * Per design.md + specs/database-schema/spec.md ("Non-destructive
 * master-data demo bootstrap", "Demo database isolation and seed-target
 * safety"): this script NEVER writes transactional tables (InventoryMovement,
 * Alert, ReplenishmentRequest, ReplenishmentRequestItem) and NEVER changes an
 * existing Product.stock. It creates/upserts exactly one public `isDemo:true`
 * ADMIN plus fabricated Category/Supplier/Product/ProductSupplier rows.
 *
 * Two independent inputs gate every write (src/shared/demo/seedSafety.ts,
 * PR4): (a) DEMO_SEED_CONFIRM must match exactly, (b) the persisted
 * DemoSeedMarker, read FIRST and independently of the confirmation. This
 * module wires the pure state machine to real Prisma reads/writes — it does
 * not reimplement the routing logic.
 *
 * Usage: DEMO_SEED_CONFIRM=... npm run db:seed:demo
 */
import { Prisma, PrismaClient, ProductUnit, UserRole } from '@prisma/client';
import bcrypt from 'bcrypt';
import 'dotenv/config';
import {
  assertConfirm,
  resolveSeedState,
  type SeedState,
} from '../../src/shared/demo/seedSafety.js';
import {
  DEMO_ADMIN_EMAIL,
  DEMO_ADMIN_PASSWORD,
  DEMO_MARKER_VERSION,
} from '../../src/shared/demo/demoCredentials.js';

/**
 * The subset of `PrismaClient` this module reads/writes. Both the real
 * `Prisma.TransactionClient` (interactive-transaction callback param) and
 * this module's test mocks satisfy this shape structurally — it deliberately
 * excludes `$transaction`/`$connect`/etc. so a value typed this way can NEVER
 * open a nested transaction (the exact defect this correction removes).
 */
type SeedTxClient = Pick<
  PrismaClient,
  | 'user'
  | 'refreshToken'
  | 'category'
  | 'product'
  | 'supplier'
  | 'productSupplier'
  | 'inventoryMovement'
  | 'alert'
  | 'replenishmentRequest'
  | 'replenishmentRequestItem'
  | 'demoSeedMarker'
>;

const BCRYPT_COST = 10;

/**
 * Operator confirmation literal. Must be supplied verbatim via
 * `DEMO_SEED_CONFIRM` — a missing or mismatched value aborts before any read
 * result is used for a write decision (specs — "Confirmation failure").
 */
export const REQUIRED_CONFIRMATION = 'YES_SEED_THE_DEMO_DATABASE';

/**
 * Maximum number of times the whole read→resolve→write transaction is
 * attempted. One initial attempt plus 2 retries — a deterministic, small
 * bound for a one-shot CLI script, not unbounded backoff ceremony.
 */
const MAX_TRANSACTION_ATTEMPTS = 3;

/**
 * `P2034` is Prisma's stable "transaction conflict" code: PostgreSQL, under
 * `Serializable` isolation, aborted this transaction because it could not be
 * placed in any serial order against a concurrent transaction it conflicted
 * with. This is the ONLY retryable case — every other
 * `PrismaClientKnownRequestError` (and every non-Prisma error) is a real
 * failure and must propagate unchanged, not be silently retried.
 */
function isRetryableTransactionConflict(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034';
}

// ---------------------------------------------------------------------------
// Fabricated master data — pharmacy demo content, no real staff/supplier PII.
// ---------------------------------------------------------------------------

interface DemoCategorySeed {
  name: string;
  description: string;
}

interface DemoSupplierSeed {
  name: string;
  rif: string;
  whatsapp: string | null;
}

interface DemoProductSeed {
  code: string;
  name: string;
  categoryName: string;
  unit: ProductUnit;
  unitContent: string;
  minStock: number;
  price: string;
  suppliers: Array<{ rif: string; referencePrice: string }>;
}

const DEMO_CATEGORIES: DemoCategorySeed[] = [
  { name: 'Analgésicos y Antipiréticos', description: 'Medicamentos para dolor y fiebre.' },
  { name: 'Antibióticos', description: 'Tratamientos antibacterianos de uso común.' },
];

/** Deterministic RIFs (`J-<seq>`) so Supplier upserts stay stable across reruns. */
const DEMO_SUPPLIERS: DemoSupplierSeed[] = [
  { name: 'Distribuidora Central de Medicamentos', rif: 'J-00000001', whatsapp: '+584121234567' },
  { name: 'Farmacéutica Andina', rif: 'J-00000002', whatsapp: null },
];

const DEMO_PRODUCTS: DemoProductSeed[] = [
  {
    code: 'DEMO-PARA-500',
    name: 'Paracetamol 500mg',
    categoryName: 'Analgésicos y Antipiréticos',
    unit: ProductUnit.UNIT,
    unitContent: '30',
    minStock: 20,
    price: '3.50',
    suppliers: [
      { rif: 'J-00000001', referencePrice: '2.80' },
      { rif: 'J-00000002', referencePrice: '3.00' },
    ],
  },
  {
    code: 'DEMO-AMOX-250',
    name: 'Amoxicilina 250mg',
    categoryName: 'Antibióticos',
    unit: ProductUnit.UNIT,
    unitContent: '20',
    minStock: 15,
    price: '6.00',
    suppliers: [{ rif: 'J-00000001', referencePrice: '5.00' }],
  },
];

// ---------------------------------------------------------------------------
// Empty-database detection — the 10 approved application models, excluding
// DemoSeedMarker (tracked separately via markerCount) and _prisma_migrations.
// ---------------------------------------------------------------------------

/** Counts every row across the 10 approved application models, via `tx`. */
export async function countApplicationRows(tx: SeedTxClient): Promise<number> {
  const counts = await Promise.all([
    tx.user.count(),
    tx.refreshToken.count(),
    tx.category.count(),
    tx.product.count(),
    tx.supplier.count(),
    tx.productSupplier.count(),
    tx.inventoryMovement.count(),
    tx.alert.count(),
    tx.replenishmentRequest.count(),
    tx.replenishmentRequestItem.count(),
  ]);
  return counts.reduce((sum, n) => sum + n, 0);
}

/**
 * Marker-first state resolution, run ENTIRELY inside the caller's open
 * transaction (`tx`) — this is the atomicity correction: the marker is read
 * FIRST and independently awaited; the ten application-model counts (the
 * empty-DB check) run ONLY when no marker exists yet, and are SKIPPED
 * entirely on a recognized rerun. Reading everything on `tx` (never on the
 * root client) closes the concurrent-first-run TOCTOU window — no other
 * transaction can commit a write between this read and this transaction's
 * own write, because Postgres serializes concurrent transactions touching
 * the same rows.
 */
export async function resolveSeedStateInTransaction(tx: SeedTxClient): Promise<SeedState> {
  const markerCount = await tx.demoSeedMarker.count();

  if (markerCount > 0) {
    const [matchingMarkerCount, totalDemoIdentityCount, matchingDemoIdentityCount] =
      await Promise.all([
        tx.demoSeedMarker.count({ where: { version: DEMO_MARKER_VERSION } }),
        tx.user.count({ where: { isDemo: true } }),
        tx.user.count({ where: { isDemo: true, email: DEMO_ADMIN_EMAIL, role: UserRole.ADMIN } }),
      ]);
    // appIsEmpty is irrelevant once a marker exists — resolveSeedState never
    // reads it on this branch (per seedSafety.ts's contract), and the ten
    // application-model counts are never queried, by construction.
    return resolveSeedState({
      markerCount,
      matchingMarkerCount,
      totalDemoIdentityCount,
      matchingDemoIdentityCount,
      appIsEmpty: false,
    });
  }

  const totalRows = await countApplicationRows(tx);
  return resolveSeedState({
    markerCount: 0,
    matchingMarkerCount: 0,
    totalDemoIdentityCount: 0,
    matchingDemoIdentityCount: 0,
    appIsEmpty: totalRows === 0,
  });
}

// ---------------------------------------------------------------------------
// Bootstrap — runs INSIDE the caller's already-open transaction.
// ---------------------------------------------------------------------------

/**
 * Creates/upserts the public demo ADMIN and all master data using `tx` — the
 * SAME transaction client `resolveSeedStateInTransaction` just read from.
 * `tx`'s type structurally excludes `$transaction`, so this function CANNOT
 * open a nested transaction; it can only write to the one the caller
 * already opened. `DemoSeedMarker` is created ONLY when `isFirstRun` is
 * true. Product UPDATE payloads intentionally omit `stock` so reruns never
 * touch a manually-adjusted stock level — new Product rows start at
 * `stock: 0`.
 */
export async function bootstrapDemoData(tx: SeedTxClient, isFirstRun: boolean): Promise<void> {
  const hashedPassword = await bcrypt.hash(DEMO_ADMIN_PASSWORD, BCRYPT_COST);

  if (isFirstRun) {
    await tx.demoSeedMarker.create({ data: { version: DEMO_MARKER_VERSION } });
  }

  await tx.user.upsert({
    where: { email: DEMO_ADMIN_EMAIL },
    update: { password: hashedPassword, role: UserRole.ADMIN, isDemo: true, active: true },
    create: {
      email: DEMO_ADMIN_EMAIL,
      fullName: 'Demo Administrator',
      password: hashedPassword,
      role: UserRole.ADMIN,
      isDemo: true,
      active: true,
    },
  });

  const categoryIdByName = new Map<string, string>();
  for (const category of DEMO_CATEGORIES) {
    const row = await tx.category.upsert({
      where: { name: category.name },
      update: { description: category.description },
      create: { name: category.name, description: category.description },
    });
    categoryIdByName.set(category.name, row.id);
  }

  const supplierIdByRif = new Map<string, string>();
  for (const supplier of DEMO_SUPPLIERS) {
    const row = await tx.supplier.upsert({
      where: { rif: supplier.rif },
      update: { name: supplier.name, whatsapp: supplier.whatsapp },
      create: { name: supplier.name, rif: supplier.rif, whatsapp: supplier.whatsapp },
    });
    supplierIdByRif.set(supplier.rif, row.id);
  }

  for (const product of DEMO_PRODUCTS) {
    const categoryId = categoryIdByName.get(product.categoryName);
    if (!categoryId) {
      throw new Error(`db:seed:demo — unknown demo category "${product.categoryName}"`);
    }

    const row = await tx.product.upsert({
      where: { code: product.code },
      update: {
        name: product.name,
        categoryId,
        unit: product.unit,
        unitContent: product.unitContent,
        minStock: product.minStock,
        price: product.price,
        // stock intentionally OMITTED — reruns must never overwrite manual stock.
      },
      create: {
        code: product.code,
        name: product.name,
        categoryId,
        unit: product.unit,
        unitContent: product.unitContent,
        minStock: product.minStock,
        price: product.price,
        stock: 0,
      },
    });

    for (const link of product.suppliers) {
      const supplierId = supplierIdByRif.get(link.rif);
      if (!supplierId) {
        throw new Error(`db:seed:demo — unknown demo supplier rif "${link.rif}"`);
      }
      await tx.productSupplier.upsert({
        where: { productId_supplierId: { productId: row.id, supplierId } },
        update: { referencePrice: link.referencePrice },
        create: { productId: row.id, supplierId, referencePrice: link.referencePrice },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Runs the full confirm → resolve → (bootstrap | abort) flow against
 * `prisma`. The marker-first safety read, the state resolution, and every
 * write all execute inside exactly ONE `$transaction` call per attempt, on
 * the SAME transaction-scoped client (`tx`) — this is the atomicity
 * correction: the root `prisma` client is used only to open the
 * transaction, never to read or write application data directly, so there
 * is no TOCTOU window between "decide it's safe to write" and "write".
 *
 * The transaction runs at `Serializable` isolation — PostgreSQL's default
 * `ReadCommitted` does NOT serialize the marker/emptiness reads against a
 * concurrent transaction's writes, so two concurrent first-run processes
 * could both read "no marker, empty" and both attempt to bootstrap.
 * `Serializable` makes PostgreSQL detect that conflict and abort the loser
 * with a retryable `P2034` error instead of silently corrupting state; the
 * bounded retry loop below re-opens a FRESH transaction (a fresh `tx`) and
 * reruns the ENTIRE marker-first read → conditional emptiness read → state
 * resolution → writes sequence from scratch on each attempt — a Postgres
 * serialization failure invalidates every read/decision the aborted
 * transaction made, so nothing from a failed attempt may be reused.
 */
export async function runSeedDemo(prisma: PrismaClient): Promise<void> {
  assertConfirm(process.env['DEMO_SEED_CONFIRM'] === REQUIRED_CONFIRMATION);

  for (let attempt = 1; attempt <= MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
    try {
      await prisma.$transaction(
        async (tx: Prisma.TransactionClient) => {
          const state = await resolveSeedStateInTransaction(tx);

          switch (state) {
            case 'FIRST_RUN':
              console.log('🌱  db:seed:demo — first run on an empty database. Bootstrapping…');
              await bootstrapDemoData(tx, true);
              console.log('✅  db:seed:demo — bootstrap complete, demo marker persisted.');
              return;
            case 'RECOGNIZED_RERUN':
              console.log(
                '🔁  db:seed:demo — recognized rerun. Upserting master data (non-destructive)…',
              );
              await bootstrapDemoData(tx, false);
              console.log('✅  db:seed:demo — rerun complete. Zero stock/transactional writes.');
              return;
            case 'ABORT_UNMARKED':
              throw new Error(
                'db:seed:demo aborted — target database has data but no DemoSeedMarker. Zero writes performed.',
              );
            case 'ABORT_MISMATCH':
              throw new Error(
                'db:seed:demo aborted — DemoSeedMarker/demo-identity invariant mismatch. Zero writes performed.',
              );
          }
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
      return;
    } catch (err) {
      if (isRetryableTransactionConflict(err) && attempt < MAX_TRANSACTION_ATTEMPTS) {
        console.warn(
          `⚠️  db:seed:demo — serialization conflict (P2034) on attempt ${attempt}/${MAX_TRANSACTION_ATTEMPTS}, retrying with a fresh transaction…`,
        );
        continue;
      }
      throw err;
    }
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1] ?? ''}`;
if (isMainModule) {
  const prisma = new PrismaClient();
  runSeedDemo(prisma)
    .catch((err: unknown) => {
      console.error('❌  db:seed:demo failed:', err);
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
