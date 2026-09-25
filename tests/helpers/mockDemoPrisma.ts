/**
 * Prisma-shaped mock for `prisma/scripts/seed-demo.ts` unit tests.
 *
 * Correction (independent-validation remediation): the mock now exposes
 * DISTINCT `prisma` (root client) and `tx` (transaction-scoped client)
 * objects with INDEPENDENT `vi.fn()` stubs per model, plus a single ordered
 * `operationLog` shared by both. This lets tests prove — not just assert
 * repeated call arguments —:
 *   - which client (root vs tx) issued each read/write, so "reads and
 *     writes must use the SAME transaction client" is checkable directly
 *     (a correct implementation NEVER calls a `root:`-tagged model method);
 *   - the exact ORDER of operations (e.g. `demoSeedMarker.count` before any
 *     of the ten application-model counts, and the ten counts absent
 *     entirely on a recognized rerun).
 *
 * `category`/`supplier`/`product` `upsert()` still return a deterministic id
 * derived from the natural key (name/rif/code) so downstream
 * `ProductSupplier` linking works without a real backing store. Real
 * persistence/uniqueness is proven by the runtime harness against a
 * disposable Postgres instance, not by this mock.
 *
 * `prisma.$transaction` mirrors Prisma's interactive-transaction callback
 * shape — it invokes the callback with `tx`, a SEPARATE object from
 * `prisma`, so a correct implementation's reads/writes all land on `tx`'s
 * stubs while `prisma`'s own model stubs stay uncalled.
 */
import { vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const MODEL_NAMES = [
  'user',
  'refreshToken',
  'category',
  'product',
  'supplier',
  'productSupplier',
  'inventoryMovement',
  'alert',
  'replenishmentRequest',
  'replenishmentRequestItem',
  'demoSeedMarker',
] as const;

type ModelName = (typeof MODEL_NAMES)[number];
type ClientTag = 'root' | 'tx';

/** Derives a deterministic id from a natural-key `where` clause (first value). */
function deriveId(model: ModelName, where: Record<string, unknown> | undefined): { id: string } {
  const key = where ? Object.values(where)[0] : undefined;
  return { id: `${model}-${String(key ?? 'default')}` };
}

function buildModels(tag: ClientTag, log: string[]): Record<ModelName, Record<string, unknown>> {
  const models = {} as Record<ModelName, Record<string, unknown>>;
  for (const name of MODEL_NAMES) {
    models[name] = {
      count: vi.fn(() => {
        log.push(`${tag}:${name}.count`);
        return Promise.resolve(0);
      }),
      upsert: vi.fn((args: { where?: Record<string, unknown> }) => {
        log.push(`${tag}:${name}.upsert`);
        return Promise.resolve(deriveId(name, args.where));
      }),
      create: vi.fn(() => {
        log.push(`${tag}:${name}.create`);
        return Promise.resolve({ id: `${name}-created` });
      }),
      update: vi.fn(() => {
        log.push(`${tag}:${name}.update`);
        return Promise.resolve({});
      }),
      delete: vi.fn(() => {
        log.push(`${tag}:${name}.delete`);
        return Promise.resolve({});
      }),
    };
  }
  return models;
}

export interface MockDemoPrisma {
  /** The root client — what `runSeedDemo(prisma)` receives. Only `$transaction` should ever be called on it. */
  prisma: PrismaClient;
  /** The transaction-scoped client — every read AND write must land here. */
  tx: PrismaClient;
  /** Ordered log of every model operation, tagged `root:`/`tx:model.method`, shared across both clients. */
  operationLog: string[];
}

export function createMockDemoPrisma(): MockDemoPrisma {
  const operationLog: string[] = [];
  const rootModels = buildModels('root', operationLog);
  const txModels = buildModels('tx', operationLog);

  const tx = { ...txModels } as unknown as PrismaClient;
  const prisma = {
    ...rootModels,
    $transaction: vi.fn((cb: (tx: PrismaClient) => Promise<unknown>) => cb(tx)),
  } as unknown as PrismaClient;

  return { prisma, tx, operationLog };
}
