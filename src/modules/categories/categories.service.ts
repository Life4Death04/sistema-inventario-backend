/**
 * CategoriesService — business logic for category management.
 *
 * Responsibilities:
 *   - Orchestrate CRUD operations via CategoriesRepository.
 *   - Enforce business guards:
 *       • Duplicate name check (409 on POST and PATCH)
 *       • Delete guard: reject if associated products exist (409)
 *   - Build paginated responses using the shared paginate() helper.
 *
 * This service does NOT import Express or interact with the HTTP layer.
 * It is consumed by categories.controller.ts.
 */
import { categoriesRepository, type CategoryRecord } from './categories.repository.js';
import { AppError } from '../../shared/errors/AppError.js';
import { ERROR_CODES } from '../../shared/errors/errorCodes.js';
import { paginate, type PaginatedResponse } from '../../shared/pagination/index.js';
import type {
  CreateCategoryDto,
  UpdateCategoryDto,
  ListCategoriesQuery,
} from './categories.schema.js';

export class CategoriesService {
  // ── Create ─────────────────────────────────────────────────────────────────

  /**
   * Create a new category.
   *
   * Guards:
   *   - 409 CONFLICT if name already in use.
   */
  async create(dto: CreateCategoryDto): Promise<CategoryRecord> {
    // Duplicate name check.
    const existing = await categoriesRepository.findByName(dto.name);
    if (existing) {
      throw new AppError(ERROR_CODES.CONFLICT, 409, 'Category name already exists.');
    }

    return categoriesRepository.create(dto);
  }

  // ── List ───────────────────────────────────────────────────────────────────

  /**
   * List categories with pagination and optional search filter.
   * Returns a standard PaginatedResponse envelope.
   */
  async list(query: ListCategoriesQuery): Promise<PaginatedResponse<CategoryRecord>> {
    const [data, total] = await categoriesRepository.list(query);
    return paginate({ data, total, page: query.page, limit: query.limit });
  }

  // ── Get one ────────────────────────────────────────────────────────────────

  /**
   * Get a single category by id.
   * Throws 404 NOT_FOUND when the category does not exist.
   */
  async getById(id: string): Promise<CategoryRecord> {
    const category = await categoriesRepository.findById(id);
    if (!category) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Category not found.');
    }
    return category;
  }

  // ── Update ─────────────────────────────────────────────────────────────────

  /**
   * Update a category by id.
   *
   * Guards (checked in order):
   *   1. 404 NOT_FOUND — category must exist.
   *   2. 409 CONFLICT  — name must not collide with a different existing category.
   *
   * @param id   Category being updated.
   * @param dto  Partial update payload (already validated).
   */
  async update(id: string, dto: UpdateCategoryDto): Promise<CategoryRecord> {
    // 1. Ensure the target category exists.
    const target = await categoriesRepository.findById(id);
    if (!target) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Category not found.');
    }

    // 2. Duplicate name guard (only when name is being changed).
    //    Allow renaming a category to its own current name (no false positive).
    if (dto.name !== undefined) {
      const nameConflict = await categoriesRepository.findByNameExcludingId(dto.name, id);
      if (nameConflict) {
        throw new AppError(ERROR_CODES.CONFLICT, 409, 'Category name already exists.');
      }
    }

    return categoriesRepository.update(id, dto);
  }

  // ── Hard delete ────────────────────────────────────────────────────────────

  /**
   * Hard-delete a category by id.
   *
   * Guards (checked in order):
   *   1. 404 NOT_FOUND — category must exist.
   *   2. 409 CONFLICT  — category must have no associated products.
   *
   * NOTE: We do an explicit count check rather than relying on Prisma's P2003
   * foreign-key exception (onDelete: Restrict). This gives a clean, predictable
   * 409 with a meaningful message, and it's testable with a plain mock.
   *
   * @param id   Category being deleted.
   */
  async hardDelete(id: string): Promise<void> {
    // 1. Ensure the target category exists.
    const target = await categoriesRepository.findById(id);
    if (!target) {
      throw new AppError(ERROR_CODES.NOT_FOUND, 404, 'Category not found.');
    }

    // 2. Associated-products guard.
    const productCount = await categoriesRepository.countProductsInCategory(id);
    if (productCount > 0) {
      throw new AppError(
        ERROR_CODES.CONFLICT,
        409,
        'Cannot delete category with associated products.',
      );
    }

    await categoriesRepository.deleteById(id);
  }
}

/** Singleton instance consumed by the categories controller. */
export const categoriesService = new CategoriesService();
