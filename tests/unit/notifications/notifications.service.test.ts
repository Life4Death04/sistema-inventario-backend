/**
 * Unit tests for NotificationService (TwilioNotificationService).
 *
 * Strategy:
 *   - Mock the twilio-client module so twilio.messages.create is a vi.fn().
 *   - Mock the env module with vi.hoisted so TWILIO_WHATSAPP_FROM can be
 *     mutated per-test without the hoisting constraint.
 *   - The production TwilioNotificationService is tested through its real code.
 *
 * Coverage:
 *   - sendWhatsAppMessage() resolves when twilio.messages.create succeeds.
 *   - sendWhatsAppMessage() rejects when twilio.messages.create rejects.
 *   - Missing TWILIO_WHATSAPP_FROM throws a configuration error.
 *   - __setNotificationService() DI override swaps the active service.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoist mutable env stub so the factory can reference it safely ─────────────

const { mockEnv, mockMessagesCreate } = vi.hoisted(() => {
  const mockEnv = {
    TWILIO_WHATSAPP_FROM: 'whatsapp:+14155238886',
    TWILIO_ACCOUNT_SID: 'ACfaketest',
    TWILIO_AUTH_TOKEN: 'faketoken',
    NODE_ENV: 'test' as const,
    PORT: 3000,
    DATABASE_URL: 'postgresql://fake/db',
    JWT_ACCESS_SECRET: 'dev-access-secret-minimum-32-chars-ok',
    JWT_REFRESH_SECRET: 'dev-refresh-secret-minimum-32-chars-ok',
    JWT_ACCESS_TTL: '15m',
    JWT_REFRESH_TTL: '7d',
    BCRYPT_COST: 10,
    FRONTEND_URL: 'http://localhost:5173',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 900_000,
    LOG_LEVEL: 'info' as const,
  };

  const mockMessagesCreate = vi.fn();

  return { mockEnv, mockMessagesCreate };
});

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../../../src/config/env.js', () => ({ env: mockEnv }));

vi.mock('../../../src/shared/notifications/twilio-client.js', () => ({
  getTwilioClient: () => ({ messages: { create: mockMessagesCreate } }),
  _resetTwilioClient: vi.fn(),
}));

// ── Import AFTER mocks are registered ────────────────────────────────────────

import {
  notificationService,
  __setNotificationService,
  type NotificationService,
} from '../../../src/shared/notifications/notifications.service.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TO = 'whatsapp:+14155238886';
const BODY = 'Test notification message.';

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('NotificationService — TwilioNotificationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Restore the default from address before each test.
    mockEnv.TWILIO_WHATSAPP_FROM = 'whatsapp:+14155238886';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('sendWhatsAppMessage — success branch', () => {
    it('resolves when twilio.messages.create succeeds', async () => {
      mockMessagesCreate.mockResolvedValueOnce({ sid: 'SM_fake_sid' });

      await expect(notificationService.sendWhatsAppMessage(TO, BODY)).resolves.toBeUndefined();

      expect(mockMessagesCreate).toHaveBeenCalledOnce();
      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ to: TO, body: BODY }),
      );
    });

    it('passes the configured from number to the Twilio call', async () => {
      mockMessagesCreate.mockResolvedValueOnce({ sid: 'SM_fake_sid_2' });

      await notificationService.sendWhatsAppMessage(TO, BODY);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({ from: 'whatsapp:+14155238886' }),
      );
    });
  });

  describe('sendWhatsAppMessage — failure branch', () => {
    it('rejects when twilio.messages.create rejects', async () => {
      mockMessagesCreate.mockRejectedValueOnce(new Error('Twilio API error: invalid to number'));

      await expect(notificationService.sendWhatsAppMessage(TO, BODY)).rejects.toThrow(
        'Twilio API error',
      );
    });

    it('rejects with the original error message from Twilio', async () => {
      mockMessagesCreate.mockRejectedValueOnce(new Error('21211 - Invalid To number'));

      await expect(notificationService.sendWhatsAppMessage(TO, BODY)).rejects.toThrow(
        '21211 - Invalid To number',
      );
    });

    it('throws a config error when TWILIO_WHATSAPP_FROM is not set', async () => {
      // Mutate the hoisted env stub: unset the from number.
      mockEnv.TWILIO_WHATSAPP_FROM = undefined as unknown as string;

      await expect(notificationService.sendWhatsAppMessage(TO, BODY)).rejects.toThrow(
        /not configured/i,
      );

      // The Twilio client must NOT be called when the from address is missing.
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });
  });

  describe('__setNotificationService DI override', () => {
    it('replaces the active service with the injected fake', async () => {
      const fakeSend = vi.fn().mockResolvedValue(undefined);
      const fake: NotificationService = { sendWhatsAppMessage: fakeSend };

      __setNotificationService(fake);

      // Re-import to read the live exported binding.
      const mod = await import('../../../src/shared/notifications/notifications.service.js');
      await mod.notificationService.sendWhatsAppMessage(TO, BODY);

      expect(fakeSend).toHaveBeenCalledOnce();
      expect(fakeSend).toHaveBeenCalledWith(TO, BODY);
      // The real Twilio client must NOT be reached.
      expect(mockMessagesCreate).not.toHaveBeenCalled();
    });

    it('injected fake reject is surfaced to the caller', async () => {
      __setNotificationService({
        sendWhatsAppMessage: vi.fn().mockRejectedValue(new Error('Simulated failure')),
      });

      const mod = await import('../../../src/shared/notifications/notifications.service.js');
      await expect(mod.notificationService.sendWhatsAppMessage(TO, BODY)).rejects.toThrow(
        'Simulated failure',
      );
    });
  });
});
