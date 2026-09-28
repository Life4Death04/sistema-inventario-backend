/**
 * Production-simulation seed (`db:seed:sim`).
 *
 * Populates the database with a realistic, cross-referenced dataset so the app
 * looks like a real pharmacy in use. The data is transcribed from the frontend
 * mock database (sistema-inventario-frontend/src/data/mockDatabase.ts) and
 * mapped onto the backend Prisma schema. It is DEV/DEMO tooling only — never
 * run it against a production database.
 *
 * Differences from the two other seeds:
 *   - `prisma/seed.ts` (db:seed)        → single PRIVATE setup ADMIN, isDemo:false.
 *   - `prisma/scripts/seed-demo.ts`     → public read-only demo bootstrap + marker.
 *   - THIS script (db:seed:sim)         → rich staff/catalog/history dataset for
 *                                         demoing a "production-like" environment.
 *
 * All 9 staff users share the password provided through SEED_SIM_STAFF_PASSWORD
 * (isDemo:false).
 * The read-only demo administrator uses SEED_SIM_DEMO_PASSWORD (isDemo:true):
 * demouser@highmeds.prod.
 *
 * No Alert rows are seeded — several products sit at/below minStock on purpose,
 * so alerts can be generated from normal inventory use instead.
 *
 * Usage:
 *   Set SEED_SIM_STAFF_PASSWORD to the shared staff password.
 *   Set SEED_SIM_DEMO_PASSWORD to the demo administrator password.
 *   npm run db:seed:sim
 */

import 'dotenv/config';
import bcrypt from 'bcrypt';
import { PrismaClient, UserRole, ProductUnit, ReplenishmentStatus } from '@prisma/client';

const BCRYPT_COST = 10;
const SIMULATED_STAFF_PASSWORD_ENV = 'SEED_SIM_STAFF_PASSWORD';
const SIMULATED_DEMO_PASSWORD_ENV = 'SEED_SIM_DEMO_PASSWORD';

function resolveRequiredPassword(envName: string): string {
  const password = process.env[envName];
  if (!password?.trim()) {
    throw new Error(`${envName} must be set to a non-empty value before seeding.`);
  }

  return password;
}

// ---------------------------------------------------------------------------
// Data — transcribed from the frontend mock (display-only fields dropped:
// suppliers.productsCount, users.lastAccess, requests.{itemsCount,estimatedTotal}).
// ---------------------------------------------------------------------------

const categories = [
  {
    name: 'Antibiotico',
    description: 'Medicamentos para tratamientos infecciosos',
    createdAt: '2026-05-01T08:00:00.000Z',
  },
  {
    name: 'Analgesico',
    description: 'Medicamentos para control del dolor y fiebre',
    createdAt: '2026-05-01T08:30:00.000Z',
  },
  {
    name: 'Antihistaminico',
    description: 'Medicamentos para alergias y afecciones respiratorias',
    createdAt: '2026-05-01T09:00:00.000Z',
  },
];

const suppliers = [
  {
    name: 'Distribuidora MedSalud C.A.',
    rif: 'J-40123456-7',
    whatsapp: '+584245551820',
    address: 'Av. Bolivar, Maturin, Monagas',
    active: true,
    createdAt: '2026-05-01T08:00:00.000Z',
  },
  {
    name: 'Farmaceutica del Oriente',
    rif: 'J-41987654-3',
    whatsapp: '+584125553041',
    address: 'Av. Alirio Ugarte Pelayo, Maturin',
    active: true,
    createdAt: '2026-05-03T08:00:00.000Z',
  },
  {
    name: 'Suministros Monagas',
    rif: 'J-40555221-9',
    whatsapp: '+584165557726',
    address: 'Zona Industrial I, Maturin',
    active: true,
    createdAt: '2026-05-05T08:00:00.000Z',
  },
  {
    name: 'Laboratorios Caroni',
    rif: 'J-31447789-0',
    whatsapp: '+584145559013',
    address: 'Puerto Ordaz, Bolivar',
    active: true,
    createdAt: '2026-05-06T08:00:00.000Z',
  },
  {
    name: 'Insumos Medicos Aragua',
    rif: 'J-42118003-5',
    whatsapp: '+584245552298',
    address: 'Maracay, Aragua',
    active: false,
    createdAt: '2026-05-08T08:00:00.000Z',
  },
  {
    name: 'Drogueria Central',
    rif: 'J-30669214-2',
    whatsapp: '+584265556634',
    address: 'Caracas, Distrito Capital',
    active: false,
    createdAt: '2026-05-10T08:00:00.000Z',
  },
  {
    name: 'Red Farma Plus',
    rif: 'J-43211009-6',
    whatsapp: '+584145551212',
    address: 'Lecheria, Anzoategui',
    active: true,
    createdAt: '2026-05-12T08:00:00.000Z',
  },
  {
    name: 'Grupo San Benito',
    rif: 'J-39877654-4',
    whatsapp: '+584247770123',
    address: 'Barcelona, Anzoategui',
    active: true,
    createdAt: '2026-05-14T08:00:00.000Z',
  },
];

const staffUsers = [
  {
    fullName: 'Santiago Rodriguez',
    email: 'l.ferrer@highmeds.com',
    role: UserRole.ADMIN,
    active: true,
    phone: '+584121234567',
    createdAt: '2026-05-02T08:30:00.000Z',
  },
  {
    fullName: 'Paola Lopez',
    email: 'p.lopez@highmeds.com',
    role: UserRole.ADMIN,
    active: true,
    phone: '+584141110022',
    createdAt: '2026-05-05T09:00:00.000Z',
  },
  {
    fullName: 'Carlos Mendoza',
    email: 'c.mendoza@highmeds.com',
    role: UserRole.MANAGER,
    active: true,
    phone: '+584241998811',
    createdAt: '2026-05-06T10:15:00.000Z',
  },
  {
    fullName: 'Daniela Ortiz',
    email: 'd.ortiz@highmeds.com',
    role: UserRole.MANAGER,
    active: true,
    phone: '+584121115566',
    createdAt: '2026-05-08T08:20:00.000Z',
  },
  {
    fullName: 'Miguel Sucre',
    email: 'm.sucre@highmeds.com',
    role: UserRole.MANAGER,
    active: true,
    phone: '+584141237890',
    createdAt: '2026-05-09T09:45:00.000Z',
  },
  {
    fullName: 'Ana Perez',
    email: 'a.perez@highmeds.com',
    role: UserRole.OPERATOR,
    active: true,
    phone: '+584241221100',
    createdAt: '2026-05-11T11:05:00.000Z',
  },
  {
    fullName: 'Jesus Salazar',
    email: 'j.salazar@highmeds.com',
    role: UserRole.OPERATOR,
    active: false,
    phone: '+584249112211',
    createdAt: '2026-05-13T15:30:00.000Z',
  },
  {
    fullName: 'Lucia Rojas',
    email: 'l.rojas@highmeds.com',
    role: UserRole.OPERATOR,
    active: true,
    phone: '+584142227744',
    createdAt: '2026-05-15T13:10:00.000Z',
  },
  {
    fullName: 'Pedro Leon',
    email: 'p.leon@highmeds.com',
    role: UserRole.OPERATOR,
    active: true,
    phone: '+584248881234',
    createdAt: '2026-05-19T10:50:00.000Z',
  },
];

const demoUser = {
  fullName: 'Demo Administrator',
  email: 'demouser@highmeds.prod',
  role: UserRole.ADMIN,
  active: true,
  isDemo: true,
};

const products = [
  {
    code: 'MED-0102',
    name: 'Amoxicilina 500mg',
    activeIngredient: 'Amoxicilina trihidrato',
    description: 'Antibiotico oral de uso frecuente para infecciones bacterianas',
    presentation: 'Caja x 50 capsulas',
    brand: 'Genfar',
    unit: ProductUnit.MG,
    unitContent: '500',
    categoryName: 'Antibiotico',
    stock: 1240,
    minStock: 300,
    price: '6.85',
    active: true,
    createdAt: '2026-05-20T10:00:00.000Z',
  },
  {
    code: 'MED-0845',
    name: 'Ibuprofeno 400mg',
    activeIngredient: 'Ibuprofeno',
    description: 'Analgesico antiinflamatorio para dolor y fiebre',
    presentation: 'Caja x 20 tabletas',
    brand: 'MK',
    unit: ProductUnit.MG,
    unitContent: '400',
    categoryName: 'Analgesico',
    stock: 45,
    minStock: 60,
    price: '3.40',
    active: true,
    createdAt: '2026-05-21T10:00:00.000Z',
  },
  {
    code: 'MED-1102',
    name: 'Loratadina 10mg',
    activeIngredient: 'Loratadina',
    description: 'Antihistaminico para control de rinitis y alergias',
    presentation: 'Blister x 10 tabletas',
    brand: 'Calox',
    unit: ProductUnit.MG,
    unitContent: '10',
    categoryName: 'Antihistaminico',
    stock: 0,
    minStock: 40,
    price: '2.25',
    active: true,
    createdAt: '2026-05-22T10:00:00.000Z',
  },
  {
    code: 'MED-0418',
    name: 'Omeprazol 20mg',
    activeIngredient: 'Omeprazol',
    description: 'Protector gastrico de alta rotacion en farmacia general',
    presentation: 'Caja x 14 capsulas',
    brand: 'Leti',
    unit: ProductUnit.MG,
    unitContent: '20',
    categoryName: 'Antibiotico',
    stock: 95,
    minStock: 120,
    price: '4.10',
    active: true,
    createdAt: '2026-05-23T10:00:00.000Z',
  },
  {
    code: 'MED-0731',
    name: 'Paracetamol 500mg',
    activeIngredient: 'Acetaminofen',
    description: 'Analgesico antipiretico para dispensacion continua',
    presentation: 'Caja x 100 tabletas',
    brand: 'Bayer',
    unit: ProductUnit.MG,
    unitContent: '500',
    categoryName: 'Analgesico',
    stock: 860,
    minStock: 250,
    price: '5.20',
    active: true,
    createdAt: '2026-05-24T10:00:00.000Z',
  },
  {
    code: 'MED-0994',
    name: 'Cetirizina 10mg',
    activeIngredient: 'Cetirizina diclorhidrato',
    description: 'Antihistaminico oral para sintomas alergicos estacionales',
    presentation: 'Caja x 30 tabletas',
    brand: 'Genven',
    unit: ProductUnit.MG,
    unitContent: '10',
    categoryName: 'Antihistaminico',
    stock: 210,
    minStock: 70,
    price: '4.85',
    active: true,
    createdAt: '2026-05-25T10:00:00.000Z',
  },
];

const productSuppliers = [
  { productCode: 'MED-0102', supplierRif: 'J-40123456-7', referencePrice: '6.50' },
  { productCode: 'MED-0845', supplierRif: 'J-41987654-3', referencePrice: '3.10' },
  { productCode: 'MED-1102', supplierRif: 'J-40555221-9', referencePrice: '2.00' },
  { productCode: 'MED-0418', supplierRif: 'J-31447789-0', referencePrice: '3.80' },
  { productCode: 'MED-0731', supplierRif: 'J-40123456-7', referencePrice: '4.90' },
  { productCode: 'MED-0994', supplierRif: 'J-41987654-3', referencePrice: '4.20' },
  { productCode: 'MED-0102', supplierRif: 'J-43211009-6', referencePrice: '6.70' },
  { productCode: 'MED-0845', supplierRif: 'J-39877654-4', referencePrice: '3.30' },
];

const replenishmentRequests = [
  {
    supplierRif: 'J-40555221-9',
    requestedByEmail: 'p.lopez@highmeds.com',
    status: ReplenishmentStatus.PENDING,
    requestedAt: '2026-06-25T14:30:00.000Z',
    sentAt: null as string | null,
    receivedAt: null as string | null,
    receivedByEmail: null as string | null,
    cancelledAt: null as string | null,
    cancelledByEmail: null as string | null,
    notes: 'Reposicion prioritaria por quiebre de antihistaminicos',
    items: [{ productCode: 'MED-1102', requestedQuantity: 120, unitPrice: '2.00' }],
  },
  {
    supplierRif: 'J-41987654-3',
    requestedByEmail: 'l.ferrer@highmeds.com',
    status: ReplenishmentStatus.SENT,
    requestedAt: '2026-06-23T10:00:00.000Z',
    sentAt: '2026-06-23T10:10:00.000Z' as string | null,
    receivedAt: null as string | null,
    receivedByEmail: null as string | null,
    cancelledAt: null as string | null,
    cancelledByEmail: null as string | null,
    notes: 'Solicitud enviada a drogueria por canal WhatsApp',
    items: [
      { productCode: 'MED-0845', requestedQuantity: 90, unitPrice: '3.10' },
      { productCode: 'MED-0994', requestedQuantity: 60, unitPrice: '4.20' },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

/**
 * Seeds the production-simulation dataset on the given `prisma` client. Master
 * data is upserted by natural key and dependent relations use returned database
 * IDs. Replenishment requests are created for fresh, disposable databases only.
 * Exported so it can be invoked/tested without the CLI side effects.
 */
export async function main(prisma: PrismaClient): Promise<void> {
  const simulatedStaffPassword = resolveRequiredPassword(SIMULATED_STAFF_PASSWORD_ENV);
  const simulatedDemoPassword = resolveRequiredPassword(SIMULATED_DEMO_PASSWORD_ENV);

  console.log('🌱  Seeding production-simulation dataset…');

  const staffPassword = await bcrypt.hash(simulatedStaffPassword, BCRYPT_COST);
  const demoPassword = await bcrypt.hash(simulatedDemoPassword, BCRYPT_COST);

  await prisma.$transaction(async (tx) => {
    const categoryIdsByName = new Map<string, string>();
    const supplierIdsByRif = new Map<string, string>();
    const userIdsByEmail = new Map<string, string>();
    const productIdsByCode = new Map<string, string>();

    // 1. Categories
    for (const c of categories) {
      const category = await tx.category.upsert({
        where: { name: c.name },
        update: { name: c.name, description: c.description },
        create: { name: c.name, description: c.description, createdAt: new Date(c.createdAt) },
      });
      categoryIdsByName.set(c.name, category.id);
    }

    // 2. Suppliers
    for (const s of suppliers) {
      const supplier = await tx.supplier.upsert({
        where: { rif: s.rif },
        update: {
          name: s.name,
          rif: s.rif,
          whatsapp: s.whatsapp,
          address: s.address,
          active: s.active,
        },
        create: {
          name: s.name,
          rif: s.rif,
          whatsapp: s.whatsapp,
          address: s.address,
          active: s.active,
          createdAt: new Date(s.createdAt),
        },
      });
      supplierIdsByRif.set(s.rif, supplier.id);
    }

    // 3. Users — 9 staff (isDemo:false) upserted by unique email.
    for (const u of staffUsers) {
      const user = await tx.user.upsert({
        where: { email: u.email },
        update: {
          fullName: u.fullName,
          role: u.role,
          active: u.active,
          phone: u.phone,
          isDemo: false,
          password: staffPassword,
        },
        create: {
          fullName: u.fullName,
          email: u.email,
          role: u.role,
          active: u.active,
          phone: u.phone,
          isDemo: false,
          password: staffPassword,
          createdAt: new Date(u.createdAt),
        },
      });
      userIdsByEmail.set(u.email, user.id);
    }

    // 4. Read-only demo administrator — not used by replenishment requests.
    await tx.user.upsert({
      where: { email: demoUser.email },
      update: {
        fullName: demoUser.fullName,
        role: demoUser.role,
        active: demoUser.active,
        isDemo: demoUser.isDemo,
        password: demoPassword,
      },
      create: {
        fullName: demoUser.fullName,
        email: demoUser.email,
        role: demoUser.role,
        active: demoUser.active,
        isDemo: demoUser.isDemo,
        password: demoPassword,
      },
    });

    // 5. Products
    for (const p of products) {
      const categoryId = categoryIdsByName.get(p.categoryName);
      if (!categoryId) throw new Error(`Missing seeded category: ${p.categoryName}`);

      const product = await tx.product.upsert({
        where: { code: p.code },
        update: {
          name: p.name,
          activeIngredient: p.activeIngredient,
          description: p.description,
          presentation: p.presentation,
          brand: p.brand,
          unit: p.unit,
          unitContent: p.unitContent,
          categoryId,
          stock: p.stock,
          minStock: p.minStock,
          price: p.price,
          active: p.active,
        },
        create: {
          code: p.code,
          name: p.name,
          activeIngredient: p.activeIngredient,
          description: p.description,
          presentation: p.presentation,
          brand: p.brand,
          unit: p.unit,
          unitContent: p.unitContent,
          categoryId,
          stock: p.stock,
          minStock: p.minStock,
          price: p.price,
          active: p.active,
          createdAt: new Date(p.createdAt),
        },
      });
      productIdsByCode.set(p.code, product.id);
    }

    // 6. Product ⇄ Supplier links
    for (const ps of productSuppliers) {
      const productId = productIdsByCode.get(ps.productCode);
      const supplierId = supplierIdsByRif.get(ps.supplierRif);
      if (!productId) throw new Error(`Missing seeded product: ${ps.productCode}`);
      if (!supplierId) throw new Error(`Missing seeded supplier: ${ps.supplierRif}`);

      await tx.productSupplier.upsert({
        where: { productId_supplierId: { productId, supplierId } },
        update: { referencePrice: ps.referencePrice },
        create: { productId, supplierId, referencePrice: ps.referencePrice },
      });
    }

    // 7. Replenishment requests + items
    for (const r of replenishmentRequests) {
      const supplierId = supplierIdsByRif.get(r.supplierRif);
      const requestedByUserId = userIdsByEmail.get(r.requestedByEmail);
      const receivedByUserId = r.receivedByEmail ? userIdsByEmail.get(r.receivedByEmail) : null;
      const cancelledByUserId = r.cancelledByEmail ? userIdsByEmail.get(r.cancelledByEmail) : null;
      if (!supplierId) throw new Error(`Missing seeded supplier: ${r.supplierRif}`);
      if (!requestedByUserId) throw new Error(`Missing seeded user: ${r.requestedByEmail}`);
      if (r.receivedByEmail && !receivedByUserId)
        throw new Error(`Missing seeded user: ${r.receivedByEmail}`);
      if (r.cancelledByEmail && !cancelledByUserId)
        throw new Error(`Missing seeded user: ${r.cancelledByEmail}`);

      await tx.replenishmentRequest.create({
        data: {
          supplierId,
          requestedByUserId,
          status: r.status,
          requestedAt: new Date(r.requestedAt),
          sentAt: r.sentAt ? new Date(r.sentAt) : null,
          receivedAt: r.receivedAt ? new Date(r.receivedAt) : null,
          receivedByUserId,
          cancelledAt: r.cancelledAt ? new Date(r.cancelledAt) : null,
          cancelledByUserId,
          notes: r.notes,
          items: {
            create: r.items.map((item) => {
              const productId = productIdsByCode.get(item.productCode);
              if (!productId) throw new Error(`Missing seeded product: ${item.productCode}`);
              return {
                productId,
                requestedQuantity: item.requestedQuantity,
                unitPrice: item.unitPrice,
              };
            }),
          },
        },
      });
    }
  });

  console.log(
    `✅  Production-simulation seed complete: ${categories.length} categories, ` +
      `${suppliers.length} suppliers, ${staffUsers.length} staff users, 1 demo administrator, ` +
      `${products.length} products, ${productSuppliers.length} product-supplier links, ` +
      `${replenishmentRequests.length} replenishment requests.`,
  );
  console.log(`   Staff login: any @highmeds.com email / ${SIMULATED_STAFF_PASSWORD_ENV}`);
  console.log(`   Demo administrator: ${demoUser.email} / ${SIMULATED_DEMO_PASSWORD_ENV}`);
}

// ---------------------------------------------------------------------------
// Entry point — only runs when executed directly (`npm run db:seed:sim`),
// never on import (e.g. from tests).
// ---------------------------------------------------------------------------

const isMainModule = import.meta.url === `file://${process.argv[1] ?? ''}`;
if (isMainModule) {
  const prisma = new PrismaClient();
  main(prisma)
    .catch((err: unknown) => {
      console.error('❌  Production-simulation seed failed:', err);
      process.exit(1);
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
