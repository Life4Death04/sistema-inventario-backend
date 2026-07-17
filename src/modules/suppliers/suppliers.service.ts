/**
 * SuppliersService — business logic for supplier management.
 *
 * Responsibilities:
 *   - Orchestrate CRUD operations via SuppliersRepository.
 *   - Enforce business guards:
 *       • Duplicate RIF check (409 on POST and PATCH)
 *       • Soft-delete guard: 404 if supplier is already inactive
 *   - Build paginated responses using the shared paginate() helper.
 *
 * This service does NOT import Express or interact with the HTTP layer.
 * It is consumed by suppliers.controller.ts.
 */
import { suppliersRepository, type SupplierRecord } from './suppliers.repository.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { paginate } from '../../shared/pagination/index.js';
import type {
  CreateSupplierDto,
  PaginatedSuppliersResponse,
  SupplierDto,
  UpdateSupplierDto,
  ListSuppliersQuery,
} from './suppliers.schema.js';

function toDto(record: SupplierRecord): SupplierDto {
  const products = record.products.map(({ product }) => ({
    id: product.id,
    name: product.name,
    code: product.code,
  }));

  return {
    id: record.id,
    name: record.name,
    rif: record.rif,
    whatsapp: record.whatsapp,
    address: record.address,
    active: record.active,
    products,
    productsCount: products.length,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export class SuppliersService {
  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a new supplier.
   *
   * Guards:
   *   - 409 CONFLICT if rif is provided and already in use by another supplier.
   */
  async create(dto: CreateSupplierDto): Promise<SupplierDto> {
    // Duplicate RIF check (only when rif is provided and non-null).
    if (dto.rif != null) {
      const existing = await suppliersRepository.findByRif(dto.rif);
      if (existing) {
        throw new AppError(ERROR_CODES.CONFLICT, 409, 'Supplier RIF already exists.');
      }
    }

    const supplier = await suppliersRepository.create(dto);
    return toDto(supplier);
  }

  // ── List ───────────────────────────────────────────────────────────────────

  /**
   * List suppliers with pagination, active filter, and optional search.
   * Returns a standard PaginatedResponse envelope.
   */
  async list(query: ListSuppliersQuery): Promise<PaginatedSuppliersResponse> {
    const [data, total] = await suppliersRepository.list(query);
    return paginate({ data: data.map(toDto), total, page: query.page, limit: query.limit });
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  /**
   * Get a single supplier by id.
   * Returns the supplier regardless of active flag (needed for historical detail views).
   * Throws 404 NOT_FOUND when the supplier does not exist at all.
   */
  async getById(id: string): Promise<SupplierDto> {
    const supplier = await suppliersRepository.findById(id);
    if (!supplier) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Supplier not found.');
    }
    return toDto(supplier);
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Update a supplier by id.
   *
   * Guards (checked in order):
   *   1. 404 NOT_FOUND — supplier must exist (active or inactive).
   *   2. 409 CONFLICT  — rif must not collide with a different existing supplier.
   *
   * PATCH with explicit null on rif, whatsapp, or address clears the field.
   * PATCH with undefined/omitted leaves the field unchanged.
   *
   * @param id   Supplier being updated.
   * @param dto  Partial update payload (already validated).
   */
  async update(id: string, dto: UpdateSupplierDto): Promise<SupplierDto> {
    // 1. Ensure the target supplier exists.
    const target = await suppliersRepository.findById(id);
    if (!target) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Supplier not found.');
    }

    // 2. Duplicate RIF guard (only when rif is being changed to a non-null value).
    if ('rif' in dto && dto.rif != null) {
      const rifConflict = await suppliersRepository.findByRifExcludingId(dto.rif, id);
      if (rifConflict) {
        throw new AppError(ERROR_CODES.CONFLICT, 409, 'Supplier RIF already exists.');
      }
    }

    const supplier = await suppliersRepository.update(id, dto);
    return toDto(supplier);
  }

  // ── Soft delete ────────────────────────────────────────────────────────────

  /**
   * Soft-delete a supplier by setting active = false.
   *
   * Guards (checked in order):
   *   1. 404 NOT_FOUND — supplier must exist AND be currently active.
   *      Rationale: treat inactive as not-found for delete idempotency check.
   *      Deleting an already-inactive supplier returns 404.
   *
   * @param id  Supplier being soft-deleted.
   */
  async softDelete(id: string): Promise<void> {
    // Find the supplier regardless of active flag.
    const target = await suppliersRepository.findById(id);

    // 404 if not found OR already inactive.
    if (!target || !target.active) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Supplier not found.');
    }

    await suppliersRepository.softDelete(id);
  }
}

/** Singleton instance consumed by the suppliers controller. */
export const suppliersService = new SuppliersService();
