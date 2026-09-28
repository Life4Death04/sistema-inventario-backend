/**
 * Pure safety state machine for the `db:seed:demo` bootstrap.
 *
 * Two independent inputs gate every write, per specs/database-schema/spec.md
 * ("Demo database isolation and seed-target safety"):
 *   (a) assertConfirm    — the operator confirmation, matched exactly.
 *   (b) resolveSeedState — the persisted DemoSeedMarker, checked
 *       independently of the confirmation (marker-first routing).
 *
 * Both functions are pure: no Prisma, no `process.env`, no script/CLI
 * coupling, no database I/O. `prisma/scripts/seed-demo.ts` (PR5) reads the
 * real confirmation env var and marker/count data, then calls these
 * functions with the pre-computed results — this module only decides,
 * it never fetches.
 *
 * design.md — Canonical seed state machine (single $transaction, marker
 * read FIRST):
 *
 *     assertConfirm(env DEMO_SEED_CONFIRM === literal) ──mismatch/missing──▶ throws
 *       │ ok
 *     resolveSeedState: markerCount? then (only if markerCount === 0) appIsEmpty?
 *       ├ no marker (count 0) & empty        → FIRST_RUN
 *       ├ EXACTLY ONE valid marker + EXACTLY
 *       │   ONE valid demo identity           → RECOGNIZED_RERUN (skips empty-check)
 *       ├ marker(s) present but cardinality
 *       │   or identity invariant broken      → ABORT_MISMATCH
 *       └ no marker (count 0) & non-empty     → ABORT_UNMARKED
 *
 * "Exactly one" is a cardinality check, not an existence check: a boolean
 * "matches" flag cannot distinguish one correct row from two correct rows,
 * and a "count of matching identities" alone cannot detect an extra
 * unrelated row alongside a correct one. Both counts below are therefore
 * total-vs-matching pairs so `resolveSeedState` can fail closed on
 * duplicates and on extra unrelated `isDemo:true` identities, not just on
 * missing/mismatched ones.
 *
 * Executable wiring (real marker read, empty-DB counts, `$transaction`
 * writes) arrives in PR5 (Phase 5) — this module stays independent of that.
 */

/**
 * Throws when the operator confirmation does not match exactly.
 *
 * The caller (prisma/scripts/seed-demo.ts) computes
 * `process.env.DEMO_SEED_CONFIRM === <expected literal>` and passes the
 * boolean result in. A missing env var and a mismatched value both collapse
 * to `confirmed=false` — both MUST abort before any write, per
 * specs/database-schema/spec.md ("Confirmation failure").
 */
export function assertConfirm(confirmed: boolean): void {
  if (!confirmed) {
    throw new Error(
      'db:seed:demo aborted — the operator confirmation is missing or does not match exactly. Zero writes performed.',
    );
  }
}

/** Injected facts `resolveSeedState` routes on — no I/O, all pre-fetched by the caller. */
export interface SeedStateInput {
  /**
   * Total `DemoSeedMarker` rows in the target database, any version.
   * Zero means "no marker" (routes on `appIsEmpty`). Any other value means
   * "marker present" and requires the cardinality/identity checks below.
   */
  markerCount: number;
  /**
   * Subset of `markerCount` whose persisted `version` matches
   * `DEMO_MARKER_VERSION`. A recognized rerun requires `markerCount === 1
   * && matchingMarkerCount === 1` — i.e. EXACTLY ONE marker row, and it
   * matches. Two matching rows (duplicate markers) is NOT a valid rerun.
   * Irrelevant when `markerCount` is 0.
   */
  matchingMarkerCount: number;
  /**
   * Total `isDemo:true` users in the target database, any identity.
   * Irrelevant when `markerCount` is 0.
   */
  totalDemoIdentityCount: number;
  /**
   * Subset of `totalDemoIdentityCount` that are the expected public demo
   * ADMIN identity (`DEMO_ADMIN_EMAIL`, `role: ADMIN`). A recognized rerun
   * requires `totalDemoIdentityCount === 1 && matchingDemoIdentityCount
   * === 1` — i.e. EXACTLY ONE demo identity exists, and it is the expected
   * one. A correct public ADMIN plus one extra unrelated `isDemo:true` row
   * is NOT a valid rerun. Irrelevant when `markerCount` is 0.
   */
  matchingDemoIdentityCount: number;
  /**
   * Whether every application/domain model has zero rows (per design.md's
   * "Empty application DB" definition; `DemoSeedMarker` itself included,
   * `_prisma_migrations` excluded). Irrelevant when `markerCount` is
   * greater than 0 — a recognized rerun skips this check entirely.
   */
  appIsEmpty: boolean;
}

/**
 * Exhaustive seed-bootstrap outcomes, per specs/database-schema/spec.md
 * ("Demo database isolation and seed-target safety", transitions 1-5) and
 * tasks.md 4.2.
 */
export type SeedState = 'FIRST_RUN' | 'RECOGNIZED_RERUN' | 'ABORT_UNMARKED' | 'ABORT_MISMATCH';

/**
 * Marker-first routing. Assumes `assertConfirm` already passed for the
 * current invocation — this function does not re-check the confirmation.
 *
 * A recognized rerun requires BOTH cardinality invariants to hold at once:
 * exactly one marker row (matching version) AND exactly one demo identity
 * row (matching the expected public ADMIN). Any other marker-present
 * combination — duplicates, wrong version, zero identities, or an extra
 * unrelated `isDemo:true` row — fails closed to `ABORT_MISMATCH`.
 */
export function resolveSeedState(input: SeedStateInput): SeedState {
  if (input.markerCount > 0) {
    const exactlyOneValidMarker = input.markerCount === 1 && input.matchingMarkerCount === 1;
    const exactlyOneValidDemoIdentity =
      input.totalDemoIdentityCount === 1 && input.matchingDemoIdentityCount === 1;

    return exactlyOneValidMarker && exactlyOneValidDemoIdentity
      ? 'RECOGNIZED_RERUN'
      : 'ABORT_MISMATCH';
  }

  return input.appIsEmpty ? 'FIRST_RUN' : 'ABORT_UNMARKED';
}
