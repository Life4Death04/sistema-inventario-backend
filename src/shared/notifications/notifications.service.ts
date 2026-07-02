/**
 * NotificationService — WhatsApp message delivery via Twilio.
 *
 * Architecture:
 *   - Module-level singleton (`notificationService`) consumed by the
 *     replenishment-requests service for fire-and-forget send/cancel flows.
 *   - `__setNotificationService(fake)` allows test code to inject a fake
 *     without constructor injection (mirrors the existing singleton style).
 *   - The TWILIO_WHATSAPP_FROM env var must be a full Twilio WhatsApp sender
 *     address (e.g. "whatsapp:+14155238886"). Missing → INTERNAL_ERROR at send.
 *
 * Concurrency / error contract:
 *   sendWhatsAppMessage() is called fire-and-forget after DB commit.
 *   The caller MUST attach `.catch(logger.error)` so Twilio failures are
 *   logged without rolling back the already-committed DB state.
 */
import { env } from '../../config/env.js';
import { getTwilioClient } from './twilio-client.js';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface NotificationService {
  sendWhatsAppMessage(to: string, body: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Production implementation
// ---------------------------------------------------------------------------

class TwilioNotificationService implements NotificationService {
  async sendWhatsAppMessage(to: string, body: string): Promise<void> {
    const from = env.TWILIO_WHATSAPP_FROM;

    if (!from) {
      throw new Error(
        'Twilio WhatsApp sender not configured. Set TWILIO_WHATSAPP_FROM (e.g. whatsapp:+14155238886).',
      );
    }

    const client = getTwilioClient();

    await client.messages.create({
      from,
      to,
      body,
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _service: NotificationService = new TwilioNotificationService();

/** The active notification service instance. Swap via __setNotificationService in tests. */
export let notificationService: NotificationService = _service;

/**
 * Replace the active notification service with a test double.
 * Call this in beforeEach to inject a fake; restore is automatic if the
 * module is re-imported between test suites.
 *
 * @internal — test-only
 */
export function __setNotificationService(fake: NotificationService): void {
  _service = fake;
  notificationService = fake;
}
