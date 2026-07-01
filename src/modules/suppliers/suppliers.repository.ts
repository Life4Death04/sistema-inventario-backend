/**
 * SuppliersRepository — Prisma data-access layer for supplier management.
 *
 * Responsibilities:
 *   - CRUD operations on the Supplier model.
 *   - Pagination + active filter + search for the list endpoint.
 *   - findByRif / findByRifExcludingId for uniqueness guards (service layer).
 *   - softDelete sets active = false (no hard-delete).
 *
 * All methods are pure data-access; no business logic here.
 * Services apply guards and rules on top of the returned data.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/utils/prisma.js';
import type {
  CreateSupplierDto,
  UpdateSupplierDto,
  ListSuppliersQuery,
} from './suppliers.schema.js';

// ---------------------------------------------------------------------------
// Supplier shape
// ---------------------------------------------------------------------------

/** Shape returned by all repository methods. */
export type SupplierRecord = {
  id: string;
  name: string;
  rif: string | null;
  whatsapp: string | null;
  address: string | null;
  active: boolean;
  createdAt: Date;
  updatedAt: Date;
};

/** Fields selected on every supplier query. */
const SUPPLIER_SELECT = {
  id: true,
  name: true,
  rif: true,
  whatsapp: true,
  address: true,
  active: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ---------------------------------------------------------------------------
// SuppliersRepository
// ---------------------------------------------------------------------------

export class SuppliersRepository {
  // ── Create ─────────────────────────────────────────────────────────────────

  /** Insert a new supplier row. Returns the created supplier. */
  async create(data: CreateSupplierDto): Promise<SupplierRecord> {
    return prisma.supplier.create({
      data: {
        name: data.name,
        rif: data.rif ?? null,
        whatsapp: data.whatsapp ?? null,
        address: data.address ?? null,
      },
      select: SUPPLIER_SELECT,
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * Find a supplier by primary key.
   * Returns the supplier regardless of active flag (needed for detail views of
   * historical or inactive records).
   * Returns null when not found.
   */
  async findById(id: string): Promise<SupplierRecord | null> {
    return prisma.supplier.findUnique({
      where: { id },
      select: SUPPLIER_SELECT,
    });
  }

  /**
   * Find an active supplier by RIF (exact match).
   * Used to check RIF uniqueness before create.
   * Returns null when not found or when rif is null.
   */
  async findByRif(rif: string): Promise<SupplierRecord | null> {
    return prisma.supplier.findUnique({
      where: { rif },
      select: SUPPLIER_SELECT,
    });
  }

  /**
   * Find a supplier by RIF excluding a specific id.
   * Used for update uniqueness check — prevents collision with other rows
   * while allowing a PATCH that keeps the same RIF value.
   * Returns null when no conflict exists.
   */
  async findByRifExcludingId(rif: string, excludeId: string): Promise<SupplierRecord | null> {
    return prisma.supplier.findFirst({
      where: { rif, NOT: { id: excludeId } },
      select: SUPPLIER_SELECT,
    });
  }

  /**
   * List suppliers with pagination, active filter, and optional search.
   *
   * Filters:
   *   active  — always applied (default true, can be set to false)
   *   search  — case-insensitive substring match on name OR rif
   *
   * Returns [rows, total] tuple so the service can build the paginated envelope.
   */
  async list(query: ListSuppliersQuery): Promise<[SupplierRecord[], number]> {
    const { page, limit, search, active } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.SupplierWhereInput = { active };

    if (search) {
      where.AND = [
        { active },
        {
          OR: [
            { name: { contains: search, mode: 'insensitive' } },
            { rif: { contains: search, mode: 'insensitive' } },
          ],
        },
      ];
      // Remove the top-level active when AND is used to avoid duplication.
      delete (where as Prisma.SupplierWhereInput & { active?: boolean }).active;
    }

    const [rows, total] = await prisma.$transaction([
      prisma.supplier.findMany({
        where,
        select: SUPPLIER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.supplier.count({ where }),
    ]);

    return [rows, total];
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Patch a supplier by id.
   * Supports setting rif, whatsapp, address to null explicitly to clear them.
   * Returns the updated supplier.
   */
  async update(id: string, data: UpdateSupplierDto): Promise<SupplierRecord> {
    return prisma.supplier.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        // rif, whatsapp, address can be undefined (not provided), a string, or null (clear it).
        ...('rif' in data && { rif: data.rif ?? null }),
        ...('whatsapp' in data && { whatsapp: data.whatsapp ?? null }),
        ...('address' in data && { address: data.address ?? null }),
      },
      select: SUPPLIER_SELECT,
    });
  }

  // ── Soft delete ────────────────────────────────────────────────────────────

  /**
   * Soft-delete a supplier by setting active = false.
   * Returns the updated supplier record.
   * The caller must verify the supplier exists and is currently active before
   * calling this method.
   */
  async softDelete(id: string): Promise<SupplierRecord> {
    return prisma.supplier.update({
      where: { id },
      data: { active: false },
      select: SUPPLIER_SELECT,
    });
  }
}

/** Singleton instance consumed by the suppliers controller. */
export const suppliersRepository = new SuppliersRepository();
