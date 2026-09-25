/**
 * Unit tests for the `db:seed:demo` pure safety state machine.
 *
 * Tests per tasks.md 4.2 + specs/database-schema/spec.md
 * ("Demo database isolation and seed-target safety") + design.md's
 * canonical seed state machine (marker read FIRST):
 *   - assertConfirm: missing/invalid confirmation throws; matching
 *     confirmation does not throw.
 *   - resolveSeedState: no marker + empty DB → FIRST_RUN.
 *   - resolveSeedState: no marker + non-empty DB → ABORT_UNMARKED.
 *   - resolveSeedState: EXACTLY ONE valid marker + EXACTLY ONE valid demo
 *     identity → RECOGNIZED_RERUN, and the empty-DB check is skipped
 *     (non-empty DB alongside a valid marker still reruns).
 *   - resolveSeedState: marker present but the version, marker-count, or
 *     demo-identity-count invariant is broken → ABORT_MISMATCH. This
 *     includes cardinality defects found in maintainer validation: two
 *     matching marker rows, and a valid public demo ADMIN alongside an
 *     extra unrelated `isDemo:true` user — both MUST fail closed, not be
 *     silently accepted as a valid rerun.
 *
 * Pure functions, no DB — no Prisma mock needed, matching the direct-unit
 * style used by tests/unit/assertMutationAllowed.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { assertConfirm, resolveSeedState } from '../../src/shared/demo/seedSafety.js';

describe('assertConfirm()', () => {
  it('throws when the confirmation is missing (confirmed=false)', () => {
    expect(() => assertConfirm(false)).toThrow();
  });

  it('throws when the confirmation does not match exactly (confirmed=false)', () => {
    // The caller computes `process.env.DEMO_SEED_CONFIRM === expectedLiteral`
    // and passes the boolean result in — a mismatched value collapses to the
    // same `false` input as a missing one.
    expect(() => assertConfirm(false)).toThrow();
  });

  it('does not throw when the confirmation matches exactly (confirmed=true)', () => {
    expect(() => assertConfirm(true)).not.toThrow();
  });
});

describe('resolveSeedState()', () => {
  it('empty database, no marker → FIRST_RUN', () => {
    const state = resolveSeedState({
      markerCount: 0,
      matchingMarkerCount: 0,
      totalDemoIdentityCount: 0,
      matchingDemoIdentityCount: 0,
      appIsEmpty: true,
    });
    expect(state).toBe('FIRST_RUN');
  });

  it('non-empty database, no marker → ABORT_UNMARKED (unsafe unmarked target)', () => {
    const state = resolveSeedState({
      markerCount: 0,
      matchingMarkerCount: 0,
      totalDemoIdentityCount: 0,
      matchingDemoIdentityCount: 0,
      appIsEmpty: false,
    });
    expect(state).toBe('ABORT_UNMARKED');
  });

  it('exactly one valid marker + exactly one valid demo identity → RECOGNIZED_RERUN', () => {
    const state = resolveSeedState({
      markerCount: 1,
      matchingMarkerCount: 1,
      totalDemoIdentityCount: 1,
      matchingDemoIdentityCount: 1,
      appIsEmpty: true,
    });
    expect(state).toBe('RECOGNIZED_RERUN');
  });

  it('recognized rerun SKIPS the empty-DB check — non-empty DB is fine with a valid marker', () => {
    const state = resolveSeedState({
      markerCount: 1,
      matchingMarkerCount: 1,
      totalDemoIdentityCount: 1,
      matchingDemoIdentityCount: 1,
      appIsEmpty: false, // e.g. setup ADMIN + manual movements/alerts already exist
    });
    expect(state).toBe('RECOGNIZED_RERUN');
  });

  it('one marker present but its version does not match → ABORT_MISMATCH', () => {
    const state = resolveSeedState({
      markerCount: 1,
      matchingMarkerCount: 0,
      totalDemoIdentityCount: 1,
      matchingDemoIdentityCount: 1,
      appIsEmpty: true,
    });
    expect(state).toBe('ABORT_MISMATCH');
  });

  it('one valid marker but zero demo identities → ABORT_MISMATCH', () => {
    const state = resolveSeedState({
      markerCount: 1,
      matchingMarkerCount: 1,
      totalDemoIdentityCount: 0,
      matchingDemoIdentityCount: 0,
      appIsEmpty: true,
    });
    expect(state).toBe('ABORT_MISMATCH');
  });

  it('one valid marker but two duplicate matching demo identities → ABORT_MISMATCH', () => {
    const state = resolveSeedState({
      markerCount: 1,
      matchingMarkerCount: 1,
      totalDemoIdentityCount: 2,
      matchingDemoIdentityCount: 2,
      appIsEmpty: true,
    });
    expect(state).toBe('ABORT_MISMATCH');
  });

  it('two matching marker rows (marker cardinality > 1) → ABORT_MISMATCH', () => {
    // Regression for a validated defect: a boolean "version matches" flag
    // cannot distinguish "exactly one matching marker" from "two matching
    // markers" — the contract requires EXACTLY ONE marker row total, with
    // that one row matching the expected version.
    const state = resolveSeedState({
      markerCount: 2,
      matchingMarkerCount: 2,
      totalDemoIdentityCount: 1,
      matchingDemoIdentityCount: 1,
      appIsEmpty: true,
    });
    expect(state).toBe('ABORT_MISMATCH');
  });

  it('valid public demo ADMIN plus an unrelated isDemo:true user (identity cardinality > 1) → ABORT_MISMATCH', () => {
    // Regression for a validated defect: counting only MATCHING identities
    // cannot detect an extra unrelated isDemo:true row alongside a correct
    // one — the contract requires EXACTLY ONE total demo identity, and that
    // one identity MUST be the expected public ADMIN.
    const state = resolveSeedState({
      markerCount: 1,
      matchingMarkerCount: 1,
      totalDemoIdentityCount: 2,
      matchingDemoIdentityCount: 1,
      appIsEmpty: true,
    });
    expect(state).toBe('ABORT_MISMATCH');
  });
});
