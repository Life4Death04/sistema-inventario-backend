/**
 * Unit tests for replenishment-requests schema sentinel behavior.
 *
 * Focused on the empty-items edge case that must produce
 * REPLENISHMENT_ITEMS_REQUIRED instead of VALIDATION_ERROR.
 *
 * The validate() middleware maps the sentinel message; here we verify
 * that the schema emits the correct sentinel message when items is empty.
 */
import { describe, expect, it } from 'vitest';
import { createReplenishmentRequestSchema } from '../../../../src/modules/replenishment-requests/replenishment-requests.schema.js';

const VALID_CUID = 'clh3xxk0h0000356c9a5oba7k';
const VALID_PRODUCT_ID = 'clh3xxk0h1001356c9a5oba8m';

describe('createReplenishmentRequestSchema — items sentinel', () => {
  it('accepts a valid body with one item', () => {
    const result = createReplenishmentRequestSchema.safeParse({
      supplierId: VALID_CUID,
      items: [{ productId: VALID_PRODUCT_ID, requestedQuantity: 5, unitPrice: 10.5 }],
    });
    expect(result.success).toBe(true);
  });

  it('emits REPLENISHMENT_ITEMS_REQUIRED sentinel message when items is empty', () => {
    const result = createReplenishmentRequestSchema.safeParse({
      supplierId: VALID_CUID,
      items: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      // The sentinel message must be exactly this string so the validate
      // middleware can map it to AppError(REPLENISHMENT_ITEMS_REQUIRED, 400).
      const sentinelIssue = result.error.issues.find(
        (issue) => issue.message === 'REPLENISHMENT_ITEMS_REQUIRED',
      );
      expect(sentinelIssue).toBeDefined();
    }
  });

  it('emits REPLENISHMENT_ITEMS_REQUIRED even when other fields are also invalid', () => {
    const result = createReplenishmentRequestSchema.safeParse({
      supplierId: 'not-a-cuid',
      items: [],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const sentinelIssue = result.error.issues.find(
        (issue) => issue.message === 'REPLENISHMENT_ITEMS_REQUIRED',
      );
      expect(sentinelIssue).toBeDefined();
    }
  });

  it('accepts an item without unitPrice (optional field)', () => {
    const result = createReplenishmentRequestSchema.safeParse({
      supplierId: VALID_CUID,
      items: [{ productId: VALID_PRODUCT_ID, requestedQuantity: 3 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an item with requestedQuantity=0', () => {
    const result = createReplenishmentRequestSchema.safeParse({
      supplierId: VALID_CUID,
      items: [{ productId: VALID_PRODUCT_ID, requestedQuantity: 0 }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects an item with negative unitPrice', () => {
    const result = createReplenishmentRequestSchema.safeParse({
      supplierId: VALID_CUID,
      items: [{ productId: VALID_PRODUCT_ID, requestedQuantity: 1, unitPrice: -5 }],
    });
    expect(result.success).toBe(false);
  });
});
