/**
 * WhatsApp message templates for replenishment request notifications.
 *
 * Templates are in English (i18n is out of scope for this release).
 * TODO: Add i18n support if multi-language supplier notifications are required
 *       for thesis defense or production deployment.
 *
 * Functions:
 *   buildSentTemplate(request, supplier)      → SENT notification body
 *   buildCancelledTemplate(request, supplier) → CANCELLED notification body
 */

// ---------------------------------------------------------------------------
// Input types (minimal — only the fields needed for template rendering)
// ---------------------------------------------------------------------------

export interface TemplateRequest {
  id: string;
  items: Array<{
    productName?: string;
    requestedQuantity: number;
    unitPrice: number | { toNumber(): number };
  }>;
}

export interface TemplateSupplier {
  name: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toNumber(value: number | { toNumber(): number }): number {
  return typeof value === 'number' ? value : value.toNumber();
}

function formatCurrency(amount: number): string {
  return amount.toFixed(2);
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * Build the SENT notification body.
 *
 * Format:
 *   New order #{id} from {company}.
 *   Items: {product} x{qty} @ ${price}, ...
 *   Total: ${total}.
 *   Please confirm.
 */
export function buildSentTemplate(request: TemplateRequest, supplier: TemplateSupplier): string {
  const lines = request.items
    .map((item) => {
      const price = toNumber(item.unitPrice);
      const label = item.productName ?? 'Item';
      return `${label} x${item.requestedQuantity} @ $${formatCurrency(price)}`;
    })
    .join(', ');

  const total = request.items.reduce((sum, item) => {
    return sum + toNumber(item.unitPrice) * item.requestedQuantity;
  }, 0);

  return (
    `New order #${request.id} from ${supplier.name}. ` +
    `Items: ${lines}. ` +
    `Total: $${formatCurrency(total)}. ` +
    `Please confirm.`
  );
}

/**
 * Build the CANCELLED notification body.
 *
 * Format:
 *   Order #{id} from {company} has been cancelled.
 */
export function buildCancelledTemplate(
  request: TemplateRequest,
  supplier: TemplateSupplier,
): string {
  return `Order #${request.id} from ${supplier.name} has been cancelled.`;
}
