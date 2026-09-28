/**
 * Manual, real-PostgreSQL concurrency proof for `db:seed:demo`'s
 * Serializable + bounded-retry correction (independent-validation
 * remediation — the unit tests in
 * `tests/unit/seed-demo.serializable-retry.test.ts` prove the JS-level
 * retry WIRING against a mock; this script proves the actual DATABASE
 * behavior, which no mock can substitute for).
 *
 * It launches a disposable, throwaway `postgres:15-alpine` container,
 * applies migrations, then runs TWO real OS-level `tsx` child processes
 * calling `runSeedDemo` CONCURRENTLY against the same empty database — the
 * exact scenario the original defect could not survive (both processes
 * reading "no marker, empty" under `ReadCommitted` and both first-running).
 * It asserts:
 *   1. both concurrent invocations exit 0 (one commits FIRST_RUN; the other
 *      hits a `P2034` serialization conflict, retries with a fresh
 *      transaction, and completes as a RECOGNIZED_RERUN);
 *   2. exactly one `DemoSeedMarker` row exists afterward;
 *   3. the fabricated dataset has the exact approved 2/2/2 cardinality plus
 *      exactly one `isDemo:true` public ADMIN and 3 `ProductSupplier` links
 *      — no duplicate rows from the race;
 *   4. a THIRD invocation (a plain sequential rerun) is recognized and
 *      non-destructive: it succeeds, and the marker count stays 1.
 *
 * This is a manual harness, not part of `npm test` — it requires Docker and
 * takes several seconds to spin up/tear down a real Postgres instance.
 *
 * Usage:
 *   npx tsx prisma/scripts/demo-seed-concurrency-harness.ts
 *
 * Requires Docker. Cleans up its own container (success, failure, or
 * uncaught error) — no manual `docker rm` needed. Uses a fixed container
 * name/port so a prior crashed run is visible via `docker ps -a` instead of
 * silently leaking a second container.
 */
import { execSync, spawn } from 'node:child_process';
import { PrismaClient } from '@prisma/client';
import { REQUIRED_CONFIRMATION } from './seed-demo.js';

const CONTAINER_NAME = 'sdd-guest-env-pg-concurrency-harness';
const HOST_PORT = 5434;
const DATABASE_URL = `postgresql://postgres:postgres@localhost:${HOST_PORT}/postgres?schema=public`;

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function sh(cmd: string): string {
  return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

function runSeedChild(env: NodeJS.ProcessEnv): Promise<ChildResult> {
  return new Promise((resolve) => {
    const child = spawn('npx', ['tsx', 'prisma/scripts/seed-demo.ts'], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function waitForPostgresReady(maxAttempts: number): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      sh(`docker exec ${CONTAINER_NAME} pg_isready -U postgres`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw new Error(`Postgres container did not become ready after ${maxAttempts}s`);
}

function teardown(): void {
  try {
    sh(`docker rm -f ${CONTAINER_NAME}`);
  } catch {
    // Container may already be gone (e.g. never started) — not a harness failure.
  }
}

async function main(): Promise<void> {
  const failures: string[] = [];

  console.log(`Starting disposable Postgres (${CONTAINER_NAME}, host port ${HOST_PORT})…`);
  teardown(); // clear any stale container from a prior interrupted run
  sh(
    `docker run -d --name ${CONTAINER_NAME} -e POSTGRES_PASSWORD=postgres -p ${HOST_PORT}:5432 postgres:15-alpine`,
  );
  await waitForPostgresReady(30);

  const baseEnv = { ...process.env, DATABASE_URL };
  console.log('Applying migrations to the empty disposable database…');
  execSync('npx prisma migrate deploy', { env: baseEnv, stdio: 'inherit' });

  const seedEnv = { ...baseEnv, DEMO_SEED_CONFIRM: REQUIRED_CONFIRMATION };

  console.log('Launching TWO concurrent first-run `db:seed:demo` invocations…');
  const [procA, procB] = await Promise.all([runSeedChild(seedEnv), runSeedChild(seedEnv)]);

  console.log(`Process A exit code: ${procA.code}`);
  console.log(procA.stdout + procA.stderr);
  console.log(`Process B exit code: ${procB.code}`);
  console.log(procB.stdout + procB.stderr);

  if (procA.code !== 0) failures.push(`Process A did not exit 0 (got ${String(procA.code)})`);
  if (procB.code !== 0) failures.push(`Process B did not exit 0 (got ${String(procB.code)})`);

  const prisma = new PrismaClient({ datasourceUrl: DATABASE_URL });
  try {
    const markerCount = await prisma.demoSeedMarker.count();
    const demoAdminCount = await prisma.user.count({ where: { isDemo: true } });
    const categoryCount = await prisma.category.count();
    const supplierCount = await prisma.supplier.count();
    const productCount = await prisma.product.count();
    const linkCount = await prisma.productSupplier.count();

    console.log(
      `Post-race counts — marker: ${String(markerCount)}, demoAdmin: ${String(demoAdminCount)}, ` +
        `category: ${String(categoryCount)}, supplier: ${String(supplierCount)}, ` +
        `product: ${String(productCount)}, productSupplier: ${String(linkCount)}`,
    );

    if (markerCount !== 1)
      failures.push(`expected exactly 1 DemoSeedMarker, got ${String(markerCount)}`);
    if (demoAdminCount !== 1)
      failures.push(`expected exactly 1 isDemo:true user, got ${String(demoAdminCount)}`);
    if (categoryCount !== 2)
      failures.push(`expected exactly 2 categories, got ${String(categoryCount)}`);
    if (supplierCount !== 2)
      failures.push(`expected exactly 2 suppliers, got ${String(supplierCount)}`);
    if (productCount !== 2)
      failures.push(`expected exactly 2 products, got ${String(productCount)}`);
    if (linkCount !== 3)
      failures.push(`expected exactly 3 ProductSupplier links, got ${String(linkCount)}`);

    console.log(
      'Running a THIRD (sequential) invocation to prove the rerun is recognized and non-destructive…',
    );
    const procC = await runSeedChild(seedEnv);
    console.log(`Process C (rerun) exit code: ${procC.code}`);
    console.log(procC.stdout + procC.stderr);
    if (procC.code !== 0)
      failures.push(`Rerun (Process C) did not exit 0 (got ${String(procC.code)})`);

    const markerCountAfterRerun = await prisma.demoSeedMarker.count();
    if (markerCountAfterRerun !== 1)
      failures.push(
        `expected marker count to stay 1 after recognized rerun, got ${String(markerCountAfterRerun)}`,
      );
  } finally {
    await prisma.$disconnect();
  }

  teardown();

  if (failures.length > 0) {
    console.error('❌ HARNESS FAILED:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exitCode = 1;
    return;
  }
  console.log(
    '✅ HARNESS PASSED — two concurrent first-run invocations both resolved successfully under retry, ' +
      'exactly one marker/admin/dataset survived the race, and a sequential rerun stayed recognized and non-destructive.',
  );
}

main().catch((err: unknown) => {
  console.error('❌ HARNESS CRASHED:', err);
  teardown();
  process.exitCode = 1;
});
