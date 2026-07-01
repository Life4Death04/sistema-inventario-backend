/**
 * CategoriesRepository — Prisma data-access layer for category management.
 *
 * Responsibilities:
 *   - CRUD operations on the Category model.
 *   - Pagination + search filter for the list endpoint.
 *   - countProductsInCategory for the delete guard.
 *
 * All methods are pure data-access; no business logic here.
 * Services apply guards and rules on top of the returned data.
 */
import type { Prisma } from '@prisma/client';
import { prisma } from '../../shared/utils/prisma.js';
import type {
  CreateCategoryDto,
  UpdateCategoryDto,
  ListCategoriesQuery,
} from './categories.schema.js';

// ---------------------------------------------------------------------------
// Category shape
// ---------------------------------------------------------------------------

/** Shape returned by all repository methods. */
export type CategoryRecord = {
  id: string;
  name: string;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
};

/** Fields selected on every category query. */
const CATEGORY_SELECT = {
  id: true,
  name: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;

// ---------------------------------------------------------------------------
// CategoriesRepository
// ---------------------------------------------------------------------------

export class CategoriesRepository {
  // ── Create ─────────────────────────────────────────────────────────────────

  /** Insert a new category row. Returns the created category. */
  async create(data: CreateCategoryDto): Promise<CategoryRecord> {
    return prisma.category.create({
      data: {
        name: data.name,
        description: data.description,
      },
      select: CATEGORY_SELECT,
    });
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * Find a category by primary key.
   * Returns null when not found.
   */
  async findById(id: string): Promise<CategoryRecord | null> {
    return prisma.category.findUnique({
      where: { id },
      select: CATEGORY_SELECT,
    });
  }

  /**
   * Find a category by name (exact match, case-sensitive at DB level).
   * Used to check name uniqueness before create.
   * Returns null when not found.
   */
  async findByName(name: string): Promise<CategoryRecord | null> {
    return prisma.category.findUnique({
      where: { name },
      select: CATEGORY_SELECT,
    });
  }

  /**
   * Find a category by name excluding a specific id.
   * Used for update uniqueness check — ensures a PATCH renaming a category
   * to its own current name is allowed, while preventing collision with others.
   * Returns null when no conflict exists.
   */
  async findByNameExcludingId(name: string, excludeId: string): Promise<CategoryRecord | null> {
    return prisma.category.findFirst({
      where: { name, NOT: { id: excludeId } },
      select: CATEGORY_SELECT,
    });
  }

  /**
   * List categories with pagination and optional search filter.
   *
   * Filters (all optional):
   *   search — case-insensitive substring match on name OR description
   *
   * Returns [rows, total] tuple so the service can build the paginated envelope.
   */
  async list(query: ListCategoriesQuery): Promise<[CategoryRecord[], number]> {
    const { page, limit, search } = query;
    const skip = (page - 1) * limit;

    // Build the where clause from optional filters.
    const where: Prisma.CategoryWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [rows, total] = await prisma.$transaction([
      prisma.category.findMany({
        where,
        select: CATEGORY_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.category.count({ where }),
    ]);

    return [rows, total];
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Patch a category by id.
   * Supports setting description to null explicitly to clear it.
   * Returns the updated category.
   */
  async update(id: string, data: UpdateCategoryDto): Promise<CategoryRecord> {
    return prisma.category.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        // description can be undefined (not provided), a string, or null (clear it)
        ...('description' in data && { description: data.description }),
      },
      select: CATEGORY_SELECT,
    });
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  /**
   * Hard-delete a category by id.
   * The caller MUST verify there are no associated products before calling this.
   */
  async deleteById(id: string): Promise<void> {
    await prisma.category.delete({ where: { id } });
  }

  // ── Guard helpers ──────────────────────────────────────────────────────────

  /**
   * Count the number of Product rows associated with this category.
   * Used by the delete guard: if count > 0, deletion must be rejected.
   */
  async countProductsInCategory(id: string): Promise<number> {
    return prisma.product.count({ where: { categoryId: id } });
  }
}

/** Singleton instance consumed by the categories controller. */
export const categoriesRepository = new CategoriesRepository();
