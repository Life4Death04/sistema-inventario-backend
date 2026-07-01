/**
 * Smoke tests for product CRUD and product-supplier link endpoints.
 * Prisma is fully mocked — no real DB required.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { app } from '../../src/app.js';

type ProductUnit = 'MG' | 'G' | 'KG' | 'ML' | 'L' | 'UNIT';

interface ProductRecord {
  id: string;
  code: string;
  name: string;
  activeIngredient: string | null;
  description: string | null;
  presentation: string | null;
  brand: string | null;
  unit: ProductUnit;
  unitContent: string;
  categoryId: string;
  stock: number;
  minStock: number;
  price: string;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface CategoryRecord {
  id: string;
  name: string;
  description: string | null;
}

interface SupplierRecord {
  id: string;
  name: string;
  rif: string | null;
  whatsapp: string | null;
  address: string | null;
  active: boolean;
}

interface ProductSupplierLink {
  id: string;
  productId: string;
  supplierId: string;
  referencePrice: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface ProductBody {
  product: ProductRecord & {
    category?: CategoryRecord | null;
    suppliers?: Array<{ supplier: SupplierRecord; referencePrice: string | null }>;
  };
}

interface LinkBody {
  link: { id: string; supplierId: string; referencePrice: string | null };
}

interface SuppliersBody {
  suppliers: Array<{ supplier: SupplierRecord; referencePrice: string | null }>;
}

interface ListBody {
  data: ProductRecord[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

interface ErrorBody {
  error: string;
  message: string;
  statusCode: number;
}

const ADMIN_ID = 'clh3xxk0h0000356c9a5oba7k';
const MANAGER_ID = 'cjld2cjxh0000qzrmn831i7rn';
const OPERATOR_ID = 'cjld2cyuq0000t3rmniod1foy';

const CAT1_ID = 'clh3xxk0h0001356c9a5oba8m';
const CAT2_ID = 'clh3xxk0h0002356c9a5oba9n';
const MISSING_CAT_ID = 'clh3xxk0h0099356c9a5zzzzz';
const PROD1_ID = 'clh3xxk0h1001356c9a5oba8m';
const PROD2_ID = 'clh3xxk0h1002356c9a5oba9n';
const PROD3_ID = 'clh3xxk0h1003356c9a5obaan';
const SUP1_ID = 'clh3xxk0h2001356c9a5oba8m';
const SUP2_ID = 'clh3xxk0h2002356c9a5oba9n';

let productStore: Map<string, ProductRecord>;
let categoryStore: Map<string, CategoryRecord>;
let supplierStore: Map<string, SupplierRecord>;
let linkStore: Map<string, ProductSupplierLink>;
let createdProductCounter: number;
let createdLinkCounter: number;

function makeAccessToken(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, role },
    process.env['JWT_ACCESS_SECRET'] ?? 'dev-access-secret-minimum-32-chars-ok',
    { algorithm: 'HS256', expiresIn: '15m' },
  );
}

const ADMIN_TOKEN = () => makeAccessToken(ADMIN_ID, 'ADMIN');
const MANAGER_TOKEN = () => makeAccessToken(MANAGER_ID, 'MANAGER');
const OPERATOR_TOKEN = () => makeAccessToken(OPERATOR_ID, 'OPERATOR');

function linkKey(productId: string, supplierId: string): string {
  return `${productId}:${supplierId}`;
}

function seedStore(): void {
  createdProductCounter = 0;
  createdLinkCounter = 0;

  categoryStore = new Map([
    [CAT1_ID, { id: CAT1_ID, name: 'Analgesics', description: 'Pain relief' }],
    [CAT2_ID, { id: CAT2_ID, name: 'Antibiotics', description: null }],
  ]);

  supplierStore = new Map([
    [
      SUP1_ID,
      {
        id: SUP1_ID,
        name: 'Pharma Distribuidora C.A.',
        rif: 'J-12345678-9',
        whatsapp: '+58412000000',
        address: 'Av. Principal',
        active: true,
      },
    ],
    [
      SUP2_ID,
      {
        id: SUP2_ID,
        name: 'Inactive Supplier',
        rif: null,
        whatsapp: null,
        address: null,
        active: false,
      },
    ],
  ]);

  productStore = new Map([
    [
      PROD1_ID,
      {
        id: PROD1_ID,
        code: 'ACET-500',
        name: 'Acetaminophen 500mg',
        activeIngredient: 'Acetaminophen',
        description: 'Pain reliever',
        presentation: 'Blister',
        brand: 'Genfar',
        unit: 'MG',
        unitContent: '500.000',
        categoryId: CAT1_ID,
        stock: 4,
        minStock: 5,
        price: '2.50',
        active: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ],
    [
      PROD2_ID,
      {
        id: PROD2_ID,
        code: 'AMOX-250',
        name: 'Amoxicillin 250mg',
        activeIngredient: 'Amoxicillin',
        description: null,
        presentation: 'Bottle',
        brand: 'MK',
        unit: 'MG',
        unitContent: '250.000',
        categoryId: CAT2_ID,
        stock: 20,
        minStock: 5,
        price: '7.75',
        active: true,
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
        updatedAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ],
    [
      PROD3_ID,
      {
        id: PROD3_ID,
        code: 'OLD-001',
        name: 'Old Product',
        activeIngredient: null,
        description: null,
        presentation: null,
        brand: null,
        unit: 'UNIT',
        unitContent: '1.000',
        categoryId: CAT1_ID,
        stock: 99,
        minStock: 1,
        price: '1.00',
        active: false,
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
        updatedAt: new Date('2026-01-03T00:00:00.000Z'),
      },
    ],
  ]);

  linkStore = new Map([
    [
      linkKey(PROD1_ID, SUP1_ID),
      {
        id: 'clh3xxk0h3001356c9a5oba8m',
        productId: PROD1_ID,
        supplierId: SUP1_ID,
        referencePrice: '2.25',
        createdAt: new Date('2026-01-04T00:00:00.000Z'),
        updatedAt: new Date('2026-01-04T00:00:00.000Z'),
      },
    ],
  ]);
}

function withProductRelations(product: ProductRecord) {
  const category = categoryStore.get(product.categoryId) ?? null;
  const suppliers = [...linkStore.values()]
    .filter((link) => link.productId === product.id)
    .map((link) => ({
      supplier: supplierStore.get(link.supplierId)!,
      referencePrice: link.referencePrice,
    }));

  return { ...product, category, suppliers };
}

function applyWhere(products: ProductRecord[], where?: ProductWhere): ProductRecord[] {
  let rows = [...products];

  if (where?.active !== undefined) {
    rows = rows.filter((product) => product.active === where.active);
  }

  if (where?.categoryId !== undefined) {
    rows = rows.filter((product) => product.categoryId === where.categoryId);
  }

  if (where?.id?.in !== undefined) {
    rows = rows.filter((product) => where.id!.in.includes(product.id));
  }

  if (where?.suppliers?.some?.supplierId !== undefined) {
    const supplierId = where.suppliers.some.supplierId;
    rows = rows.filter((product) => linkStore.has(linkKey(product.id, supplierId)));
  }

  if (where?.OR !== undefined) {
    const terms = where.OR.map((condition) =>
      Object.values(condition)[0]?.contains.toLowerCase(),
    ).filter((term): term is string => term !== undefined);

    rows = rows.filter((product) => {
      const searchable = [product.name, product.code, product.activeIngredient, product.brand]
        .filter((value): value is string => value !== null)
        .map((value) => value.toLowerCase());

      return terms.some((term) => searchable.some((value) => value.includes(term)));
    });
  }

  return rows;
}

function sortRows(rows: ProductRecord[], orderBy?: ProductOrderBy): ProductRecord[] {
  if (orderBy === undefined) return rows;
  const [field, direction] = Object.entries(orderBy)[0] as [keyof ProductRecord, 'asc' | 'desc'];

  return [...rows].sort((left, right) => {
    const leftValue = field === 'price' ? Number(left[field]) : left[field];
    const rightValue = field === 'price' ? Number(right[field]) : right[field];

    if (leftValue < rightValue) return direction === 'asc' ? -1 : 1;
    if (leftValue > rightValue) return direction === 'asc' ? 1 : -1;
    return 0;
  });
}

interface ProductWhere {
  active?: boolean;
  categoryId?: string;
  OR?: Array<Record<string, { contains: string }>>;
  suppliers?: { some?: { supplierId?: string } };
  id?: { in: string[] };
  NOT?: { id?: string };
  code?: string;
}

type ProductOrderBy = Partial<Record<keyof ProductRecord, 'asc' | 'desc'>>;

vi.mock('../../src/shared/utils/prisma.js', () => {
  const mockPrisma = {
    category: { findUnique: vi.fn() },
    supplier: { findUnique: vi.fn() },
    product: {
      create: vi.fn(),
      findMany: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    productSupplier: {
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
      findMany: vi.fn(),
    },
    refreshToken: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    user: { findUnique: vi.fn() },
    $queryRaw: vi.fn(),
    $disconnect: vi.fn().mockResolvedValue(undefined),
    $transaction: vi.fn(),
  };
  return { prisma: mockPrisma };
});

describe('Products CRUD smoke tests', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    seedStore();

    const { prisma } = await import('../../src/shared/utils/prisma.js');

    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockCategoryFindUnique = vi.mocked(prisma.category.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockSupplierFindUnique = vi.mocked(prisma.supplier.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockProductCreate = vi.mocked(prisma.product.create);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockProductFindMany = vi.mocked(prisma.product.findMany);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockProductFindUnique = vi.mocked(prisma.product.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockProductFindFirst = vi.mocked(prisma.product.findFirst);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockProductUpdate = vi.mocked(prisma.product.update);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockProductCount = vi.mocked(prisma.product.count);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockLinkFindUnique = vi.mocked(prisma.productSupplier.findUnique);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockLinkCreate = vi.mocked(prisma.productSupplier.create);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockLinkDelete = vi.mocked(prisma.productSupplier.delete);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockLinkFindMany = vi.mocked(prisma.productSupplier.findMany);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockQueryRaw = vi.mocked(prisma.$queryRaw);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const mockTransaction = vi.mocked(prisma.$transaction);

    mockCategoryFindUnique.mockImplementation(({ where }: { where: { id?: string } }) => {
      if (where.id === undefined) return Promise.resolve(null);
      return Promise.resolve(categoryStore.get(where.id) ?? null);
    });

    mockSupplierFindUnique.mockImplementation(({ where }: { where: { id?: string } }) => {
      if (where.id === undefined) return Promise.resolve(null);
      return Promise.resolve(supplierStore.get(where.id) ?? null);
    });

    mockProductCreate.mockImplementation(({ data }: { data: Partial<ProductRecord> }) => {
      createdProductCounter += 1;
      const product: ProductRecord = {
        id: `clh3xxk0h900${createdProductCounter}356c9a5oba8m`,
        code: data.code ?? '',
        name: data.name ?? '',
        activeIngredient: data.activeIngredient ?? null,
        description: data.description ?? null,
        presentation: data.presentation ?? null,
        brand: data.brand ?? null,
        unit: data.unit ?? 'UNIT',
        unitContent: data.unitContent ?? '1.000',
        categoryId: data.categoryId ?? CAT1_ID,
        stock: data.stock ?? 0,
        minStock: data.minStock ?? 0,
        price: data.price ?? '0.00',
        active: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      productStore.set(product.id, product);
      return Promise.resolve(product);
    });

    mockProductFindUnique.mockImplementation(
      ({ where }: { where: { id?: string; code?: string } }) => {
        if (where.id !== undefined) {
          const product = productStore.get(where.id);
          return Promise.resolve(product ? withProductRelations(product) : null);
        }
        if (where.code !== undefined) {
          const product = [...productStore.values()].find((entry) => entry.code === where.code);
          return Promise.resolve(product ?? null);
        }
        return Promise.resolve(null);
      },
    );

    mockProductFindFirst.mockImplementation(({ where }: { where: ProductWhere }) => {
      const match = [...productStore.values()].find((product) => {
        if (where.code !== undefined && product.code !== where.code) return false;
        if (where.NOT?.id !== undefined && product.id === where.NOT.id) return false;
        return true;
      });
      return Promise.resolve(match ?? null);
    });

    mockProductFindMany.mockImplementation(
      ({
        where,
        orderBy,
        skip = 0,
        take,
      }: {
        where?: ProductWhere;
        orderBy?: ProductOrderBy;
        skip?: number;
        take?: number;
      }) => {
        const filtered = sortRows(applyWhere([...productStore.values()], where), orderBy);
        return Promise.resolve(filtered.slice(skip, take !== undefined ? skip + take : undefined));
      },
    );

    mockProductCount.mockImplementation(({ where }: { where?: ProductWhere } = {}) => {
      return Promise.resolve(applyWhere([...productStore.values()], where).length);
    });

    mockProductUpdate.mockImplementation(
      ({ where, data }: { where: { id: string }; data: Partial<ProductRecord> }) => {
        const existing = productStore.get(where.id);
        if (!existing) throw Object.assign(new Error('P2025'), { code: 'P2025' });
        const updated = { ...existing, ...data, updatedAt: new Date() };
        productStore.set(where.id, updated);
        return Promise.resolve(updated);
      },
    );

    mockLinkFindUnique.mockImplementation(
      ({
        where,
      }: {
        where: { productId_supplierId: { productId: string; supplierId: string } };
      }) => {
        const key = linkKey(
          where.productId_supplierId.productId,
          where.productId_supplierId.supplierId,
        );
        const link = linkStore.get(key);
        return Promise.resolve(link ? { id: link.id } : null);
      },
    );

    mockLinkCreate.mockImplementation(
      ({
        data,
      }: {
        data: { productId: string; supplierId: string; referencePrice?: string | null };
      }) => {
        createdLinkCounter += 1;
        const link: ProductSupplierLink = {
          id: `clh3xxk0h800${createdLinkCounter}356c9a5oba8m`,
          productId: data.productId,
          supplierId: data.supplierId,
          referencePrice: data.referencePrice ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        linkStore.set(linkKey(link.productId, link.supplierId), link);
        return Promise.resolve(link);
      },
    );

    mockLinkDelete.mockImplementation(
      ({
        where,
      }: {
        where: { productId_supplierId: { productId: string; supplierId: string } };
      }) => {
        const key = linkKey(
          where.productId_supplierId.productId,
          where.productId_supplierId.supplierId,
        );
        const existing = linkStore.get(key);
        if (!existing) throw Object.assign(new Error('P2025'), { code: 'P2025' });
        linkStore.delete(key);
        return Promise.resolve(existing);
      },
    );

    mockLinkFindMany.mockImplementation(({ where }: { where: { productId: string } }) => {
      const links = [...linkStore.values()]
        .filter((link) => link.productId === where.productId)
        .map((link) => ({
          referencePrice: link.referencePrice,
          supplier: supplierStore.get(link.supplierId)!,
        }));
      return Promise.resolve(links);
    });

    mockQueryRaw.mockImplementation(() => {
      const lowStockIds = [...productStore.values()]
        .filter((product) => product.active && product.stock <= product.minStock)
        .map((product) => ({ id: product.id }));
      return Promise.resolve(lowStockIds);
    });

    mockTransaction.mockImplementation(async (queries: Array<Promise<unknown>>) =>
      Promise.all(queries),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('role matrix', () => {
    it('rejects unauthenticated core and supplier sub-resource requests', async () => {
      expect((await request(app).get('/api/products')).status).toBe(401);
      expect((await request(app).get(`/api/products/${PROD1_ID}/suppliers`)).status).toBe(401);
    });

    it('allows OPERATOR reads and denies OPERATOR mutations', async () => {
      const readList = await request(app)
        .get('/api/products')
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      const readDetail = await request(app)
        .get(`/api/products/${PROD1_ID}`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);
      const readSuppliers = await request(app)
        .get(`/api/products/${PROD1_ID}/suppliers`)
        .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`);

      expect(readList.status).toBe(200);
      expect(readDetail.status).toBe(200);
      expect(readSuppliers.status).toBe(200);

      expect(
        (
          await request(app)
            .post('/api/products')
            .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
            .send(validCreatePayload({ code: 'DENIED-1' }))
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .post(`/api/products/${PROD2_ID}/suppliers`)
            .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
            .send({ supplierId: SUP1_ID })
        ).status,
      ).toBe(403);
      expect(
        (
          await request(app)
            .delete(`/api/products/${PROD1_ID}/suppliers/${SUP1_ID}`)
            .set('Authorization', `Bearer ${OPERATOR_TOKEN()}`)
        ).status,
      ).toBe(403);
    });

    it('allows MANAGER core mutation', async () => {
      const res = await request(app)
        .patch(`/api/products/${PROD1_ID}`)
        .set('Authorization', `Bearer ${MANAGER_TOKEN()}`)
        .send({ minStock: 8 });

      expect(res.status).toBe(200);
      expect((res.body as ProductBody).product.minStock).toBe(8);
    });
  });

  describe('CRUD behavior', () => {
    it('creates with default stock 0 and explicit minStock', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send(validCreatePayload({ code: 'IBU-400', minStock: 3 }));

      expect(res.status).toBe(201);
      const body = res.body as ProductBody;
      expect(body.product.stock).toBe(0);
      expect(body.product.minStock).toBe(3);
    });

    it('creates with explicit initial stock', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send(validCreatePayload({ code: 'LOR-10', stock: 15 }));

      expect(res.status).toBe(201);
      expect((res.body as ProductBody).product.stock).toBe(15);
    });

    it('updates editable fields and clears nullable text fields', async () => {
      const res = await request(app)
        .patch(`/api/products/${PROD1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ name: 'Acetaminophen Updated', activeIngredient: null, brand: null, minStock: 9 });

      expect(res.status).toBe(200);
      const product = (res.body as ProductBody).product;
      expect(product.name).toBe('Acetaminophen Updated');
      expect(product.activeIngredient).toBeNull();
      expect(product.brand).toBeNull();
      expect(product.minStock).toBe(9);
    });

    it('rejects PATCH stock with exact message', async () => {
      const res = await request(app)
        .patch(`/api/products/${PROD1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ stock: 10 });

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).message).toBe(
        'stock is only modifiable via /api/inventory-movements',
      );
    });

    it('rejects duplicate code on create and update', async () => {
      const createRes = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send(validCreatePayload({ code: 'ACET-500' }));

      const updateRes = await request(app)
        .patch(`/api/products/${PROD1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ code: 'AMOX-250' });

      expect(createRes.status).toBe(409);
      expect(updateRes.status).toBe(409);
      expect((updateRes.body as ErrorBody).message).toBe('Product code already exists.');
    });

    it('returns clean 400 when categoryId is unknown', async () => {
      const res = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send(validCreatePayload({ code: 'NO-CAT', categoryId: MISSING_CAT_ID }));

      expect(res.status).toBe(400);
      expect((res.body as ErrorBody).error).toBe('VALIDATION_ERROR');
      expect((res.body as ErrorBody).message).toContain('Category not found');
    });

    it('validates invalid enum, decimal, and integer inputs', async () => {
      const invalidUnit = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send(validCreatePayload({ code: 'BAD-UNIT', unit: 'BOX' as ProductUnit }));
      const invalidDecimal = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send(validCreatePayload({ code: 'BAD-DEC', price: '1.234' }));
      const invalidInteger = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send(validCreatePayload({ code: 'BAD-STOCK', stock: 1.5 }));
      const invalidUnitContent = await request(app)
        .post('/api/products')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send(validCreatePayload({ code: 'BAD-CONTENT', unitContent: '1.2345' }));

      expect(invalidUnit.status).toBe(400);
      expect(invalidDecimal.status).toBe(400);
      expect(invalidInteger.status).toBe(400);
      expect(invalidUnitContent.status).toBe(400);
    });

    it('soft-deletes active products and returns 404 for already inactive products', async () => {
      const deleteRes = await request(app)
        .delete(`/api/products/${PROD1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      expect(deleteRes.status).toBe(204);
      expect(productStore.get(PROD1_ID)?.active).toBe(false);

      const inactiveDeleteRes = await request(app)
        .delete(`/api/products/${PROD1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      expect(inactiveDeleteRes.status).toBe(404);
    });
  });

  describe('list and detail behavior', () => {
    it('filters by active=false, search, categoryId, supplierId, and lowStock=true', async () => {
      const inactive = await request(app)
        .get('/api/products?active=false')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      const search = await request(app)
        .get('/api/products?search=amox')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      const category = await request(app)
        .get(`/api/products?categoryId=${CAT2_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      const supplier = await request(app)
        .get(`/api/products?supplierId=${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      const lowStock = await request(app)
        .get('/api/products?lowStock=true')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect((inactive.body as ListBody).data.every((product) => product.active === false)).toBe(
        true,
      );
      expect((search.body as ListBody).data.map((product) => product.id)).toEqual([PROD2_ID]);
      expect((category.body as ListBody).data.map((product) => product.id)).toEqual([PROD2_ID]);
      expect((supplier.body as ListBody).data.map((product) => product.id)).toEqual([PROD1_ID]);
      expect((lowStock.body as ListBody).data.map((product) => product.id)).toEqual([PROD1_ID]);
    });

    it('supports orderBy/order and pageSize meta', async () => {
      const res = await request(app)
        .get('/api/products?orderBy=name&order=asc&page=1&pageSize=1')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      const body = res.body as ListBody;
      expect(body.meta.limit).toBe(1);
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.name).toBe('Acetaminophen 500mg');
    });

    it('interprets active=false and lowStock=false correctly', async () => {
      const inactive = await request(app)
        .get('/api/products?active=false')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      const notLowStockFiltered = await request(app)
        .get('/api/products?lowStock=false')
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect((inactive.body as ListBody).data.map((product) => product.id)).toEqual([PROD3_ID]);
      expect((notLowStockFiltered.body as ListBody).data.map((product) => product.id)).toContain(
        PROD2_ID,
      );
    });

    it('GET by id includes category and suppliers and returns inactive products', async () => {
      const active = await request(app)
        .get(`/api/products/${PROD1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      const inactive = await request(app)
        .get(`/api/products/${PROD3_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(active.status).toBe(200);
      const product = (active.body as ProductBody).product;
      expect(product.category?.id).toBe(CAT1_ID);
      expect(product.suppliers?.[0]?.supplier.id).toBe(SUP1_ID);
      expect(product.suppliers?.[0]?.referencePrice).toBe('2.25');
      expect((inactive.body as ProductBody).product.active).toBe(false);
    });
  });

  describe('product suppliers sub-resource', () => {
    it('lists suppliers for a product', async () => {
      const res = await request(app)
        .get(`/api/products/${PROD1_ID}/suppliers`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(res.status).toBe(200);
      expect((res.body as SuppliersBody).suppliers[0]?.supplier.id).toBe(SUP1_ID);
      expect((res.body as SuppliersBody).suppliers[0]?.referencePrice).toBe('2.25');
    });

    it('attaches a supplier with optional referencePrice', async () => {
      linkStore.delete(linkKey(PROD1_ID, SUP1_ID));
      const res = await request(app)
        .post(`/api/products/${PROD1_ID}/suppliers`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ supplierId: SUP1_ID, referencePrice: '2.40' });

      expect(res.status).toBe(201);
      expect((res.body as LinkBody).link.supplierId).toBe(SUP1_ID);
      expect((res.body as LinkBody).link.referencePrice).toBe('2.40');
    });

    it('rejects duplicate link, inactive product, inactive supplier, and invalid referencePrice', async () => {
      const duplicate = await request(app)
        .post(`/api/products/${PROD1_ID}/suppliers`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ supplierId: SUP1_ID });
      const inactiveProduct = await request(app)
        .post(`/api/products/${PROD3_ID}/suppliers`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ supplierId: SUP1_ID });
      const inactiveSupplier = await request(app)
        .post(`/api/products/${PROD2_ID}/suppliers`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ supplierId: SUP2_ID });
      const invalidReferencePrice = await request(app)
        .post(`/api/products/${PROD2_ID}/suppliers`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`)
        .send({ supplierId: SUP1_ID, referencePrice: '1.234' });

      expect(duplicate.status).toBe(409);
      expect(inactiveProduct.status).toBe(404);
      expect(inactiveSupplier.status).toBe(404);
      expect(invalidReferencePrice.status).toBe(400);
    });

    it('detaches a supplier and returns 404 for a missing link', async () => {
      const detach = await request(app)
        .delete(`/api/products/${PROD1_ID}/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);
      const missing = await request(app)
        .delete(`/api/products/${PROD1_ID}/suppliers/${SUP1_ID}`)
        .set('Authorization', `Bearer ${ADMIN_TOKEN()}`);

      expect(detach.status).toBe(204);
      expect(missing.status).toBe(404);
    });
  });
});

function validCreatePayload(overrides: Partial<ProductRecord> = {}) {
  return {
    code: 'NEW-001',
    name: 'New Product',
    activeIngredient: 'Ibuprofen',
    presentation: 'Box',
    brand: 'Generic',
    description: 'New product description',
    unit: 'MG' as ProductUnit,
    unitContent: '400.000',
    categoryId: CAT1_ID,
    minStock: 0,
    price: '3.25',
    ...overrides,
  };
}
