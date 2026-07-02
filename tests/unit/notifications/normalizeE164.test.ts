/**
 * Unit tests for normalizeE164.
 *
 * Covers:
 *   - Valid E.164 numbers (with and without formatting characters)
 *   - Numbers that are already canonical E.164
 *   - Invalid numbers (missing +, too short, too long, non-digits)
 *   - Edge cases (empty string, null-like inputs, whitespace-only)
 */
import { describe, expect, it } from 'vitest';
import { normalizeE164 } from '../../../src/shared/notifications/normalizeE164.js';

describe('normalizeE164', () => {
  // ── Valid E.164 → canonical form ────────────────────────────────────────────

  it('returns canonical E.164 when input is already clean', () => {
    expect(normalizeE164('+14155238886')).toBe('+14155238886');
  });

  it('strips spaces and returns canonical form', () => {
    expect(normalizeE164('+1 415 523 8886')).toBe('+14155238886');
  });

  it('strips dashes and returns canonical form', () => {
    expect(normalizeE164('+1-415-523-8886')).toBe('+14155238886');
  });

  it('strips parentheses and returns canonical form', () => {
    expect(normalizeE164('+1 (415) 523-8886')).toBe('+14155238886');
  });

  it('strips dots and returns canonical form', () => {
    expect(normalizeE164('+1.415.523.8886')).toBe('+14155238886');
  });

  it('accepts an 8-digit number after + (minimum E.164 digits)', () => {
    // +12345678 → 8 digits after + → valid
    expect(normalizeE164('+12345678')).toBe('+12345678');
  });

  it('accepts a 15-digit number after + (maximum E.164 digits)', () => {
    expect(normalizeE164('+123456789012345')).toBe('+123456789012345');
  });

  it('handles Venezuelan WhatsApp number format', () => {
    expect(normalizeE164('+58 414 123 4567')).toBe('+584141234567');
  });

  // ── Invalid inputs → null ──────────────────────────────────────────────────

  it('returns null for a number without leading +', () => {
    expect(normalizeE164('14155238886')).toBeNull();
  });

  it('returns null for a number that is too short (7 digits after +)', () => {
    expect(normalizeE164('+1234567')).toBeNull();
  });

  it('returns null for a number that is too long (16 digits after +)', () => {
    expect(normalizeE164('+1234567890123456')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeE164('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeE164('   ')).toBeNull();
  });

  it('returns null when number contains non-numeric characters (letters)', () => {
    expect(normalizeE164('+1415CALL886')).toBeNull();
  });

  it('returns null for just a + sign', () => {
    expect(normalizeE164('+')).toBeNull();
  });
});
