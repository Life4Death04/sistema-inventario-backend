/**
 * Unit tests for AuthService.
 *
 * Tests per tasks.md 4.14:
 *   - signAccessToken / verifyAccessToken round-trip
 *   - Expired token → TOKEN_EXPIRED
 *   - Wrong secret   → INVALID_TOKEN
 *   - hashPassword / comparePassword correctness
 *   - signRefreshToken / verifyRefreshToken round-trip
 *   - parseTtlToSeconds utility
 *
 * No DB, no HTTP — pure unit tests using vi.mock for the env module.
 */
import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { AuthService } from '../../src/modules/auth/auth.service.js';
import { isAppError } from '../../src/shared/errors/AppError.js';
import { ERROR_CODES } from '../../src/shared/errors/errorCodes.js';

// Mock the env module so tests control secrets and TTLs without a real .env.
vi.mock('../../src/config/env.js', () => ({
  env: {
    JWT_ACCESS_SECRET: 'test-access-secret-minimum-32-chars-ok!',
    JWT_REFRESH_SECRET: 'test-refresh-secret-minimum-32-chars-ok',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '7d',
    BCRYPT_COST: 10,
    NODE_ENV: 'test',
  },
}));

const ACCESS_SECRET = 'test-access-secret-minimum-32-chars-ok!';
const REFRESH_SECRET = 'test-refresh-secret-minimum-32-chars-ok';

const service = new AuthService();

// ── Access token ──────────────────────────────────────────────────────────────

describe('AuthService — access token', () => {
  it('signAccessToken / verifyAccessToken round-trip returns correct payload', () => {
    const userId = 'cuid-user-123';
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    const role = 'ADMIN' as const;

    const token = service.signAccessToken(userId, role);
    const payload = service.verifyAccessToken(token);

    expect(payload.sub).toBe(userId);
    expect(payload.role).toBe(role);
  });

  it('verifyAccessToken throws TOKEN_EXPIRED on an expired token', () => {
    // Sign a token that expired 1 second ago.
    const expiredToken = jwt.sign({ sub: 'user-1', role: 'OPERATOR' }, ACCESS_SECRET, {
      algorithm: 'HS256',
      expiresIn: -1,
    });

    try {
      service.verifyAccessToken(expiredToken);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.code).toBe(ERROR_CODES.TOKEN_EXPIRED);
        expect(e.statusCode).toBe(401);
      }
    }
  });

  it('verifyAccessToken throws INVALID_TOKEN when signed with a different secret', () => {
    const tokenWithWrongSecret = jwt.sign(
      { sub: 'user-1', role: 'ADMIN' },
      'completely-different-secret-that-is-wrong!!',
      { algorithm: 'HS256', expiresIn: '15m' },
    );

    try {
      service.verifyAccessToken(tokenWithWrongSecret);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.code).toBe(ERROR_CODES.INVALID_TOKEN);
        expect(e.statusCode).toBe(401);
      }
    }
  });

  it('verifyAccessToken throws INVALID_TOKEN on a malformed string', () => {
    try {
      service.verifyAccessToken('not.a.jwt');
      expect.fail('Should have thrown');
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.code).toBe(ERROR_CODES.INVALID_TOKEN);
        expect(e.statusCode).toBe(401);
      }
    }
  });
});

// ── Refresh token ─────────────────────────────────────────────────────────────

describe('AuthService — refresh token', () => {
  it('signRefreshToken / verifyRefreshToken round-trip returns correct payload', () => {
    const userId = 'cuid-user-456';
    const jti = 'cuid-jti-row-id';

    const token = service.signRefreshToken(userId, jti);
    const payload = service.verifyRefreshToken(token);

    expect(payload.sub).toBe(userId);
    expect(payload.jti).toBe(jti);
  });

  it('verifyRefreshToken throws INVALID_REFRESH_TOKEN on expired token', () => {
    const expiredToken = jwt.sign({ sub: 'user-2', jti: 'some-jti' }, REFRESH_SECRET, {
      algorithm: 'HS256',
      expiresIn: -1,
    });

    try {
      service.verifyRefreshToken(expiredToken);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.code).toBe(ERROR_CODES.INVALID_REFRESH_TOKEN);
        expect(e.statusCode).toBe(401);
      }
    }
  });

  it('verifyRefreshToken throws INVALID_REFRESH_TOKEN when signed with a different secret', () => {
    const tokenWithWrongSecret = jwt.sign(
      { sub: 'user-2', jti: 'some-jti' },
      'completely-different-wrong-secret-here!!',
      { algorithm: 'HS256', expiresIn: '7d' },
    );

    try {
      service.verifyRefreshToken(tokenWithWrongSecret);
      expect.fail('Should have thrown');
    } catch (e) {
      expect(isAppError(e)).toBe(true);
      if (isAppError(e)) {
        expect(e.code).toBe(ERROR_CODES.INVALID_REFRESH_TOKEN);
        expect(e.statusCode).toBe(401);
      }
    }
  });
});

// ── Password utilities ────────────────────────────────────────────────────────

describe('AuthService — password hashing', () => {
  it('hashPassword produces a bcrypt hash that comparePassword accepts', async () => {
    const plain = 'MySecurePassword123!';
    const hash = await service.hashPassword(plain);

    // Hash should be a bcrypt string starting with $2b$
    expect(hash).toMatch(/^\$2[ab]\$/);

    const match = await service.comparePassword(plain, hash);
    expect(match).toBe(true);
  });

  it('comparePassword returns false for a wrong password', async () => {
    const hash = await service.hashPassword('correct-horse-battery');
    const match = await service.comparePassword('wrong-password', hash);
    expect(match).toBe(false);
  });

  it('hashPassword produces a different hash each call (bcrypt salting)', async () => {
    const plain = 'same-password';
    const hash1 = await service.hashPassword(plain);
    const hash2 = await service.hashPassword(plain);
    expect(hash1).not.toBe(hash2);
  });
}, 30_000); // bcrypt is intentionally slow — allow up to 30s

// ── TTL helpers ───────────────────────────────────────────────────────────────

describe('AuthService — parseTtlToSeconds', () => {
  it('parses days correctly', () => {
    expect(service.parseTtlToSeconds('7d')).toBe(7 * 86_400);
  });

  it('parses hours correctly', () => {
    expect(service.parseTtlToSeconds('2h')).toBe(2 * 3_600);
  });

  it('parses minutes correctly', () => {
    expect(service.parseTtlToSeconds('15m')).toBe(15 * 60);
  });

  it('parses raw seconds', () => {
    expect(service.parseTtlToSeconds('900s')).toBe(900);
  });

  it('falls back to 7d (604800s) for unrecognized format', () => {
    expect(service.parseTtlToSeconds('invalid')).toBe(7 * 86_400);
  });
});
