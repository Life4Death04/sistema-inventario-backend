/**
 * normalizeE164 — strip formatting characters and validate E.164 phone numbers.
 *
 * Accepts numbers in various formats (with spaces, dashes, dots, parentheses)
 * and returns the canonical E.164 string, or null if the result is not valid.
 *
 * Valid E.164: starts with '+', followed by 8–15 digits (ITU-T E.164 spec).
 *
 * Examples:
 *   normalizeE164('+14155238886')       → '+14155238886'
 *   normalizeE164('+1 (415) 523-8886') → '+14155238886'
 *   normalizeE164('4155238886')         → null  (no leading +)
 *   normalizeE164('+1')                 → null  (too short)
 */

/** Regex matching a valid E.164 number after stripping whitespace and formatting. */
const E164_REGEX = /^\+\d{8,15}$/;

/** Characters to strip before validation: spaces, dashes, dots, parentheses. */
const STRIP_REGEX = /[\s\-().]/g;

/**
 * Normalize a raw phone string to E.164.
 *
 * @param raw  Raw phone number string (may include spaces, dashes, etc.).
 * @returns    Canonical E.164 string, or null if the number is invalid.
 */
export function normalizeE164(raw: string): string | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;

  const stripped = raw.replace(STRIP_REGEX, '');

  if (!E164_REGEX.test(stripped)) return null;

  return stripped;
}
