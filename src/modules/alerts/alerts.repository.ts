/**
 * AlertsRepository — Prisma data-access layer for the alerts module.
 *
 * Responsibilities:
 *   - findMany()             Paginated list with resolved/type/productId filters.
 *   - findById()             Point read by primary key.
 *   - findOpenByProduct()    Look up the single open alert for a product (null if none).
 *   - resolveAlert()         Mark an alert resolved inside a transaction.
 *   - createAlert()          Insert a new alert inside a transaction.
 *   - reconcile()            Full reconcile logic — close-before-create, auto-resolve.
 *
 * Reconcile semantics (REQ-1..5):
 *   Given (tx, productId, nextStock, minStock):
 *   - If nextStock === 0  → ensure open OUT_OF_STOCK exists (close any open LOW_STOCK first).
 *   - If nextStock > 0 && nextStock <= minStock → ensure open LOW_STOCK (close any open OUT_OF_STOCK).
 *   - If nextStock > minStock → close any open alert (no-op if none).
 *   - Close-before-create: close the wrong-type open alert before inserting the right one.
 *   - At-most-one open alert per product at any time.
 *
 * reconcile is an advisory hook. The caller (service) is responsible for
 * catching non-critical errors and swallowing them (REQ-5).
 *
 * All tx-bound methods accept Prisma.TransactionClient so they run atomically
 * inside the caller's $transaction.
 */
import type { Prisma, AlertType as PrismaAlertType } from '@prisma/client';
import { AlertType } from '@prisma/client';
import { prisma } from '../../shared/utils/prisma.js';
import type { ListAlertsQuery } from './alerts.schema.js';
import type { AlertDto } from './alerts.schema.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** Minimal product read needed by reconcile (read inside the same tx). */
type ProductMinimalRow = {
  id: string;
  stock: number;
  minStock: number;
};

/** Raw alert row selected from Prisma — matches AlertDto shape. */
type AlertRow = {
  id: string;
  productId: string;
  type: PrismaAlertType;
  message: string;
  resolved: boolean;
  resolvedAt: Date | null;
  resolvedByUserId: string | null;
  createdAt: Date;
};

/** Fields selected for all alert reads. */
const ALERT_SELECT = {
  id: true,
  productId: true,
  type: true,
  message: true,
  resolved: true,
  resolvedAt: true,
  resolvedByUserId: true,
  createdAt: true,
} as const;

// ---------------------------------------------------------------------------
// DTO mapper
// ---------------------------------------------------------------------------

/** Map a raw Prisma alert row to the API AlertDto. */
function toDto(row: AlertRow): AlertDto {
  return {
    id: row.id,
    productId: row.productId,
    type: row.type,
    message: row.message,
    resolved: row.resolved,
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolvedByUserId: row.resolvedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// AlertsRepository
// ---------------------------------------------------------------------------

export class AlertsRepository {
  // ── Paginated list ─────────────────────────────────────────────────────────

  /**
   * Paginated list of alerts with optional filters.
   *
   * resolved filter:
   *   'false' (default) → resolved = false
   *   'true'            → resolved = true
   *   'all'             → no filter on resolved
   *
   * Sorted by createdAt DESC (spec REQ-6).
   *
   * Returns [rows as AlertDto[], total] tuple for the service to assemble pagination.
   */
  async findMany(query: ListAlertsQuery): Promise<[AlertDto[], number]> {
    const { page, limit, resolved, type, productId } = query;
    const skip = (page - 1) * limit;

    const where: Prisma.AlertWhereInput = {};

    if (resolved !== 'all') {
      where.resolved = resolved === 'true';
    }
    if (type) where.type = type;
    if (productId) where.productId = productId;

    const [rows, total] = await Promise.all([
      prisma.alert.findMany({
        where,
        select: ALERT_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.alert.count({ where }),
    ]);

    return [rows.map(toDto), total];
  }

  // ── Point read ─────────────────────────────────────────────────────────────

  /**
   * Find a single alert by primary key.
   * Returns null when not found.
   */
  async findById(id: string): Promise<AlertDto | null> {
    const row = await prisma.alert.findUnique({
      where: { id },
      select: ALERT_SELECT,
    });
    return row ? toDto(row as AlertRow) : null;
  }

  /**
   * Find a single alert by id WITH product stock/minStock data for
   * create-replenishment quantity calculation.
   *
   * Returns null when not found.
   */
  async findByIdWithProduct(id: string): Promise<{
    alert: AlertDto;
    product: ProductMinimalRow;
  } | null> {
    const row = await prisma.alert.findUnique({
      where: { id },
      select: {
        ...ALERT_SELECT,
        product: {
          select: { id: true, stock: true, minStock: true },
        },
      },
    });

    if (!row) return null;

    const { product, ...alertFields } = row;
    return {
      alert: toDto(alertFields as AlertRow),
      product,
    };
  }

  // ── Open alert lookup ───────────────────────────────────────────────────────

  /**
   * Find the single open (resolved=false) alert for a product.
   * Returns null when no open alert exists.
   * Used by reconcile to decide close-before-create logic.
   */
  async findOpenByProduct(
    tx: Prisma.TransactionClient,
    productId: string,
  ): Promise<(AlertRow & { type: PrismaAlertType }) | null> {
    const row = await tx.alert.findFirst({
      where: { productId, resolved: false },
      select: ALERT_SELECT,
    });
    return row as (AlertRow & { type: PrismaAlertType }) | null;
  }

  // ── Alert mutations (inside tx) ────────────────────────────────────────────

  /**
   * Mark an alert as resolved inside a transaction.
   * resolvedByUserId is null for system-triggered resolves.
   */
  async resolveAlert(tx: Prisma.TransactionClient, alertId: string): Promise<void> {
    await tx.alert.update({
      where: { id: alertId },
      data: {
        resolved: true,
        resolvedAt: new Date(),
        resolvedByUserId: null,
      },
    });
  }

  /**
   * Insert a new alert inside a transaction.
   *
   * @param tx         Prisma transaction client.
   * @param productId  Product this alert is for.
   * @param type       LOW_STOCK or OUT_OF_STOCK.
   * @param message    Human-readable message.
   */
  async createAlert(
    tx: Prisma.TransactionClient,
    productId: string,
    type: PrismaAlertType,
    message: string,
  ): Promise<void> {
    await tx.alert.create({
      data: {
        productId,
        type,
        message,
        resolved: false,
        resolvedAt: null,
        resolvedByUserId: null,
      },
    });
  }

  // ── Reconcile (transactional alert state machine) ──────────────────────────

  /**
   * Reconcile the alert state for a product after a stock write.
   *
   * This method is ADVISORY. The caller must wrap the call in a try/catch and
   * swallow non-critical errors (REQ-5). Real DB connection failures may
   * still propagate.
   *
   * State machine (REQ-1..4):
   *   nextStock === 0            → ensure open OUT_OF_STOCK (close LOW_STOCK if open)
   *   0 < nextStock <= minStock  → ensure open LOW_STOCK (close OUT_OF_STOCK if open)
   *   nextStock > minStock       → close any open alert (no-op if none)
   *
   * @param tx         Prisma transaction client.
   * @param productId  Product whose stock was just updated.
   * @param nextStock  The new stock value after the write.
   * @param minStock   The product's current minStock threshold.
   */
  async reconcile(
    tx: Prisma.TransactionClient,
    productId: string,
    nextStock: number,
    minStock: number,
  ): Promise<void> {
    const openAlert = await this.findOpenByProduct(tx, productId);

    if (nextStock > minStock) {
      // REQ-4: Recovery — close any open alert, no new one needed.
      if (openAlert) {
        await this.resolveAlert(tx, openAlert.id);
      }
      return;
    }

    // Determine the required alert type.
    const requiredType: PrismaAlertType =
      nextStock === 0 ? AlertType.OUT_OF_STOCK : AlertType.LOW_STOCK;

    if (openAlert) {
      if (openAlert.type === requiredType) {
        // REQ-1/REQ-2 duplicate: same type already open — no-op.
        return;
      }
      // REQ-3 close-before-create: close the wrong-type alert first.
      await this.resolveAlert(tx, openAlert.id);
    }

    // Insert the new alert.
    const message =
      requiredType === AlertType.OUT_OF_STOCK
        ? `Product stock is 0 — OUT OF STOCK.`
        : `Product stock (${nextStock}) is at or below minimum threshold (${minStock}).`;

    await this.createAlert(tx, productId, requiredType, message);
  }
}

/** Singleton instance consumed by the alerts service and hook callers. */
export const alertsRepository = new AlertsRepository();
