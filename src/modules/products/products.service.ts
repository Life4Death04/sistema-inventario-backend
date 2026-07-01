/**
 * ProductsService — business logic for product management.
 *
 * Responsibilities:
 *   - Orchestrate CRUD operations via ProductsRepository.
 *   - Enforce business guards:
 *       • Duplicate code check (409 on POST and PATCH)
 *       • CategoryId existence check (400 with clear message before FK hit)
 *       • PATCH stock rejection (400)
 *       • Soft-delete guard: 404 if product is already inactive
 *       • ProductSupplier attach guards: product active + supplier active + no duplicate
 *   - Build paginated responses using the shared paginate() helper.
 *
 * This service does NOT import Express or interact with the HTTP layer.
 * It is consumed by products.controller.ts.
 */
import {
  productsRepository,
  type ProductListRecord,
  type ProductDetailRecord,
  type ProductSupplierEntry,
} from './products.repository.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { paginate, type PaginatedResponse } from '../../shared/pagination/index.js';
import { prisma } from '../../shared/utils/prisma.js';
import type {
  CreateProductDto,
  UpdateProductDto,
  ListProductsQuery,
  AttachSupplierDto,
} from './products.schema.js';

export class ProductsService {
  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a new product.
   *
   * Guards:
   *   - 400 if categoryId does not exist (clean message before FK Restrict triggers).
   *   - 409 CONFLICT if code is already in use.
   */
  async create(dto: CreateProductDto): Promise<ProductListRecord> {
    // Pre-check categoryId for a clean 400 error (Prisma FK Restrict would give a cryptic error).
    const category = await prisma.category.findUnique({
      where: { id: dto.categoryId },
      select: { id: true },
    });
    if (!category) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        400,
        `Category not found: ${dto.categoryId}.`,
      );
    }

    // Duplicate code check.
    const existingCode = await productsRepository.findByCode(dto.code);
    if (existingCode) {
      throw new AppError(ERROR_CODES.CONFLICT, 409, 'Product code already exists.');
    }

    return productsRepository.create(dto);
  }

  // ── List ───────────────────────────────────────────────────────────────────

  /**
   * List products with pagination, filters, and ordering.
   * Returns a standard PaginatedResponse envelope.
   */
  async list(query: ListProductsQuery): Promise<PaginatedResponse<ProductListRecord>> {
    const [data, total] = await productsRepository.list(query);
    return paginate({ data, total, page: query.page, limit: query.pageSize });
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  /**
   * Get a single product by id.
   * Returns the product regardless of active flag (historical detail view).
   * Includes category and suppliers.
   * Throws 404 when the product does not exist at all.
   */
  async getById(id: string): Promise<ProductDetailRecord> {
    const product = await productsRepository.findById(id);
    if (!product) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Product not found.');
    }
    return product;
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Update a product by id (partial update).
   *
   * Guards (checked in order):
   *   1. 404 NOT_FOUND — product must exist (active or inactive).
   *   2. 400 if dto contains `stock` key — stock is managed via inventory-movements.
   *   3. 400 if categoryId is provided but does not exist.
   *   4. 409 CONFLICT if code would collide with a different product.
   *
   * PATCH with explicit null on activeIngredient, description, presentation,
   * brand clears the field. Undefined/omitted leaves unchanged.
   */
  async update(id: string, dto: UpdateProductDto): Promise<ProductListRecord> {
    // 1. Ensure the target product exists.
    const target = await productsRepository.findById(id);
    if (!target) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Product not found.');
    }

    // 2. Reject stock modification — managed by inventory-movements.
    if ('stock' in dto) {
      throw new AppError(
        ERROR_CODES.VALIDATION_ERROR,
        400,
        'stock is only modifiable via /api/inventory-movements',
      );
    }

    // 3. Pre-check categoryId when provided.
    if (dto.categoryId !== undefined) {
      const category = await prisma.category.findUnique({
        where: { id: dto.categoryId },
        select: { id: true },
      });
      if (!category) {
        throw new AppError(
          ERROR_CODES.VALIDATION_ERROR,
          400,
          `Category not found: ${dto.categoryId}.`,
        );
      }
    }

    // 4. Duplicate code guard.
    if (dto.code !== undefined) {
      const codeConflict = await productsRepository.findByCodeExcludingId(dto.code, id);
      if (codeConflict) {
        throw new AppError(ERROR_CODES.CONFLICT, 409, 'Product code already exists.');
      }
    }

    return productsRepository.update(id, dto);
  }

  // ── Soft delete ────────────────────────────────────────────────────────────

  /**
   * Soft-delete a product by setting active = false.
   *
   * Guards:
   *   - 404 if product does not exist OR is already inactive.
   *     Rationale: mirrors suppliers — delete on inactive = not-found (idempotency guard).
   */
  async softDelete(id: string): Promise<void> {
    const target = await productsRepository.findById(id);

    if (!target || !target.active) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Product not found.');
    }

    await productsRepository.softDelete(id);
  }

  // ── ProductSupplier sub-resource ───────────────────────────────────────────

  /**
   * Attach a supplier to a product.
   *
   * Guards (checked in order):
   *   1. 404 if product does not exist or is inactive.
   *   2. 404 if supplier does not exist or is inactive.
   *   3. 409 if the product-supplier pair already exists.
   */
  async attachSupplier(
    productId: string,
    dto: AttachSupplierDto,
  ): Promise<{ id: string; referencePrice: string | null; supplierId: string }> {
    // 1. Product must exist and be active.
    const product = await productsRepository.findById(productId);
    if (!product) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Product not found.');
    }
    if (!product.active) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Product is inactive.');
    }

    // 2. Supplier must exist and be active.
    const supplier = await prisma.supplier.findUnique({
      where: { id: dto.supplierId },
      select: { id: true, active: true },
    });
    if (!supplier) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Supplier not found.');
    }
    if (!supplier.active) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Supplier is inactive.');
    }

    // 3. Pair must not already exist.
    const existing = await productsRepository.findLink(productId, dto.supplierId);
    if (existing) {
      throw new AppError(ERROR_CODES.CONFLICT, 409, 'Product-supplier link already exists.');
    }

    return productsRepository.attachSupplier(productId, dto);
  }

  /**
   * Detach a supplier from a product.
   * 404 if the link does not exist.
   */
  async detachSupplier(productId: string, supplierId: string): Promise<void> {
    const link = await productsRepository.findLink(productId, supplierId);
    if (!link) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Product-supplier link not found.');
    }

    await productsRepository.detachSupplier(productId, supplierId);
  }

  /**
   * List all suppliers linked to a product.
   * Returns the suppliers regardless of product active flag (read-only view).
   * 404 if the product does not exist at all.
   */
  async listSuppliers(productId: string): Promise<ProductSupplierEntry[]> {
    const product = await productsRepository.findById(productId);
    if (!product) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Product not found.');
    }

    return productsRepository.listSuppliers(productId);
  }
}

/** Singleton instance consumed by the products controller. */
export const productsService = new ProductsService();
