/**
 * Unit tests for pagination utilities.
 *
 * Tests per tasks.md 3.14:
 *   - paginate() defaults apply (page=1, limit=20).
 *   - limit > 100 → validation rejects with appropriate message.
 *   - sort without direction → validation rejects.
 *   - paginate() returns correct meta fields.
 */
import { describe, expect, it } from 'vitest';
import { paginate, paginationQuerySchema } from '../../src/shared/pagination/index.js';

describe('paginationQuerySchema', () => {
  it('applies default page=1 and limit=20 when no params provided', () => {
    const result = paginationQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(1);
      expect(result.data.limit).toBe(20);
    }
  });

  it('parses valid page and limit from query strings (coercion)', () => {
    const result = paginationQuerySchema.safeParse({ page: '3', limit: '50' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.page).toBe(3);
      expect(result.data.limit).toBe(50);
    }
  });

  it('rejects page < 1', () => {
    const result = paginationQuerySchema.safeParse({ page: '0' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.flatten().fieldErrors['page'];
      expect(msgs).toBeDefined();
    }
  });

  it('rejects limit > 100', () => {
    const result = paginationQuerySchema.safeParse({ limit: '500' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.flatten().fieldErrors['limit'];
      expect(msgs).toBeDefined();
      // Message should mention max 100
      expect(msgs?.join(' ')).toMatch(/100/);
    }
  });

  it('rejects limit = 0', () => {
    const result = paginationQuerySchema.safeParse({ limit: '0' });
    expect(result.success).toBe(false);
  });

  it('accepts valid sort "createdAt:desc"', () => {
    const result = paginationQuerySchema.safeParse({ sort: 'createdAt:desc' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.sort).toBe('createdAt:desc');
    }
  });

  it('accepts multi-field sort "name:asc,createdAt:desc"', () => {
    const result = paginationQuerySchema.safeParse({ sort: 'name:asc,createdAt:desc' });
    expect(result.success).toBe(true);
  });

  it('rejects sort without direction (e.g. "name" alone)', () => {
    const result = paginationQuerySchema.safeParse({ sort: 'name' });
    expect(result.success).toBe(false);
    if (!result.success) {
      const msgs = result.error.flatten().fieldErrors['sort'];
      expect(msgs).toBeDefined();
      expect(msgs?.join(' ')).toMatch(/asc|desc/i);
    }
  });

  it('rejects sort with invalid direction (e.g. "name:up")', () => {
    const result = paginationQuerySchema.safeParse({ sort: 'name:up' });
    expect(result.success).toBe(false);
  });
});

describe('paginate()', () => {
  it('returns correct envelope with meta fields', () => {
    const result = paginate({ data: ['a', 'b', 'c'], total: 50, page: 2, limit: 10 });
    expect(result.data).toEqual(['a', 'b', 'c']);
    expect(result.meta).toEqual({ page: 2, limit: 10, total: 50, totalPages: 5 });
  });

  it('calculates totalPages correctly (ceil)', () => {
    const result = paginate({ data: [], total: 21, page: 1, limit: 20 });
    expect(result.meta.totalPages).toBe(2);
  });

  it('returns totalPages=1 when total is 0 (no divide-by-zero / empty state)', () => {
    const result = paginate({ data: [], total: 0, page: 1, limit: 20 });
    expect(result.meta.totalPages).toBe(1);
  });

  it('returns totalPages=1 when total fits exactly one page', () => {
    const result = paginate({ data: [1, 2, 3], total: 3, page: 1, limit: 20 });
    expect(result.meta.totalPages).toBe(1);
  });

  it('passes data through unmodified', () => {
    const data = [{ id: '1' }, { id: '2' }];
    const result = paginate({ data, total: 100, page: 1, limit: 20 });
    expect(result.data).toBe(data);
  });
});
