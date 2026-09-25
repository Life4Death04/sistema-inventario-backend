import { ProductUnit, UserRole } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
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
