/**
 * ProductsRepository — Prisma data-access layer for product management.
 *
 * Responsibilities:
 *   - CRUD operations on the Product model.
 *   - Pagination + filters (active, search, categoryId, supplierId, lowStock) for list.
 *   - findByCode / findByCodeExcludingId for uniqueness guards (service layer).
 *   - softDelete sets active = false (no hard-delete).
 *   - ProductSupplier sub-resource: attach, detach, listByProduct.
 *
 * All methods are pure data-access; no business logic here.
 * Services apply guards and rules on top of the returned data.
 *
 * Low-stock filter note:
 *   Prisma does not support native column-to-column comparisons in its
 *   type-safe API (e.g. { stock: { lte: prisma.product.fields.minStock } }).
 *   We use $queryRaw with a parameterized SQL query to avoid type confusion
 *   and SQL injection. The result set is then used to build a list of ids
 *   for filtering via the regular Prisma API.
 *   See: https://www.prisma.io/docs/concepts/components/prisma-client/raw-database-access
 */
import type { Prisma, ProductUnit } from '@prisma/client';
import { prisma } from '../../shared/utils/prisma.js';
import type {
  CreateProductDto,
  UpdateProductDto,
  ListProductsQuery,
  AttachSupplierDto,
} from './products.schema.js';

// ---------------------------------------------------------------------------
// Product shape
// ---------------------------------------------------------------------------

/** Supplier info nested inside a product's suppliers list. */
export type ProductSupplierEntry = {
  supplier: {
    id: string;
    name: string;
    rif: string | null;
    whatsapp: string | null;
    address: string | null;
    active: boolean;
  };
  referencePrice: string | null;
};

/** Shape returned by findById — includes category and suppliers. */
export type ProductDetailRecord = {
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
  category: { id: string; name: string; description: string | null } | null;
  stock: number;
  minStock: number;
  price: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
  suppliers: ProductSupplierEntry[];
};

/** Shape returned by list (no category/suppliers nesting). */
export type ProductListRecord = {
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
  price: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type DecimalLike = string | { toString(): string };

type ProductSupplierRawEntry = {
  supplier: ProductSupplierEntry['supplier'];
  referencePrice: DecimalLike | null;
};

type ProductDetailRaw = Omit<ProductDetailRecord, 'unitContent' | 'price' | 'suppliers'> & {
  unitContent: DecimalLike;
  price: DecimalLike | null;
  suppliers: ProductSupplierRawEntry[];
};

/** Fields selected for list queries. */
const PRODUCT_LIST_SELECT = {
  id: true,
  code: true,
  name: true,
  activeIngredient: true,
  description: true,
  presentation: true,
  brand: true,
  unit: true,
  unitContent: true,
  categoryId: true,
  stock: true,
  minStock: true,
  price: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Fields selected for detail (with category + suppliers). */
const PRODUCT_DETAIL_SELECT = {
  ...PRODUCT_LIST_SELECT,
  category: {
    select: { id: true, name: true, description: true },
  },
  suppliers: {
    select: {
      referencePrice: true,
      supplier: {
        select: { id: true, name: true, rif: true, whatsapp: true, address: true, active: true },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// ProductsRepository
// ---------------------------------------------------------------------------

export class ProductsRepository {
  // ── Create ─────────────────────────────────────────────────────────────────

  /** Insert a new product row. Returns the created product (list shape). */
  async create(data: CreateProductDto): Promise<ProductListRecord> {
    return prisma.product.create({
      data: {
        code: data.code,
        name: data.name,
        activeIngredient: data.activeIngredient ?? null,
        presentation: data.presentation ?? null,
        brand: data.brand ?? null,
        description: data.description ?? null,
        unit: data.unit,
        unitContent: data.unitContent,
        categoryId: data.categoryId,
        stock: data.stock ?? 0,
        minStock: data.minStock ?? 0,
        price: data.price ?? null,
      },
      select: PRODUCT_LIST_SELECT,
    }) as unknown as Promise<ProductListRecord>;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * Find a product by primary key, including category and suppliers.
   * Returns the product regardless of active flag.
   * Returns null when not found.
   */
  async findById(id: string): Promise<ProductDetailRecord | null> {
    const result = await prisma.product.findUnique({
      where: { id },
      select: PRODUCT_DETAIL_SELECT,
    });
    if (!result) return null;
    return this.serializeDetail(result as ProductDetailRaw);
  }

  /**
   * Find a product by code (exact match, case-sensitive).
   * Used for uniqueness check on POST.
   * Returns null when not found.
   */
  async findByCode(code: string): Promise<ProductListRecord | null> {
    return prisma.product.findUnique({
      where: { code },
      select: PRODUCT_LIST_SELECT,
    }) as unknown as Promise<ProductListRecord | null>;
  }

  /**
   * Find a product by code, excluding a specific id.
   * Used for PATCH uniqueness check — prevents collision with other rows
   * while allowing a PATCH that keeps the same code value.
   * Returns null when no conflict exists.
   */
  async findByCodeExcludingId(code: string, excludeId: string): Promise<ProductListRecord | null> {
    return prisma.product.findFirst({
      where: { code, NOT: { id: excludeId } },
      select: PRODUCT_LIST_SELECT,
    }) as unknown as Promise<ProductListRecord | null>;
  }

  /**
   * List products with pagination, filters, and ordering.
   *
   * Filters:
   *   active    — always applied (default true)
   *   search    — case-insensitive substring on name OR code OR activeIngredient OR brand
   *   categoryId — exact match
   *   supplierId — products with a ProductSupplier entry for this supplier
   *   lowStock  — stock <= minStock (via $queryRaw correlated sub-select; see module note)
   *   orderBy + order
   *
   * Returns [rows, total] tuple so the service can build the paginated envelope.
   */
  async list(query: ListProductsQuery): Promise<[ProductListRecord[], number]> {
    const { page, pageSize, search, active, categoryId, supplierId, lowStock, orderBy, order } =
      query;
    const skip = (page - 1) * pageSize;

    // Build the where clause incrementally.
    const where: Prisma.ProductWhereInput = { active };

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
        { activeIngredient: { contains: search, mode: 'insensitive' } },
        { brand: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (categoryId) {
      where.categoryId = categoryId;
    }

    if (supplierId) {
      where.suppliers = {
        some: { supplierId },
      };
    }

    // Low-stock filter: stock <= minStock.
    // Prisma does not support column-to-column comparisons in its type-safe API.
    // Strategy: use $queryRaw to fetch matching product ids, then filter with `id: { in: ids }`.
    // This is safe (parameterized query) and avoids raw SQL injection.
    if (lowStock) {
      const lowStockRows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "Product" WHERE stock <= "minStock" AND active = ${active}
      `;
      const lowStockIds = lowStockRows.map((r) => r.id);
      where.id = { in: lowStockIds };
    }

    const [rows, total] = await prisma.$transaction([
      prisma.product.findMany({
        where,
        select: PRODUCT_LIST_SELECT,
        orderBy: { [orderBy]: order },
        skip,
        take: pageSize,
      }),
      prisma.product.count({ where }),
    ]);

    return [rows as unknown as ProductListRecord[], total];
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Patch a product by id.
   * Supports nullable clearing for activeIngredient, description, presentation, brand.
   * Returns the updated product (list shape).
   */
  async update(id: string, data: UpdateProductDto): Promise<ProductListRecord> {
    return prisma.product.update({
      where: { id },
      data: {
        ...(data.code !== undefined && { code: data.code }),
        ...(data.name !== undefined && { name: data.name }),
        // Nullable clearing: explicit null clears the field, undefined leaves unchanged.
        ...('activeIngredient' in data && { activeIngredient: data.activeIngredient ?? null }),
        ...('presentation' in data && { presentation: data.presentation ?? null }),
        ...('brand' in data && { brand: data.brand ?? null }),
        ...('description' in data && { description: data.description ?? null }),
        ...(data.unit !== undefined && { unit: data.unit }),
        ...(data.unitContent !== undefined && { unitContent: data.unitContent }),
        ...(data.categoryId !== undefined && { categoryId: data.categoryId }),
        ...(data.minStock !== undefined && { minStock: data.minStock }),
        ...(data.price !== undefined && { price: data.price }),
      },
      select: PRODUCT_LIST_SELECT,
    }) as unknown as Promise<ProductListRecord>;
  }

  // ── Soft delete ────────────────────────────────────────────────────────────

  /**
   * Soft-delete a product by setting active = false.
   * Returns the updated product record.
   * The caller must verify the product exists and is currently active.
   */
  async softDelete(id: string): Promise<ProductListRecord> {
    return prisma.product.update({
      where: { id },
      data: { active: false },
      select: PRODUCT_LIST_SELECT,
    }) as unknown as Promise<ProductListRecord>;
  }

  // ── ProductSupplier sub-resource ───────────────────────────────────────────

  /**
   * Find a ProductSupplier link by productId + supplierId.
   * Returns null when the link does not exist.
   */
  async findLink(productId: string, supplierId: string): Promise<{ id: string } | null> {
    return prisma.productSupplier.findUnique({
      where: { productId_supplierId: { productId, supplierId } },
      select: { id: true },
    });
  }

  /**
   * Create a ProductSupplier link (attach a supplier to a product).
   * Returns the created link with supplier info.
   */
  async attachSupplier(
    productId: string,
    dto: AttachSupplierDto,
  ): Promise<{ id: string; referencePrice: string | null; supplierId: string }> {
    const result = await prisma.productSupplier.create({
      data: {
        productId,
        supplierId: dto.supplierId,
        referencePrice: dto.referencePrice ?? null,
      },
      select: {
        id: true,
        supplierId: true,
        referencePrice: true,
      },
    });
    return {
      id: result.id,
      supplierId: result.supplierId,
      referencePrice: result.referencePrice != null ? result.referencePrice.toString() : null,
    };
  }

  /**
   * Remove a ProductSupplier link (detach a supplier from a product).
   */
  async detachSupplier(productId: string, supplierId: string): Promise<void> {
    await prisma.productSupplier.delete({
      where: { productId_supplierId: { productId, supplierId } },
    });
  }

  /**
   * List all suppliers linked to a product.
   * Returns [{ supplier, referencePrice }] array.
   */
  async listSuppliers(productId: string): Promise<ProductSupplierEntry[]> {
    const links = await prisma.productSupplier.findMany({
      where: { productId },
      select: {
        referencePrice: true,
        supplier: {
          select: { id: true, name: true, rif: true, whatsapp: true, address: true, active: true },
        },
      },
    });

    return links.map((link) => ({
      supplier: link.supplier,
      referencePrice: link.referencePrice != null ? link.referencePrice.toString() : null,
    }));
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Serialize Prisma Decimal fields (unitContent, price) to strings
   * and normalize the supplier entries for the detail shape.
   */
  private serializeDetail(raw: ProductDetailRaw): ProductDetailRecord {
    return {
      ...raw,
      unitContent: raw.unitContent.toString(),
      price: raw.price != null ? raw.price.toString() : null,
      suppliers: raw.suppliers.map((s) => ({
        supplier: s.supplier,
        referencePrice: s.referencePrice != null ? s.referencePrice.toString() : null,
      })),
    };
  }
}

/** Singleton instance consumed by the products service. */
export const productsRepository = new ProductsRepository();
